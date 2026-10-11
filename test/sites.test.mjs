import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Sites } from '../plugins/official/kiki-sites/lib/sites.mjs';
import { Adapters, cliEnvironment, loginCommand } from '../plugins/official/kiki-sites/lib/adapters.mjs';
import { catalog } from '../plugins/official/kiki-sites/lib/catalog.mjs';
import { definitions } from '../plugins/official/kiki-sites/lib/definitions.mjs';
import { run, request, executable, dataDirectory, SitesError } from '../plugins/official/kiki-sites/lib/runtime.mjs';
import { register, handlePanelRequest, sitesInstance } from '../plugins/official/kiki-sites/entry.mjs';
const base = path.resolve('.tmp/sites-plugin');
async function fixture(deps = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'test-')); const project = path.join(root, 'project'); await mkdir(path.join(project, 'dist'), { recursive: true }); await writeFile(path.join(project, 'dist/index.html'), '<h1>Fixture</h1>'); await writeFile(path.join(project, 'package.json'), '{"name":"example-project"}'); await writeFile(path.join(project, 'wrangler.toml'), 'name = "example-worker"'); await writeFile(path.join(project, 'fly.toml'), 'app = "example-app"');
  const settings = { dataDirectory: path.join(root, 'home') }; return { root, project, settings, sites: new Sites(settings, deps) };
}
const checkCli = async (_command, args) => ({ stdout: args[0] === 'deploy' ? 'https://example.vercel.app' : '{"id":"example-user"}', stderr: '' });
async function connect(sites, service, extra = {}) { const r = await sites.action('save_connection', { connection: { service, enabled: true, authMode: catalog.find(s => s.id === service).cli ? 'cli' : 'token', ...extra }, ...(extra.authMode === 'token' || !catalog.find(s => s.id === service).cli ? { token: 'fixture-token-not-real' } : {}) }); assert.equal(r.ok, true, JSON.stringify(r)); return r.connection; }
async function save(sites, project, c, fields = {}) { const r = await sites.action('save_target', { target: { service: c.service, connectionId: c.id, project, ...fields } }); assert.equal(r.ok, true, JSON.stringify(r)); return r.target; }
async function finish(sites, job) { await sites.active.get(job.id)?.promise; return (await sites.action('job', { id: job.id })).job; }

test('manifest definitions, current settings shape and static routing skill agree', async () => {
  const m = JSON.parse(await readFile('plugins/official/kiki-sites/kimi.plugin.json', 'utf8')); assert.deepEqual(m['x-kiki'].tools, definitions); assert.equal(m['x-kiki'].entry, './entry.mjs'); assert.equal(m['x-kiki'].settings.schema.properties.dataDirectory.type, 'string');
  const registered = []; register({ registerTool: (d, f) => registered.push([d, f]) }); assert.deepEqual(registered.map(r => r[0]), definitions); assert.equal(typeof registered[1][1], 'function');
  const skill = await readFile('plugins/official/kiki-sites/skills/kiki-sites/SKILL.md', 'utf8'); assert.match(skill, /action: "guidance"/); assert.match(skill, /Not for local preview/); assert.match(skill, /does not upload code/); assert.match(skill, /without a second plugin-specific confirmation/);
});

test('persistent configuration, enable/disable guidance, token write-only and code/deploy separation', async () => {
  const f = await fixture({ run: checkCli }); const c = await connect(f.sites, 'github', { authMode: 'token' });
  const initial = await f.sites.action('state'); assert.equal(initial.connections[0].hasToken, true); assert.equal(JSON.stringify(initial).includes('fixture-token-not-real'), false); assert.deepEqual(initial.guidance.services[0].operations, ['check_auth', 'repositories']);
  const wrong = await f.sites.action('save_target', { target: { service: 'github', project: f.project, connectionId: c.id } }); assert.equal(wrong.error.code, 'wrong_kind');
  await f.sites.action('set_enabled', { id: c.id, enabled: false }); const restored = new Sites(f.settings, { run: checkCli }); assert.equal((await restored.action('guidance')).guidance.services.length, 0); assert.equal((await restored.action('check_auth', { id: c.id })).error.code, 'disabled');
  await restored.action('set_enabled', { id: c.id, enabled: true }); assert.equal((await restored.action('guidance')).guidance.services[0].service, 'github');
});

