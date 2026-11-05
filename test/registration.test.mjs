import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateRegistration } from '../scripts/validate-registration.mjs';
import { resolveLocalPlugin } from '../scripts/local-plugin.mjs';

const im = {
  schemaVersion: 1, id: 'example-im', label: 'Example IM', inbound: true, outbound: true,
  listenerRealm: 'example-protocol', maxInboundBytes: 1024 * 1024, textLimit: 2000,
  supportsMentions: true, supportsReply: true, supportsEdit: true,
  mediaCapabilities: [{ kind: 'video', mimeTypes: ['video/mp4'], maxBytes: 1024 * 1024, rendering: 'video' }],
};
const adapter = { async start() {}, async stop() {}, async sendText() {}, async sendMedia() {}, async editText() {} };
const manifest = (definitions = [im]) => ({ name: 'example', 'x-kiki': { entry: './entry.mjs', imAdapters: definitions } });
const registerIm = (definition = im, implementation = adapter) => api => api.registerImAdapter(definition, implementation);

test('validates IM registration against the pinned public schema and complete manifest definition', async () => {
  await validateRegistration(manifest(), registerIm(structuredClone(im)));
  for (const changed of [
    { ...im, listenerRealm: 'another-protocol' },
    { ...im, supportsReply: false },
    { ...im, mediaCapabilities: [{ ...im.mediaCapabilities[0], maxBytes: 2048 }] },
  ]) {
    await assert.rejects(validateRegistration(manifest(), registerIm(changed)), /Registered imAdapters changed/);
  }
});

test('rejects invalid declared or registered IM schemas, including missing inbound listener realm', async () => {
  const { listenerRealm, ...missingRealm } = im;
  for (const invalid of [missingRealm, { ...im, inbound: false, outbound: false }, { ...im, privateField: true }]) {
    await assert.rejects(validateRegistration(manifest([invalid]), registerIm(invalid)));
    await assert.rejects(validateRegistration(manifest(), registerIm(invalid)));
  }
});

test('requires one registration for every declared IM adapter and rejects duplicates or undeclared ids', async () => {
  await assert.rejects(validateRegistration(manifest(), () => {}), /Missing registered imAdapters/);
  await assert.rejects(validateRegistration(manifest([im, im]), registerIm()), /Duplicate declared imAdapters/);
  await assert.rejects(validateRegistration(manifest(), api => { registerIm()(api); registerIm()(api); }), /Duplicate registered imAdapters/);
  await assert.rejects(validateRegistration(manifest(), registerIm({ ...im, id: 'undeclared' })), /Undeclared imAdapters/);
});

test('requires IM lifecycle and advertised outbound/media/edit handlers without starting a transport', async () => {
  for (const method of ['start', 'stop', 'sendText', 'sendMedia', 'editText']) {
    await assert.rejects(validateRegistration(manifest(), registerIm(im, { ...adapter, [method]: undefined })), new RegExp(`needs ${method}\\(\\)`));
  }
  const inboundOnly = { ...im, outbound: false, supportsEdit: false, mediaCapabilities: [] };
  await validateRegistration(manifest([inboundOnly]), registerIm(inboundOnly, { async start() {}, async stop() {} }));
});

test('requires readHistory only when the IM adapter advertises history support', async () => {
  const withHistory = { ...im, supportsHistory: true };
  const historyAdapter = { ...adapter, async readHistory() { return { status: 'unsupported' }; } };
  await validateRegistration(manifest([withHistory]), registerIm(withHistory, historyAdapter));
  await assert.rejects(validateRegistration(manifest([withHistory]), registerIm(withHistory)), /needs readHistory\(\)/);
  await assert.rejects(validateRegistration(manifest([withHistory]), registerIm({ ...withHistory, supportsHistory: false }, historyAdapter)), /Registered imAdapters changed/);
  await validateRegistration(manifest([{ ...im, supportsHistory: false }]), registerIm({ ...im, supportsHistory: false }));
});

test('checks tools and media providers field-for-field and requires their declared registrations', async () => {
  const tool = { schemaVersion: 1, name: 'example', description: 'Example', parameters: { type: 'object', additionalProperties: false } };
  const media = { schemaVersion: 1, id: 'example-media', label: 'Example Media', kinds: ['tts'], resumeVersion: 1 };
  const m = { name: 'example', 'x-kiki': { entry: './entry.mjs', tools: [tool], mediaProviders: [media] } };
  const provider = { async describe() {}, async submit() {} };
  await validateRegistration(m, api => { api.registerTool(tool, async () => {}); api.registerMediaProvider(media, provider); });
  await assert.rejects(validateRegistration(m, api => api.registerTool({ ...tool, description: 'Changed' }, async () => {})), /Registered tools changed/);
  await assert.rejects(validateRegistration(m, api => { api.registerTool(tool, async () => {}); api.registerMediaProvider({ ...media, kinds: ['image'] }, provider); }), /Registered mediaProviders changed/);
  await assert.rejects(validateRegistration(m, api => api.registerTool(tool, async () => {})), /Missing registered mediaProviders/);
});

