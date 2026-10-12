import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ownWork from '../vendor/own-work-tasks.mjs';
import { readStorageConfig } from './config.mjs';
import { workspaceRootKey } from './paths.mjs';

const STATUSES = new Set(['active', 'in_progress', 'paused', 'done', 'cancelled', 'superseded']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const KINDS = new Set(['workspace', 'embedded']);

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function failure(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string'
    && (error.code.startsWith('TASK_') || error.code.startsWith('BOARD_') || error.code.startsWith('WORKSPACE_'))) {
    return fail(error.code, error instanceof Error ? error.message : 'Own Work rejected the operation.');
  }
  return fail('BOARD_UNAVAILABLE', 'Own Work storage is unavailable or incompatible. No fallback store was selected.');
}

function identity(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512;
}

function rootPath(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096;
}

function links(value) {
  return Array.isArray(value) && value.length <= 256 && value.every(identity);
}

function only(object, keys) {
  return object !== null && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).every((key) => keys.includes(key));
}

function storageRef(value) {
  return only(value, ['root', 'storageId', 'kind']) && rootPath(value.root) && identity(value.storageId) && KINDS.has(value.kind);
}

function storageConfig(value) {
  if (!only(value, ['mode', 'path']) || !['auto', 'global', 'fixed'].includes(value.mode)) return false;
  if (value.mode === 'fixed') return typeof value.path === 'string' && value.path.trim() !== '' && value.path.length <= 4096 && !/[\u0000-\u001f]/u.test(value.path);
  return value.path === undefined;
}

function patchOf(value) {
  if (!only(value, ['title', 'description', 'priority', 'category', 'sessionIds', 'executionIds', 'status'])) return undefined;
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.trim() === '' || value.title.trim().length > 1000)) return undefined;
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 100_000)) return undefined;
  if (value.priority !== undefined && !PRIORITIES.has(value.priority)) return undefined;
  if (value.category !== undefined && (typeof value.category !== 'string' || value.category.length > 256)) return undefined;
  if (value.sessionIds !== undefined && !links(value.sessionIds)) return undefined;
  if (value.executionIds !== undefined && !links(value.executionIds)) return undefined;
  if (value.status !== undefined && !STATUSES.has(value.status)) return undefined;
  if (Object.keys(value).length === 0) return undefined;
  return value.title === undefined ? value : { ...value, title: value.title.trim() };
}

export function parseRead(raw) {
  if (!only(raw, ['action', 'workspaceId', 'workspaceIds', 'configuration', 'storage', 'sessionId', 'status', 'archived', 'cursor', 'limit', 'id'])) return undefined;
  if (raw.workspaceId !== undefined && !identity(raw.workspaceId)) return undefined;
  if (raw.status !== undefined && !STATUSES.has(raw.status)) return undefined;
  if (raw.limit !== undefined && (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 100)) return undefined;
  if (raw.action === 'preview') {
    if (raw.configuration !== undefined && !storageConfig(raw.configuration)) return undefined;
    return raw;
  }
  if (raw.action === 'list') {
    if (raw.storage !== undefined && !storageRef(raw.storage)) return undefined;
    if (raw.sessionId !== undefined && !identity(raw.sessionId)) return undefined;
    if (raw.archived !== undefined && typeof raw.archived !== 'boolean') return undefined;
    if (raw.cursor !== undefined && !identity(raw.cursor)) return undefined;
    return raw;
  }
  if (raw.action === 'show') {
    if (!identity(raw.workspaceId) || !storageRef(raw.storage) || !identity(raw.id)) return undefined;
    return raw;
  }
  if (raw.action === 'overview') {
    if (!Array.isArray(raw.workspaceIds) || raw.workspaceIds.length < 1 || raw.workspaceIds.length > 32 || !raw.workspaceIds.every(identity)) return undefined;
    return raw;
  }
  return undefined;
}

