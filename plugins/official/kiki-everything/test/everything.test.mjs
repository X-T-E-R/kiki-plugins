import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EsRunner, splitQueryTerms, notASwitch, commandArg, decodeOutput, resolveEsPath, checkEs } from '../lib/es.mjs';
import { acquireLease } from '../lib/lease.mjs';
import { excluded, admitRoot, enrichCandidate } from '../lib/paths.mjs';
import { createSearch, searchArgs, validateArgs } from '../lib/search.mjs';
import { definition } from '../lib/definitions.mjs';
import { register } from '../entry.mjs';

const scratch = path.resolve('.tmp/everything-tests');
await mkdir(scratch, { recursive: true });
const temp = () => mkdtemp(path.join(scratch, 'run-'));
const noExternal = () => { throw new Error('Unexpected real external call in fixture'); };
globalThis.fetch = noExternal;
function fixtureRunner(extra = {}) {
  const children = [];
  const executor = new EsRunner({
    lock: async () => ({ release: async () => {} }), identity: async () => null,
    spawnProcess(executable, args, options) {
      assert.equal(executable, 'fixture-es');
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
const ready = async fixture => { while (!fixture.children.length) await new Promise(resolve => setImmediate(resolve)); return fixture.children.at(-1); };
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
  assert.equal(manifest['x-kiki'].activation, 'app');
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
test('timeout drains ES, keeps same-session and cross-session busy, then recovers on exit', async () => {
  const name = process.platform === 'win32' ? `\\\\.\\pipe\\everything-test-${process.pid}` : path.join(await temp(), 'lease.sock');
  const fixture = fixtureRunner({ lock: () => acquireLease(name) });
  const result = fixture.executor.run('fixture-es', [], { timeoutMs: 20 });
  await assert.rejects(result, { code: 'ES_TIMEOUT' });
  assert.equal(fixture.children[0].killed, false);
  await assert.rejects(fixture.executor.run('fixture-es', []), { code: 'ES_BUSY' });
  await assert.rejects(acquireLease(name), { code: 'ES_BUSY' });
  fixture.children[0].finish(); await new Promise(resolve => setImmediate(resolve));
  const lease = await acquireLease(name); await lease.release();
  const next = fixture.executor.run('fixture-es', []); await new Promise(resolve => setImmediate(resolve)); fixture.children[1].finish(0, 'ok');
  assert.equal((await next).stdout, 'ok');
});
test('cancellation stops waiting without killing or queuing ES; pre-abort spawns nothing', async () => {
  const fixture = fixtureRunner(), abort = new AbortController();
  const result = fixture.executor.run('fixture-es', [], { signal: abort.signal });
  await ready(fixture); abort.abort(); await assert.rejects(result, { code: 'CANCELLED' });
  assert.equal(fixture.children[0].killed, false);
  await assert.rejects(fixture.executor.run('fixture-es', []), { code: 'ES_BUSY' });
  fixture.children[0].finish(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(fixture.executor.run('fixture-es', [], { signal: abort.signal }), { code: 'CANCELLED' });
  assert.equal(fixture.children.length, 1);
});
test('pending ES is retired only after the selected Everything client restarts', async () => {
  let identity = 'old-client';
  const fixture = fixtureRunner({ identity: async () => identity, watchMs: 5 });
  await assert.rejects(fixture.executor.run('fixture-es', [], { timeoutMs: 10 }), { code: 'ES_TIMEOUT' });
  const closed = once(fixture.children[0], 'close'); identity = 'new-client'; await closed;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(fixture.children[0].killed, true); assert.equal(fixture.executor.pending, false);
});
test('failed spawn releases the lease and returns an actionable error', async () => {
  const fixture = fixtureRunner();
  const result = fixture.executor.run('fixture-es', []); const child = await ready(fixture);
  child.emit('error', new Error('ENOENT')); child.emit('close', -1);
  await assert.rejects(result, { code: 'ES_START_FAILED' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(fixture.executor.pending, false);
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
test('explicit instance never falls back; old ES and unexpected versions fail', async () => {
  const calls = [];
  await assert.rejects(checkEs('fixture', { instance: 'missing' }, {}, { run: async (file, args) => { calls.push(args); if (calls.length === 1) return { stdout: '1.1.0.37' }; throw new Error('instance unavailable'); } }), /unavailable/);
  assert.equal(calls.length, 2); assert.ok(calls[1].includes('"missing"'));
  await assert.rejects(checkEs('fixture', {}, {}, { run: async () => ({ stdout: '1.1.0.36' }) }), { code: 'ES_VERSION' });
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
