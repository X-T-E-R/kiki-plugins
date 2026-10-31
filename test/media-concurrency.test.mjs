import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { register } from '../plugins/official/kiki-media/entry.mjs';
import { createProviderLimiter } from '../plugins/official/kiki-media/lib/provider-concurrency.mjs';

const context = (settings = {}, signal = new AbortController().signal) => ({ settings, signal });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('declares parallel tools without changing their permission accesses and wraps every provider', async () => {
  const providers = [];
  const tools = [];
  await register({ registerMediaProvider: (definition, adapter) => providers.push({ definition, adapter }), registerTool: (definition) => tools.push(definition) });
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.equal(tool.concurrencySafe, true);
    assert.deepEqual(tool.accesses, [{ kind: 'all' }]);
  }
  const manifest = JSON.parse(await readFile(new URL('../plugins/official/kiki-media/kimi.plugin.json', import.meta.url), 'utf8'));
  assert.equal(providers.length, manifest['x-kiki'].mediaProviders.length);
  for (const source of manifest['x-kiki'].mediaSources) assert.equal(manifest['x-kiki'].settings.schema.properties[source.settingsPrefix + 'maxConcurrentRequests'].default, 8);
});

test('queues same-provider requests at eight by default while independent providers start', async () => {
  const wrap = createProviderLimiter();
  const release = deferred();
  let active = 0;
  let peak = 0;
  let started = 0;
  const a = wrap({ submit: async () => { started++; peak = Math.max(peak, ++active); await release.promise; active--; return { state: 'complete' }; } }, 'a');
  const pending = Array.from({ length: 10 }, () => a.submit({}, context()));
  await nextTurn();
  assert.equal(started, 8);
  const b = wrap({ submit: async () => 'independent' }, 'b');
  assert.equal(await b.submit({}, context()), 'independent');
  release.resolve();
  await Promise.all(pending);
  assert.equal(started, 10);
  assert.equal(peak, 8);
});

test('cancels queued requests before provider entry and releases failed requests', async () => {
  const wrap = createProviderLimiter();
  const release = deferred();
  let started = 0;
  const adapter = wrap({ submit: async () => { started++; if (started === 1) { await release.promise; throw new Error('fixture failure'); } return 'done'; } }, 'a');
  const first = adapter.submit({}, context({ maxConcurrentRequests: 1 }));
  const failed = assert.rejects(first, /fixture failure/);
  const controller = new AbortController();
  const queued = adapter.submit({}, context({ maxConcurrentRequests: 1 }, controller.signal));
  const cancelled = assert.rejects(queued, /cancelled in queue/);
  await nextTurn();
  controller.abort(new Error('cancelled in queue'));
  await cancelled;
  assert.equal(started, 1);
  release.resolve();
  await failed;
  assert.equal(await adapter.submit({}, context({ maxConcurrentRequests: 1 })), 'done');
  assert.equal(started, 2);
});

test('shares submit and poll capacity, but cancellation and discovery bypass it', async () => {
  const wrap = createProviderLimiter();
  const release = deferred();
  let polled = false;
  const adapter = wrap({ submit: async () => { await release.promise; return 'submitted'; }, poll: async () => { polled = true; return 'polled'; }, cancel: async () => 'cancelled', describe: async () => 'models' }, 'a');
  const first = adapter.submit({}, context({ maxConcurrentRequests: 1 }));
  const poll = adapter.poll({}, context({ maxConcurrentRequests: 1 }));
  await nextTurn();
  assert.equal(polled, false);
  assert.equal(await adapter.cancel({}, context()), 'cancelled');
  assert.equal(await adapter.describe({}, context()), 'models');
  release.resolve();
  assert.deepEqual(await Promise.all([first, poll]), ['submitted', 'polled']);
});

test('uses a separate configurable queue for each custom script source', async () => {
  const wrap = createProviderLimiter();
  const release = deferred();
  const starts = [];
  const adapter = wrap({ submit: async (_input, ctx) => { starts.push(ctx.settings.scriptSource.id); await release.promise; } }, 'custom-script');
  const settings = (id) => ({ scriptSource: { id }, environment: JSON.stringify({ KIKI_MEDIA_MAX_CONCURRENT_REQUESTS: '1' }) });
  const pending = [adapter.submit({}, context(settings('a'))), adapter.submit({}, context(settings('a'))), adapter.submit({}, context(settings('b')))];
  await nextTurn();
  assert.deepEqual(starts, ['a', 'b']);
  release.resolve();
  await Promise.all(pending);
  assert.deepEqual(starts, ['a', 'b', 'a']);
});

for (const limit of [1, 8]) test(`ten 60-second fixture generations with provider capacity ${limit}`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const wrap = createProviderLimiter();
  let started = 0;
  const adapter = wrap({ submit: async () => { started++; await new Promise((resolve) => setTimeout(resolve, 60_000)); return 'generated'; } }, 'fixture');
  const pending = Promise.all(Array.from({ length: 10 }, () => adapter.submit({}, context({ maxConcurrentRequests: limit }))));
  await nextTurn();
  assert.equal(started, limit);
  let elapsed = 0;
  for (let remaining = 10; remaining > 0; remaining -= limit) { t.mock.timers.tick(60_000); elapsed += 60_000; await nextTurn(); }
  assert.equal((await pending).length, 10);
  assert.equal(elapsed, limit === 1 ? 600_000 : 120_000);
  console.info(JSON.stringify({ fixture: '10x60s-provider', limit, elapsed_ms: elapsed, fixed_overhead_ms: 0 }));
});