export function parseWrite(raw) {
  if (!only(raw, ['action', 'workspaceId', 'requestKey', 'target', 'title', 'description', 'priority', 'category', 'sessionIds', 'executionIds', 'storage', 'id', 'expectedRevision', 'patch'])) return undefined;
  if (raw.workspaceId !== undefined && !identity(raw.workspaceId)) return undefined;
  if (raw.action === 'create') {
    if (!identity(raw.requestKey) || typeof raw.title !== 'string' || raw.title.trim() === '' || raw.title.trim().length > 1000) return undefined;
    if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 100_000)) return undefined;
    if (raw.priority !== undefined && !PRIORITIES.has(raw.priority)) return undefined;
    if (raw.category !== undefined && (typeof raw.category !== 'string' || raw.category.length > 256)) return undefined;
    if (raw.sessionIds !== undefined && !links(raw.sessionIds)) return undefined;
    if (raw.executionIds !== undefined && !links(raw.executionIds)) return undefined;
    if (raw.target !== undefined && !(only(raw.target, ['root', 'storageId', 'kind']) && rootPath(raw.target.root) && KINDS.has(raw.target.kind) && (raw.target.storageId === undefined || identity(raw.target.storageId)))) return undefined;
    return { ...raw, title: raw.title.trim() };
  }
  if (raw.action === 'update') {
    const patch = patchOf(raw.patch);
    if (!identity(raw.workspaceId) || !storageRef(raw.storage) || !identity(raw.id) || !Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 0 || patch === undefined) return undefined;
    return { ...raw, patch };
  }
  return undefined;
}

function normalize(root) {
  return workspaceRootKey(path.resolve(root));
}

async function canonical(root) {
  try { return normalize(await realpath(root)); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = path.dirname(root);
    if (parent === root) throw error;
    return normalize(path.join(await canonical(parent), path.basename(root)));
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function bindingsOf(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => !only(entry, ['root', 'canonical', 'workspaceRoot']) || typeof entry.root !== 'string' || typeof entry.canonical !== 'string' || typeof entry.workspaceRoot !== 'string')) {
    throw Object.assign(new Error('The task board authorization ledger cannot be read.'), { code: 'BOARD_UNAVAILABLE' });
  }
  return raw;
}

async function remember(kikiHome, binding) {
  const file = path.join(kikiHome, 'task-board-authorizations', binding.workspaceId);
  const previous = bindingsOf(await readJson(file));
  if (previous.some((entry) => normalize(entry.root) === binding.root && normalize(entry.workspaceRoot) === binding.workspaceRoot)) return;
  await mkdir(path.dirname(file), { recursive: true });
  const next = JSON.stringify([...previous, { root: binding.root, canonical: binding.canonical, workspaceRoot: binding.workspaceRoot }]);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, next);
  await rename(temporary, file);
}

async function loadWorkspaces(kikiHome) {
  const file = await readJson(path.join(kikiHome, 'workspaces.json'));
  const record = file && typeof file === 'object' ? file.workspaces : undefined;
  if (record === undefined || record === null || typeof record !== 'object') return [];
  const workspaces = [];
  for (const [id, raw] of Object.entries(record)) {
    if (!identity(id) || raw === null || typeof raw !== 'object' || typeof raw.root !== 'string' || raw.root === '') continue;
    workspaces.push({ id, root: raw.root, name: typeof raw.name === 'string' ? raw.name : id });
  }
  return workspaces;
}

