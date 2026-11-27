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
import { createCli, closeAllDaemons, getActiveDaemonPids } from '../lib/cli.mjs';

const root = path.dirname(import.meta.dirname);
const scratch = path.resolve('.tmp');
await mkdir(scratch, { recursive: true });
const cases = [
  ['discover', { action: 'search', keyword: '--not-a-flag', order: 'new', page: 2, limit: 5 }, ['search', 'video', '--order', 'new', '--page', '2', '--size', '5', '--', '--not-a-flag']],
  ['discover', { action: 'hot', limit: 4 }, ['hot', 'search', '--limit', '4']],
  ['discover', { action: 'popular', page: 2, limit: 10, unseen: true }, ['hot', 'popular', '--page', '2', '--size', '10', '--unseen']],
  ['discover', { action: 'weekly', issue: 300, unseen: true }, ['hot', 'weekly', '--issue', '300', '--unseen']],
  ['discover', { action: 'precious', unseen: true }, ['hot', 'precious', '--unseen']],
  ['discover', { action: 'rank', zone: 'tech', limit: 15, unseen: true }, ['hot', 'rank', '--zone', 'tech', '--limit', '15', '--unseen']],
  ['discover', { action: 'users', keyword: 'creator' }, ['search', 'user', '--page', '1', '--', 'creator']],
  ['discover', { action: 'user_info', up: '1245004422' }, ['user', 'info', '--', '1245004422']],
  ['discover', { action: 'user_videos', up: '1245004422', order: 'views', page: 2, limit: 15, keyword: 'AI' }, ['user', 'videos', '--order', 'views', '--page', '2', '--size', '15', '--keyword', 'AI', '--', '1245004422']],
  ['discover', { action: 'recommend', limit: 5, page: 2, unseen: true }, ['feed', 'recommend', '--count', '5', '--page', '2', '--unseen']],
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
  ['watch', { action: 'digest', video: 'BV1Q541167Qg', frames: 0, comments: 5, transcript: 'subtitle', maxChars: 2000, record: true }, ['video', 'watch', '--page', '1', '--frames', '0', '--comments', '5', '--transcript', 'subtitle', '--max-chars', '2000', '--record', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'summary', video: 'BV1Q541167Qg', page: 1 }, ['video', 'summary', '--page', '1', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'chapters', video: 'BV1Q541167Qg', page: 1 }, ['video', 'chapters', '--page', '1', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'danmaku', video: 'BV1Q541167Qg', page: 1, limit: 100 }, ['video', 'danmaku', '--page', '1', '--limit', '100', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'subtitle', video: 'BV1Q541167Qg', page: 2, language: 'zh-CN', textOnly: true }, ['video', 'subtitle', '--page', '2', '--lang', 'zh-CN', '--text', '--', 'BV1Q541167Qg']],
  ['watch', { action: 'transcribe', video: 'BV1Q541167Qg', textOnly: true }, ['video', 'transcribe', '--page', '1', '--engine', 'local', '--max-minutes', '60', '--text', '--', 'BV1Q541167Qg']],
  ['interact', { action: 'comment', video: 'av123', text: '--hello', mentions: ['123'] }, ['comment', 'post', '--at', '123', '--', 'av123', '--hello']],
  ['interact', { action: 'reply', video: 'av123', text: 'hi', commentId: 22, rootId: 11, mentions: ['123'] }, ['comment', 'reply', '--at', '123', '--root', '11', '--', 'av123', '22', 'hi']],
  ['interact', { action: 'danmaku', video: 'BV1Q541167Qg', text: '前方高能', time: 12.5, danmakuMode: 'top', color: 'ff0000' }, ['danmaku', 'send', '--page', '1', '--time', '12.5', '--mode', 'top', '--color', 'ff0000', '--', 'BV1Q541167Qg', '前方高能']],
  ['interact', { action: 'like', video: 'av123', commentId: 22, undo: true }, ['comment', 'like', '--undo', '--', 'av123', '22']],
  ['interact', { action: 'like', video: 'av123' }, ['video', 'like', '--', 'av123']],
  ['interact', { action: 'favorite', video: 'av123', folder: 'mine', undo: true }, ['video', 'fav', '--folder', 'mine', '--remove', '--', 'av123']],
  ['interact', { action: 'comments', video: 'av123', unreplied: true, supporters: true }, ['comment', 'list', '--page', '1', '--sort', 'hot', '--unreplied', '--supporters', '--', 'av123']],
  ['inbox', { action: 'list' }, ['dm', 'list', '--limit', '20']],
  ['inbox', { action: 'read', threadId: '123' }, ['dm', 'read', '--limit', '30', '--', '123']],
  ['inbox', { action: 'mark_read', threadId: '123' }, ['dm', 'read', '--limit', '30', '--mark-read', '--', '123']],
  ['publish', { action: 'status', bvid: 'BV1Q541167Qg' }, ['upload', 'status', '--', 'BV1Q541167Qg']],
  ['publish', { action: 'list', uploadStatus: 'published', page: 2, limit: 5 }, ['upload', 'list', '--status', 'published', '--page', '2', '--size', '5']],
  ['publish', { action: 'stats', bvid: 'BV1Q541167Qg' }, ['upload', 'stats', '--', 'BV1Q541167Qg']],
  ['publish', { action: 'zones' }, ['upload', 'zones']],
  ['publish', { action: 'chapters_show', bvid: 'BV1Q541167Qg', page: 2 }, ['upload', 'chapters', 'show', '--page', '2', '--', 'BV1Q541167Qg']],
  ['publish', { action: 'chapters_set', bvid: 'BV1Q541167Qg', chapters: ['00:00 开场', '01:30 实战'] }, ['upload', 'chapters', 'set', '--page', '1', '--chapter', '00:00 开场', '--chapter', '01:30 实战', '--', 'BV1Q541167Qg']],
  ['publish', { action: 'chapters_clear', bvid: 'BV1Q541167Qg' }, ['upload', 'chapters', 'clear', '--page', '1', '--', 'BV1Q541167Qg']],
  ['publish', { action: 'dynamic_list', up: '1245004422', cursor: '999' }, ['dynamic', 'list', '--mid', '1245004422', '--offset', '999']],
  ['publish', { action: 'dynamic_delete', dynamicId: '888888' }, ['dynamic', 'delete', '--', '888888']],
  ['publish', { action: 'dynamic_vote', voteId: 42 }, ['dynamic', 'vote', '--', '42']],
  ['publish', { action: 'season_list' }, ['season', 'list']],
  ['publish', { action: 'season_add', season: 7, section: 9, videos: ['BV1Q541167Qg', 'av123'] }, ['season', 'add', '--section', '9', '--', '7', 'BV1Q541167Qg', 'av123']],
  ['account', { action: 'login' }, ['auth', 'login']],
  ['account', { action: 'login', waitSeconds: 60 }, ['auth', 'login', '--wait', '60']],
  ['account', { action: 'status' }, ['auth', 'status']],
  ['account', { action: 'status', waitSeconds: 120 }, ['auth', 'status', '--wait', '120']],
  ['account', { action: 'logout' }, ['auth', 'logout']],
  ['account', { action: 'profile' }, ['me', 'show']],
  ['account', { action: 'stats', period: 'month' }, ['me', 'stats', '--period', 'month']],
  ['account', { action: 'following', page: 2, limit: 25 }, ['user', 'following', '--page', '2', '--size', '25']],
  ['account', { action: 'set_sign', sign: 'midnight lab' }, ['me', 'set-sign', '--', 'midnight lab']],
  ['account', { action: 'set_name', name: 'Nia', allowCost: true }, ['me', 'set-name', '--allow-cost', '--', 'Nia']],
  ['account', { action: 'asr_status' }, ['asr', 'status']],
];