test('project configuration -> token-free preview -> deploy result/URL, stale preview and disabled target', async () => {
  const calls = []; const f = await fixture({ run: async (cli, argv, opts) => { calls.push({ cli, argv, opts }); return checkCli(cli, argv); } });
  const c = await connect(f.sites, 'vercel', { authMode: 'token' }); const t = await save(f.sites, f.project, c, { projectId: 'prj_example', orgId: 'team_example', production: true });
  const p = await f.sites.action('preview', { id: t.id }); assert.equal(p.ok, true); assert.equal(calls.length, 0); assert.equal(JSON.stringify(p).includes('fixture-token-not-real'), false); assert.deepEqual(p.preview.command.argv, ['deploy', '--project', 'prj_example', '--yes', '--non-interactive', '--prod']);
  const d = await f.sites.action('deploy', { previewId: p.preview.id }); const job = await finish(f.sites, d.job); assert.equal(job.state, 'ready'); assert.equal(job.result.url, 'https://example.vercel.app'); assert.equal(calls[1].opts.env.VERCEL_PROJECT_ID, 'prj_example'); assert.equal(calls[1].opts.env.VERCEL_ORG_ID, 'team_example'); assert.equal(calls[1].opts.env.VERCEL_TOKEN, 'fixture-token-not-real'); assert.equal(calls[1].argv.includes('fixture-token-not-real'), false);
  const p2 = await f.sites.action('preview', { id: t.id }); await writeFile(path.join(f.project, 'package.json'), '{"name":"changed"}'); assert.equal((await f.sites.action('deploy', { previewId: p2.preview.id })).error.code, 'preview_stale');
  await f.sites.action('set_enabled', { id: c.id, enabled: false }); assert.equal((await f.sites.action('deploy', { id: t.id })).error.code, 'disabled');
  const restored = new Sites(f.settings); assert.equal((await restored.action('job', { id: job.id })).job.result.url, job.result.url);
});

test('unlogged, expired and offline auth states are recoverable and retain config', async () => {
  for (const code of ['not_logged_in', 'expired', 'offline', 'missing_cli']) {
    const f = await fixture({ run: async () => { throw new SitesError(code, 'Controlled fixture failure.', 'Retry authentication.'); } }); const c = await connect(f.sites, 'vercel'); const r = await f.sites.action('check_auth', { id: c.id }); assert.equal(r.auth.state, code); assert.ok(r.auth.recovery); assert.equal((await f.sites.action('state')).connections.length, 1);
  }
  const f = await fixture(); const c = await connect(f.sites, 'render'); await f.sites.action('save_connection', { connection: { ...c, authMode: 'token' }, clearToken: true }); assert.equal((await f.sites.action('check_auth', { id: c.id })).auth.state, 'not_logged_in');
});

test('browser login exposes official URL/device code, completes or cancels without tokens', async () => {
  let cancelled = false; const f = await fixture({ run: async (_cli, argv, options) => {
    if (argv[0] === 'auth' && argv[1] === 'login') { options.onText('First copy your one-time code: ABCD-EFGH\nhttps://github.com/login/device\n'); return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { cancelled = true; reject(new SitesError('cancelled', 'Cancelled.')); }, { once: true }); }); }
    return { stdout: '{}', stderr: '' };
  } }); const c = await connect(f.sites, 'github'); const r = await f.sites.action('login', { id: c.id }); await f.sites.store.queue; const status = await f.sites.action('job', { id: r.job.id }); assert.equal(status.job.loginUrl, 'https://github.com/login/device'); assert.equal(status.job.deviceCode, 'ABCD-EFGH'); const stopped = await f.sites.action('cancel_job', { id: r.job.id }); assert.equal(cancelled, true); assert.equal(stopped.job.state, 'cancelled');
  const success = await fixture({ run: checkCli }); const vc = await connect(success.sites, 'vercel'); const login = await success.sites.action('login', { id: vc.id }); assert.equal((await finish(success.sites, login.job)).state, 'completed');
});

