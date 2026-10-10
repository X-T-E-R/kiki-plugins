import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CloudflareService, validateValues } from '../plugins/official/kiki-cloudflare/lib/service.mjs';
import { CloudflareAccount } from '../plugins/official/kiki-cloudflare/lib/account.mjs';
import { installBinary } from '../plugins/official/kiki-cloudflare/lib/binary.mjs';

test('App management is sessionless and reports credential provenance without secrets', async (t) => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/official/kiki-cloudflare/kimi.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest['x-kiki'].activation, 'app');
  assert.equal(manifest['x-kiki'].panels[0].slot, 'sidebar');
  const catalog = JSON.parse(await readFile(new URL('../plugins/marketplace.json', import.meta.url), 'utf8'));
  const entry = catalog.plugins.find((item) => item.id === manifest.name);
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.source, './official/kiki-cloudflare');
  const f = await fixture(t);
  await f.service.activate(f.context({ autoStart: false }));
  let status = await f.service.panel('status');
  assert.equal(status.configuration.source, 'plugin-settings');
  assert.equal(status.configuration.credentialSource, 'none');
  assert.equal(typeof status.dependency.installable, 'boolean');
  await f.service.configure({ tokenFile: path.join(f.root, 'missing-token-file') });
  status = await f.service.panel('status');
  assert.equal(status.configuration.credentialSource, 'existing-token-file');
  assert.equal(status.service.state, 'error');
  await f.service.configure({ mode: 'local' });
  assert.equal((await f.service.panel('status')).configuration.credentialSource, 'none');
  await f.service.configure({ configPath: path.join(f.root, 'config.yml') });
  assert.equal((await f.service.panel('status')).configuration.credentialSource, 'existing-local-config');
  assert.equal((await f.service.panel('setup')).url, 'https://dash.cloudflare.com/?to=/:account/tunnels');
});

const scratch = path.resolve('.tmp/cloudflare-plugin/tests');
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const file = path.join(root, 'cloudflared-fixture.mjs');
  await writeFile(file, `import http from 'node:http';
const args=process.argv.slice(2);const at=args.indexOf('--metrics');
if(at<0||args.at(-1)!=='run')process.exit(2);
const [host,port]=args[at+1].split(':');
const server=http.createServer((req,res)=>{if(req.url!=='/ready'){res.writeHead(500);res.end();return;}res.writeHead(200);res.end('ready');});
server.listen(Number(port),host);process.on('SIGTERM',()=>server.close(()=>process.exit()));
`);
  const children = [];
  const service = new CloudflareService({
    spawnFn: (_file, args, options) => { assert.ok(!args.some((arg) => arg.includes('synthetic-token'))); const child = spawn(process.execPath, [file, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); return child; },
    commandFn: async (_file, args) => { assert.deepEqual(args, ['--version']); return 'cloudflared version 2026.10.0'; }, probeMs: 20, retryDelayMs: 20,
  });
  t.after(() => service.deactivate());
  const stored = {};
  const context = (settings) => ({ settings, userHome: root, dataDir: path.join(root, 'data'), updateSettings: async (values) => { for (const [key, value] of Object.entries(values)) { if (value === null) delete stored[key]; else stored[key] = value; } } });
  return { service, stored, context, children, root };
}
async function eventually(work) {
  const until = Date.now() + 6000;
  do { try { return await work(); } catch (error) { if (Date.now() > until) throw error; await new Promise((resolve) => setTimeout(resolve, 20)); } } while (true);
}

test('synthetic process + controlled HTTP: save/connect, readiness, temporary stop, preference off and App restart', async (t) => {
  const f = await fixture(t);
  await f.service.activate(f.context({}));
  assert.equal((await f.service.status()).service.state, 'unconfigured');
  await f.service.configure({ tunnelToken: 'synthetic-token' });
  await eventually(async () => assert.equal((await f.service.status()).service.state, 'running'));
  const pid = f.children[0].pid;
  assert.equal(f.children[0].spawnargs.includes('synthetic-token'), false);
  const publicState = JSON.stringify(await f.service.status()); assert.equal(publicState.includes('synthetic-token'), false);
  await f.service.configure({ autoStart: false });
  assert.equal(f.children[0].pid, pid); assert.equal((await f.service.status()).service.state, 'running');
  await f.service.configure({ apiToken: 'synthetic-account-key', accountId: '0'.repeat(32), publicUrl: 'https://fixture.example.test' });
  assert.equal(f.children.length, 1); assert.equal((await f.service.status()).service.pid, pid);
  assert.equal(JSON.stringify(await f.service.status()).includes('synthetic-account-key'), false);
  await f.service.stop();
  await f.service.configure({ apiToken: 'synthetic-replacement-key', certificatePath: path.join(f.root, 'custom-cert.pem') });
  assert.equal(f.children.length, 1); assert.equal(f.stored.apiToken, 'synthetic-replacement-key');
  assert.equal((await f.service.status()).configuration.autoStart, false); assert.equal((await f.service.status()).service.manualStop, true);
  await f.service.start(); await eventually(async () => assert.equal((await f.service.status()).service.ready, true));
  await f.service.deactivate();
  assert.ok(f.children.every((child) => child.exitCode !== null || child.signalCode !== null));
  const count = f.children.length;
  await f.service.activate(f.context(f.stored)); assert.equal(f.children.length, count); assert.equal((await f.service.status()).service.state, 'stopped');
  await f.service.configure({ autoStart: true }); assert.equal(f.children.length, count);
  await f.service.deactivate(); await f.service.activate(f.context(f.stored));
  await eventually(async () => assert.equal((await f.service.status()).service.ready, true));
  await f.service.stop(); assert.equal((await f.service.status()).configuration.autoStart, true);
  await f.service.activate(f.context(f.stored)); assert.equal((await f.service.status()).service.state, 'stopped');
});