test('requires entry for executable contributions and validates the dependency map contract', async () => {
  await assert.rejects(validateRegistration({ 'x-kiki': { imAdapters: [im] } }), /imAdapters requires x-kiki.entry/);
  await assert.rejects(validateRegistration(manifest(null), registerIm()), /imAdapters must be an array/);
  await validateRegistration({ 'x-kiki': { dependencies: { 'kiki-media': '^0.2.1' } } });
  for (const dependencies of [[], null, { 'invalid id': '^0.2.1' }, { 'kiki-media': 'next' }, { 'kiki-media': 1 }]) {
    await assert.rejects(validateRegistration({ 'x-kiki': { dependencies } }));
  }
});

test('unknown or invalid package selection fails explicitly before any Host runner download', () => {
  for (const [id, message] of [
    ['unknown-fixture-package', /No local package selected: unknown-fixture-package/],
    ['../outside', /Invalid local plugin id/],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/check.mjs', id], {
      encoding: 'utf8', env: { ...process.env, KIKI_HOST_RUNNER: '' }, timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test('CI catalog-only selection validates metadata without reading or downloading a runner', async () => {
  const catalog = JSON.parse(await readFile('plugins/marketplace.json', 'utf8'));
  const result = spawnSync(process.execPath, ['scripts/check.mjs', 'catalog'], {
    encoding: 'utf8', env: { ...process.env, KIKI_HOST_RUNNER: '.tmp/nonexistent-catalog-fixture-runner.mjs' }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Validated catalog: ${catalog.plugins.length} entries`);
});

test('validates harness account sources and their complete lifecycle without acquiring credentials', async () => {
  const source = { schemaVersion: 1, id: 'example-oauth', label: 'Example OAuth', engineIds: ['agy-cli', 'codex-app-server'] };
  const m = { name: 'example', 'x-kiki': { entry: './entry.mjs', harnessAccountSources: [source] } };
  const implementation = { async list() { throw new Error('must not execute'); }, async prepare() { throw new Error('must not execute'); }, async release() { throw new Error('must not execute'); } };
  await validateRegistration(m, api => api.registerHarnessAccountSource(source, implementation));
  await assert.rejects(validateRegistration(m, () => {}), /Missing registered harnessAccountSources/);
  await assert.rejects(validateRegistration(m, api => api.registerHarnessAccountSource({ ...source, label: 'Changed' }, implementation)), /Registered harnessAccountSources changed/);
  await assert.rejects(validateRegistration(m, api => {
    api.registerHarnessAccountSource(source, implementation);
    api.registerHarnessAccountSource(source, implementation);
  }), /Duplicate registered harnessAccountSources/);
  await assert.rejects(validateRegistration({ 'x-kiki': { harnessAccountSources: [source] } }), /harnessAccountSources requires x-kiki.entry/);
  for (const method of ['list', 'prepare', 'release']) {
    await assert.rejects(validateRegistration(m, api => api.registerHarnessAccountSource(source, { ...implementation, [method]: undefined })), new RegExp(`needs ${method}\\(\\)`));
  }
  await assert.rejects(validateRegistration({ ...m, 'x-kiki': { ...m['x-kiki'], harnessAccountSources: [{ ...source, engineIds: [] }] } }, () => {}));
});

test('resolves non-catalog local packages without classifying them as official', async () => {
  await mkdir('.tmp', { recursive: true });
  const dir = await mkdtemp(resolve('.tmp/local-plugin-'));
  try {
    const id = 'example-oauth';
    const root = join(dir, id);
    await mkdir(root);
    await writeFile(join(root, 'kimi.plugin.json'), JSON.stringify({ name: id, version: '0.1.0' }));
    assert.equal((await resolveLocalPlugin(id, dir)).source, `./${id}`);
    await assert.rejects(resolveLocalPlugin('../outside', dir), /Invalid local plugin id/);
    await assert.rejects(resolveLocalPlugin('missing', dir), /No local package selected/);
    await mkdir(join(dir, 'official', id), { recursive: true });
    await writeFile(join(dir, 'official', id, 'kimi.plugin.json'), JSON.stringify({ name: id }));
    await assert.rejects(resolveLocalPlugin(id, dir), /Ambiguous local package/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