test('cancelled deploy and interrupted waiting do not fabricate failure or retry', async () => {
  const f = await fixture({ run: async (_cli, argv, opts) => argv[0] !== 'deploy' ? { stdout: 'user', stderr: '' } : new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new SitesError('cancelled', 'Stopped.')), { once: true })) }); const c = await connect(f.sites, 'vercel'); const t = await save(f.sites, f.project, c, { projectId: 'prj_example', orgId: 'team_example' }); const d = await f.sites.action('deploy', { id: t.id }); const cancelled = await f.sites.action('cancel_job', { id: d.job.id }); assert.equal(cancelled.job.state, 'unknown'); assert.match(cancelled.job.error.recovery, /provider/);
  await f.sites.store.update(s => s.jobs.push({ id: 'interrupted', kind: 'deploy', state: 'running', target: t })); assert.equal((await new Sites(f.settings).action('job', { id: 'interrupted' })).job.state, 'unknown');
});

test('all seven deploy adapters select exact provider parameters and target semantics', async () => {
  const calls = []; const a = new Adapters({ run: async (cli, argv, opts) => { calls.push({ cli, argv, opts }); return { stdout: cli === 'netlify' ? '{"deploy_id":"dep_example","deploy_url":"https://example.netlify.app"}' : cli === 'railway' ? '{"message":"build log"}\n{"status":"success"}\n' : 'https://example.workers.dev', stderr: '' }; }, fetchImpl: async (url, opts) => { assert.equal(url, 'https://api.render.com/v1/services/srv_example/deploys'); assert.equal(opts.method, 'POST'); assert.deepEqual(JSON.parse(opts.body), { clearCache: 'do_not_clear' }); return Response.json({ id: 'dep_example', status: 'queued' }); } });
  const fixtures = {
    vercel: { projectId: 'prj_example', orgId: 'team_example', prebuilt: true }, netlify: { siteId: 'site_example', directory: 'dist', production: true }, 'cloudflare-pages': { projectName: 'example-pages', branch: 'main', directory: 'dist' }, 'cloudflare-workers': { config: 'wrangler.toml', environment: 'staging' }, railway: { projectId: 'project_example', serviceId: 'service_example', environment: 'production' }, fly: { app: 'example-app', config: 'fly.toml' }, render: { serviceId: 'srv_example' },
  };
  for (const [service, fields] of Object.entries(fixtures)) {
    const c = { service, authMode: 'token', token: 'fixture-token-not-real', accountId: 'account_example' }; const result = await a.deploy(c, { service, project: base, ...fields }); assert.ok(['ready', 'submitted', 'completed_without_url'].includes(result.state));
    if (service === 'render') assert.equal(result.remoteId, 'dep_example');
    if (service === 'railway') { assert.equal(result.deploymentSucceeded, true); assert.equal(result.url, undefined); }
  }
  assert.deepEqual(calls.find(c => c.cli === 'netlify').argv, ['deploy', '--site', 'site_example', '--dir', 'dist', '--no-build', '--json', '--prod']);
  const pages = calls.filter(c => c.cli === 'wrangler'); assert.deepEqual(pages[0].argv, ['pages', 'deployment', 'list', '--project-name', 'example-pages']); assert.deepEqual(pages[1].argv, ['pages', 'deploy', 'dist', '--project-name', 'example-pages', '--branch', 'main']); assert.deepEqual(pages[2].argv, ['deploy', '--config', 'wrangler.toml', '--env', 'staging']); assert.equal(pages[1].opts.env.CLOUDFLARE_ACCOUNT_ID, 'account_example');
  assert.deepEqual(calls.find(c => c.cli === 'railway').argv, ['up', '--project', 'project_example', '--service', 'service_example', '--environment', 'production', '--json']); assert.deepEqual(calls.find(c => c.cli === 'flyctl').argv, ['deploy', '--app', 'example-app', '--config', 'fly.toml', '--yes']);
  assert.equal(cliEnvironment({ service: 'railway', authMode: 'token', token: 'x' }).RAILWAY_TOKEN, undefined); assert.equal(cliEnvironment({ service: 'fly', authMode: 'token', token: 'x' }).FLY_ACCESS_TOKEN, 'x'); assert.ok(loginCommand({ service: 'gitlab', baseUrl: 'https://gitlab.example.test' }).includes('gitlab.example.test'));
});

