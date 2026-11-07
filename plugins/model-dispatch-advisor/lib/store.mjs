import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_ID } from './definitions.mjs';

const STORE_SCHEMA_VERSION = 1;
const STORE_FILENAME = 'preferences.json';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function advisorError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function resolvePluginDataFile({ kikiHome, dataDir } = {}) {
  if (typeof dataDir === 'string' && dataDir.trim().length > 0) {
    const resolved = path.resolve(dataDir.trim());
    return path.join(resolved, STORE_FILENAME);
  }
  if (typeof kikiHome !== 'string' || kikiHome.trim().length === 0) {
    throw advisorError(
      'ADVISOR_STORAGE_UNAVAILABLE',
      'The host did not provide kikiHome for plugin data storage.',
    );
  }
  const home = path.resolve(kikiHome.trim());
  const pluginDir = path.join(home, 'plugin-data', PLUGIN_ID);
  const target = path.join(pluginDir, STORE_FILENAME);
  const rel = path.relative(pluginDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw advisorError('ADVISOR_STORAGE_UNAVAILABLE', 'Resolved plugin data path escaped plugin-data boundary.');
  }
  return target;
}

export function emptyState() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    preferences: {},
    customGroups: {},
  };
}

function sanitizeStringList(value, maxItems = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeCandidateDefinition(raw, index = 0) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
    throw advisorError('ADVISOR_INVALID_CANDIDATE', `Candidate at index ${index} requires a non-empty string id.`);
  }
  const id = raw.id.trim();
  const kind = ['native-model', 'external-harness', 'profile'].includes(raw.kind)
    ? raw.kind
    : (raw.executorId ? 'external-harness' : (raw.profile && !raw.modelId ? 'profile' : 'native-model'));
  return {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
    kind,
    ...(typeof raw.profile === 'string' && raw.profile.trim() ? { profile: raw.profile.trim() } : {}),
    ...(typeof raw.executorId === 'string' && raw.executorId.trim() ? { executorId: raw.executorId.trim() } : {}),
    ...(typeof raw.modelId === 'string' && raw.modelId.trim() ? { modelId: raw.modelId.trim() } : {}),
    ...(typeof raw.effort === 'string' && raw.effort.trim() ? { effort: raw.effort.trim() } : {}),
    ...(typeof raw.family === 'string' && raw.family.trim() ? { family: raw.family.trim().toLowerCase() } : {}),
    defaultRank: Number.isInteger(raw.defaultRank) && raw.defaultRank >= 0 ? raw.defaultRank : index * 10,
    isRoleDefault: raw.isRoleDefault === true,
    ...(typeof raw.available === 'boolean' ? { available: raw.available } : {}),
    ...(Array.isArray(raw.allowedModels) ? { allowedModels: sanitizeStringList(raw.allowedModels, 128) } : {}),
    ...(Array.isArray(raw.deniedModels) ? { deniedModels: sanitizeStringList(raw.deniedModels, 128) } : {}),
  };
}

function sanitizeStoredState(parsed) {
  if (!isRecord(parsed)) return emptyState();
  const preferences = {};
  if (isRecord(parsed.preferences)) {
    for (const [group, entry] of Object.entries(parsed.preferences)) {
      if (!isRecord(entry) || !group.trim()) continue;
      preferences[group.trim()] = {
        group: group.trim(),
        prefer: sanitizeStringList(entry.prefer, 32),
        avoid: sanitizeStringList(entry.avoid, 32),
        authorizedRoles: sanitizeStringList(entry.authorizedRoles, 32),
        source: {
          kind: 'explicit_user',
          userQuote: typeof entry.source?.userQuote === 'string' ? entry.source.userQuote : '',
          ...(typeof entry.source?.sourceNote === 'string' && entry.source.sourceNote
            ? { sourceNote: entry.source.sourceNote }
            : {}),
          updatedAt: typeof entry.source?.updatedAt === 'string' ? entry.source.updatedAt : null,
        },
      };
    }
  }
  const customGroups = {};
  if (isRecord(parsed.customGroups)) {
    for (const [group, entry] of Object.entries(parsed.customGroups)) {
      if (!isRecord(entry) || !group.trim()) continue;
      const candidates = Array.isArray(entry.candidates)
        ? entry.candidates.map((item, idx) => normalizeCandidateDefinition(item, idx))
        : [];
      customGroups[group.trim()] = {
        id: group.trim(),
        label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : group.trim(),
        protectedRoleDefault: entry.protectedRoleDefault === true,
        ...(typeof entry.defaultRole === 'string' && entry.defaultRole.trim()
          ? { defaultRole: entry.defaultRole.trim() }
          : {}),
        candidates,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
      };
    }
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    preferences,
    customGroups,
  };
}

// Per-file in-process serialization so concurrent mutations never interleave temp renames.
const writeQueues = new Map();

export function getActiveWriteQueueCountForTesting() {
  return writeQueues.size;
}

function enqueueFileMutation(filePath, fn) {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const tracked = previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => {
      if (writeQueues.get(key) === tracked) {
        writeQueues.delete(key);
      }
    });
  writeQueues.set(key, tracked);
  return tracked;
}

export class PreferenceStore {
  constructor({ kikiHome, dataDir, now = () => new Date().toISOString() } = {}) {
    this.filePath = resolvePluginDataFile({ kikiHome, dataDir });
    this.now = now;
  }

  async read() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw advisorError(
        'ADVISOR_STORAGE_READ_FAILED',
        `Failed to read preference store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw advisorError(
        'ADVISOR_STORAGE_CORRUPTED',
        `Preference store contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return sanitizeStoredState(parsed);
  }

