import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStorageConfig } from '../lib/config.mjs';
import { createBoard } from '../lib/board.mjs';
import { encodeWorkDirKey, workspaceRootKey } from '../lib/paths.mjs';

async function tree(root) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push([path.relative(root, full).replaceAll('\\', '/'), createHash('sha256').update(await readFile(full)).digest('hex')]);
    }
  }
  await walk(root);
  return out.sort(([a], [b]) => a.localeCompare(b));
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiki-task-board-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  const id = encodeWorkDirKey(workspace);
  await writeFile(path.join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { [id]: { root: workspace, name: 'Fixture' } } }));
  return { home, workspace, id, board: createBoard({ kikiHome: home }) };
}

test('reads nested and inline taskBoard storage without inventing a fixed path', () => {
  assert.deepEqual(readStorageConfig('[taskBoard.storage]\nmode = "fixed"\npath = "cards"\n'), { mode: 'fixed', path: 'cards' });
  assert.deepEqual(readStorageConfig('[taskBoard]\nstorage = { mode = "global" }\n'), { mode: 'global' });
  assert.deepEqual(readStorageConfig(''), { mode: 'auto' });
  assert.deepEqual(readStorageConfig('[taskBoard.storage]\nmode = "fixed"\n'), { mode: 'auto' });
});

test('creates, rereads, and updates a card without rewriting bytes on read', async () => {
  const { board, id, workspace } = await fixture();
  const created = await board.write({ action: 'create', workspaceId: id, requestKey: 'card-one', title: 'Ship the board', description: 'Keep the address', priority: 'P1' });
  assert.equal(created.ok, true);
  assert.equal(created.value.status, 'active');
  assert.equal(created.value.storage.kind, 'embedded');
  const again = await board.write({ action: 'create', workspaceId: id, requestKey: 'card-one', title: 'Ship the board', description: 'Keep the address', priority: 'P1' });
  assert.equal(again.ok, true);
  assert.equal(again.value.id, created.value.id);
  const conflict = await board.write({ action: 'create', workspaceId: id, requestKey: 'card-one', title: 'Different title', description: 'Keep the address', priority: 'P1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'TASK_CONFLICT');
  const before = await tree(created.value.storage.root);
  const listed = await board.read({ action: 'list', workspaceId: id });
  const shown = await board.read({ action: 'show', workspaceId: id, storage: created.value.storage, id: created.value.id });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.cards.length, 1);
  assert.equal(shown.value.title, 'Ship the board');
  assert.deepEqual(await tree(created.value.storage.root), before);
  const updated = await board.write({ action: 'update', workspaceId: id, storage: created.value.storage, id: created.value.id, expectedRevision: created.value.revision, patch: { status: 'done', description: 'Done once' } });
  assert.equal(updated.value.status, 'done');
  assert.notEqual(updated.value.completedAt, null);
  const stale = await board.write({ action: 'update', workspaceId: id, storage: created.value.storage, id: created.value.id, expectedRevision: created.value.revision, patch: { title: 'Stale' } });
  assert.equal(stale.ok, false);
  const reopened = await board.write({ action: 'update', workspaceId: id, storage: updated.value.storage, id: updated.value.id, expectedRevision: updated.value.revision, patch: { status: 'active' } });
  assert.equal(reopened.value.status, 'active');
  assert.equal(reopened.value.completedAt, null);
  const ledger = JSON.parse(await readFile(path.join(path.dirname(workspace), 'home', 'task-board-authorizations', id), 'utf8'));
  assert.equal(ledger.length, 2);
  assert.equal(ledger.some((entry) => entry.root === workspaceRootKey(created.value.storage.root)), true);
  assert.equal(new Set(ledger.map((entry) => entry.workspaceRoot)).size, 1);
});

test('keeps an existing card file byte-for-byte when the read uses its original address', async () => {
  const { board, id, workspace, home } = await fixture();
  const created = await board.write({ action: 'create', workspaceId: id, requestKey: 'legacy', title: 'Already there', priority: 'P2' });
  assert.equal(created.ok, true);
  const store = created.value.storage.root;
  const snapshot = await tree(store);
  const read = await board.read({ action: 'show', workspaceId: id, storage: created.value.storage, id: created.value.id });
  assert.equal(read.ok, true);
  assert.deepEqual(await tree(store), snapshot);
  const foreign = path.join(workspace, 'not-the-store');
  await mkdir(foreign);
  const denied = await board.read({ action: 'show', workspaceId: id, storage: { ...created.value.storage, root: foreign }, id: created.value.id });
  assert.equal(denied.error.code, 'BOARD_ACCESS_DENIED');
  const saved = JSON.parse(await readFile(path.join(home, 'workspaces.json'), 'utf8'));
  assert.equal(saved.workspaces[id].root, workspace);
});

test('panel request saves a card and rejects an unknown action', async () => {
  const { home, id } = await fixture();
  const plugin = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'entry.mjs')).href);
  const saved = await plugin.handlePanelRequest('write', { action: 'create', workspaceId: id, requestKey: 'from-panel', title: 'Panel card', priority: 'P1' }, { kikiHome: home, settings: {} });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.title, 'Panel card');
  const listed = await plugin.handlePanelRequest('read', { action: 'list', workspaceId: id }, { kikiHome: home, settings: {} });
  assert.equal(listed.value.cards.some((card) => card.id === saved.value.id), true);
  const missing = await plugin.handlePanelRequest('nope', {}, { kikiHome: home, settings: {} });
  assert.equal(missing.error.code, 'BOARD_INPUT_INVALID');
  const noHome = await plugin.handlePanelRequest('workspaces', {}, { settings: {} });
  assert.equal(noHome.error.code, 'BOARD_UNAVAILABLE');
});