test('six code hosting adapters use verified API bases/auth and bounded pagination', async () => {
  const cases = [
    ['github', 'https://api.github.com', '/user/repos?per_page=30&page=1', 'Bearer fixture-token-not-real'],
    ['gitlab', 'https://gitlab.example.test', '/api/v4/projects?membership=true&per_page=30&page=1', 'Bearer fixture-token-not-real'],
    ['gitea', 'https://git.example.test', '/api/v1/user/repos?limit=30&page=1', 'token fixture-token-not-real'],
    ['forgejo', 'https://forge.example.test', '/api/v1/user/repos?limit=30&page=1', 'token fixture-token-not-real'],
    ['gitee', 'https://gitee.com', '/api/v5/user/repos?per_page=30&page=1', 'Bearer fixture-token-not-real'],
    ['bitbucket', 'https://api.bitbucket.org/2.0', '/repositories/example-workspace?pagelen=30&page=1', `Basic ${Buffer.from('user@example.test:fixture-token-not-real').toString('base64')}`],
  ];
  for (const [service, baseUrl, suffix, authorization] of cases) {
    let count = 0; const a = new Adapters({ fetchImpl: async (url, options) => { count++; assert.equal(url, baseUrl + suffix); assert.equal(options.headers.Authorization, authorization); assert.equal(options.redirect, 'error'); const repo = { id: 1, full_name: 'example/repository', html_url: 'https://example.test/repository', private: true }; return Response.json(service === 'bitbucket' ? { values: [repo], next: 'https://api.bitbucket.org/2.0/next' } : [repo]); } }); const result = await a.repositories({ service, baseUrl, authMode: 'token', token: 'fixture-token-not-real', username: 'user@example.test' }, service === 'bitbucket' ? { owner: 'example-workspace' } : {}); assert.equal(count, 1); assert.equal(result.repositories[0].name, 'example/repository'); assert.equal(result.repositories[0].private, true);
  }
});

test('GitHub and GitLab token authentication works without requiring their CLI', async () => {
  for (const [service, baseUrl, url] of [['github', 'https://github.example.test', 'https://github.example.test/api/v3/user'], ['gitlab', 'https://gitlab.example.test/team', 'https://gitlab.example.test/team/api/v4/user']]) {
    const adapters = new Adapters({ run: async () => { throw new Error('Token mode must not execute a code-hosting CLI'); }, fetchImpl: async (actual, opts) => { assert.equal(actual, url); assert.equal(opts.headers.Authorization, 'Bearer fixture-token-not-real'); return Response.json({ id: 1 }); } });
    await adapters.check({ service, baseUrl, authMode: 'token', token: 'fixture-token-not-real' });
  }
});

