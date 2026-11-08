import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EsRunner, splitQueryTerms, notASwitch, commandArg, decodeOutput, resolveEsPath, createEsProbe } from '../lib/es.mjs';
import { excluded, admitRoot, enrichCandidate } from '../lib/paths.mjs';
import { createSearch, searchArgs, validateArgs } from '../lib/search.mjs';
import { definition } from '../lib/definitions.mjs';
import { register } from '../entry.mjs';

const scratch = path.resolve('.tmp/everything-tests');
await mkdir(scratch, { recursive: true });
const temp = () => mkdtemp(path.join(scratch, 'run-'));
const noExternal = () => { throw new Error('Unexpected real external call in fixture'); };
globalThis.fetch = noExternal;
function fixtureRunner({ executable: expectedExecutable = 'fixture-es', ...extra } = {}) {
  const children = [];
  const executor = new EsRunner({
    spawnProcess(executable, args, options) {
      assert.equal(executable, expectedExecutable);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.args = args; child.killed = false;
      child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
      child.finish = (code = 0, stdout = '', stderr = '') => { child.stdout.end(stdout); child.stderr.end(stderr); child.emit('close', code); };
      children.push(child); return child;
    }, ...extra,
  });
  return { executor, children };
}
const ready = async (fixture, index = 0) => {
  while (fixture.children.length <= index) await new Promise(resolve => setImmediate(resolve));
  return fixture.children[index];
};
function esArgv(line) {
  const args = []; let i = 0;
  while (i < line.length) {
    while (i < line.length && ' \t\r\n'.includes(line[i])) i++;
    if (i === line.length) break;
    let out = '', quoted = false;
    while (i < line.length && (quoted || !' \t\r\n'.includes(line[i]))) {
      if (line.startsWith('"""', i)) { out += '&quot:'; i += 3; continue; }
      if (line[i] === '"') quoted = !quoted;
      out += line[i++];
    }
    args.push(out);
  }
  return args;
}

