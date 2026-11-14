import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { exportPages, readLedger, writeLedger } from '../lib/ledger.mjs';
import { exportSnapshot, writeFully } from '../scripts/ledger.mjs';
import { definitions } from '../lib/definitions.mjs';
import { register } from '../entry.mjs';

const plugin = fileURLToPath(new URL('..', import.meta.url));
const scratch = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
await mkdir(scratch, { recursive: true });
const temp = await mkdtemp(path.join(scratch, 'controller-ledger-tests-'));
const workspace = path.join(temp, 'alpha'), other = path.join(temp, 'beta');
await mkdir(workspace); await mkdir(other);
const context = { workspaceRoot: workspace, approvedPaths: [], signal: new AbortController().signal };
const evidence = { kind: 'document', ref: 'evidence/example.md', label: 'Acceptance check' };
let key = 0;
const write = (operations, extra = {}, ctx = context) => writeLedger({ workspace: '.', requestKey: `fixture-${++key}`, actor: 'fixture-owner', basis: 'Explicit fixture observation', operations, ...extra }, ctx);
const create = (id, set = {}) => ({ action: 'create', id, set: { title: id, goal: `Deliver ${id}`, success: ['Explicit acceptance evidence exists'], ...set } });
const patch = (id, set, extra = {}) => ({ action: 'patch', id, set, ...extra });
const read = (view, extra = {}, ctx = context) => readLedger({ workspace: '.', view, ...extra }, ctx);
const page = (result) => { assert.equal(result.nextTextOffset, null); return result.item ?? result.items ?? result.revisions ?? JSON.parse(result.text); };
const get = async (id) => page(await read('get', { id }));
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('single-source manifest and registration definitions match exactly', async () => {
  const manifest = JSON.parse(await readFile(path.join(plugin, 'kimi.plugin.json')));
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  const registrations = [];
  register({ registerTool: (definition) => registrations.push(definition) });
  assert.deepEqual(registrations, definitions);
});

test('incremental work lifecycle, evidence, decisions, full history and idempotent requests', async () => {
  const operations = [create('choice', { kind: 'decision', state: 'awaiting_decision', options: ['A', 'B'] }), create('build', { owner: 'example-owner', nextAction: 'Implement after choice', dependsOn: ['choice'], refs: [{ kind: 'agent', ref: 'example-agent' }] })];
  const receipt = await write(operations, { requestKey: 'stable-import' });
  assert.equal(receipt.results.length, 2);
  const replay = await write(operations, { requestKey: 'stable-import' });
  assert.equal(replay.replayed, true);
  await rejects(write([create('different')], { requestKey: 'stable-import' }), 'request_key_reused');
  assert.deepEqual(page(await read('ready')), []);
  assert.equal(page(await read('pending-decisions'))[0].id, 'choice');
  assert.equal(page(await read('blocked')).some((r) => r.id === 'build'), true);
  await write([patch('build', { nextAction: 'Wait for explicit choice' })]);
  let item = await get('build');
  assert.equal(item.owner, 'example-owner'); assert.equal(item.goal, 'Deliver build'); assert.equal(item.refs[0].ref, 'example-agent');
  await write([patch('choice', { state: 'accepted', decision: 'A' })]);
  assert.ok((await get('choice')).informationGaps.includes('acceptanceEvidence'));
  await write([patch('choice', { state: 'accepted', decision: 'A', evidence: [evidence] })]);
  assert.equal(page(await read('ready'))[0].id, 'build');
  await write([patch('build', { state: 'delivered' })]);
  assert.equal(page(await read('brief')).some((r) => r.id === 'build'), true);
  assert.equal(page(await read('ready')).length, 0);
  assert.equal(page(await read('brief')).some((r) => r.id === 'choice'), false);
  assert.equal((await get('choice')).decision, 'A');
  const history = page(await read('history', { id: 'build' }));
  assert.equal(history.length, 3); assert.equal(history[0].changes.state.after, 'delivered'); assert.equal(history[0].actor, 'fixture-owner');
  assert.equal(page(await read('search', { query: 'choice', includeCompleted: true })).some((r) => r.id === 'choice'), true);
});