test('unexpected child exit retries, manual stop cancels recovery, existing certificate login is reused without spawn', async (t) => {
  const f = await fixture(t);
  await f.service.activate(f.context({ tunnelToken: 'synthetic-token' }));
  await eventually(async () => assert.equal((await f.service.status()).service.ready, true));
  f.children[0].kill();
  await eventually(async () => { assert.ok(f.children.length >= 2); assert.equal((await f.service.status()).service.ready, true); });
  await f.service.stop(); const count = f.children.length;
  await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(f.children.length, count);
  await mkdir(path.join(f.root, '.cloudflared')); await writeFile(path.join(f.root, '.cloudflared', 'cert.pem'), 'synthetic-certificate');
  assert.equal((await f.service.login()).login.state, 'complete'); assert.equal(f.children.length, count);
});

test('dependency missing and invalid paths fail safely; token supplied never enters public status', async (t) => {
  const f = await fixture(t); f.service.command = async () => { throw new Error('missing'); };
  await f.service.activate(f.context({ tunnelToken: 'synthetic-token' }));
  const state = await f.service.status(); assert.equal(state.dependency.state, 'missing'); assert.equal(state.service.state, 'error'); assert.equal(f.children.length, 0);
  assert.throws(() => validateValues({ configPath: 'relative/path' }), /absolute/);
  assert.throws(() => validateValues({ mode: 'quick' }), /mode/);
  assert.throws(() => validateValues({ publicUrl: 'http://example.test' }), /HTTPS/);
  assert.throws(() => validateValues({ tunnelId: '--token' }), /UUID/);
  assert.equal((await f.service.panel('setup')).managedExternally, true);
});

test('installer uses fixed URL/checksum, needs explicit consent, refuses overwrite, preserves existing identical file', async (t) => {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, 'install-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-binary'); const checksum = createHash('sha256').update(bytes).digest('hex');
  const destination = path.join(root, 'cloudflared');
  let requests = 0;
  const options = { platform: 'linux', arch: 'x64', assets: { 'linux/x64': ['cloudflared-linux-amd64', checksum] }, fetchFn: async (url) => { requests++; assert.equal(url, 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64'); return new Response(bytes); } };
  await assert.rejects(installBinary({ consent: false, destination }, options), /Install/); assert.equal(requests, 0);
  assert.equal(await installBinary({ consent: true, destination }, options), destination);
  assert.equal(await installBinary({ consent: true, destination }, options), destination);
  await writeFile(destination, 'other-owned-file'); await assert.rejects(installBinary({ consent: true, destination }, options), /existing file/); assert.equal(await readFile(destination, 'utf8'), 'other-owned-file');
  await assert.rejects(installBinary({ consent: true, destination: path.join(root, 'bad') }, { ...options, fetchFn: async () => new Response('tampered') }), /checksum/);
});

test('controlled API fixture denies unexpected URLs, pages full accounts and never returns the API token', async () => {
  const calls = [];
  const account = new CloudflareAccount({ apiToken: 'synthetic-account-key', accountId: '0'.repeat(32) }, { fetchFn: async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer synthetic-account-key');
    if (url === 'https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50') return Response.json({ success: true, result: [{ id: '0'.repeat(32), name: 'fixture' }], result_info: { total_pages: 2 } });
    if (url === 'https://api.cloudflare.com/client/v4/accounts?page=2&per_page=50') return Response.json({ success: true, result: [{ id: '1'.repeat(32), name: 'fixture-2' }], result_info: { total_pages: 2 } });
    throw new Error('Unexpected HTTP request');
  } });
  const result = await account.accounts(); assert.equal(result.length, 2); assert.equal(calls.length, 2); assert.equal(JSON.stringify(result).includes('synthetic-account-key'), false);
  await assert.rejects(new CloudflareAccount({}).accounts(), /API token/);
});
