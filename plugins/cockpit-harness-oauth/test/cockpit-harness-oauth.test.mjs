import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NdjsonBackend } from '../lib/backend.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { cockpitHarnessService, harnessAccountSourceDefinition, register } from '../entry.mjs';
import { CockpitHarnessService } from '../lib/service.mjs';

const fixture = fileURLToPath(new URL('./fixture-backend.mjs', import.meta.url));
const sourceDefinition = manifest['x-kiki'].harnessAccountSources[0];

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for synthetic backend state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function harness({ failRelease } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-harness-oauth-'));
  const stateFile = path.join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify({ requests: [], releases: [], eof: false }));
  let spawnCount = 0;
  let spawnArgs;
  const spawnFixture = (_backendPath, args, options) => {
    spawnCount++;
    spawnArgs = [...args];
    return spawn(process.execPath, [fixture, ...args], {
      ...options,
      env: {
        ...process.env,
        COCKPIT_HARNESS_FIXTURE_STATE: stateFile,
        ...(failRelease ? { COCKPIT_HARNESS_FIXTURE_FAIL_RELEASE: failRelease } : {}),
      },
    });
  };
  const service = new CockpitHarnessService({ spawnFn: spawnFixture });
  const settings = {
    backendPath: path.join(root, 'cockpit-harness-oauth.exe'),
    sidecarPath: path.join(root, 'cockpit-sidecar.exe'),
    dataDir: path.join(root, 'data'),
  };
  const context = { settings, kikiHome: root, signal: new AbortController().signal };
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  return { root, service, context, state, get spawnCount() { return spawnCount; }, get spawnArgs() { return spawnArgs; } };
}

test('manifest and registration use the fixed harness account-source definition without starting a backend', () => {
  assert.deepEqual(sourceDefinition, harnessAccountSourceDefinition);
  assert.deepEqual(sourceDefinition, {
    schemaVersion: 1,
    id: 'cockpit-oauth',
    label: 'Cockpit OAuth',
    engineIds: ['agy-cli', 'codex-app-server'],
  });
  const calls = [];
  register({ registerHarnessAccountSource: (definition, adapter) => calls.push({ definition, adapter }) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].definition, sourceDefinition);
  assert.deepEqual(Object.keys(calls[0].adapter).sort(), ['list', 'prepare', 'release']);
  assert.equal(cockpitHarnessService.backend, undefined);
});