test('stale disjoint patches merge; same-field conflict is concrete; additive evidence preserved', async () => {
  const before = await get('build');
  await write([patch('build', { owner: 'new-owner' })]);
  await write([patch('build', { nextAction: 'Inspect delivery' }, { baseRevision: before.revision })]);
  assert.equal((await get('build')).owner, 'new-owner');
  await assert.rejects(write([patch('build', { owner: 'stale-owner' }, { baseRevision: before.revision })]), (error) => error.code === 'stale_conflict' && error.details.conflicts[0].current === 'new-owner');
  await Promise.all([write([patch('build', {}, { append: { evidence: [evidence] } })]), write([patch('build', {}, { append: { evidence: [{ kind: 'history', ref: 'example-history' }] } })])]);
  assert.equal((await get('build')).evidence.length, 2);
});

test('workspace isolation and host-admitted explicit roots', async () => {
  const ctx = { ...context, workspaceRoot: other };
  assert.equal((await read('brief', {}, ctx)).total, 0);
  await write([create('build')], {}, ctx);
  assert.equal(page(await read('get', { id: 'build' }, ctx)).owner, '');
  await rejects(readLedger({ workspace: other }, context), 'path_not_admitted');
  assert.equal((await readLedger({ workspace: other }, { ...context, approvedPaths: [other] })).total, 1);
});