test('manifest and registration share one exact schema', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest['x-kiki'].tools, [definition]);
  assert.equal(manifest['x-kiki'].activation, undefined);
  assert.deepEqual(manifest['x-kiki'].permissions.exec, ['es.exe']);
  assert.equal(definition.concurrencySafe, true);
  assert.equal(manifest['x-kiki'].settings.schema.properties.timeoutMs.type, 'number');
  assert.equal(manifest['x-kiki'].settings.schema.additionalProperties, undefined);
  assert.throws(() => validateArgs({ root: '.' }, { timeoutMs: 0.5 }), { code: 'INVALID_TIMEOUT' });
  const registrations = [];
  register({ registerTool: (...args) => registrations.push(args) });
  assert.equal(registrations.length, 1); assert.deepEqual(registrations[0][0], definition);
  assert.deepEqual(definition.accesses, [{ kind: 'file', operation: 'search', path: '$.root', recursive: true }]);
});
test('donor query tokenizer preserves quotes, AND terms, triple quotes and unclosed quotes', () => {
  assert.deepEqual(splitQueryTerms('ext:log dm:today path:"C:\\My Docs" "annual report"'), ['ext:log', 'dm:today', 'path:"C:\\My Docs"', '"annual report"']);
  let seed = 18;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const alphabet = ' \t\r\n"ab-/';
  for (let n = 0; n < 3000; n++) {
    const query = Array.from({ length: random(15) }, () => alphabet[random(alphabet.length)]).join('');
    const terms = splitQueryTerms(query);
    assert.equal(esArgv(query).length, terms.length, query);
    assert.equal(esArgv(terms.join(' ')).length, terms.length, query);
  }
});
test('donor injection cases never become executable switches; Windows quotes pass through', () => {
  for (const query of ['x""" -exit', 'ext:py"a"\t-exit', '"a"\n-save-db', 'a\r\n/reindex', '"x" -export-csv C:\\out.csv', '-exit', '-argv -save-settings', '/exit', '--']) {
    const terms = splitQueryTerms(query).map(notASwitch);
    assert.ok(esArgv(terms.map(commandArg).join(' ')).every(term => !/^[-/]/.test(term)), query);
  }
  assert.equal(commandArg('path:"C:\\Program Files\\WSL"'), 'path:"C:\\Program Files\\WSL"');
  const args = searchArgs(validateArgs({ root: '.', query: 'ext:log dm:today -exit' }), 'C:\\My Docs', {});
  assert.equal(args[0], '-default-argv'); assert.ok(args.includes('ext:log')); assert.ok(args.includes('dm:today'));
  assert.ok(!args.includes('ext:log dm:today')); assert.ok(args.includes('"-exit"')); assert.ok(args.includes('"C:\\My Docs"'));
});
test('UTF-8 is decoded as one buffer, preserving BOM, Chinese and split multibyte sequences', () => {
  const text = 'C:\\中文 空格\\😀.txt\r\n';
  const bytes = Buffer.from('\uFEFF' + text);
  assert.equal(decodeOutput(Buffer.concat([bytes.subarray(0, 8), bytes.subarray(8)])), text);
  assert.throws(() => decodeOutput(Buffer.from([0xff, 0xfe])), { code: 'ES_ENCODING' });
});
test('exit 1 is a real failure, exit 9 alone is no results', async () => {
  for (const code of [1, 6, 8, 9]) {
    const fixture = fixtureRunner(); const result = fixture.executor.run('fixture-es', []);
    const assertion = code === 9 ? result : assert.rejects(result, error => error.code === 'ES_FAILED' && error.message.includes(`exit ${code}`));
    (await ready(fixture)).finish(code, '', code === 8 ? 'Everything IPC window not found' : 'failure');
    await assertion;
    if (code === 9) assert.equal((await result).stdout, '');
  }
});
test('four independent ES clients overlap; queue is FIFO and output/error are isolated', async () => {
  const fixture = fixtureRunner();
  const runs = Array.from({ length: 7 }, (_, i) => fixture.executor.run('fixture-es', [String(i)]));
  const failure = assert.rejects(runs[1], error => error.code === 'ES_FAILED' && !error.message.includes('private'));
  assert.equal(fixture.children.length, 4);
  fixture.children[2].finish(0, 'third');
  assert.deepEqual(fixture.children.at(-1).args, ['4']);
  fixture.children[1].finish(8, 'C:\\private\\unfiltered', 'C:\\private\\diagnostic');
  assert.deepEqual(fixture.children.at(-1).args, ['5']);
  fixture.children[0].finish(0, 'first');
  assert.deepEqual(fixture.children.at(-1).args, ['6']);
  fixture.children[3].finish(9, 'no results');
  for (const i of [4, 5, 6]) fixture.children[i].finish(0, `row-${i}`);
  await failure;
  assert.deepEqual((await Promise.all(runs.filter((_, i) => i !== 1))).map(x => x.stdout), ['first', 'third', '', 'row-4', 'row-5', 'row-6']);
});
test('cancellation kills only its own ES and immediately schedules the next request after close', async () => {
  const fixture = fixtureRunner({ concurrency: 2 }), abort = new AbortController();
  const cancelled = fixture.executor.run('fixture-es', ['cancel'], { signal: abort.signal });
  const other = fixture.executor.run('fixture-es', ['other']);
  const queued = fixture.executor.run('fixture-es', ['next']);
  abort.abort();
  await assert.rejects(cancelled, { code: 'CANCELLED' });
  assert.equal(fixture.children[0].killed, true); assert.equal(fixture.children[1].killed, false);
  assert.equal(fixture.children.length, 3);
  fixture.children[1].finish(0, 'other'); fixture.children[2].finish(0, 'next');
  assert.deepEqual((await Promise.all([other, queued])).map(x => x.stdout), ['other', 'next']);
  await assert.rejects(fixture.executor.run('fixture-es', [], { signal: abort.signal }), { code: 'CANCELLED' });
  assert.equal(fixture.children.length, 3);
});
test('cancelled queue entries never spawn; process cap includes a killed child until close', async () => {
  const fixture = fixtureRunner({ concurrency: 1 }), runningAbort = new AbortController(), queuedAbort = new AbortController();
  const running = fixture.executor.run('fixture-es', ['running'], { signal: runningAbort.signal });
  const cancelled = fixture.executor.run('fixture-es', ['cancelled'], { signal: queuedAbort.signal });
  const next = fixture.executor.run('fixture-es', ['next']);
  queuedAbort.abort(); await assert.rejects(cancelled, { code: 'CANCELLED' });
  fixture.children[0].kill = () => { fixture.children[0].killed = true; };
  runningAbort.abort(); await assert.rejects(running, { code: 'CANCELLED' });
  assert.equal(fixture.children.length, 1);
  fixture.children[0].emit('close', null, 'SIGTERM');
  assert.equal(fixture.children.length, 2); assert.deepEqual(fixture.children[1].args, ['next']);
  fixture.children[1].finish(0, 'ok'); assert.equal((await next).stdout, 'ok');
});
test('timeout kills its own process and frees the slot without waiting for Everything restart', async () => {
  const fixture = fixtureRunner({ concurrency: 1 });
  const timeout = fixture.executor.run('fixture-es', [], { timeoutMs: 10 });
  const next = fixture.executor.run('fixture-es', ['next']);
  await assert.rejects(timeout, { code: 'ES_TIMEOUT' });
  assert.equal(fixture.children[0].killed, true); assert.equal(fixture.children.length, 2);
  fixture.children[1].finish(0, 'ok'); assert.equal((await next).stdout, 'ok');
});
test('queue waiting counts towards timeout and a timed-out queue entry never spawns', async () => {
  const fixture = fixtureRunner({ concurrency: 1 });
  const running = fixture.executor.run('fixture-es', ['running']);
  await assert.rejects(fixture.executor.run('fixture-es', ['expired'], { timeoutMs: 10 }), { code: 'ES_TIMEOUT' });
  const next = fixture.executor.run('fixture-es', ['next']);
  fixture.children[0].finish(0, 'running');
  assert.deepEqual(fixture.children[1].args, ['next']); fixture.children[1].finish(0, 'next');
  await Promise.all([running, next]); assert.equal(fixture.children.length, 2);
});
test('spawn errors release their slot on close; synchronous failure does not consume a slot', async () => {
  const fixture = fixtureRunner({ concurrency: 1 });
  const result = fixture.executor.run('fixture-es', []);
  const next = fixture.executor.run('fixture-es', ['next']);
  fixture.children[0].emit('error', new Error('ENOENT')); fixture.children[0].emit('close', -1);
  await assert.rejects(result, { code: 'ES_START_FAILED' });
  assert.equal(fixture.children.length, 2); fixture.children[1].finish(); await next;
  const fail = fixtureRunner({ spawnProcess: () => { throw new Error('denied'); } });
  await assert.rejects(fail.executor.run('fixture-es', []), { code: 'ES_START_FAILED' });
  await assert.rejects(fail.executor.run('fixture-es', []), { code: 'ES_START_FAILED' });
});
test('output overflow kills only the oversized client; invalid encoding remains an error', async () => {
  const fixture = fixtureRunner();
  const oversized = fixture.executor.run('fixture-es', []), other = fixture.executor.run('fixture-es', []);
  fixture.children[0].stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(oversized, { code: 'ES_OUTPUT_LIMIT' });
  assert.equal(fixture.children[0].killed, true); assert.equal(fixture.children[1].killed, false);
  fixture.children[1].finish(0, Buffer.from([0xff])); await assert.rejects(other, { code: 'ES_ENCODING' });
});
test('resolution uses explicit path, then PATH, then WinGet; invalid configured path fails', async () => {
  const root = await temp(), bin = path.join(root, 'bin'), winget = path.join(root, 'Microsoft/WinGet/Packages/voidtools.Everything.Cli_fixture');
  await mkdir(bin); await mkdir(winget, { recursive: true });
  const fromPath = path.join(bin, process.platform === 'win32' ? 'es.exe' : 'es'), fromWinget = path.join(winget, 'es.exe');
  await writeFile(fromPath, 'fixture, never executed'); await writeFile(fromWinget, 'fixture, never executed');
  const env = { PATH: bin, LOCALAPPDATA: root };
  assert.equal(await resolveEsPath({ esPath: fromWinget }, env), fromWinget);
  assert.equal(await resolveEsPath({}, env), fromPath);
  assert.equal(await resolveEsPath({}, { ...env, PATH: '' }), fromWinget);
  await assert.rejects(resolveEsPath({ esPath: path.join(root, 'missing') }, env), { code: 'ES_NOT_FOUND' });
  await assert.rejects(resolveEsPath({}, { PATH: '', LOCALAPPDATA: path.join(root, 'missing') }), { code: 'ES_NOT_FOUND' });
});
test('probe reuses the checked ES binary, verifies the selected live instance and rechecks binary replacements', async () => {
  const executable = path.join(await temp(), 'fixture-es'); await writeFile(executable, 'first executable');
  const calls = []; let es = '1.1.0.37', everything = '1.5.0.1423';
  const probe = createEsProbe({ run: async (file, args) => {
    assert.equal(file, executable); calls.push(args);
    if (args.includes('"missing"')) throw new Error('instance unavailable');
    return { stdout: args.includes('-version') ? es : everything };
  } });
  assert.deepEqual(await probe(executable, {}, {}), { es, everything });
  assert.deepEqual(await probe(executable, {}, {}), { es, everything });
  assert.deepEqual(calls.map(args => args.at(-1)), ['-version', '-get-everything-version', '-get-everything-version']);
  await assert.rejects(probe(executable, { instance: 'missing' }, {}), /unavailable/);
  assert.equal(calls.length, 4); assert.ok(calls.at(-1).includes('"missing"'));
  everything = '1.4.1.1024';
  await assert.rejects(probe(executable, {}, {}), { code: 'EVERYTHING_VERSION' });
  es = '1.1.0.36'; await writeFile(executable, 'replacement');
  await assert.rejects(probe(executable, {}, {}), { code: 'ES_VERSION' });
  assert.deepEqual(calls.at(-1), ['-version']);
});
test('Kiki sensitive/VCS rules filter variants but retain public keys and templates', () => {
  for (const name of ['.env', '.env.local', 'ID_RSA', 'id_rsa-old', 'credentials.backup', 'id_ecdsa.pem', '.git/config', '.svn/x', '.hg/x', '.bzr/x', '.jj/x', '.sl/x', 'credentials/child']) assert.equal(excluded('C:/root/' + name), true, name);
  for (const name of ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'id_ed25519.pub', 'credentials.json', 'normal.txt']) assert.equal(excluded('C:/root/' + name), false, name);
});
test('root admission, sensitive/VCS and canonical escape checks all precede stat', async () => {
  const root = await temp(), outside = await temp(), calls = [];
  await assert.rejects(admitRoot(outside, { workspaceRoot: root }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  assert.equal(await admitRoot(outside, { workspaceRoot: root, approvedPaths: [outside] }), outside);
  const fs = { realpath: async file => { calls.push('realpath'); return file.endsWith('escape') ? outside : file; }, stat: async () => { calls.push('stat'); throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  for (const file of [path.join(root, '.env'), path.join(root, '.git', 'config'), path.join(outside, 'other'), path.join(root, 'escape')]) assert.equal(await enrichCandidate(file, root, fs), null);
  assert.deepEqual(calls, ['realpath']);
  const unknown = await enrichCandidate(path.join(root, 'allowed'), root, fs);
  assert.equal(unknown.type, 'unknown'); assert.equal(unknown.metadata_error, 'EACCES');
});
test('real junction escaping admitted root is filtered before metadata is returned', async t => {
  const root = await temp(), outside = await temp(); await writeFile(path.join(outside, 'target.txt'), 'fixture');
  const link = path.join(root, 'linked');
  try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('Symlink privilege unavailable'); throw error; }
  assert.equal(await enrichCandidate(path.join(link, 'target.txt'), root), null);
});
test('index-only functions reject content and unindexed properties before any external call', async () => {
  const search = createSearch({ executor: { run: noExternal }, findEs: noExternal, probe: noExternal, admit: noExternal, enrich: noExternal });
  for (const query of ['content:secret', 'regex:content:x', 'width:20', 'dc:today', 'utf8content:x', 'macro:foo']) {
    const result = await search({ root: '.', query }); assert.equal(result.isError, true); assert.equal(JSON.parse(result.output).code, 'INDEX_QUERY_ONLY');
  }
});
test('pagination reports raw index offsets and unknown visible total after filtering', { skip: process.platform !== 'win32' }, async () => {
  const results = ['C:\\root\\.env', 'C:\\root\\allowed.txt', 'C:\\root\\extra.txt'];
  const search = createSearch({ admit: async () => 'C:\\root', findEs: async () => 'fixture', probe: async () => ({ es: 'fixture', everything: 'fixture' }), executor: { run: async () => ({ stdout: results.join('\r\n') }) }, enrich: async file => file.endsWith('.env') ? null : ({ path: file, type: 'file' }) });
  const result = JSON.parse((await search({ root: '.', limit: 2, offset: 7 })).output);
  assert.equal(result.returned, 1); assert.equal(result.pagination.filtered, 1); assert.equal(result.pagination.total, null); assert.equal(result.pagination.next_offset, 9); assert.equal(result.pagination.has_more, true);
});
test('cancelling a cold compatibility check does not cancel another search or poison its cache', { skip: process.platform !== 'win32' }, async () => {
  const executable = path.join(await temp(), 'fixture-es'); await writeFile(executable, 'fixture');
  const fixture = fixtureRunner({ executable }), abort = new AbortController();
  const search = createSearch({ executor: fixture.executor, admit: async () => 'C:\\root', findEs: async () => executable, enrich: noExternal });
  const cancelled = search({ root: '.' }, { signal: abort.signal });
  await ready(fixture);
  const other = search({ root: '.' });
  await ready(fixture, 1);
  abort.abort();
  assert.equal(JSON.parse((await cancelled).output).code, 'CANCELLED');
  assert.equal(fixture.children[1].killed, false);
  fixture.children[1].finish(0, '1.1.0.37');
  (await ready(fixture, 2)).finish(0, '1.5.0.1423');
  (await ready(fixture, 3)).finish(0, ''); assert.equal((await other).isError, undefined);
  const next = search({ root: '.' });
  const liveVersion = await ready(fixture, 4);
  assert.equal(liveVersion.args.includes('-get-everything-version'), true);
  liveVersion.finish(0, '1.5.0.1423');
  (await ready(fixture, 5)).finish(0, ''); await next;
  assert.equal(fixture.children.length, 6);
});
test('cancellation while enriching the final result still cancels only that call', { skip: process.platform !== 'win32' }, async () => {
  const abort = new AbortController();
  const search = createSearch({ admit: async () => 'C:\\root', findEs: async () => 'fixture-es', probe: async () => ({}),
    executor: { run: async () => ({ stdout: 'C:\\root\\allowed.txt' }) },
    enrich: async () => { abort.abort(); return { path: 'C:\\root\\allowed.txt', type: 'file' }; } });
  const result = await search({ root: '.' }, { signal: abort.signal });
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.output).code, 'CANCELLED');
});