test('manifest equals native registrations; runtime has no plan/mock-only tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.1');
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  assert.deepEqual(manifest['x-kiki'].permissions.exec, ['bili', 'python', 'ffmpeg']);
  const settingsSchema = manifest['x-kiki'].settings.schema;
  assert.equal(settingsSchema.properties.timeoutMs.type, 'number');
  assert.equal(settingsSchema.properties.profiles.type, 'string');
  assert.equal(settingsSchema.properties.defaultProfile.type, 'string');
  assert.equal(settingsSchema.properties.timeoutMs.minimum, undefined);
  assert.equal(settingsSchema.additionalProperties, undefined);
  assert.equal(definitions[0].parameters.properties.page.type, 'integer');
  assert.equal(definitions[0].parameters.properties.page.minimum, 1);
  assert.equal(definitions[0].parameters.additionalProperties, false);
  const actual = [];
  register({ registerTool: (d) => actual.push(d) });
  assert.deepEqual(actual, definitions);
  for (const d of definitions) {
    assert.ok(d.description.length < 600, `${d.name} description length ${d.description.length} >= 600`);
    assert.equal(d.parameters.properties.mode, undefined);
    assert.equal(d.parameters.properties.profile.type, 'string');
    assert.deepEqual(d.parameters.properties.reason, { type: 'string', maxLength: 500, description: 'Optional brief note on why this tool is being called (ignored at runtime).' });
  }
});