test('batch errors and cancellation roll back everything, including dedupe keys', async () => {
  await rejects(write([create('rollback-a'), patch('missing', { title: 'Missing' })]), 'item_not_found');
  await rejects(read('get', { id: 'rollback-a' }), 'item_not_found');
  await write([create('missing-dep', { dependsOn: ['missing'] }), create('cycle-a', { dependsOn: ['cycle-b'] }), create('cycle-b', { dependsOn: ['cycle-a'] })]);
  assert.deepEqual((await get('missing-dep')).missingDependencies, ['missing']);
  assert.deepEqual((await get('cycle-a')).dependencyCycle, ['cycle-a', 'cycle-b', 'cycle-a']);
  assert.equal((await get('cycle-a')).ready, false);
  const controller = new AbortController();
  const pending = write([create('cancelled-write')], { requestKey: 'cancel-key' }, { ...context, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending);
  await rejects(read('get', { id: 'cancelled-write' }), 'item_not_found');
  await write([create('cancelled-write')], { requestKey: 'cancel-key' });
  const afterController = new AbortController();
  let checks = 0;
  const abortBeforeCommit = { throwIfAborted() {
    if (++checks === 5) afterController.abort();
    afterController.signal.throwIfAborted();
  } };
  await assert.rejects(write([create('precommit-cancel')], { requestKey: 'precommit-key' }, { ...context, signal: abortBeforeCommit }));
  assert.equal(checks, 5);
  await rejects(read('get', { id: 'precommit-cancel' }), 'item_not_found');
  await write([create('precommit-cancel')], { requestKey: 'precommit-key' });
});

test('pagination and chunks are complete, explicit, and reject mixed-generation recovery', async () => {
  await write([create('long', { goal: 'Example '.repeat(1400) })]);
  const overview = await read('overview', { limit: 1 });
  assert.ok(overview.cursor);
  const all = []; let result = overview;
  do { all.push(...page(result)); result = result.cursor ? await read('overview', { limit: 1, cursor: result.cursor }) : null; } while (result);
  assert.equal(all.length, overview.total);
  const first = await read('get', { id: 'long', maxChars: 1000 });
  assert.ok(first.nextTextOffset);
  let text = first.text, offset = first.nextTextOffset;
  while (offset !== null) { const r = await read('get', { id: 'long', textOffset: offset, maxChars: 1000, atGeneration: first.generation }); text += r.text; offset = r.nextTextOffset; }
  assert.equal(JSON.parse(text).goal, 'Example '.repeat(1400));
  const compact = page(await read('search', { query: 'long' }))[0]; assert.ok(compact.shortenedFields.includes('goal'));
  await write([patch('build', { nextAction: 'Unrelated change' }), patch('long', { nextAction: 'Read full goal' })]);
  const continuation = await read('get', { id: 'long', textOffset: 1000, atGeneration: first.generation });
  assert.equal(continuation.generation, first.generation);
  assert.ok(continuation.currentGeneration > first.generation);
  assert.equal((await read('overview', { limit: 1, cursor: overview.cursor })).total, overview.total);
  const historical = page(await read('get', { id: 'build', atGeneration: first.generation }));
  assert.equal(historical.nextAction, 'Inspect delivery');
  const jsonExport = await read('export', { maxChars: 24000 });
  assert.equal(jsonExport.totalChars > 24000 ? jsonExport.complete : true, jsonExport.totalChars <= 24000);
  assert.ok((await read('export', { format: 'markdown' })).text.startsWith('# Controller Ledger'));
});

test('concurrent process writes to different items do not lose values', async () => {
  await write([create('parallel-a'), create('parallel-b')]);
  const run = (id) => new Promise((resolve, reject) => {
    const source = `import {writeLedger} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'lib/ledger.mjs')).href)}; await writeLedger({workspace:'.',requestKey:${JSON.stringify(`process-${id}`)},actor:'process',basis:'Concurrent fixture',operations:[{action:'patch',id:${JSON.stringify(id)},set:{owner:${JSON.stringify(id)}}}]},{workspaceRoot:${JSON.stringify(workspace)},approvedPaths:[],signal:new AbortController().signal});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', (data) => { errors += data; }); child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  await Promise.all([run('parallel-a'), run('parallel-b')]);
  assert.equal((await get('parallel-a')).owner, 'parallel-a'); assert.equal((await get('parallel-b')).owner, 'parallel-b');
});

test('replacing a managed copy preserves workspace data and entry returns recoverable errors', async () => {
  const managed = path.join(temp, 'managed'); await cp(plugin, managed, { recursive: true });
  const executors = new Map(); const installed = await import(pathToFileURL(path.join(managed, 'entry.mjs')).href);
  installed.register({ registerTool: (definition, execute) => executors.set(definition.name, execute) });
  const successful = await executors.get('ledger_read')({ workspace: '.', view: 'get', id: 'build' }, context);
  assert.equal(successful.isError, undefined); assert.equal(JSON.parse(successful.output).item.owner, 'new-owner');
  const failure = await executors.get('ledger_read')({ workspace: '.', view: 'get', id: 'not-found' }, context);
  assert.equal(failure.isError, true); assert.equal(JSON.parse(failure.output).error, 'item_not_found');
  await rm(managed, { recursive: true }); await cp(plugin, managed, { recursive: true });
  assert.equal((await get('build')).owner, 'new-owner');
});

test('export pages cover empty, single, multi-page, and last-page snapshots', async () => {
  const dir = path.join(temp, 'export-shape');
  await mkdir(dir);
  const ctx = { workspaceRoot: dir, approvedPaths: [], signal: new AbortController().signal };
  const writeHere = (requestKey, operations) => writeLedger({ workspace: '.', requestKey, actor: 'fixture-owner', basis: 'Explicit fixture observation', operations }, ctx);
  const empty = await readLedger({ workspace: '.', view: 'export', format: 'json' }, ctx);
  assert.equal(empty.generation, 0);
  assert.equal(empty.complete, true);
  assert.equal(empty.nextTextOffset, null);
  assert.equal(typeof empty.text, 'string');
  assert.deepEqual(JSON.parse(empty.text).items, []);
  await writeHere('export-one', [create('solo', { goal: 'short' })]);
  const single = await readLedger({ workspace: '.', view: 'export', format: 'json', maxChars: 24000 }, ctx);
  assert.equal(single.nextTextOffset, null);
  assert.equal(single.complete, true);
  assert.equal(JSON.parse(single.text).items[0].id, 'solo');
  const goal = `${'阅'.repeat(4000)}😀`;
  await writeHere('export-wide', [create('wide', { goal })]);
  const pages = [];
  let offset = 0, generation, guard = 0;
  for (;;) {
    const page = await readLedger({ workspace: '.', view: 'export', format: 'json', maxChars: 1000, textOffset: offset, ...(generation === undefined ? {} : { atGeneration: generation }) }, ctx);
    assert.equal(typeof page.text, 'string');
    assert.equal(page.textOffset, offset);
    if (generation === undefined) generation = page.generation;
    assert.equal(page.generation, generation);
    pages.push(page);
    if (page.nextTextOffset === null) break;
    assert.equal(page.complete, false);
    assert.equal(Number.isSafeInteger(page.nextTextOffset) && page.nextTextOffset > offset, true);
    offset = page.nextTextOffset;
    assert.ok(++guard < 80);
  }
  const last = pages.at(-1);
  assert.ok(pages.length > 2);
  assert.equal(last.nextTextOffset, null);
  assert.equal(last.complete, false);
  assert.ok(last.textOffset > 0);
  assert.ok(last.text.length > 0 && last.text.length <= 1000);
  const joined = pages.map((page) => page.text).join('');
  assert.equal(joined.length, pages[0].totalChars);
  const directPages = [];
  for await (const text of exportPages(dir, 'json', ctx.signal, 1000)) {
    assert.ok(text.length <= 1000);
    directPages.push(text);
  }
  assert.equal(directPages.join(''), joined);
  const body = JSON.parse(joined);
  assert.equal(body.generation, generation);
  assert.equal(body.items.find((item) => item.id === 'wide').goal, goal);
  const markdown = [];
  let lastMarkdown;
  offset = 0; guard = 0;
  for (;;) {
    const page = await readLedger({ workspace: '.', view: 'export', format: 'markdown', maxChars: 1000, textOffset: offset, atGeneration: generation }, ctx);
    assert.equal(page.generation, generation);
    lastMarkdown = page;
    markdown.push(page.text);
    if (page.nextTextOffset === null) break;
    offset = page.nextTextOffset;
    assert.ok(++guard < 80);
  }
  const markdownText = markdown.join('');
  assert.equal(markdownText.startsWith('# Controller Ledger'), true);
  assert.equal(markdownText.includes(goal), true);
  assert.equal(lastMarkdown.nextTextOffset, null);
  assert.equal(lastMarkdown.complete, false);
  assert.ok(lastMarkdown.textOffset > 0);
  const cli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(plugin, 'scripts/ledger.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  const jsonOut = path.join(dir, 'ledger.json'), markdownOut = path.join(dir, 'ledger.md');
  const exported = await cli(['export', dir, 'json', jsonOut]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(await readFile(jsonOut, 'utf8'), joined);
  const existing = await cli(['export', dir, 'json', jsonOut]);
  assert.equal(existing.code, 1);
  assert.equal(await readFile(jsonOut, 'utf8'), joined);
  const printed = await cli(['export', dir, 'json']);
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(printed.stdout, joined);
  const markdownExport = await cli(['export', dir, 'markdown', markdownOut]);
  assert.equal(markdownExport.code, 0, markdownExport.stderr);
  assert.equal(await readFile(markdownOut, 'utf8'), markdownText);
  const fresh = path.join(temp, 'export-empty');
  await mkdir(fresh);
  const emptyOut = path.join(fresh, 'empty.json');
  const emptyExport = await cli(['export', fresh, 'json', emptyOut]);
  assert.equal(emptyExport.code, 0, emptyExport.stderr);
  const emptyText = await readFile(emptyOut, 'utf8');
  assert.deepEqual(JSON.parse(emptyText).items, []);
  assert.equal(JSON.parse(emptyText).generation, 0);
  assert.equal(emptyText, (await readLedger({ workspace: '.', view: 'export', format: 'json' }, { ...ctx, workspaceRoot: fresh })).text);
});

test('file export completes short writes and rejects no-progress output', async () => {
  const chunks = [];
  let calls = 0;
  const handle = {
    async write(bytes, offset, length, position) {
      assert.equal(position, offset);
      const amount = Math.min(3, length);
      chunks.push(Buffer.from(bytes.subarray(offset, offset + amount)));
      calls++;
      return { bytesWritten: amount };
    },
  };
  const expected = 'bounded export 阅😀';
  await writeFully(handle, expected);
  assert.equal(Buffer.concat(chunks).toString('utf8'), expected);
  assert.ok(calls > 1);
  await assert.rejects(writeFully({ write: async () => ({ bytesWritten: 0 }) }, 'x'), /no write progress/);
});

test('retained export pages release each snapshot', async () => {
  const dir = path.join(temp, 'export-retain');
  await mkdir(dir);
  const ctx = { workspaceRoot: dir, approvedPaths: [], signal: new AbortController().signal };
  await writeLedger({ workspace: '.', requestKey: 'export-retain', actor: 'fixture-owner', basis: 'Explicit fixture observation', operations: Array.from({ length: 40 }, (_, index) => create(`row${index}`, { goal: `${'阅'.repeat(8000)}😀` })) }, ctx);
  let checks = 0;
  const controller = new AbortController();
  const signal = { throwIfAborted() { if (++checks === 5) controller.abort(); controller.signal.throwIfAborted(); } };
  const partial = path.join(dir, 'partial.json');
  await assert.rejects(exportSnapshot(dir, 'json', signal, partial));
  assert.equal(checks, 5);
  await assert.rejects(readFile(partial, 'utf8'), (error) => error.code === 'ENOENT');
  const jsonOut = path.join(dir, 'ledger.json');
  const exported = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(plugin, 'scripts/ledger.mjs'), 'export', dir, 'json', jsonOut], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(exported.code, 0, exported.stderr);
  const snapshot = JSON.parse(await readFile(jsonOut, 'utf8'));
  assert.equal(snapshot.items.length, 40);
  assert.equal(snapshot.items[0].goal.endsWith('😀'), true);
  assert.equal(snapshot.history.length, 40);
  assert.equal(snapshot.generation, 40);
  const source = `import { readLedger } from ${JSON.stringify(pathToFileURL(path.join(plugin, 'lib/ledger.mjs')).href)};
const ctx = { workspaceRoot: ${JSON.stringify(dir)}, approvedPaths: [], signal: new AbortController().signal };
await readLedger({ workspace: '.', view: 'export', format: 'json', maxChars: 8000 }, ctx);
global.gc();
const before = process.memoryUsage().heapUsed;
const pages = [];
let offset = 0, generation;
for (let index = 0; index < 20; index++) {
  const page = await readLedger({ workspace: '.', view: 'export', format: 'json', maxChars: 8000, textOffset: offset, ...(generation === undefined ? {} : { atGeneration: generation }) }, ctx);
  generation ??= page.generation;
  pages.push(page.text);
  if (page.nextTextOffset === null) break;
  offset = page.nextTextOffset;
}
global.gc();
const delta = process.memoryUsage().heapUsed - before;
const kept = pages.join('').length;
if (!(pages.length >= 8 && delta < 8_000_000 && kept > 1000)) {
  console.error(JSON.stringify({ delta, pages: pages.length, kept }));
  process.exit(1);
}
console.log(JSON.stringify({ delta, pages: pages.length, kept }));`;
  const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=256', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr || stdout);
  const measured = JSON.parse(stdout);
  assert.ok(measured.delta < 8_000_000);
  assert.ok(measured.pages >= 8);
});

test.after(async () => { await rm(temp, { recursive: true }); });

test('quick capture, gradual contract, archive/reopen same ID, and history continuation across other work', async () => {
  await writeLedger({ workspace: '.', requestKey: 'quick-capture', operations: [{ action: 'create', id: 'quick', set: { title: 'Capture an idea' } }] }, context);
  assert.ok((await get('quick')).informationGaps.includes('goal'));
  await writeLedger({ workspace: '.', requestKey: 'quick-enrich', operations: [patch('quick', { goal: 'Evaluate captured idea', success: ['Make a decision'], owner: 'example-owner', nextAction: 'Read source' })] }, context);
  await writeLedger({ workspace: '.', requestKey: 'quick-archive', operations: [patch('quick', { state: 'archived' })] }, context);
  assert.equal(page(await read('brief')).some((item) => item.id === 'quick'), false);
  await writeLedger({ workspace: '.', requestKey: 'quick-reopen', operations: [patch('quick', { state: 'active' })] }, context);
  assert.equal((await get('quick')).goal, 'Evaluate captured idea');
  const history = await read('history', { id: 'quick', limit: 1 });
  await write([patch('build', { owner: 'other-update' })]);
  const next = await read('history', { id: 'quick', limit: 1, cursor: history.cursor });
  assert.equal(next.generation, history.generation);
  assert.equal(next.revisions[0].revision, 3);
});