test('AGY and Codex list, prepare and release use one lazy NDJSON backend and never persist connection credentials', async () => {
  const h = await harness();
  try {
    assert.equal(h.spawnCount, 0);
    const agy = await h.service.adapter.list({ engineId: 'agy-cli' }, h.context);
    const codex = await h.service.adapter.list({ engineId: 'codex-app-server' }, h.context);
    assert.equal(h.spawnCount, 1);
    assert.deepEqual(h.spawnArgs, ['--sidecar', h.context.settings.sidecarPath, '--data-dir', h.context.settings.dataDir]);
    assert.equal(h.spawnArgs.some((value) => /fixture-secret|apiKey/i.test(value)), false);
    assert.deepEqual(agy, [{ id: 'agy-cli-account', label: 'agy-cli fixture', status: 'ready' }]);
    assert.deepEqual(codex, [{ id: 'codex-app-server-account', label: 'codex-app-server fixture', status: 'ready' }]);

    const agyLease = await h.service.adapter.prepare({
      engineId: 'agy-cli', accountId: 'agy-cli-account', instanceId: 'instance-agy', proxy: { mode: 'system' },
    }, h.context);
    const codexLease = await h.service.adapter.prepare({
      engineId: 'codex-app-server', accountId: 'codex-app-server-account', instanceId: 'instance-codex', proxy: { mode: 'direct' },
    }, h.context);
    assert.match(agyLease.connection.apiKey, /^fixture-secret-/);
    assert.match(codexLease.connection.apiKey, /^fixture-secret-/);
    assert.equal(h.service.activeLeases.size, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(h.service, 'connection'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(h.service, 'connections'), false);

    const changedContext = { ...h.context, settings: { ...h.context.settings, dataDir: path.join(h.root, 'other-data') } };
    await assert.rejects(
      h.service.adapter.list({ engineId: 'agy-cli' }, changedContext),
      /settings changed while leases are active/,
    );
    assert.equal(h.spawnCount, 1);
    await h.service.adapter.release({ leaseId: agyLease.leaseId }, changedContext);
    await h.service.adapter.release({ leaseId: codexLease.leaseId }, h.context);
    assert.equal(h.service.activeLeases.size, 0);
    const state = await h.state();
    assert.deepEqual(state.releases.sort(), [agyLease.leaseId, codexLease.leaseId].sort());
    assert.deepEqual(state.requests.map((request) => request.method), ['list', 'list', 'prepare', 'prepare', 'release', 'release']);
  } finally {
    await h.service.deactivate();
  }
});

test('proxy mode payloads match the backend enum and unknown release is idempotent without spawning', async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.service.adapter.release({ leaseId: 'expired-lease' }, h.context), {});
    assert.equal(h.spawnCount, 0);
    await h.service.adapter.prepare({
      engineId: 'agy-cli', accountId: 'agy-cli-account', instanceId: 'proxy-system',
      proxy: { mode: 'system', url: 'https://ignored.example' },
    }, h.context);
    await h.service.adapter.prepare({
      engineId: 'codex-app-server', accountId: 'codex-app-server-account', instanceId: 'proxy-direct',
      proxy: { mode: 'direct', url: 'https://ignored.example' },
    }, h.context);
    await h.service.adapter.prepare({
      engineId: 'agy-cli', accountId: 'agy-cli-account', instanceId: 'proxy-custom',
      proxy: { mode: 'custom', url: 'http://user:password@127.0.0.1:9' },
    }, h.context);
    const state = await h.state();
    const proxies = state.requests.filter((request) => request.method === 'prepare').map((request) => request.params.proxy);
    assert.deepEqual(proxies, [
      { mode: 'system' },
      { mode: 'direct' },
      { mode: 'custom', url: 'http://user:password@127.0.0.1:9' },
    ]);
  } finally {
    await h.service.deactivate();
  }
});

test('aborted prepare releases only its eventual lease and leaves unrelated leases alive', async () => {
  const h = await harness();
  try {
    const existing = await h.service.adapter.prepare({
      engineId: 'agy-cli', accountId: 'agy-cli-account', instanceId: 'existing', proxy: { mode: 'system' },
    }, h.context);
    const controller = new AbortController();
    const pending = h.service.adapter.prepare({
      engineId: 'codex-app-server', accountId: 'codex-app-server-account', instanceId: 'slow', proxy: { mode: 'custom', url: 'http://127.0.0.1:9' },
    }, { ...h.context, signal: controller.signal });
    await waitFor(() => h.service.pendingPrepares === 1);
    controller.abort();
    await assert.rejects(pending, /cancelled/i);
    assert.equal(h.service.activeLeases.has(existing.leaseId), true);
    await waitFor(async () => (await h.state()).releases.length === 1);
    const state = await h.state();
    assert.equal(state.releases[0], 'lease-codex-app-server-slow');
    assert.equal(h.service.activeLeases.has(existing.leaseId), true);
    assert.equal(h.service.activeLeases.has(state.releases[0]), false);
    await h.service.adapter.release({ leaseId: existing.leaseId }, h.context);
  } finally {
    await h.service.deactivate();
  }
});