  async #writeAtomic(state) {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempFile = path.join(dir, `.preferences.${process.pid}.${randomUUID()}.tmp`);
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(tempFile, payload, 'utf8');
    try {
      await rename(tempFile, this.filePath);
    } catch (error) {
      await rm(tempFile, { force: true }).catch(() => undefined);
      throw advisorError(
        'ADVISOR_STORAGE_WRITE_FAILED',
        `Failed to persist preference store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return state;
  }

  async setPreference({
    group,
    prefer = [],
    avoid = [],
    authorizedRoles = [],
    userAuthorized,
    userQuote,
    sourceNote,
  }) {
    const groupId = typeof group === 'string' ? group.trim() : '';
    if (!groupId || groupId.length > 128) {
      throw advisorError('ADVISOR_INVALID_ARGUMENT', 'Provide a valid non-empty functional group name.');
    }
    if (userAuthorized !== true) {
      throw advisorError(
        'ADVISOR_USER_AUTHORIZATION_REQUIRED',
        'Preferences can only be saved from an explicit user instruction (set userAuthorized=true and provide userQuote). Model self-inferred preferences are refused.',
      );
    }
    const quote = typeof userQuote === 'string' ? userQuote.trim() : '';
    const note = typeof sourceNote === 'string' ? sourceNote.trim() : '';
    if (!quote && !note) {
      throw advisorError(
        'ADVISOR_PROVENANCE_REQUIRED',
        'Provide userQuote or sourceNote recording the explicit user instruction behind this preference.',
      );
    }
    const cleanPrefer = sanitizeStringList(prefer, 32);
    const cleanAvoid = sanitizeStringList(avoid, 32);
    if (cleanPrefer.length === 0 && cleanAvoid.length === 0) {
      throw advisorError(
        'ADVISOR_EMPTY_PREFERENCE',
        'Specify at least one entry in prefer or avoid, or use action="clear" to remove a preference.',
      );
    }
    const cleanRoles = sanitizeStringList(authorizedRoles, 32);

    return enqueueFileMutation(this.filePath, async () => {
      const current = await this.read();
      const timestamp = this.now();
      const entry = {
        group: groupId,
        prefer: cleanPrefer,
        avoid: cleanAvoid,
        authorizedRoles: cleanRoles,
        source: {
          kind: 'explicit_user',
          userQuote: quote || note,
          ...(note ? { sourceNote: note } : {}),
          updatedAt: timestamp,
        },
      };
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        preferences: {
          ...current.preferences,
          [groupId]: entry,
        },
      };
      return this.#writeAtomic(next);
    });
  }

  async clearPreference({ group, clearAll = false, includeCustomGroups = false } = {}) {
    if (!clearAll && (typeof group !== 'string' || !group.trim())) {
      throw advisorError(
        'ADVISOR_INVALID_ARGUMENT',
        'Specify group to clear one functional group, or set clearAll=true to clear all saved preferences.',
      );
    }
    return enqueueFileMutation(this.filePath, async () => {
      const current = await this.read();
      const timestamp = this.now();
      let nextPreferences;
      let nextCustomGroups = current.customGroups;
      let clearedGroups = [];
      if (clearAll) {
        clearedGroups = Object.keys(current.preferences);
        nextPreferences = {};
        if (includeCustomGroups) {
          nextCustomGroups = {};
        }
      } else {
        const groupId = group.trim();
        nextPreferences = { ...current.preferences };
        if (Object.hasOwn(nextPreferences, groupId)) {
          clearedGroups = [groupId];
          delete nextPreferences[groupId];
        }
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        preferences: nextPreferences,
        customGroups: nextCustomGroups,
      };
      await this.#writeAtomic(next);
      return { state: next, clearedGroups };
    });
  }

  async defineCustomGroup({ group, groupLabel, protectedRoleDefault = false, candidates = [] }) {
    const groupId = typeof group === 'string' ? group.trim() : '';
    if (!groupId || groupId.length > 128) {
      throw advisorError('ADVISOR_INVALID_ARGUMENT', 'Provide a valid non-empty group ID for define_group.');
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw advisorError('ADVISOR_INVALID_ARGUMENT', 'define_group requires a non-empty candidates array.');
    }
    const normalizedCandidates = candidates.map((item, idx) => normalizeCandidateDefinition(item, idx));
    const seenIds = new Set();
    for (const candidate of normalizedCandidates) {
      if (seenIds.has(candidate.id)) {
        throw advisorError('ADVISOR_INVALID_CANDIDATE', `Duplicate candidate id "${candidate.id}" in group "${groupId}".`);
      }
      seenIds.add(candidate.id);
    }

    return enqueueFileMutation(this.filePath, async () => {
      const current = await this.read();
      const timestamp = this.now();
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        customGroups: {
          ...current.customGroups,
          [groupId]: {
            id: groupId,
            label: typeof groupLabel === 'string' && groupLabel.trim() ? groupLabel.trim() : groupId,
            protectedRoleDefault: protectedRoleDefault === true,
            candidates: normalizedCandidates,
            updatedAt: timestamp,
          },
        },
      };
      return this.#writeAtomic(next);
    });
  }

  async removeCustomGroup({ group }) {
    const groupId = typeof group === 'string' ? group.trim() : '';
    if (!groupId) {
      throw advisorError('ADVISOR_INVALID_ARGUMENT', 'Provide a non-empty group ID for remove_group.');
    }
    return enqueueFileMutation(this.filePath, async () => {
      const current = await this.read();
      const timestamp = this.now();
      const nextCustomGroups = { ...current.customGroups };
      const existed = Object.hasOwn(nextCustomGroups, groupId);
      delete nextCustomGroups[groupId];
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        customGroups: nextCustomGroups,
      };
      await this.#writeAtomic(next);
      return { state: next, removed: existed };
    });
  }
}