test('Render remote source -> accepted id -> automatic status -> live URL, HTTP failures are honest', async () => {
  const seen = []; const f = await fixture({ pollInterval: 0, fetchImpl: async (url, opts) => {
    seen.push([url, opts.method]); const base = 'https://api.render.com/v1';
    if (url === base + '/owners?limit=1') return Response.json([{ owner: { id: 'owner_example' } }]);
    if (url === base + '/services/srv_example/deploys' && opts.method === 'POST') return Response.json({ id: 'dep_example', status: 'queued' });
    if (url === base + '/services/srv_example/deploys/dep_example') return Response.json({ id: 'dep_example', status: 'live' });
    if (url === base + '/services/srv_example') return Response.json({ serviceDetails: { url: 'https://example.onrender.com' } });
    throw new Error('Unexpected HTTP fixture request');
  } }); const c = await connect(f.sites, 'render'); const t = await save(f.sites, f.project, c, { serviceId: 'srv_example' }); const p = await f.sites.action('preview', { id: t.id }); assert.equal(p.preview.source.localUpload, false); const d = await f.sites.action('deploy', { id: t.id }); const job = await finish(f.sites, d.job); assert.equal(job.state, 'ready'); assert.equal(job.result.url, 'https://example.onrender.com'); assert.equal(seen.filter(r => r[1] === 'POST').length, 1);
  for (const [status, expected] of [[401, 'expired'], [403, 'forbidden'], [500, 'result_unknown']]) await assert.rejects(request('https://example.test', { method: 'POST', fetchImpl: async () => new Response('', { status }) }), e => e.code === expected);
  await assert.rejects(request('https://example.test', { fetchImpl: async () => { throw new Error('offline'); } }), e => e.code === 'offline');
});

test('private CLI installation pins upstream version, ignores scripts and stores path without manual editing', async () => {
  const calls = []; const f = await fixture({ installRunner: async (cmd, args) => { calls.push([cmd, args]); const prefix = args[args.indexOf('--prefix') + 1]; await mkdir(path.join(prefix, 'node_modules/vercel/dist'), { recursive: true }); await writeFile(path.join(prefix, 'node_modules/vercel/dist/index.js'), ''); return { stdout: '', stderr: '' }; } }); const c = await connect(f.sites, 'vercel'); const d = await f.sites.action('install_cli', { id: c.id }); const job = await finish(f.sites, d.job); assert.equal(job.state, 'completed'); assert.equal(calls[0][0], 'npm'); assert.ok(calls[0][1].includes('vercel@62.2.0')); assert.ok(calls[0][1].includes('--ignore-scripts')); assert.equal(calls[0][1].includes('--global'), false); assert.equal((await f.sites.action('state')).connections[0].cliPath, job.result.cliPath);
});

test('real local process fixture: argument boundaries, secret redaction, cancellation and Windows npm shims', async () => {
  const f = await fixture(); const cli = path.join(f.root, 'fixture-cli.mjs'); await writeFile(cli, `if(process.argv[2]==='wait'){console.log('started');setInterval(()=>{},1000);}else {console.log(JSON.stringify(process.argv.slice(2)));console.error(process.env.EXAMPLE_TOKEN);}`);
  const r = await run(cli, ['a b', 'x&y', '$(not-a-shell)'], { env: { EXAMPLE_TOKEN: 'fixture-secret' }, secrets: ['fixture-secret'], timeout: 5000 }); assert.deepEqual(JSON.parse(r.stdout), ['a b', 'x&y', '$(not-a-shell)']); assert.equal(r.stderr.includes('fixture-secret'), false);
  const controller = new AbortController(); await assert.rejects(run(cli, ['wait'], { signal: controller.signal, onText: () => controller.abort(), timeout: 5000 }), e => e.code === 'cancelled');
  const lookupCancel = new AbortController(); let startedAfterCancel = false; const lookup = run(cli, ['wait'], { signal: lookupCancel.signal, onText: () => { startedAfterCancel = true; }, timeout: 1000 }); lookupCancel.abort(); await assert.rejects(lookup, e => e.name === 'AbortError'); assert.equal(startedAfterCancel, false);
  const shim = path.join(f.root, 'official.cmd'); await writeFile(shim, '@echo off\n"%dp0%\\fixture-cli.mjs" %*'); assert.equal((await executable(shim)).prefix[0], cli);
  const npmShim = path.join(f.root, 'npm.cmd'); const npmJs = path.join(f.root, 'node_modules/npm/bin/npm-cli.js'); await mkdir(path.dirname(npmJs), { recursive: true }); await writeFile(npmJs, ''); await writeFile(npmShim, 'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\n"%NODE_EXE%" "%NPM_CLI_JS%" %*'); assert.equal((await executable(npmShim)).prefix[0], npmJs);
  assert.throws(() => dataDirectory({ dataDirectory: 'relative-path' }), e => e.code === 'invalid_data_directory');
});

