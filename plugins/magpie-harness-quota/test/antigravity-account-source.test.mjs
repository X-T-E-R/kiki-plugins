import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MagpieAntigravityDirectQuotaService, clearCollectorRuntimeCaches, ensureFreshAccessToken } from '../lib/antigravity-direct-quota.mjs';
import { MagpieAntigravityAccountService } from '../lib/antigravity-account-source.mjs';

const SECRET = 'synthetic-oauth-secret';
const CLIENT_ID = 'synthetic-oauth-client';
const TOKEN_A = 'TOKEN-A-DO-NOT-LEAK';
const REFRESH_A = 'REFRESH-A-DO-NOT-LEAK';
const TOKEN_B = 'TOKEN-B-DO-NOT-LEAK';
const REFRESH_B = 'REFRESH-B-DO-NOT-LEAK';
const SIDECAR = process.env.MAGPIE_AGY_SIDECAR ?? path.resolve('.tmp', 'fixture-sidecar');
const HOST_RUNNER = process.env.MAGPIE_AGY_HOST_RUNNER;
const PLUGIN_ENTRY = fileURLToPath(new URL('../entry.mjs', import.meta.url));

let serial = Promise.resolve();
function exclusive(name, fn) {
  test(name, async (context) => {
    const previous = serial;
    let release;
    serial = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      clearCollectorRuntimeCaches();
      await fn(context);
    } finally {
      clearCollectorRuntimeCaches();
      release();
    }
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    server.close(finish);
    setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, 300);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function startUpstream({ holdProjectC = false } = {}) {
  const hits = [];
  const held = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    const proxy = req.headers['x-fixture-proxy'] || 'direct';
    const hit = { proxy, path: url.pathname, authorization: req.headers.authorization ?? '', userAgent: req.headers['user-agent'], body };
    hits.push(hit);
    const send = (status, payload, type = 'application/json') => {
      const encoded = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': type });
      res.end(encoded);
    };
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(body);
      const refresh = form.get('refresh_token');
      const issued = refresh === REFRESH_B ? 'TOKEN-B-REFRESHED' : 'TOKEN-A-REFRESHED';
      send(200, { access_token: issued, expires_in: 3600, token_type: 'Bearer' });
      return;
    }
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
    if (url.pathname === '/v1internal:loadCodeAssist') {
      const project = hit.authorization.includes('TOKEN-B') ? 'project-B' : 'project-A';
      send(200, { cloudaicompanionProject: project, currentTier: { id: 'test-tier' } });
      return;
    }
    if (url.pathname === '/v1internal:fetchAvailableModels') {
      if (holdProjectC && parsed.project === 'project-C') {
        await new Promise((resolve) => {
          held.set('C', resolve);
          req.on('close', resolve);
        });
        if (!res.headersSent) send(499, { error: 'cancelled' });
        return;
      }
      const model = parsed.project === 'project-B' ? 'gemini-3.1-flash-lite-preview' : 'claude-opus-5-5-high';
      send(200, { models: { [model]: { displayName: model } } });
      return;
    }
    if (url.pathname === '/v1internal:streamGenerateContent') {
      const refreshed = hit.authorization.includes('TOKEN-A-REFRESHED');
      if (hit.authorization.includes(TOKEN_A) && !refreshed) {
        send(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'stale' } });
        return;
      }
      if (parsed.project === 'project-A' && refreshed && !startUpstream.sawSuccess) {
        startUpstream.sawSuccess = true;
        send(200, `data: ${JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'scoped-A' }] }, finishReason: 'STOP' }] } })}\n\n`, 'text/event-stream');
        return;
      }
      if (parsed.project === 'project-A' && !startUpstream.saw429) {
        startUpstream.saw429 = true;
        send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'fixture rate limit' } });
        return;
      }
      const text = parsed.project === 'project-B' ? 'scoped-B' : 'scoped-A';
      send(200, `data: ${JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] } })}\n\n`, 'text/event-stream');
      return;
    }
    send(404, { error: 'unexpected' });
  });
  return listen(server).then((port) => ({
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    hits,
    releaseHold() { held.get('C')?.(); },
    close: () => closeServer(server),
  }));
}

function startForwardProxy(id) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch {
      res.writeHead(400).end();
      return;
    }
    hits.push({ id, path: target.pathname, host: target.host });
    const headers = { ...req.headers, host: target.host, 'x-fixture-proxy': id };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers.connection;
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  return listen(server).then((port) => ({
    id,
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => closeServer(server),
  }));
}

