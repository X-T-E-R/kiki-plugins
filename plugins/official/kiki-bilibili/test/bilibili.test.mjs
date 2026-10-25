import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { definitions } from '../lib/definitions.mjs';
import { register } from '../entry.mjs';
import { createBilibiliCore } from '../lib/core.mjs';
import { createCli } from '../lib/cli.mjs';

const root = path.dirname(import.meta.dirname);
const scratch = path.resolve('.tmp');
await mkdir(scratch, { recursive: true });
const cases = [
  ['discover', { action: 'search', keyword: '--not-a-flag', order: 'new', page: 2, limit: 5 }, ['search', 'video', '--order', 'new', '--page', '2', '--size', '5', '--', '--not-a-flag']],
  ['discover', { action: 'hot', limit: 4 }, ['hot', 'search', '--limit', '4']],
  ['discover', { action: 'users', keyword: 'creator' }, ['search', 'user', '--page', '1', '--', 'creator']],
  ['discover', { action: 'recommend', limit: 5, page: 2 }, ['feed', 'recommend', '--count', '5', '--page', '2']],
  ['discover', { action: 'timeline', cursor: '123', up: '456', kind: 'video' }, ['feed', 'timeline', '--type', 'video', '--limit', '20', '--up', '456', '--offset', '123']],
  ['inbox', { action: 'notifications' }, ['feed', 'notifications']],
  ['inbox', { action: 'inbox' }, ['feed', 'inbox', '--limit', '5']],
  ['inbox', { action: 'replies', cursor: '1,2' }, ['feed', 'replies', '--limit', '20', '--cursor', '1,2']],
  ['inbox', { action: 'mentions' }, ['feed', 'mentions', '--limit', '20']],
  ['inbox', { action: 'likes' }, ['feed', 'likes', '--limit', '20']],
  ['inbox', { action: 'system' }, ['feed', 'system', '--limit', '20']],
  ['interact', { action: 'replies', video: '123', resourceType: 'dynamic', commentId: 22 }, ['comment', 'replies', '--page', '1', '--type', 'dynamic', '--', '123', '22']],
  ['interact', { action: 'check', video: 'av123', commentId: 22, rootId: 11 }, ['comment', 'check', '--root', '11', '--', 'av123', '22']],
  ['watch', { action: 'metadata', video: 'BV1Q541167Qg' }, ['video', 'info', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'subtitle', video: 'BV1Q541167Qg', page: 2, language: 'zh-CN' }, ['video', 'subtitle', '--page', '2', '--lang', 'zh-CN', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'transcribe', video: 'BV1Q541167Qg' }, ['video', 'transcribe', '--page', '1', '--engine', 'local', '--max-minutes', '60', '--', 'BV1Q541167Qg']],
  ['interact', { action: 'comment', video: 'av123', text: '--hello', mentions: ['123'] }, ['comment', 'post', '--at', '123', '--', 'av123', '--hello']],
  ['interact', { action: 'reply', video: 'av123', text: 'hi', commentId: 22, rootId: 11, mentions: ['123'] }, ['comment', 'reply', '--at', '123', '--root', '11', '--', 'av123', '22', 'hi']],
  ['interact', { action: 'like', video: 'av123', commentId: 22, undo: true }, ['comment', 'like', '--undo', '--', 'av123', '22']],
  ['interact', { action: 'like', video: 'av123' }, ['video', 'like', '--', 'av123']],
  ['interact', { action: 'favorite', video: 'av123', folder: 'mine', undo: true }, ['video', 'fav', '--folder', 'mine', '--remove', '--', 'av123']],
  ['interact', { action: 'comments', video: 'av123' }, ['comment', 'list', '--page', '1', '--sort', 'hot', '--', 'av123']],
  ['inbox', { action: 'list' }, ['dm', 'list', '--limit', '20']],
  ['inbox', { action: 'read', threadId: '123' }, ['dm', 'read', '--limit', '30', '--', '123']],
  ['inbox', { action: 'mark_read', threadId: '123' }, ['dm', 'read', '--limit', '30', '--mark-read', '--', '123']],
  ['publish', { action: 'status', bvid: 'BV1Q541167Qg' }, ['upload', 'status', '--', 'BV1Q541167Qg']],
  ['account', { action: 'login' }, ['auth', 'login']],
  ['account', { action: 'status' }, ['auth', 'status']],
  ['account', { action: 'logout' }, ['auth', 'logout']],
  ['account', { action: 'asr_status' }, ['asr', 'status']],
];