async function loadConfig(kikiHome) {
  try {
    return readStorageConfig(await readFile(path.join(kikiHome, 'config.toml'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { mode: 'auto' };
    throw error;
  }
}

async function inspect(api, context, root) {
  await context.authorizeStorage(root, 'read');
  return api.inspectTaskStorage(root);
}

function previewOf(context, mode, storage) {
  if (storage.kind === 'absent' && storage.empty !== true) {
    return fail('BOARD_STORAGE_NOT_EMPTY', 'The selected directory contains unrecognized content. Choose an empty directory or an existing compatible Own Work store.');
  }
  return { ok: true, value: {
    mode, workspaceId: context.workspaceId, root: storage.root,
    tasksDirectory: storage.tasksDirectory ?? path.join(storage.root, 'tasks'),
    existing: storage.kind !== 'absent', kind: storage.kind === 'workspace' ? 'workspace' : 'embedded',
    storageId: storage.storageId, selectionOnly: true,
  } };
}

async function previewBoardStorage(api, context, config) {
  if (!storageConfig(config)) return fail('BOARD_STORAGE_CONFIG_INVALID', 'Invalid task board storage configuration.');
  if (!path.isAbsolute(context.workspaceRoot) || !path.isAbsolute(context.homeDir) || !path.isAbsolute(context.sessionsDir)
    || !context.workspaceId || /[/\\]/u.test(context.workspaceId) || context.workspaceId === '.' || context.workspaceId === '..') {
    return fail('BOARD_WORKSPACE_INVALID', 'The host did not provide a valid workspace storage context.');
  }
  if (config.mode === 'auto') {
    const existing = await inspect(api, context, context.workspaceRoot);
    if (existing.kind !== 'absent') return previewOf(context, config.mode, existing);
  }
  const root = config.mode === 'global'
    ? path.join(context.homeDir, 'boards')
    : config.mode === 'fixed'
      ? path.resolve(context.workspaceRoot, config.path ?? '')
      : path.join(context.sessionsDir, context.workspaceId, '.board');
  return previewOf(context, config.mode, await inspect(api, context, root));
}

async function prepareBoardStorage(api, context, preview) {
  await context.authorizeStorage(preview.root, 'write');
  let current = await api.inspectTaskStorage(preview.root);
  if (preview.existing && (current.kind === 'absent' || current.storageId !== preview.storageId)) {
    return fail('BOARD_STORAGE_CHANGED', 'The selected store changed. Refresh before creating a card.');
  }
  if (current.kind === 'absent') {
    if (current.empty !== true) return fail('BOARD_STORAGE_NOT_EMPTY', 'The selected directory is no longer empty. No store was initialized.');
    await api.initializeEmbeddedTaskStorage(preview.root);
    current = await api.inspectTaskStorage(preview.root);
  }
  if (current.kind === 'absent' || !current.storageId) return fail('BOARD_STORAGE_INVALID', 'Own Work did not confirm a storage identity.');
  return { ok: true, value: { root: current.root, storageId: current.storageId, kind: current.kind } };
}

async function openBoardStorage(api, context, reference, operation) {
  if (!path.isAbsolute(reference.root)) return fail('BOARD_STORAGE_INVALID', 'A stored card address must have an absolute root.');
  await context.authorizeStorage(reference.root, operation);
  const current = await api.inspectTaskStorage(reference.root);
  if (current.kind !== reference.kind || current.storageId !== reference.storageId) {
    return fail('BOARD_STORAGE_CHANGED', 'This card’s original store is missing or has a different identity. No replacement store was opened.');
  }
  return { ok: true, value: reference };
}

function owns(context, storage, item) {
  return item ? item.workspaceId === context.workspaceId : storage.kind === 'workspace'
    && workspaceRootKey(storage.root) === workspaceRootKey(context.workspaceRoot);
}

function summary(context, storage, entry) {
  if (!owns(context, storage, entry.workItem)) return fail('BOARD_WORKSPACE_MISMATCH', 'The record belongs to another workspace or has no ownership in a shared store.');
  if (entry.title === undefined || entry.status === undefined || entry.revision === undefined || entry.priority === undefined || entry.createdAt === undefined) {
    return fail('BOARD_API_INCOMPATIBLE', 'Own Work did not provide the required summary contract.');
  }
  return { ok: true, value: {
    id: entry.id, workspaceId: context.workspaceId, storage, title: entry.title, priority: entry.priority,
    status: entry.status, revision: entry.revision, createdAt: entry.createdAt, updatedAt: entry.workItem?.updatedAt ?? entry.createdAt,
    completedAt: entry.completedAt ?? null, archived: entry.archived, category: entry.workItem?.category ?? '',
    sessionIds: entry.workItem?.sessionIds ?? [], executionIds: entry.workItem?.executionIds ?? [],
  } };
}

function project(context, storage, record) {
  const meta = record.task.meta?.['own_work_item'];
  const workItem = meta === undefined ? undefined : meta;
  if (workItem !== undefined && (typeof workItem.workspaceId !== 'string' || typeof workItem.category !== 'string' || !Array.isArray(workItem.sessionIds) || !Array.isArray(workItem.executionIds) || typeof workItem.updatedAt !== 'string')) {
    return fail('BOARD_API_INCOMPATIBLE', 'Own Work did not provide the required work item contract.');
  }
  const result = summary(context, storage, { ...record.task, revision: record.revision, archived: record.archived, workItem });
  return result.ok ? { ok: true, value: { ...result.value, description: record.task.description, prd: record.prd, handoff: record.handoff } } : result;
}

export function createBoard(options, api = ownWork) {
  const kikiHome = options.kikiHome;
  const sessionsDir = path.join(kikiHome, 'sessions');
  async function access(selected, operation, config, previewOnly, use) {
    if (!identity(selected ?? '')) return fail('BOARD_WORKSPACE_REQUIRED', 'Select an authorized workspace.');
    const workspaceId = selected;
    try {
      const workspaces = await loadWorkspaces(kikiHome);
      const registered = workspaces.find((workspace) => workspace.id === workspaceId);
      if (registered === undefined) throw Object.assign(new Error('Workspace is not registered.'), { code: 'WORKSPACE_NOT_FOUND' });
      const workspaceCanonical = await canonical(registered.root);
      const bindings = bindingsOf(await readJson(path.join(kikiHome, 'task-board-authorizations', workspaceId)));
      const selectedConfig = config;
      const candidates = [
        { root: registered.root, canonical: workspaceCanonical },
        { root: path.join(kikiHome, 'boards'), canonical: normalize(path.join(await canonical(kikiHome), 'boards')) },
        { root: path.join(sessionsDir, workspaceId, '.board'), canonical: normalize(path.join(await canonical(sessionsDir), workspaceId, '.board')) },
      ];
      if (selectedConfig.mode === 'fixed' && selectedConfig.path) {
        const root = path.resolve(registered.root, selectedConfig.path);
        candidates.push({ root, canonical: await canonical(root) });
      }
      const touched = [];
      const result = await use({
        workspaceId, workspaceRoot: registered.root, homeDir: kikiHome, sessionsDir,
        async authorizeStorage(root, accessMode) {
          if (!path.isAbsolute(root)) throw Object.assign(new Error('A storage root must be absolute.'), { code: 'BOARD_ACCESS_DENIED' });
          if (accessMode === 'write' && operation !== 'write') throw Object.assign(new Error('This operation does not authorize storage writes.'), { code: 'BOARD_ACCESS_DENIED' });
          const resolved = normalize(root);
          const physical = await canonical(resolved);
          const old = bindings.find((binding) => normalize(binding.root) === resolved && binding.workspaceRoot === workspaceCanonical);
          if (old && old.canonical !== physical) throw Object.assign(new Error('The authorized storage path now points to a different directory.'), { code: 'BOARD_ACCESS_DENIED' });
          if (!old && !candidates.some((candidate) => normalize(candidate.root) === resolved && candidate.canonical === physical)) {
            throw Object.assign(new Error('This storage location has not been authorized for the workspace.'), { code: 'BOARD_ACCESS_DENIED' });
          }
          if (!previewOnly) touched.push({ workspaceId, root: resolved, canonical: physical, workspaceRoot: workspaceCanonical });
        },
      });
      if (result.ok && !previewOnly) {
        for (const binding of touched) await remember(kikiHome, binding);
      }
      return result;
    } catch (error) {
      return failure(error);
    }
  }

  async function page(input, config) {
    return access(input.workspaceId, 'read', config, false, async (context) => {
      let storage;
      if (input.storage) {
        const opened = await openBoardStorage(api, context, input.storage, 'read');
        if (!opened.ok) return opened;
        storage = opened.value;
      } else {
        const preview = await previewBoardStorage(api, context, config);
        if (!preview.ok) return preview;
        if (!preview.value.existing) return { ok: true, value: { workspaceId: context.workspaceId, cards: [], issues: [] } };
        if (!preview.value.storageId) return fail('BOARD_STORAGE_INVALID', 'The existing store has no identity.');
        storage = { root: preview.value.root, storageId: preview.value.storageId, kind: preview.value.kind };
      }
      const listing = await api.listTasks({ root: storage.root, workspaceId: context.workspaceId, sessionId: input.sessionId, status: input.status, archived: input.archived, limit: input.limit ?? 50, cursor: input.cursor });
      const cards = [];
      const issues = listing.issues.flatMap((entry) => entry.issues.map(({ code, message }) => ({ code, message: `${entry.path} (${entry.id}): ${message}` })));
      for (const entry of listing.tasks) {
        const projected = summary(context, storage, entry);
        if (projected.ok) cards.push(projected.value);
        else issues.push(projected.error);
      }
      return { ok: true, value: { workspaceId: context.workspaceId, storage, cards, issues, nextCursor: listing.next_cursor } };
    });
  }

  return {
    async workspaces() {
      return { ok: true, value: { workspaces: await loadWorkspaces(kikiHome), storage: await loadConfig(kikiHome) } };
    },
    async read(raw) {
      const input = parseRead(raw);
      if (!input) return fail('BOARD_INPUT_INVALID', 'Invalid board request.');
      const config = input.action === 'preview' && input.configuration !== undefined ? input.configuration : await loadConfig(kikiHome);
      if (input.action === 'list') return page(input, config);
      if (input.action === 'preview') return access(input.workspaceId, 'read', config, true, (context) => previewBoardStorage(api, context, config));
      if (input.action === 'show') return access(input.workspaceId, 'read', config, false, async (context) => {
        const opened = await openBoardStorage(api, context, input.storage, 'read');
        if (!opened.ok) return opened;
        return project(context, opened.value, await api.peekTask({ root: opened.value.root, id: input.id }));
      });
      const entries = [];
      for (const workspaceId of new Set(input.workspaceIds)) entries.push({ workspaceId, result: await page({ action: 'list', workspaceId, status: input.status, limit: input.limit }, config) });
      return { ok: true, value: entries };
    },
    async write(raw) {
      const input = parseWrite(raw);
      if (!input) return fail('BOARD_INPUT_INVALID', 'Invalid board request.');
      const config = await loadConfig(kikiHome);
      return access(input.workspaceId, 'write', config, false, async (context) => {
        if (input.action === 'update') {
          const opened = await openBoardStorage(api, context, input.storage, 'write');
          if (!opened.ok) return opened;
          const prior = project(context, opened.value, await api.peekTask({ root: opened.value.root, id: input.id }));
          if (!prior.ok) return prior;
          return project(context, opened.value, await api.updateWorkItem({ root: opened.value.root, workspaceId: context.workspaceId, id: input.id, expectedRevision: input.expectedRevision, patch: input.patch }));
        }
        let preview;
        if (input.target) {
          if (!path.isAbsolute(input.target.root)) return fail('BOARD_STORAGE_INVALID', 'A creation target must be an absolute previewed location.');
          preview = { ok: true, value: { mode: 'fixed', workspaceId: context.workspaceId, root: input.target.root, tasksDirectory: path.join(input.target.root, 'tasks'), kind: input.target.kind, existing: input.target.storageId !== undefined, storageId: input.target.storageId, selectionOnly: true } };
        } else preview = await previewBoardStorage(api, context, config);
        if (!preview.ok) return preview;
        const prepared = await prepareBoardStorage(api, context, preview.value);
        if (!prepared.ok) return prepared;
        const record = await api.createTask({
          root: prepared.value.root, title: input.title, description: input.description, priority: input.priority,
          workItem: { workspaceId: context.workspaceId, requestKey: input.requestKey, category: input.category, sessionIds: input.sessionIds, executionIds: input.executionIds },
        });
        return project(context, prepared.value, record);
      });
    },
  };
}