async function writeStore(dir, { proxyA, proxyB }) {
  const later = Date.now() + 3_600_000;
  const login = (user, extra) => ({ agent: 'antigravity', user, ...extra });
  const logins = [
    login('Work-A@example.test', {
      project: 'project-A',
      auth: { access_token: TOKEN_A, refresh_token: REFRESH_A, expiry_date: later },
    }),
    login('Work-B@example.test', {
      on: true,
      auth: { access_token: 'expired-B', refresh_token: REFRESH_B, expiry_date: 1_000 },
    }),
    login('lapsed@example.test', {
      on: true,
      lapsed: 'revoked: synthetic',
      auth: { access_token: 'TOKEN-LAPSED', refresh_token: 'REFRESH-LAPSED', expiry_date: later },
    }),
    login('disabled@example.test', {
      on: false,
      auth: { access_token: 'TOKEN-DISABLED', refresh_token: 'REFRESH-DISABLED', expiry_date: later },
    }),
    login('signed-out@example.test', { auth: { access_token: '', refresh_token: '' } }),
    login('Cancel@example.test', {
      on: true,
      project: 'project-C',
      auth: { access_token: 'TOKEN-C-DO-NOT-LEAK', refresh_token: 'REFRESH-C-DO-NOT-LEAK', expiry_date: later },
    }),
  ];
  const providers = {
    providers: [{
      id: 'antigravity',
      proxy: 'direct',
      accountNames: {
        'work-a@example.test': 'Seat-Alpha',
        'work-b@example.test': 'Seat Beta',
      },
      accountProxies: {
        'work-a@example.test': proxyA,
        'work-b@example.test': proxyA,
        'lapsed@example.test': proxyA,
        'disabled@example.test': proxyA,
        'cancel@example.test': proxyA,
      },
    }],
  };
  await writeFile(path.join(dir, 'logins.json'), `${JSON.stringify(logins, null, 2)}\n`);
  await writeFile(path.join(dir, 'providers.json'), `${JSON.stringify(providers, null, 2)}\n`);
  return {
    logins: await readFile(path.join(dir, 'logins.json'), 'utf8'),
    providers: await readFile(path.join(dir, 'providers.json'), 'utf8'),
  };
}

function fakeSpawn() {
  const calls = [];
  let port = 19000;
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      child.emit('exit', 0, null);
      return true;
    };
    const record = { command, args, options, child, messages: [] };
    calls.push(record);
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        record.messages.push(message);
        if (message.type === 'harness_configure') {
          child.stdout.write(`${JSON.stringify({ type: 'harness_ready', port: port++ })}\n`);
        }
        newline = buffer.indexOf('\n');
      }
    });
    return child;
  };
  return { spawnFn, calls };
}

function noSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SECRET, TOKEN_A, TOKEN_B, REFRESH_A, REFRESH_B, 'TOKEN-C-DO-NOT-LEAK', 'REFRESH-C-DO-NOT-LEAK', 'TOKEN-DISABLED', 'REFRESH-DISABLED']) {
    assert.equal(text.includes(secret), false, `secret leaked: ${secret.slice(0, 8)}`);
  }
}