test('manifest equals native registrations; runtime has no plan/mock-only tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  const actual = [];
  register({ registerTool: (d) => actual.push(d) });
  assert.deepEqual(actual, definitions);
  for (const d of definitions) { assert.ok(d.description.length < 600); assert.equal(d.parameters.properties.mode, undefined); }
});

test('complete platform path maps to the donor commands, including option-like text', async () => {
  const calls = [];
  const core = createBilibiliCore({ cli: async (args, options) => { calls.push({ args, options }); return { marked_read: args.includes('--mark-read') }; } });
  for (const [method, input, args] of cases) {
    const result = await core[method](input);
    assert.deepEqual(calls.at(-1).args, args);
    if (method === 'inbox') assert.equal(result.marked_read, input.action === 'mark_read');
  }
});

async function workspace(t) {
  const dir = await mkdtemp(path.join(scratch, 'bili-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('real frame provenance, ASR fallback and multi-P upload use production CLI shapes', async (t) => {
  const dir = await workspace(t), calls = [];
  const core = createBilibiliCore({ workspaceRoot: dir, cli: async (args, options) => {
    calls.push({ args, options });
    if (args[1] === 'subtitle') throw Object.assign(new Error('No subtitles'), { code: 'not_found' });
    if (args[1] === 'frames') return { quality: 'hd', frames: [{ requested_time: 0.5, actual_time: 0.5, path: '/frame.jpg' }] };
    return { items: [{ from: 0, to: 1, content: 'spoken' }] };
  } });
  const watched = await core.watch({ action: 'all', video: 'av123', timestamps: [0.5, 1.5] });
  assert.equal(watched.transcript.source, 'asr');
  assert.equal(watched.visual.source, 'real-video-stream');
  assert.deepEqual(watched.visual.frames[0], { requested_time: 0.5, actual_time: 0.5, path: '/frame.jpg' });
  assert.ok(calls[2].args.includes('local'));
  assert.deepEqual(calls[3].args.slice(-6), ['--at', '0.5', '--at', '1.5', '--', 'av123']);
  await writeFile(path.join(dir, 'a.mp4'), 'fixture'); await writeFile(path.join(dir, 'b.mp4'), 'fixture');
  const sent = await core.publish({ action: 'submit', files: ['a.mp4', 'b.mp4'], title: 'title', tags: ['one', 'two'], tid: 1, zone: 2, private: true });
  const last = calls.at(-1);
  assert.equal(last.options.write, true);
  assert.equal(sent.submission, 'accepted');
  assert.deepEqual(last.args.slice(0, 14), ['upload', 'video', '--title', 'title', '--tag', 'one', '--tag', 'two', '--tid', '1', '--zone', '2', '--private', '--ai-declare']);
  await writeFile(path.join(dir, 'cover.png'), 'fixture');
  await core.publish({ action: 'submit', files: ['a.mp4'], cover: 'cover.png', title: 'title', tags: ['one'] });
  assert.equal(calls.at(-1).args[5], path.join(dir, 'cover.png'));
  await assert.rejects(core.publish({ action: 'submit', files: ['../missing.mp4'], title: 'a', tags: ['a'] }), { code: 'FILE_MISSING' });
  const outside = path.join(scratch, 'bili-outside.mp4');
  await writeFile(outside, 'fixture'); t.after(() => rm(outside, { force: true }));
  await assert.rejects(core.publish({ action: 'submit', files: [outside], title: 'a', tags: ['a'] }), { code: 'PATH_OUTSIDE_WORKSPACE' });
});

function fakeSpawn({ receipt = { ok: true, data: { rpid: 1 } }, code = 0, error, hang, chunks } = {}) {
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { calls.at(-1).killed = true; };
    queueMicrotask(() => {
      if (error) return child.emit('error', error);
      child.emit('spawn');
      if (!hang) {
        for (const chunk of chunks ?? [Buffer.from(typeof receipt === 'string' ? receipt : JSON.stringify(receipt))]) child.stdout.emit('data', chunk);
        child.emit('close', code);
      }
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('CLI process pins an explicit profile, never uses shell and disables donor fixed-rate gates', async () => {
  const fixture = fakeSpawn();
  const cli = createCli({ settings: { cliHome: path.resolve('.tmp/profile') }, ...fixture });
  assert.deepEqual(await cli(['comment', 'post', '--', 'av123', 'hello'], { write: true }), { rpid: 1 });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].options.shell, false);
  assert.equal(fixture.calls[0].options.env.BILI_CLI_HOME, path.resolve('.tmp/profile'));
  assert.equal(fixture.calls[0].options.env.BILI_CLI_NO_RATE_LIMIT, '1');
  assert.throws(() => createCli(), { code: 'CONFIGURATION' });
  const bytes = Buffer.from(JSON.stringify({ ok: true, data: { title: '中文标题' } }));
  const splitFixture = fakeSpawn({ chunks: [...bytes].map((value) => Buffer.from([value])) });
  assert.deepEqual(await createCli({ settings: { cliHome: path.resolve('.tmp/profile') }, ...splitFixture })(['video', 'info']), { title: '中文标题' });
});

test('lost response, CLI failure, missing dependency and abort preserve outbound uncertainty without retry', async () => {
  for (const [fixture, expected] of [
    [fakeSpawn({ receipt: 'broken JSON' }), 'unknown'],
    [fakeSpawn({ receipt: { ok: false, error: { code: 'network_error', message: 'lost response' } }, code: 1 }), 'unknown'],
    [fakeSpawn({ receipt: { ok: false, error: { code: 'not_logged_in', message: 'login required' } }, code: 1 }), 'not_sent'],
    [fakeSpawn({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }), 'not_sent'],
  ]) {
    const cli = createCli({ settings: { cliHome: path.resolve('.tmp/profile') }, ...fixture });
    await assert.rejects(cli(['comment', 'post'], { write: true }), (error) => error.submission === expected);
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = fakeSpawn({ hang: true }), controller = new AbortController();
  const cli = createCli({ settings: { cliHome: path.resolve('.tmp/profile') }, signal: controller.signal, ...fixture });
  const pending = cli(['upload', 'video'], { write: true });
  await new Promise((r) => setImmediate(r)); controller.abort();
  await assert.rejects(pending, (error) => error.code === 'LOCAL_ABORTED' && error.submission === 'unknown');
  assert.equal(fixture.calls[0].killed, true);
});

test('installed bili-agent parser accepts every generated argument vector with network denied', { skip: !process.env.BILI_CONTRACT_PYTHON }, async (t) => {
  const dir = await workspace(t), commands = cases.map((c) => c[2]);
  const file = path.join(dir, 'a.mp4'); await writeFile(file, 'fixture');
  const core = createBilibiliCore({ workspaceRoot: dir, cli: async (args) => { commands.push(args); return { quality: 'hd' }; } });
  await writeFile(path.join(dir, 'cover.png'), 'fixture');
  await core.publish({ action: 'submit', files: ['a.mp4'], cover: 'cover.png', title: 'title', tags: ['tag'], description: 'desc', tid: 1, zone: 2 });
  await core.watch({ action: 'visual', video: 'av123', timestamps: [0.25, 0.5] });
  const result = spawnSync(process.env.BILI_CONTRACT_PYTHON, [path.join(root, 'test/cli-contract.py')], { input: JSON.stringify(commands), encoding: 'utf8', env: { ...process.env, BILI_CLI_HOME: dir, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).accepted, commands.length);
  const feedResult = spawnSync(process.env.BILI_CONTRACT_PYTHON, [path.join(root, 'test/feed-contract.py')], { encoding: 'utf8', env: { ...process.env, BILI_CLI_HOME: dir, PYTHONUTF8: '1' } });
  assert.equal(feedResult.status, 0, feedResult.stderr + feedResult.stdout);
  assert.equal(JSON.parse(feedResult.stdout).inbox.replies[0].rpid, 11);
});

test('notification read effects and current-account comment inspection remain explicit', async () => {
  const calls = [];
  const core = createBilibiliCore({ cli: async (args, options) => { calls.push({ args, options }); return { found: false, visible: false, next: 'overstated upstream hint', next_cursor: '1,2' }; } });
  assert.equal((await core.inbox({ action: 'notifications' })).read_effect, 'counts-only');
  assert.equal(calls.at(-1).options, undefined);
  assert.equal((await core.inbox({ action: 'inbox' })).read_effect, 'marks-notifications-read');
  assert.equal(calls.at(-1).options.write, true);
  const checked = await core.interact({ action: 'check', video: 'av123', commentId: 11, rootId: 10 });
  assert.equal(checked.found, false);
  assert.deepEqual(checked.inspection, { perspective: 'configured-account', max_pages: 2, other_accounts_visibility: 'not_measured' });
  const posted = await core.interact({ action: 'comment', video: '123', resourceType: 'dynamic', text: 'hello' });
  assert.match(posted.next, /configured account/);
  assert.deepEqual(calls.at(-1).args, ['comment', 'post', '--type', 'dynamic', '--', '123', 'hello']);
});


test('frames render as image parts with timestamps and original paths; missing images remain visible errors', async (t) => {
  const { renderResult } = await import('../lib/output.mjs');
  const dir = await workspace(t), file = path.join(dir, 'frame.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
  await writeFile(file, png);
  const data = { source: 'real-video-stream', frames: [{ time: 0.25, actual_time: 0.25, path: file }] };
  const rendered = await renderResult(data, true);
  assert.equal(rendered.output.length, 2);
  assert.deepEqual(JSON.parse(rendered.output[0].text), data);
  assert.equal(rendered.output[1].imageUrl.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal((await renderResult(data, false)).output.length, 1);
  const missing = await renderResult({ frames: [{ path: path.join(dir, 'missing.jpg') }] }, true);
  assert.match(missing.output[1].text, /Image unavailable/);
});


test('public Host runner registers the plugin, diagnoses its real CLI and reports configuration failures', { skip: !process.env.KIKI_HOST_RUNNER, timeout: 30000 }, async (t) => {
  const dir = await workspace(t);
  const child = spawn(process.execPath, [path.resolve(process.env.KIKI_HOST_RUNNER), path.join(root, 'entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: root });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); child.kill(); await closed; });
  let id = 0, stderr = '';
  const waiting = new Map(), registered = [];
  child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'register') registered.push(message.params.tool);
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`Runner timeout: ${method}; ${stderr}`)); }, 15000);
      waiting.set(requestId, (message) => { clearTimeout(timer); waiting.delete(requestId); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  assert.deepEqual(await rpc('handshake', { version: 1 }), { version: 1 });
  const failed = await rpc('execute', { name: 'bilibili_diagnose', args: {}, settings: {}, workspaceRoot: dir });
  assert.deepEqual(registered, definitions);
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.output).error.code, 'CONFIGURATION');
  if (process.env.BILI_CONTRACT_PYTHON) {
    const executable = path.join(path.dirname(process.env.BILI_CONTRACT_PYTHON), process.platform === 'win32' ? 'bili.exe' : 'bili');
    const diagnosed = await rpc('execute', { name: 'bilibili_diagnose', args: {}, settings: { biliCliPath: executable, cliHome: dir }, workspaceRoot: dir });
    assert.equal(diagnosed.isError, undefined);
    assert.equal(JSON.parse(diagnosed.output[0].text).cli.version, '1.0.0');
  }
  await rpc('shutdown', {});
  await closed;
});