test('complete platform path maps to the donor commands, including option-like text', async () => {
  const calls = [];
  const core = createBilibiliCore({ cli: async (args, options) => { calls.push({ args, options }); return { marked_read: args.includes('--mark-read') }; } });
  for (const [method, input, args] of cases) {
    const result = await core[method]({ ...input, reason: 'CallTool caller intent note' });
    assert.deepEqual(calls.at(-1).args, args);
    if (method === 'inbox') assert.equal(result.marked_read, input.action === 'mark_read');
  }
});

async function workspace(t) {
  const dir = await mkdtemp(path.join(scratch, 'bili-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('real frame provenance, concurrent watch(all), ASR fallback and creator media uploads use production CLI shapes', async (t) => {
  const dir = await workspace(t), calls = [];
  let inFlight = 0, maxConcurrent = 0;
  const core = createBilibiliCore({ workspaceRoot: dir, cli: async (args, options) => {
    calls.push({ args, options });
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    const isFanout = args[1] === 'subtitle' || args[1] === 'frames' || (args[0] === 'comment' && args[1] === 'list');
    await new Promise((r) => setTimeout(r, isFanout ? 60 : 5));
    try {
      if (args[1] === 'subtitle') throw Object.assign(new Error('No subtitles'), { code: 'not_found' });
      if (args[1] === 'frames') return { quality: 'hd', frames: [{ requested_time: 0.5, actual_time: 0.5, path: '/frame.jpg' }] };
      if (args[0] === 'comment' && args[1] === 'list') return { items: [{ rpid: 99, content: 'nice' }] };
      return { items: [{ from: 0, to: 1, content: 'spoken' }] };
    } finally {
      inFlight -= 1;
    }
  } });
  const watched = await core.watch({ action: 'all', video: 'av123', timestamps: [0.5, 1.5], includeComments: true });
  assert.ok(maxConcurrent >= 3, `Expected watch(all) fanout concurrency >= 3, got ${maxConcurrent}`);
  assert.equal(watched.transcript.source, 'asr');
  assert.equal(watched.visual.source, 'real-video-stream');
  assert.equal(watched.comments.items[0].rpid, 99);
  assert.deepEqual(watched.visual.frames[0], { requested_time: 0.5, actual_time: 0.5, path: '/frame.jpg' });
  const transcribeCall = calls.find((c) => c.args[1] === 'transcribe');
  const framesCall = calls.find((c) => c.args[1] === 'frames');
  assert.ok(transcribeCall.args.includes('local'));
  assert.deepEqual(framesCall.args.slice(-6), ['--at', '0.5', '--at', '1.5', '--', 'av123']);

  await writeFile(path.join(dir, 'a.mp4'), 'fixture');
  await writeFile(path.join(dir, 'b.mp4'), 'fixture');
  const sent = await core.publish({ action: 'submit', files: ['a.mp4', 'b.mp4'], title: 'title', tags: ['one', 'two'], tid: 1, zone: 2, private: true });
  const last = calls.at(-1);
  assert.equal(last.options.write, true);
  assert.equal(sent.submission, 'accepted');
  assert.deepEqual(last.args.slice(0, 14), ['upload', 'video', '--title', 'title', '--tag', 'one', '--tag', 'two', '--tid', '1', '--zone', '2', '--private', '--ai-declare']);

  await writeFile(path.join(dir, 'cover.png'), 'fixture');
  await writeFile(path.join(dir, 'cover43.png'), 'fixture');
  await core.publish({ action: 'submit', files: ['a.mp4'], cover: 'cover.png', cover43: 'cover43.png', topic: 'AI大赛', season: 12, dynamicText: '新视频！', noReprint: true, title: 'title', tags: ['one'] });
  assert.equal(calls.at(-1).args[5], path.join(dir, 'cover.png'));
  assert.ok(calls.at(-1).args.includes('--cover43'));
  assert.ok(calls.at(-1).args.includes('--no-reprint'));

  await core.publish({ action: 'edit', bvid: 'BV1Q541167Qg', title: 'new title', cover: 'cover.png', video: 'b.mp4', aiDeclare: false });
  assert.deepEqual(calls.at(-1).args, ['upload', 'edit', '--title', 'new title', '--cover', path.join(dir, 'cover.png'), '--no-ai-declare', '--video', path.join(dir, 'b.mp4'), '--', 'BV1Q541167Qg']);
  assert.equal(calls.at(-1).options.write, true);

  await core.publish({ action: 'dynamic_post', text: 'Vote now', images: ['cover.png'], mentions: ['1245004422'], topic: '99', voteTitle: 'Pick AI topic', voteOptions: ['Agent', 'Video'], voteMulti: 1, voteDays: 3 });
  assert.deepEqual(calls.at(-1).args, ['dynamic', 'post', '--image', path.join(dir, 'cover.png'), '--topic', '99', '--at', '1245004422', '--vote', 'Pick AI topic', '--option', 'Agent', '--option', 'Video', '--vote-multi', '1', '--vote-days', '3', '--', 'Vote now']);
  assert.equal(calls.at(-1).options.write, true);

  await core.publish({ action: 'season_create', title: 'AI Series', cover: 'cover.png', description: 'Weekly AI' });
  assert.deepEqual(calls.at(-1).args, ['season', 'create', '--cover', path.join(dir, 'cover.png'), '--desc', 'Weekly AI', '--', 'AI Series']);
  assert.equal(calls.at(-1).options.write, true);

  await assert.rejects(core.publish({ action: 'submit', files: ['../missing.mp4'], title: 'a', tags: ['a'] }), { code: 'FILE_MISSING' });
  const outside = path.join(scratch, 'bili-outside.mp4');
  await writeFile(outside, 'fixture'); t.after(() => rm(outside, { force: true }));
  await assert.rejects(core.publish({ action: 'submit', files: [outside], title: 'a', tags: ['a'] }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  await assert.rejects(core.publish({ action: 'dynamic_post', text: 'leak', images: [outside] }), { code: 'PATH_OUTSIDE_WORKSPACE' });
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

test('named profiles, waitSeconds timeout extension, and expectedMid write lock isolate accounts fail-closed', async (t) => {
  const dir = await workspace(t);
  const niaHome = path.join(dir, 'nia-home');
  const mainHome = path.join(dir, 'main-home');
  await mkdir(niaHome, { recursive: true });
  await mkdir(mainHome, { recursive: true });
  await writeFile(path.join(niaHome, 'credential.json'), JSON.stringify({ sessdata: 'nia_sess', bili_jct: 'csrf1', dedeuserid: '1245004422' }));

  const settings = {
    cliHome: niaHome,
    profiles: `${`nia=${niaHome}`}\n${`main=${mainHome}`}`,
    defaultProfile: 'nia',
    timeoutMs: 5000,
  };

  const spawned = [];
  const spawnImpl = (exe, args, options) => {
    spawned.push({ exe, args, home: options.env.BILI_CLI_HOME });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit('spawn');
      if (args.includes('status') && options.env.BILI_CLI_HOME === mainHome) {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: { code: 'not_logged_in', message: 'not logged in' } })));
        child.emit('close', 3);
        return;
      }
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, data: { logged_in: true, user: { mid: 1245004422, name: 'Nia' } } })));
      child.emit('close', 0);
    });
    return child;
  };

  const core = createBilibiliCore({ settings, workspaceRoot: dir, spawnImpl });

  // Enumerate all profiles without failing on unauthenticated main profile
  const listed = await core.account({ action: 'profiles' });
  assert.equal(listed.profiles.length, 3);
  const niaEntry = listed.profiles.find((p) => p.name === 'nia');
  const mainEntry = listed.profiles.find((p) => p.name === 'main');
  assert.equal(niaEntry.active, true);
  assert.equal(niaEntry.logged_in, true);
  assert.equal(mainEntry.active, false);
  assert.equal(mainEntry.logged_in, false);
  assert.equal(mainEntry.code, 'not_logged_in');

  // Unknown profile or raw path in profile arg fails closed before spawn
  const beforeCount = spawned.length;
  await assert.rejects(core.account({ action: 'status', profile: 'unknown' }), (err) => err.code === 'CONFIGURATION' && err.submission === 'not_sent');
  await assert.rejects(core.account({ action: 'status', profile: mainHome }), (err) => err.code === 'CONFIGURATION' && err.submission === 'not_sent');
  assert.equal(spawned.length, beforeCount);

  // expectedMid blocks mismatched UID and unauthenticated profile BEFORE any spawn!
  await assert.rejects(
    core.interact({ action: 'comment', video: 'BV1Q541167Qg', text: 'hi', profile: 'nia', expectedMid: 999999 }),
    (err) => err.code === 'ACCOUNT_MISMATCH' && err.submission === 'not_sent',
  );
  await assert.rejects(
    core.interact({ action: 'comment', video: 'BV1Q541167Qg', text: 'hi', profile: 'main', expectedMid: 1245004422 }),
    (err) => err.code === 'ACCOUNT_MISMATCH' && err.submission === 'not_sent',
  );
  assert.equal(spawned.length, beforeCount);

  // Matching expectedMid allows write on niaHome
  const okComment = await core.interact({ action: 'comment', video: 'BV1Q541167Qg', text: 'hi', profile: 'nia', expectedMid: 1245004422 });
  assert.equal(okComment.submission, 'accepted');
  assert.equal(spawned.at(-1).home, niaHome);

  // waitSeconds extends timeout beyond short configured timeoutMs (5000ms -> 75000ms)
  const cliCalls = [];
  const mockCore = createBilibiliCore({ settings, cli: async (args, opts) => { cliCalls.push({ args, opts }); return { logged_in: false }; } });
  await mockCore.account({ action: 'status', profile: 'main', waitSeconds: 60 });
  assert.deepEqual(cliCalls[0].args, ['auth', 'status', '--wait', '60']);
  assert.equal(cliCalls[0].opts.timeoutMs, 75000);
  assert.equal(cliCalls[0].opts.profile, 'main');
});