exclusive('account ids match direct quota readings and list does not query the catalog', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-agy-ids-'));
  const upstream = await startUpstream();
  const proxyA = await startForwardProxy('A');
  const proxyB = await startForwardProxy('B');
  try {
    const files = await writeStore(root, { proxyA: proxyA.url, proxyB: proxyB.url });
    const accounts = new MagpieAntigravityAccountService({
      env: { GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: upstream.origin, ANTIGRAVITY_TOKEN_URL: `${upstream.origin}/oauth2/token` },
    });
    const listed = await accounts.list({ engineId: 'agy-cli' }, { settings: { magpieConfigDir: root }, signal: AbortSignal.timeout(5000) });
    assert.equal(proxyA.hits.length, 0);
    assert.equal(proxyB.hits.length, 0);
    assert.equal(upstream.hits.length, 0);
    assert.deepEqual(listed, [
      { id: 'Work-A@example.test', label: 'Seat-Alpha', status: 'ready' },
      { id: 'Work-B@example.test', label: 'Seat Beta', status: 'ready' },
      { id: 'lapsed@example.test', label: 'lapsed@example.test', status: 'signed_out' },
      { id: 'disabled@example.test', label: 'disabled@example.test', status: 'disabled' },
      { id: 'Cancel@example.test', label: 'Cancel@example.test', status: 'ready' },
      { id: 'signed-out@example.test', label: 'signed-out@example.test', status: 'signed_out' },
    ]);
    noSecrets(listed);
    const quota = new MagpieAntigravityDirectQuotaService({
      env: {},
      origin: upstream.origin,
      tokenUrl: `${upstream.origin}/oauth2/token`,
      oauthClient: { clientId: CLIENT_ID, clientSecret: SECRET },
      minRefreshIntervalMs: 0,
    });
    const { readings } = await quota.read({ settings: { magpieConfigDir: root }, signal: AbortSignal.timeout(15000) });
    const readingIds = [...new Set(readings.map((reading) => reading.accountId))].sort();
    assert.deepEqual(readingIds, ['Cancel@example.test', 'Work-A@example.test', 'Work-B@example.test', 'lapsed@example.test']);
    assert.equal(readingIds.includes('Seat-Alpha'), false);
    assert.equal(readingIds.includes('work-a@example.test'), false);
    clearCollectorRuntimeCaches();
    await assert.rejects(
      accounts.prepare({
        engineId: 'agy-cli', accountId: 'Seat-Alpha', instanceId: 'label-lookup', proxy: { mode: 'direct' },
      }, { settings: { magpieConfigDir: root, antigravitySidecarPath: SIDECAR }, signal: AbortSignal.timeout(5000) }),
      /not found/,
    );
    await assert.rejects(async () => {
      const prepared = await accounts.prepare({
        engineId: 'agy-cli', accountId: 'Work-B@example.test', instanceId: 'expired', proxy: { mode: 'direct' },
      }, { settings: { magpieConfigDir: root, antigravitySidecarPath: SIDECAR }, signal: AbortSignal.timeout(5000) });
      await accounts.release({ leaseId: prepared.leaseId });
      throw new Error('prepare returned a lease');
    }, /no OAuth client is configured/);
    assert.equal(await readFile(path.join(root, 'logins.json'), 'utf8'), files.logins);
    assert.equal(await readFile(path.join(root, 'providers.json'), 'utf8'), files.providers);
  } finally {
    await Promise.all([upstream.close(), proxyA.close(), proxyB.close(), rm(root, { recursive: true, force: true })]);
  }
});

exclusive('explicit instance proxy wins and cancel or release stays on that lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-agy-proxy-'));
  const upstream = await startUpstream({ holdProjectC: true });
  const proxyA = await startForwardProxy('A');
  const proxyB = await startForwardProxy('B');
  const fake = fakeSpawn();
  const service = new MagpieAntigravityAccountService({
    spawnFn: fake.spawnFn,
    env: {
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      ANTIGRAVITY_OAUTH_CLIENT_SECRET: SECRET,
      GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: upstream.origin,
      ANTIGRAVITY_TOKEN_URL: `${upstream.origin}/oauth2/token`,
    },
  });
  const settings = {
    magpieConfigDir: root,
    antigravitySidecarPath: SIDECAR,
    antigravityOAuthClientId: CLIENT_ID,
    antigravityOAuthClientSecret: SECRET,
  };
  try {
    await writeStore(root, { proxyA: proxyA.url, proxyB: proxyB.url });
    const preparedA = await service.prepare({
      engineId: 'agy-cli', accountId: 'Work-A@example.test', instanceId: 'instance-A', proxy: { mode: 'system' },
    }, { settings, signal: AbortSignal.timeout(15000) });
    const beforeB = proxyA.hits.length;
    const preparedB = await service.prepare({
      engineId: 'agy-cli', accountId: 'Work-B@example.test', instanceId: 'instance-B', proxy: { mode: 'custom', url: proxyB.url },
    }, { settings, signal: AbortSignal.timeout(15000) });
    assert.ok(proxyA.hits.slice(0, beforeB).every((hit) => hit.path.includes('project-A') || hit.path.includes('fetchAvailableModels') || hit.path.includes('loadCodeAssist') || hit.path === '/v1internal:fetchAvailableModels' || hit.path === '/oauth2/token'));
    assert.ok(proxyA.hits.length > 0);
    assert.ok(proxyB.hits.some((hit) => hit.path === '/oauth2/token' || hit.path === '/v1internal:loadCodeAssist' || hit.path === '/v1internal:fetchAvailableModels'));
    assert.equal(proxyB.hits.some((hit) => proxyA.hits.includes(hit)), false);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[0].args, ['--harness-scoped', '--parent-pid', String(process.pid)]);
    assert.equal(fake.calls[0].options.env.HTTP_PROXY, undefined);
    assert.equal(fake.calls[0].options.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET, undefined);
    assert.equal(fake.calls[0].messages[0].proxy_url, proxyA.url);
    assert.equal(fake.calls[1].messages[0].proxy_url, proxyB.url);
    assert.match(fake.calls[0].messages[0].user_agent, /^antigravity\/hub\//);
    assert.equal(fake.calls[0].messages[0].bearer.refresh_token, undefined);
    assert.equal(fake.calls[0].messages[0].model_ids[0], 'claude-opus-5-5-high');
    assert.deepEqual(preparedB.connection.modelIds, ['gemini-3.1-flash-lite-preview']);
    assert.equal(preparedA.connection.apiKey.includes(TOKEN_A), false);
    assert.notEqual(preparedA.connection.apiKey, preparedB.connection.apiKey);
    noSecrets({ listed: preparedA.connection.modelIds, key: preparedA.connection.apiKey });
    const proxyBCount = proxyB.hits.length;
    const controller = new AbortController();
    const pending = service.prepare({
      engineId: 'agy-cli', accountId: 'Cancel@example.test', instanceId: 'instance-C', proxy: { mode: 'system' },
    }, { settings, signal: controller.signal });
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (proxyA.hits.some((hit) => hit.path === '/v1internal:fetchAvailableModels' && upstream.hits.some((item) => item.body.includes('project-C')))) {
          clearInterval(timer);
          clearTimeout(deadline);
          resolve();
        }
      }, 20);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error('catalog hold for project-C did not start'));
      }, 12000);
    });
    controller.abort();
    await assert.rejects(pending, /cancelled/i);
    assert.equal(fake.calls[0].child.killed, false);
    assert.equal(fake.calls[1].child.killed, false);
    assert.equal(proxyB.hits.length, proxyBCount);
    await service.release({ leaseId: preparedA.leaseId });
    assert.equal(fake.calls[0].child.killed, true);
    assert.equal(fake.calls[1].child.killed, false);
    await service.release({ leaseId: preparedA.leaseId });
    await service.release({ leaseId: preparedB.leaseId });
    assert.equal(fake.calls[1].child.killed, true);
  } finally {
    upstream.releaseHold();
    await Promise.all([upstream.close(), proxyA.close(), proxyB.close(), rm(root, { recursive: true, force: true })]);
  }
});