test('Pages and Workers reuse one installed official Wrangler and login loader without tunnel dependency', async () => {
  const calls = []; const f = await fixture({ run: async (command, argv, opts) => { calls.push({ command, argv, opts }); return { stdout: '{"authenticated":true}', stderr: '' }; } });
  const installed = path.join(f.settings.dataDirectory, 'cli/wrangler-4.147.0/node_modules/wrangler/bin/wrangler.js'); await mkdir(path.dirname(installed), { recursive: true }); await writeFile(installed, '');
  const pages = await connect(f.sites, 'cloudflare-pages'); const workers = await connect(f.sites, 'cloudflare-workers');
  assert.equal((await f.sites.action('check_auth', { id: pages.id })).auth.state, 'valid'); assert.equal((await f.sites.action('check_auth', { id: workers.id })).auth.state, 'valid');
  assert.equal(calls[0].command, installed); assert.equal(calls[1].command, installed); assert.deepEqual(calls[0].argv, ['whoami', '--json']); assert.equal(calls.some(c => c.argv.includes('login')), false); assert.equal(calls.some(c => Object.keys(c.opts.env).some(k => /TUNNEL/.test(k))), false);
});

test('cancelling during authentication checks cannot later submit an upload', async () => {
  const controller = new AbortController(); let uploads = 0;
  const f = await fixture({ run: async (_cli, argv) => { if (argv[0] === 'whoami') controller.abort(); else uploads++; return { stdout: 'fixture-user', stderr: '' }; } }); const c = await connect(f.sites, 'vercel'); const t = await save(f.sites, f.project, c, { projectId: 'prj_example', orgId: 'team_example' });
  const result = await f.sites.action('deploy', { id: t.id }, { signal: controller.signal }); assert.equal(result.error.code, 'cancelled'); assert.equal(uploads, 0); assert.equal((await f.sites.action('state')).jobs.length, 0);
});

test('panel action and native tool use the same isolated persisted backend and wait for actual result', async () => {
  const f = await fixture(); const settings = f.settings; const sites = sitesInstance(settings); sites.adapters = new Adapters({ run: checkCli }); const c = (await handlePanelRequest('save_connection', { connection: { service: 'vercel', enabled: true, authMode: 'cli' } }, { settings })).connection; const t = await save(sites, f.project, c, { projectId: 'prj_example', orgId: 'team_example' }); const handlers = {}; register({ registerTool: (d, fn) => { handlers[d.name] = fn; } }); const result = await handlers.sites_project({ action: 'deploy', id: t.id, project: f.project }, { settings, signal: new AbortController().signal, progress() {} }); const data = JSON.parse(result.output); assert.equal(data.job.state, 'ready'); assert.equal(data.job.result.url, 'https://example.vercel.app'); assert.equal((await handlePanelRequest('state', {}, { settings })).jobs[0].id, data.job.id);
  const wrong = await handlers.sites_project({ action: 'deploy', id: t.id, project: f.root }, { settings, signal: new AbortController().signal, progress() {} }); assert.equal(JSON.parse(wrong.output).error.code, 'project_mismatch');
});
