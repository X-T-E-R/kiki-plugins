// Opt-in Windows check: node scripts/verify-concurrency.mjs <admitted-test-directory>
// Use a small source/fixture directory with .mjs and .md files. Prints counts, never paths.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EsRunner, baseArgs, resolveEsPath } from '../lib/es.mjs';
import { createSearch, searchArgs, validateArgs } from '../lib/search.mjs';
import { admitRoot } from '../lib/paths.mjs';

try {
  assert.equal(process.platform, 'win32');
  assert.ok(process.argv[2], 'Pass a small admitted test directory');
  const workspaceRoot = path.resolve(process.argv[2]);
  const root = await admitRoot('.', { workspaceRoot });
  const executable = await resolveEsPath();
  const controller = new AbortController();
  let cancelChild, cancelNext = false, active = 0, peak = 0;
  const intervals = [];
  const executor = new EsRunner({ spawnProcess(file, args, options) {
    const child = spawn(file, args, options);
    const interval = { start: performance.now(), query: args.includes('-path') };
    intervals.push(interval); peak = Math.max(peak, ++active);
    if (cancelNext && args.includes('ext:md') && args.includes('-p')) {
      cancelChild = child;
      cancelNext = false;
      setTimeout(() => controller.abort(), 30);
    }
    child.once('close', () => { active--; interval.end = performance.now(); });
    return child;
  } });
  const context = { workspaceRoot, settings: { esPath: executable } };
  const search = createSearch({ executor });
  const inputs = [
    { root: '.', query: 'ext:mjs', sort: 'name', limit: 3 },
    { root: '.', query: 'ext:mjs', sort: 'name', limit: 3, offset: 2 },
    { root: '.', query: 'ext:md', sort: 'name', limit: 3 },
    { root: '.', query: 'name:kiki_concurrency_probe_no_match', sort: 'name', limit: 3 },
  ];
  const checked = async input => {
    const response = await search(input, context);
    assert.ok(!response.isError, 'Search returned an error');
    return JSON.parse(response.output);
  };
  const single = [];
  for (const input of inputs) single.push(await checked(input));
  assert.ok(single.slice(0, 3).every(result => result.returned > 0), 'Test directory needs indexed .mjs and .md files');
  assert.equal(single[3].returned, 0);
  let equivalent = 0, minimumOverlap = Infinity;
  for (let round = 0; round < 3; round++) {
    const start = intervals.length;
    const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => checked(inputs[i % 4])));
    for (const [i, result] of batch.entries()) { assert.deepEqual(result, single[i % 4]); equivalent++; }
    // Measure indexed queries, excluding version probes and parent-promise lifetimes.
    const first = intervals.slice(start).filter(interval => interval.query).slice(0, 4);
    const overlap = Math.min(...first.map(x => x.end)) - Math.max(...first.map(x => x.start));
    assert.ok(overlap > 0, 'ES child lifetimes must overlap');
    minimumOverlap = Math.min(minimumOverlap, overlap);
  }
  const args = searchArgs(validateArgs(inputs[0]), root, {});
  const missing = [...baseArgs({ instance: 'kiki_concurrency_probe_missing' }), '-timeout', '150', ...args.slice(1)];
  cancelNext = true;
  await Promise.all([
    search({ ...inputs[2], match_path: true }, { ...context, signal: controller.signal }).then(response => {
      assert.equal(response.isError, true);
      assert.equal(JSON.parse(response.output).code, 'CANCELLED');
      assert.equal(cancelChild?.killed, true);
    }),
    assert.rejects(executor.run(executable, missing), error => error.code === 'ES_FAILED' && error.message.includes('exit 8')),
    assert.rejects(executor.run(executable, missing, { timeoutMs: 30 }), { code: 'ES_TIMEOUT' }),
    ...inputs.map(async (input, i) => { assert.deepEqual(await checked(input), single[i]); equivalent++; }),
  ]);
  assert.deepEqual(await checked(inputs[0]), single[0]);
  assert.equal(active, 0); assert.equal(peak, 4);
  console.log(JSON.stringify({ versions: single[0].versions, singleReturned: single.map(x => x.returned), equivalentParallelOutputs: equivalent,
    peakEsProcesses: peak, minimumFourQueryProcessOverlapMs: Math.round(minimumOverlap * 10) / 10,
    missingInstanceIsolated: true, cancellationIsolated: true, timeoutIsolated: true, recovery: true }, null, 2));
} catch {
  // Assertion details can contain result paths. Keep local/CI logs free of unfiltered filenames.
  console.error('Everything concurrency verification failed; use a small indexed test directory and run the fixture tests for diagnostics.');
  process.exitCode = 1;
}