exclusive('real sidecar and HostRunner keep A and B on their own proxies', async (context) => {
  if (!HOST_RUNNER || !process.env.MAGPIE_AGY_SIDECAR) {
    context.skip('Set MAGPIE_AGY_HOST_RUNNER and MAGPIE_AGY_SIDECAR to run the integration fixture.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-agy-host-'));
  const upstream = await startUpstream();
  startUpstream.saw429 = false;
  startUpstream.sawSuccess = false;
  const proxyA = await startForwardProxy('A');
  const proxyB = await startForwardProxy('B');
  const home = path.join(root, 'home');
  const store = path.join(root, 'magpie');
  await writeFile(path.join(root, 'placeholder'), '');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home, { recursive: true });
  await mkdir(store, { recursive: true });
  const files = await writeStore(store, { proxyA: proxyA.url, proxyB: proxyB.url });
  const help = spawn(SIDECAR, ['-h'], { windowsHide: true });
  let helpText = '';
  help.stdout.on('data', (chunk) => { helpText += chunk; });
  help.stderr.on('data', (chunk) => { helpText += chunk; });
  const helpExit = await new Promise((resolve) => help.once('exit', resolve));
  assert.equal(helpExit, 0);
  assert.match(helpText, /-harness-scoped/);
  assert.match(helpText, /-parent-pid/);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: upstream.origin,
    ANTIGRAVITY_TOKEN_URL: `${upstream.origin}/oauth2/token`,
  };
  delete env.ANTIGRAVITY_OAUTH_CLIENT_ID;
  delete env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  const child = spawn(process.execPath, [HOST_RUNNER, PLUGIN_ENTRY], {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let ready;
  const untilReady = new Promise((resolve) => { ready = resolve; });
  const registrations = [];
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'register-harness-account-source') registrations.push(message.params.definition);
    if (message.method === 'ready') ready();
    if (message.method === 'register-error') ready(message);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  let sequence = 0;
  function request(method, params, id = ++sequence) {
    const reply = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return reply;
  }
  const settings = {
    magpieConfigDir: store,
    antigravitySidecarPath: SIDECAR,
    antigravityOAuthClientId: CLIENT_ID,
    antigravityOAuthClientSecret: SECRET,
  };
  const sourceId = 'antigravity';
  async function call(method, params) {
    if (method === 'release') {
      const response = await request('harness-account-release', { prepareId: params.prepareId });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    }
    const id = ++sequence;
    const response = await request('harness-account-request', {
      sourceId, action: method, input: params, settings, kikiHome: home,
    }, id);
    if (response.error) throw new Error(response.error.message);
    return method === 'prepare' ? { prepareId: id, connection: response.result } : response.result;
  }
  async function generate(connection, model) {
    return fetch(`${connection.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': connection.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] }),
      signal: AbortSignal.timeout(20000),
    });
  }
  try {
    const handshake = await request('handshake', { version: 1 });
    assert.equal(handshake.id, 1);
    assert.deepEqual(handshake.result, { version: 1 });
    await untilReady;
    assert.deepEqual(registrations, [{
      schemaVersion: 1, id: 'antigravity', label: 'Magpie · Antigravity', engineIds: ['agy-cli'],
    }]);
    const listed = await call('list', { engineId: 'agy-cli' });
    assert.equal(listed.find((account) => account.id === 'Work-A@example.test').label, 'Seat-Alpha');
    noSecrets(listed);
    const beforePrepare = upstream.hits.length;
    const preparedA = await call('prepare', {
      engineId: 'agy-cli', accountId: 'Work-A@example.test', instanceId: 'host-A', proxy: { mode: 'system' },
    });
    const preparedB = await call('prepare', {
      engineId: 'agy-cli', accountId: 'Work-B@example.test', instanceId: 'host-B', proxy: { mode: 'custom', url: proxyB.url },
    });
    assert.deepEqual(preparedA.connection.modelIds, ['claude-opus-5-5-high']);
    assert.deepEqual(preparedB.connection.modelIds, ['gemini-3.1-flash-lite-preview']);
    assert.equal(preparedA.connection.protocol, 'gemini-v1beta');
    assert.match(preparedA.connection.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(preparedA.connection.baseUrl, preparedB.connection.baseUrl);
    assert.notEqual(preparedA.connection.apiKey, TOKEN_A);
    noSecrets(preparedA.connection);
    noSecrets(preparedB.connection);
    const catalogHits = upstream.hits.slice(beforePrepare);
    assert.ok(catalogHits.some((hit) => hit.proxy === 'A' && hit.path === '/v1internal:fetchAvailableModels' && hit.body.includes('project-A')));
    assert.ok(catalogHits.some((hit) => hit.proxy === 'B' && hit.path === '/v1internal:fetchAvailableModels' && hit.body.includes('project-B')));
    assert.equal(catalogHits.some((hit) => hit.proxy === 'B' && hit.body.includes('project-A')), false);
    const proxyBBeforeA = proxyB.hits.length;
    const refreshed = await generate(preparedA.connection, 'claude-opus-5-5-high');
    const refreshedText = await refreshed.text();
    assert.equal(refreshed.status, 200, refreshedText);
    assert.match(refreshedText, /scoped-A/);
    assert.equal(proxyB.hits.length, proxyBBeforeA);
    assert.ok(upstream.hits.some((hit) => hit.proxy === 'A' && hit.path === '/oauth2/token' && hit.body.includes(REFRESH_A)));
    assert.equal(upstream.hits.some((hit) => hit.proxy === 'B' && hit.body.includes(REFRESH_A)), false);
    assert.ok(upstream.hits.some((hit) => hit.proxy === 'A' && hit.path === '/v1internal:streamGenerateContent' && hit.body.includes('project-A')));
    assert.equal(upstream.hits.some((hit) => hit.proxy === 'B' && hit.path === '/v1internal:streamGenerateContent'), false);
    const denied = await generate(preparedA.connection, 'claude-opus-5-5-high');
    const deniedText = await denied.text();
    assert.equal(denied.status, 429, deniedText);
    assert.equal(proxyB.hits.length, proxyBBeforeA);
    const other = await generate(preparedB.connection, 'gemini-3.1-flash-lite-preview');
    const otherText = await other.text();
    assert.equal(other.status, 200, otherText);
    assert.match(otherText, /scoped-B/);
    assert.ok(proxyB.hits.length > proxyBBeforeA);
    assert.ok(upstream.hits.some((hit) => hit.proxy === 'B' && hit.path === '/v1internal:streamGenerateContent' && hit.body.includes('project-B')));
    assert.equal(upstream.hits.some((hit) => hit.proxy === 'B' && hit.body.includes('project-A')), false);
    const crossed = await fetch(`${preparedA.connection.baseUrl}/v1beta/models/claude-opus-5-5-high:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': preparedB.connection.apiKey },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(crossed.status, 401);
    await call('release', { prepareId: preparedA.prepareId });
    await assert.rejects(generate(preparedA.connection, 'claude-opus-5-5-high'));
    const stillB = await generate(preparedB.connection, 'gemini-3.1-flash-lite-preview');
    assert.equal(stillB.status, 200);
    assert.ok(upstream.hits.filter((hit) => hit.path === '/v1internal:streamGenerateContent').every((hit) => /^antigravity\/hub\//.test(hit.userAgent)));
    await call('release', { prepareId: preparedB.prepareId });
    await call('release', { prepareId: preparedA.prepareId });
    assert.equal(await readFile(path.join(store, 'logins.json'), 'utf8'), files.logins);
    noSecrets(stderr);
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill();
    await Promise.all([upstream.close(), proxyA.close(), proxyB.close(), rm(root, { recursive: true, force: true })]);
  }
});

exclusive('concurrent refresh updates each caller, isolates cancellation and uses the requested route', async () => {
  const account = (proxyUrl = 'http://proxy-a.test') => ({
    userHash: 'fixture-account',
    _secrets: { accessToken: 'expired', expiryMs: 1, refreshToken: 'fixture-refresh', proxyUrl },
  });
  const requests = [];
  const requestFn = (url, options) => new Promise((resolve) => requests.push({ url, options, resolve }));
  const oauthClient = { clientId: CLIENT_ID, clientSecret: SECRET };
  const success = (index, access_token) => requests[index].resolve({ status: 200, body: JSON.stringify({ access_token, expires_in: 3600 }) });
  const cancel = new AbortController();
  const cancelled = ensureFreshAccessToken(account(), { requestFn, oauthClient, signal: cancel.signal });
  const a = account();
  const b = account();
  const pA = ensureFreshAccessToken(a, { requestFn, oauthClient });
  const pB = ensureFreshAccessToken(b, { requestFn, oauthClient });
  const separate = account('http://proxy-b.test');
  const pSeparate = ensureFreshAccessToken(separate, { requestFn, oauthClient, tokenUrl: 'https://issuer-b.test/token' });
  cancel.abort();
  success(0, 'fresh-a');
  if (requests.length > 1) success(1, 'fresh-b');
  const results = await Promise.allSettled([cancelled, pA, pB, pSeparate]);
  assert.deepEqual(requests.map(({ url, options }) => [url, options.proxyUrl]), [
    ['https://oauth2.googleapis.com/token', 'http://proxy-a.test'],
    ['https://issuer-b.test/token', 'http://proxy-b.test'],
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'ABORT_ERR');
  assert.deepEqual(results.slice(1).map((result) => result.value), ['fresh-a', 'fresh-a', 'fresh-b']);
  assert.equal(a._secrets.accessToken, 'fresh-a');
  assert.equal(b._secrets.accessToken, 'fresh-a');
  assert.equal(a._secrets.expiryMs, b._secrets.expiryMs);
  assert.ok(b._secrets.expiryMs > Date.now());
  assert.equal(separate._secrets.accessToken, 'fresh-b');
  assert.equal(await ensureFreshAccessToken(account(), { requestFn, oauthClient }), 'fresh-a');
  assert.equal(await ensureFreshAccessToken(account(), { requestFn, oauthClient, tokenUrl: 'https://issuer-b.test/token' }), 'fresh-b');
  assert.equal(requests.length, 2);

  clearCollectorRuntimeCaches();
  const only = new AbortController();
  const abandoned = ensureFreshAccessToken(account(), { requestFn, oauthClient, signal: only.signal });
  const rejected = assert.rejects(abandoned, { code: 'ABORT_ERR' });
  only.abort();
  await rejected;
  assert.equal(requests[2].options.signal.aborted, true);
  success(2, 'discarded');
});

exclusive('shared project is omitted only from the catalog and a broken stdin stays on its lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-agy-pipe-'));
  const catalog = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (req.url !== '/v1internal:fetchAvailableModels') { res.writeHead(404).end(); return; }
    catalog.push(body);
    if (body.project === 'aicode-consumers') { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models: { 'gemini-4-argon-high': {} } }));
  });
  const port = await listen(server);
  const normal = fakeSpawn();
  const broken = [];
  const service = new MagpieAntigravityAccountService({
    env: { GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: `http://127.0.0.1:${port}` },
    spawnFn(command, args, options) {
      if (normal.calls.length === 0) return normal.spawnFn(command, args, options);
      const fixture = fakeSpawn();
      const child = fixture.spawnFn(command, args, options);
      child.stdin.removeAllListeners('data');
      child.stdin.write = () => { child.stdin.destroy(new Error('write EOF (TOKEN-A-DO-NOT-LEAK)')); return false; };
      broken.push(child);
      return child;
    },
  });
  try {
    await writeFile(path.join(root, 'logins.json'), JSON.stringify([{
      agent: 'antigravity', user: 'shared@example.test', project: 'aicode-consumers',
      auth: { access_token: TOKEN_A, refresh_token: REFRESH_A, expiry_date: Date.now() + 3_600_000 },
    }]));
    await writeFile(path.join(root, 'providers.json'), '[]');
    const input = { engineId: 'agy-cli', accountId: 'shared@example.test', instanceId: 'shared', proxy: { mode: 'direct' } };
    const settings = { magpieConfigDir: root, antigravitySidecarPath: SIDECAR };
    const first = await service.prepare(input, { settings });
    assert.deepEqual(first.connection.modelIds, ['gemini-4-argon-high']);
    assert.equal(normal.calls[0].messages[0].bearer.project_id, 'aicode-consumers');
    await assert.rejects(service.prepare(input, { settings }), (error) => {
      noSecrets(error.message);
      return /sidecar.*pipe/i.test(error.message);
    });
    assert.equal(broken[0].killed, true);
    assert.equal(normal.calls[0].child.killed, false);
    await assert.rejects(service.prepare(input, { settings: { magpieConfigDir: root } }), /Configure antigravitySidecarPath/);
    assert.deepEqual(catalog, [{}, {}]);
    const live = normal.calls[0].child;
    const closed = new Promise((resolve) => live.once('exit', resolve));
    live.stdin.write = () => { live.stdin.destroy(new Error('write EOF during refresh')); return false; };
    live.stdout.write('{"type":"harness_refresh"}\n');
    await closed;
    assert.equal(live.killed, true);
    await service.release({ leaseId: first.leaseId });
  } finally {
    await Promise.all([closeServer(server), rm(root, { recursive: true, force: true })]);
  }
});