test('failed eventual release records one concrete cleanup failure without retrying', async () => {
  const leaseId = 'lease-codex-app-server-slow';
  const h = await harness({ failRelease: leaseId });
  try {
    const controller = new AbortController();
    const pending = h.service.adapter.prepare({
      engineId: 'codex-app-server', accountId: 'codex-app-server-account', instanceId: 'slow', proxy: { mode: 'system' },
    }, { ...h.context, signal: controller.signal });
    await waitFor(() => h.service.pendingPrepares === 1);
    controller.abort();
    await assert.rejects(pending, /cancelled/i);
    await waitFor(async () => {
      const state = await h.state();
      return h.service.pendingCleanups === 0 && state.requests.filter((request) => request.method === 'release').length === 1;
    });
    assert.deepEqual(h.service.cleanupFailures.get(leaseId), { phase: 'eventual-release', message: 'fixture release failed once' });
    assert.equal(h.service.activeLeases.has(leaseId), true);
  } finally {
    await h.service.deactivate();
  }
});

test('backend exit clears stale leases, makes release idempotent, and allows a later prepare to reopen it', async () => {
  const h = await harness();
  try {
    const lease = await h.service.adapter.prepare({
      engineId: 'agy-cli', accountId: 'agy-cli-account', instanceId: 'crash', proxy: { mode: 'system' },
    }, h.context);
    const oldBackend = h.service.backend;
    oldBackend.child.kill();
    await waitFor(() => h.service.backend === undefined && h.service.activeLeases.size === 0);
    assert.deepEqual(await h.service.adapter.release({ leaseId: lease.leaseId }, h.context), {});
    assert.equal(h.spawnCount, 1);
    await h.service.adapter.list({ engineId: 'codex-app-server' }, h.context);
    assert.equal(h.spawnCount, 2);
  } finally {
    await h.service.deactivate();
  }
});

test('panel configuration is metadata-only and refresh lists both engines without model or connection fields', async () => {
  const h = await harness();
  try {
    const configuration = await h.service.panel('configuration', {}, h.context);
    assert.equal(h.spawnCount, 0);
    assert.deepEqual(configuration.configuration, h.context.settings);
    const refreshed = await h.service.panel('refresh', {}, h.context);
    assert.equal(h.spawnCount, 1);
    assert.deepEqual(refreshed.accounts.map((account) => account.engineId), ['agy-cli', 'codex-app-server']);
    assert.equal(JSON.stringify(refreshed).includes('fixture-secret-'), false);
    assert.equal(JSON.stringify(refreshed).includes('modelIds'), false);
    assert.equal(JSON.stringify(refreshed).includes('connection'), false);
  } finally {
    await h.service.deactivate();
  }
});

test('deactivation closes stdin and backend EOF clears leases', async () => {
  const h = await harness();
  try {
    const lease = await h.service.adapter.prepare({
      engineId: 'agy-cli', accountId: 'agy-cli-account', instanceId: 'eof', proxy: { mode: 'system' },
    }, h.context);
    assert.equal(h.service.activeLeases.has(lease.leaseId), true);
    await h.service.parentEof();
    await waitFor(async () => (await h.state()).eof === true);
    const state = await h.state();
    assert.equal(state.leaseCountAtEof, 0);
    assert.equal(h.service.activeLeases.size, 0);
    await assert.rejects(h.service.adapter.list({ engineId: 'agy-cli' }, h.context), /deactivated/);
  } finally {
    await h.service.deactivate();
  }
});


test('NDJSON preserves account labels when a UTF-8 character crosses pipe chunks', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  const backend = new NdjsonBackend({ spawnFn: () => child });
  await backend.start({ backendPath: '/fixture/backend', sidecarPath: '/fixture/sidecar' });
  const result = backend.request('list', { engineId: 'agy-cli' });
  const response = Buffer.from(JSON.stringify({ id: '1', result: [{ id: 'A', label: '工作账号', status: 'ready' }] }) + '\n');
  const split = response.indexOf(Buffer.from('工作')) + 1;
  child.stdout.write(response.subarray(0, split));
  child.stdout.write(response.subarray(split));
  assert.deepEqual(await result, [{ id: 'A', label: '工作账号', status: 'ready' }]);
  child.exitCode = 0;
  child.emit('exit', 0, null);
});
