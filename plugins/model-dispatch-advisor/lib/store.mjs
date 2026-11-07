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

function sanitizeStoredState(parsed) {
  if (!isRecord(parsed)) return emptyState();
  const preferences = {};
  if (isRecord(parsed.preferences)) {
    for (const [group, entry] of Object.entries(parsed.preferences)) {
      if (!isRecord(entry) || !group.trim()) continue;
      const key = group.trim();
      preferences[key] = {
        group: key,
        prefer: sanitizeStringList(entry.prefer, 32),
        avoid: sanitizeStringList(entry.avoid, 32),
        ...(typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note.trim() } : {}),
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
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    preferences,
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
    note,
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
    const provenanceNote = typeof sourceNote === 'string' ? sourceNote.trim() : '';
    if (!quote && !provenanceNote) {
      throw advisorError(
        'ADVISOR_PROVENANCE_REQUIRED',
        'Provide userQuote or sourceNote recording the explicit user instruction behind this preference.',
      );
    }
    const cleanPrefer = sanitizeStringList(prefer, 32);
    const cleanAvoid = sanitizeStringList(avoid, 32);
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : undefined;
    if (cleanPrefer.length === 0 && cleanAvoid.length === 0 && !cleanNote) {
      throw advisorError(
        'ADVISOR_EMPTY_PREFERENCE',
        'Specify at least one entry in prefer, avoid, or note, or use action="clear" to remove a preference.',
      );
    }

    return enqueueFileMutation(this.filePath, async () => {
      const current = await this.read();
      const timestamp = this.now();
      const entry = {
        group: groupId,
        prefer: cleanPrefer,
        avoid: cleanAvoid,
        ...(cleanNote ? { note: cleanNote } : {}),
        source: {
          kind: 'explicit_user',
          userQuote: quote || provenanceNote,
          ...(provenanceNote ? { sourceNote: provenanceNote } : {}),
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

  async clearPreference({ group, clearAll = false } = {}) {
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
      let clearedGroups = [];
      if (clearAll) {
        clearedGroups = Object.keys(current.preferences);
        nextPreferences = {};
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
      };
      await this.#writeAtomic(next);
      return { state: next, clearedGroups };
    });
  }
}