exclusive('renews expired tokens via managed `magpie quota refresh` across both prepare and cross-hour runtime harness_refresh without OAuth client settings', async () => {
  const rootBase = await mkdtemp(path.join(os.tmpdir(), 'magpie-agy-cli-renew-'));
  const magpieDir = path.join(rootBase, 'magpie');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(magpieDir, { recursive: true });
  const upstream = await startUpstream();
  const proxyA = await startForwardProxy('A');
  const fake = fakeSpawn();
  const cliInvocations = [];
  let issuedCounter = 0;

  const loginsPath = path.join(magpieDir, 'logins.json');
  const providersPath = path.join(magpieDir, 'providers.json');

  const execFileFn = async (executable, args, options) => {
    cliInvocations.push({ executable, args, envXdg: options.env?.XDG_CONFIG_HOME });
    const logins = JSON.parse(await readFile(loginsPath, 'utf8'));
    issuedCounter += 1;
    const targetUser = args[3];
    for (const entry of logins) {
      if (!targetUser || entry.user === targetUser) {
        entry.auth.access_token = `CLI-RENEWED-TOKEN-${issuedCounter}-DO-NOT-LEAK`;
        entry.auth.expiry_date = Date.now() + 3_600_000;
      }
    }
    await writeFile(loginsPath, `${JSON.stringify(logins, null, 2)}\n`, 'utf8');
    return { stdout: '[]', stderr: '' };
  };

  const service = new MagpieAntigravityAccountService({
    spawnFn: fake.spawnFn,
    execFileFn,
    env: {
      XDG_CONFIG_HOME: rootBase,
      GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: upstream.origin,
      ANTIGRAVITY_TOKEN_URL: `${upstream.origin}/oauth2/token`,
    },
  });

  try {
    await writeFile(loginsPath, JSON.stringify([{
      agent: 'antigravity',
      user: 'Work-A@example.test',
      on: true,
      auth: {
        access_token: 'EXPIRED-INITIAL-TOKEN',
        refresh_token: REFRESH_A,
        expiry_date: 1_000,
      },
    }], null, 2), 'utf8');
    await writeFile(providersPath, JSON.stringify({
      providers: [{
        id: 'antigravity',
        accountProxies: { 'work-a@example.test': proxyA.url },
      }],
    }, null, 2), 'utf8');

    const magpieExe = path.join(rootBase, 'bin', 'magpie.exe');
    const prepareAbort = new AbortController();
    const prepared = await service.prepare({
      engineId: 'agy-cli',
      accountId: 'Work-A@example.test',
      instanceId: 'instance-cli-renew',
      proxy: { mode: 'system' },
    }, {
      settings: {
        magpieConfigDir: magpieDir,
        magpiePath: magpieExe,
        antigravitySidecarPath: SIDECAR,
        // Note: NO antigravityOAuthClientId / antigravityOAuthClientSecret configured!
      },
      signal: prepareAbort.signal,
    });

    assert.equal(cliInvocations.length, 1);
    assert.equal(cliInvocations[0].executable, magpieExe);
    assert.deepEqual(cliInvocations[0].args, ['quota', 'refresh', 'antigravity', 'Work-A@example.test', '--json']);
    assert.equal(cliInvocations[0].envXdg, rootBase);
    assert.equal(upstream.hits.some((h) => h.path === '/oauth2/token'), false);

    const sidecarRecord = fake.calls[0];
    assert.equal(sidecarRecord.messages[0].type, 'harness_configure');
    assert.equal(sidecarRecord.messages[0].bearer.access_token, 'CLI-RENEWED-TOKEN-1-DO-NOT-LEAK');
    assert.equal(sidecarRecord.messages[0].bearer.project_id, 'project-A');

    // Simulate prepare's caller signal expiring/aborting later (e.g. initial RPC timeout cleaned up)
    // while the lease remains active for cross-hour sidecar execution:
    prepareAbort.abort();

    // Simulate 1 hour later: sidecar receives 401 or hits expiry and sends two concurrent `harness_refresh` requests
    const refreshReplies = new Promise((resolve) => {
      const check = () => {
        const results = sidecarRecord.messages.filter((m) => m.type === 'harness_refresh_result');
        if (results.length >= 2) resolve(results);
      };
      sidecarRecord.child.stdin.on('data', () => setImmediate(check));
    });

    sidecarRecord.child.stdout.write(`${JSON.stringify({
      type: 'harness_refresh',
      rejected_bearer: 'CLI-RENEWED-TOKEN-1-DO-NOT-LEAK',
    })}\n`);
    sidecarRecord.child.stdout.write(`${JSON.stringify({
      type: 'harness_refresh',
      rejected_bearer: 'CLI-RENEWED-TOKEN-1-DO-NOT-LEAK',
    })}\n`);

    const [reply1, reply2] = await refreshReplies;
    assert.equal(reply1.error, undefined);
    assert.equal(reply2.error, undefined);
    assert.equal(reply1.bearer.access_token, 'CLI-RENEWED-TOKEN-2-DO-NOT-LEAK');
    assert.equal(reply2.bearer.access_token, 'CLI-RENEWED-TOKEN-2-DO-NOT-LEAK');
    assert.equal(cliInvocations.length, 2, 'second cross-hour renewal must coalesce concurrent harness_refresh into one CLI call');
    // Catalog was NOT re-queried during runtime harness_refresh
    assert.equal(upstream.hits.filter((h) => h.path === '/v1internal:fetchAvailableModels').length, 1);

    // Verify ENOENT or disabled CLI fallback still surfaces OAUTH_CLIENT_UNCONFIGURED cleanly without leaking secrets
    const enoentService = new MagpieAntigravityAccountService({
      spawnFn: fake.spawnFn,
      execFileFn: async () => {
        const err = new Error('spawn magpie.exe ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      env: {
        XDG_CONFIG_HOME: rootBase,
        GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: upstream.origin,
      },
    });
    await writeFile(loginsPath, JSON.stringify([{
      agent: 'antigravity',
      user: 'Work-A@example.test',
      on: true,
      auth: {
        access_token: 'EXPIRED-AGAIN-TOKEN',
        refresh_token: 'REFRESH-ENOENT-DO-NOT-LEAK',
        expiry_date: 1_000,
      },
    }], null, 2), 'utf8');
    clearCollectorRuntimeCaches();
    await assert.rejects(
      enoentService.prepare({
        engineId: 'agy-cli',
        accountId: 'Work-A@example.test',
        instanceId: 'instance-enoent',
        proxy: { mode: 'system' },
      }, {
        settings: { magpieConfigDir: magpieDir, magpiePath: magpieExe, antigravitySidecarPath: SIDECAR },
      }),
      (err) => err?.code === 'OAUTH_CLIENT_UNCONFIGURED' && !err.message.includes('REFRESH-ENOENT-DO-NOT-LEAK'),
    );

    await service.release({ leaseId: prepared.leaseId });
  } finally {
    await Promise.all([upstream.close(), proxyA.close(), rm(rootBase, { recursive: true, force: true })]);
  }
});