test('CLI rejects invalid configured or overridden timeouts before spawning and accepts timer-safe boundaries', async () => {
  const cliHome = path.resolve('.tmp/profile');
  const invalid = [NaN, Infinity, -Infinity, -1, 0, 999, 1000.5, 2147483648, '1000', '', null, false];
  for (const timeoutMs of invalid) {
    const fixture = fakeSpawn();
    assert.throws(() => createCli({ settings: { cliHome, timeoutMs }, ...fixture }), (error) => error.code === 'CONFIGURATION' && error.submission === 'not_sent');
    const cli = createCli({ settings: { cliHome }, ...fixture });
    await assert.rejects(cli(['upload', 'video'], { write: true, timeoutMs }), (error) => error.code === 'CONFIGURATION' && error.submission === 'not_sent');
    assert.equal(fixture.calls.length, 0);
  }
  for (const timeoutMs of [undefined, 1000, 600000, 2147483647]) {
    const fixture = fakeSpawn();
    const cli = createCli({ settings: { cliHome, timeoutMs }, ...fixture });
    assert.deepEqual(await cli(['auth', 'status']), { rpid: 1 });
    assert.deepEqual(await cli(['--version'], { timeoutMs: 10000 }), { rpid: 1 });
    assert.equal(fixture.calls.length, 2);
  }
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
  await writeFile(path.join(dir, 'cover43.png'), 'fixture');
  await core.publish({ action: 'submit', files: ['a.mp4'], cover: 'cover.png', cover43: 'cover43.png', topic: 'AI', season: 3, dynamicText: 'hi', noReprint: true, title: 'title', tags: ['tag'], description: 'desc', tid: 1, zone: 2 });
  await core.publish({ action: 'edit', bvid: 'BV1Q541167Qg', title: 'edited', cover: 'cover.png', video: 'a.mp4', aiDeclare: true });
  await core.publish({ action: 'dynamic_post', text: 'hello', images: ['cover.png'], mentions: ['123'], topic: '10', voteTitle: 'poll', voteOptions: ['A', 'B'] });
  await core.publish({ action: 'season_create', title: 'season', cover: 'cover.png', description: 'desc' });
  await core.watch({ action: 'visual', video: 'av123', timestamps: [0.25, 0.5] });
  const result = spawnSync(process.env.BILI_CONTRACT_PYTHON, [path.join(root, 'test/cli-contract.py')], { input: JSON.stringify(commands), encoding: 'utf8', env: { ...process.env, BILI_CLI_HOME: dir, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).accepted, commands.length);
  const feedResult = spawnSync(process.env.BILI_CONTRACT_PYTHON, [path.join(root, 'test/feed-contract.py')], { encoding: 'utf8', env: { ...process.env, BILI_CLI_HOME: dir, PYTHONUTF8: '1' } });
  assert.equal(feedResult.status, 0, feedResult.stderr + feedResult.stdout);
  assert.equal(JSON.parse(feedResult.stdout).inbox.replies[0].rpid, 11);
});

test('daemon _fast_me_stats normalizes None creative-center payloads on 0-video accounts without AttributeError', { skip: !process.env.BILI_CONTRACT_PYTHON }, async (t) => {
  const dir = await workspace(t);
  const probeScript = [
    'import asyncio, importlib.util, json, socket, sys',
    'loop = asyncio.new_event_loop()',
    'def deny(*a, **kw): raise AssertionError("Unexpected network access")',
    'socket.create_connection = deny',
    'socket.socket.connect = deny',
    'spec = importlib.util.spec_from_file_location("kiki_bili_daemon", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'mod.config.require_credential = lambda: object()',
    'scenarios = [',
    '  ("all_none", None, None, None, None, None),',
    '  ("nested_none", {"log_date": 20261126, "play": 0}, {"all_fans": 3}, {"play_proportion": None, "audience_proportion": {"fans": None, "guest": 10}}, None, {"2026-11-26": None}),',
    '  ("empty_list_survey_and_arc_none", {}, {}, {"play_proportion": {"new_web": None, "new_app": 7500}, "audience_proportion": None}, {"play_pass_peer": 0}, {"2026-11-26": {"arc_inc": [None, {"bvid": "BV1xx", "title": "demo", "incr": 12}]}}),',
    '  ("list_survey", None, None, None, None, []),',
    ']',
    'async def run_all():',
    '  out = {}',
    '  for name, ov, fn, src, cmp_, srv in scenarios:',
    '    async def _ret(val): return val',
    '    mod.bili_cc.get_overview = lambda cred, p, v=ov: _ret(v)',
    '    mod.bili_cc.get_fan_overview = lambda cred, p, v=fn: _ret(v)',
    '    mod.bili_cc.get_video_source = lambda cred, v=src: _ret(v)',
    '    mod.bili_cc.get_compare = lambda cred, v=cmp_: _ret(v)',
    '    mod.bili_cc.get_video_survey = lambda cred, v=srv: _ret(v)',
    '    out[name] = await mod._fast_me_stats("month")',
    '  return out',
    'try:',
    '  mod._IPC_OUT.write((json.dumps(loop.run_until_complete(run_all()), ensure_ascii=False) + "\\n").encode("utf-8"))',
    'finally:',
    '  loop.close()',
  ].join('\n');
  const result = spawnSync(
    process.env.BILI_CONTRACT_PYTHON,
    ['-c', probeScript, path.join(root, 'lib/daemon.py')],
    { encoding: 'utf8', env: { ...process.env, BILI_CLI_HOME: dir, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.all_none.period, 'month');
  assert.equal(parsed.all_none.data_date, null);
  assert.deepEqual(parsed.all_none.plays, { now: null, previous: null });
  assert.deepEqual(parsed.all_none.fans, { total: null, followed: null, unfollowed: null, interacting_percent: null });
  assert.deepEqual(parsed.all_none.play_platforms_percent, {});
  assert.equal(parsed.all_none.plays_from_fans_percent, null);
  assert.deepEqual(parsed.all_none.top_videos_yesterday, []);

  assert.equal(parsed.nested_none.data_date, '20261126');
  assert.equal(parsed.nested_none.fans.total, 3);
  assert.equal(parsed.nested_none.plays_from_fans_percent, 0);
  assert.deepEqual(parsed.nested_none.top_videos_yesterday, []);

  assert.deepEqual(parsed.empty_list_survey_and_arc_none.play_platforms_percent, { app: 75 });
  assert.deepEqual(parsed.empty_list_survey_and_arc_none.top_videos_yesterday, [{ bvid: 'BV1xx', title: 'demo', plays: 12 }]);
  assert.deepEqual(parsed.list_survey.top_videos_yesterday, []);
});

test('warm daemon reuses a single Python worker per profile, kills on write abort, and closes cleanly', { skip: !process.env.BILI_CONTRACT_PYTHON, timeout: 30000 }, async (t) => {
  t.after(async () => { await closeAllDaemons(); });
  await closeAllDaemons();

  const dir = await workspace(t);
  const homeA = path.join(dir, 'profile-a');
  const homeB = path.join(dir, 'profile-b');
  await mkdir(homeA, { recursive: true });
  await mkdir(homeB, { recursive: true });

  const executable = path.join(path.dirname(process.env.BILI_CONTRACT_PYTHON), process.platform === 'win32' ? 'bili.exe' : 'bili');
  const settings = {
    biliCliPath: executable,
    profiles: JSON.stringify({ a: homeA, b: homeB }),
    defaultProfile: 'a',
    ffmpegDir: process.env.FFMPEG_PATH || '',
  };

  const core = createBilibiliCore({ settings, workspaceRoot: dir });

  // Cold boot + warm up daemon for profile 'a'
  const firstDiag = await core.diagnose({ profile: 'a' });
  assert.equal(firstDiag.cli.version, '1.0.0');
  const pidsAfterFirst = getActiveDaemonPids();
  assert.equal(pidsAfterFirst.length, 1);
  const pidA = pidsAfterFirst[0].pid;

  // Subsequent warm calls reuse the exact same PID in < 50ms
  const t0 = performance.now();
  const secondDiag = await core.diagnose({ profile: 'a' });
  const warmMs = performance.now() - t0;
  assert.equal(secondDiag.cli.version, '1.0.0');
  assert.ok(warmMs < 50, `Expected warm diagnose < 50ms, got ${warmMs.toFixed(2)}ms`);
  assert.deepEqual(getActiveDaemonPids().map((x) => x.pid), [pidA]);

  // Profile 'b' gets its own isolated daemon process
  const diagB = await core.diagnose({ profile: 'b' });
  assert.equal(diagB.cli.version, '1.0.0');
  const bothPids = getActiveDaemonPids();
  assert.equal(bothPids.length, 2);
  const pidB = bothPids.find((x) => x.profileHome === path.resolve(homeB)).pid;
  assert.notEqual(pidA, pidB);

  // Before-send error (not_logged_in on write) reports submission: 'not_sent' and keeps daemon alive
  await assert.rejects(
    core.interact({ action: 'comment', video: 'BV1Q541167Qg', text: 'hello', profile: 'a' }),
    (err) => err.code === 'not_logged_in' && err.submission === 'not_sent',
  );
  assert.ok(getActiveDaemonPids().some((x) => x.pid === pidA));

  // Aborting an in-flight write kills that profile's daemon immediately and reports submission: 'unknown'
  const abortController = new AbortController();
  const abortCli = createCli({ settings, workspaceRoot: dir, signal: abortController.signal });
  const pendingWrite = abortCli(['comment', 'post', '--', 'BV1Q541167Qg', 'abort-me'], { write: true, profile: 'a' });
  queueMicrotask(() => abortController.abort());
  await assert.rejects(pendingWrite, (err) => err.code === 'LOCAL_ABORTED' && err.submission === 'unknown');
  assert.equal(getActiveDaemonPids().some((x) => x.pid === pidA), false, 'Aborted write must evict/kill profile A daemon');
  assert.equal(getActiveDaemonPids().some((x) => x.pid === pidB), true, 'Profile B daemon remains untouched');

  // Next read on profile 'a' cleanly starts a fresh daemon PID
  await core.diagnose({ profile: 'a' });
  const newPidA = getActiveDaemonPids().find((x) => x.profileHome === path.resolve(homeA))?.pid;
  assert.ok(newPidA && newPidA !== pidA);

  await closeAllDaemons();
  assert.equal(getActiveDaemonPids().length, 0);
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
    const diagnosed = await rpc('execute', {
      name: 'bilibili_diagnose',
      args: {},
      settings: { biliCliPath: executable, cliHome: dir, ffmpegDir: process.env.FFMPEG_PATH || '' },
      workspaceRoot: dir,
    });
    assert.equal(diagnosed.isError, undefined);
    assert.equal(JSON.parse(diagnosed.output[0].text).cli.version, '1.0.0');
  }
  await rpc('shutdown', {});
  await closed;
});
