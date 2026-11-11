import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODE_ASSIST_DAILY_URL,
  CODE_ASSIST_PROD_URL,
  COLLECTOR_PROTOCOL_ID,
  COLLECTOR_SCHEMA_VERSION,
  MagpieAntigravityDirectQuotaService,
  OAUTH_CLIENT_UNCONFIGURED,
  clearCollectorRuntimeCaches,
  collectMagpieAntigravityDirectQuotas,
  ensureFreshAccessToken,
  interpretAntigravityDirectQuota,
  loadMagpieAntigravityAccounts,
  resolveCodeAssistOrigin,
  resolveMagpieConfigDir,
} from '../lib/antigravity-direct-quota.mjs';

function validateHarnessQuotaReading(reading) {
  assert.equal(typeof reading.accountId, 'string');
  assert.ok(reading.accountId.length > 0 && !/\s/.test(reading.accountId));
  assert.equal(reading.unit, 'percent');
  if (reading.modelIds !== undefined) {
    assert.ok(Array.isArray(reading.modelIds) && reading.modelIds.length > 0);
    for (const id of reading.modelIds) {
      assert.ok(typeof id === 'string' && id.length > 0 && !/\s/.test(id));
    }
  }
  if (reading.pool !== undefined) assert.ok(typeof reading.pool === 'string' && reading.pool.length > 0);
  if (reading.window !== undefined) assert.ok(typeof reading.window === 'string' && reading.window.length > 0);
  if (reading.remaining !== undefined) {
    assert.ok(typeof reading.remaining === 'number' && Number.isFinite(reading.remaining) && reading.remaining >= 0);
  }
  if (reading.resetAt !== undefined) assert.ok(Number.isFinite(Date.parse(reading.resetAt)));
  if (reading.readAt !== undefined) assert.ok(Number.isFinite(Date.parse(reading.readAt)));
  const allowedKeys = new Set(['accountId', 'accountLabel', 'modelIds', 'pool', 'unit', 'window', 'remaining', 'resetAt', 'readAt']);
  for (const k of Object.keys(reading)) {
    assert.ok(allowedKeys.has(k), `Unexpected key on HarnessQuotaReading: ${k}`);
  }
}

function opensslCommandEnv() {
  if (process.env.OPENSSL_CONF) return process.env;
  const bundled = 'C:\\Program Files\\Git\\usr\\ssl\\openssl.cnf';
  if (existsSync(bundled)) return { ...process.env, OPENSSL_CONF: bundled };
  return process.env;
}

function generateTestSelfSignedCert(tmpDir) {
  const keyPath = path.join(tmpDir, 'tls.key');
  const certPath = path.join(tmpDir, 'tls.crt');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath.replaceAll('\\', '/')}" -out "${certPath.replaceAll('\\', '/')}" -days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
    { stdio: 'ignore', env: opensslCommandEnv() },
  );
  return { keyPath, certPath };
}

async function startAuthenticatedConnectProxy({ expectedAuth }) {
  const connectLog = [];
  const sockets = new Set();
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(405).end('Forward HTTP unexpected for HTTPS target');
  });
  proxyServer.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  proxyServer.on('connect', (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    const authHeader = req.headers['proxy-authorization'] || '';
    connectLog.push({ target: req.url, authHeader });
    if (expectedAuth && authHeader !== expectedAuth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const [host, portStr] = String(req.url).split(':');
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const { port } = proxyServer.address();
  return {
    port,
    connectLog,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => proxyServer.close(resolve));
    },
  };
}

async function startAuthenticatedSocks5Proxy({ expectedUser, expectedPass }) {
  const socksLog = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    let buf = Buffer.alloc(0);
    let waiter = null;
    function pump() {
      if (waiter && buf.length >= waiter.n) {
        const { n, r } = waiter;
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        waiter = null;
        r(out);
      }
    }
    client.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      pump();
    });
    const readN = (n) => new Promise((r) => {
      waiter = { n, r };
      pump();
    });

    (async () => {
      const greet = await readN(2);
      const methods = await readN(greet[1]);
      assert.equal(greet[0], 0x05);
      assert.ok(methods.includes(0x02));
      client.write(Buffer.from([0x05, 0x02]));

      const authVer = await readN(2);
      assert.equal(authVer[0], 0x01);
      const uBuf = await readN(authVer[1]);
      const pLen = await readN(1);
      const pBuf = await readN(pLen[0]);
      const user = uBuf.toString('utf8');
      const pass = pBuf.toString('utf8');
      if (user !== expectedUser || pass !== expectedPass) {
        client.write(Buffer.from([0x01, 0x01]));
        client.destroy();
        return;
      }
      client.write(Buffer.from([0x01, 0x00]));

      const head = await readN(4);
      assert.equal(head[0], 0x05);
      assert.equal(head[1], 0x01);
      let host;
      if (head[3] === 0x01) {
        const ip = await readN(4);
        host = [...ip].join('.');
      } else if (head[3] === 0x03) {
        const l = await readN(1);
        const h = await readN(l[0]);
        host = h.toString('utf8');
      } else {
        throw new Error(`Unsupported ATYP ${head[3]}`);
      }
      const portBuf = await readN(2);
      const port = portBuf.readUInt16BE(0);
      socksLog.push({ target: `${host}:${port}`, user });

      const upstream = net.connect(port, host, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        if (buf.length > 0) upstream.write(buf);
        client.removeAllListeners('data');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    })().catch(() => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    socksLog,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('resolveCodeAssistOrigin follows GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL without fallback', () => {
  assert.equal(resolveCodeAssistOrigin({ env: {} }), CODE_ASSIST_DAILY_URL);
  assert.equal(resolveCodeAssistOrigin({ env: { GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: 'daily' } }), CODE_ASSIST_DAILY_URL);
  assert.equal(resolveCodeAssistOrigin({ env: { GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: 'sandbox' } }), CODE_ASSIST_DAILY_URL);
  assert.equal(resolveCodeAssistOrigin({ env: { GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: 'prod' } }), CODE_ASSIST_PROD_URL);
});

test('interpretAntigravityDirectQuota distinguishes Pro independent Argon group vs Ultra shared Gemini group without 100%/reset guessing', () => {
  // Case 1: Pro plan where Argon has its own versioned group ("Gemini 4 Argon", weekly only) even when numbers happen to equal 100%
  const proRes = interpretAntigravityDirectQuota({
    account: { user: 'pro@example.test', userHash: '1111222233334444', plan: 'Pro', proxyEndpoint: 'http://127.0.0.1:18903' },
    origin: CODE_ASSIST_DAILY_URL,
    readAt: '2026-11-08T00:00:00Z',
    loadResp: { currentTier: { id: 'standard-tier' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } },
    modelsResp: {
      models: {
        'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' } },
        'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-08T04:00:00Z' } },
        'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (Thinking)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' } },
      },
    },
    summaryResp: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-15T00:00:00Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          description: 'Gemini 4 Argon weekly allowance',
          buckets: [
            { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: '2026-11-12T00:00:00Z' },
          ],
        },
      ],
    },
  });

  assert.equal(proRes.sanitizedAccount.argonWeekly.status, 'known');
  assert.equal(proRes.sanitizedAccount.argonWeekly.poolMode, 'pro_independent_argon_group');
  assert.equal(proRes.sanitizedAccount.argonWeekly.pool, 'Gemini 4 Argon');
  assert.equal(proRes.sanitizedAccount.argonWeekly.remainingPercent, 40);

  const proArgon7d = proRes.readings.find((r) => r.pool === 'Gemini 4 Argon' && r.window === '7 days');
  const proGemini7d = proRes.readings.find((r) => r.pool === 'Gemini' && r.window === '7 days');
  const proArgon5h = proRes.readings.find((r) => r.pool === 'Gemini 4 Argon' && r.window === '5 hours');
  assert.deepEqual(proArgon7d.modelIds, ['gemini-4-argon-high']);
  assert.deepEqual(proGemini7d.modelIds, ['gemini-3.8-flash']); // Argon excluded from general Gemini pool!
  assert.equal(proArgon5h.remaining, 75); // Preserved per-model 5h because Gemini 4 Argon group had no 5h bucket
  for (const r of proRes.readings) validateHarnessQuotaReading(r);

  // Case 2: Ultra plan where `fetchAvailableModels` offers Argon and `retrieveUserQuotaSummary` has only `Gemini Models` (5h + weekly)
  const ultraRes = interpretAntigravityDirectQuota({
    account: { user: 'ultra@example.test', userHash: 'aaaabbbbccccdddd', plan: 'Ultra', proxyEndpoint: 'http://127.0.0.1:18906' },
    origin: CODE_ASSIST_DAILY_URL,
    readAt: '2026-11-08T00:00:00Z',
    loadResp: { currentTier: { id: 'standard-tier' }, paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
    modelsResp: {
      models: {
        'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9132, resetTime: '2026-11-08T03:00:00Z' } },
        'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 0.9132, resetTime: '2026-11-08T03:00:00Z' } },
        'gemini-4-argon-disabled': { displayName: 'Gemini 4 Argon', disabled: true, quotaInfo: { remainingFraction: 1 } },
      },
    },
    summaryResp: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.864, resetTime: '2026-11-14T02:05:06Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9132, resetTime: '2026-11-08T03:00:00Z' },
          ],
        },
      ],
    },
  });

  assert.equal(ultraRes.sanitizedAccount.argonWeekly.status, 'known');
  assert.equal(ultraRes.sanitizedAccount.argonWeekly.poolMode, 'ultra_shared_family_group');
  assert.equal(ultraRes.sanitizedAccount.argonWeekly.pool, 'Gemini');
  assert.equal(ultraRes.sanitizedAccount.argonWeekly.weeklyBucketId, 'gemini-weekly');
  assert.equal(ultraRes.sanitizedAccount.argonWeekly.remainingPercent, 86.4);
  const ultraGemini7d = ultraRes.readings.find((r) => r.pool === 'Gemini' && r.window === '7 days');
  assert.deepEqual(ultraGemini7d.modelIds, ['gemini-3.8-flash', 'gemini-4-argon-high']);
  for (const r of ultraRes.readings) validateHarnessQuotaReading(r);

  // Case 3: Account where Argon is disabled/not in catalog: Gemini · 7 days does NOT claim Argon even if 100%
  const noArgonRes = interpretAntigravityDirectQuota({
    account: { user: 'free@example.test', userHash: '9999888877776666', plan: 'Free', proxyEndpoint: 'http://127.0.0.1:18903' },
    origin: CODE_ASSIST_DAILY_URL,
    readAt: '2026-11-08T00:00:00Z',
    loadResp: { currentTier: { id: 'free-tier' } },
    modelsResp: {
      models: {
        'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' } },
        'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', disabled: true, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' } },
      },
    },
    summaryResp: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-15T00:00:00Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' },
          ],
        },
      ],
    },
  });
  assert.equal(noArgonRes.sanitizedAccount.argonWeekly.status, 'unknown');
  assert.equal(noArgonRes.sanitizedAccount.argonWeekly.offeredInCatalog, false);
  const freeGemini7d = noArgonRes.readings.find((r) => r.pool === 'Gemini' && r.window === '7 days');
  assert.deepEqual(freeGemini7d.modelIds, ['gemini-3.8-flash']);
});

test('end-to-end collector enforces per-account HTTP CONNECT Proxy-Authorization & SOCKS5 auth for both OAuth refresh and Code Assist queries without touching disk', async () => {
  clearCollectorRuntimeCaches();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-direct-quota-test-'));
  try {
    const { keyPath, certPath } = generateTestSelfSignedCert(tmpDir);
    const [keyPem, certPem] = await Promise.all([
      fs.readFile(keyPath),
      fs.readFile(certPath),
    ]);

    const expectedHttpAuth = `Basic ${Buffer.from('acctA:pass:A@1', 'utf8').toString('base64')}`;
    const httpProxy = await startAuthenticatedConnectProxy({ expectedAuth: expectedHttpAuth });
    const socksProxy = await startAuthenticatedSocks5Proxy({ expectedUser: 'acctB', expectedPass: 's3cr3t!' });

    const upstreamHits = [];
    const httpsUpstream = https.createServer({ key: keyPem, cert: certPem }, async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      upstreamHits.push({ url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'], body: bodyStr });

      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth2/token') {
        const params = new URLSearchParams(bodyStr);
        const rt = params.get('refresh_token');
        res.writeHead(200).end(JSON.stringify({ access_token: `fresh-at-for-${rt}`, expires_in: 3600 }));
        return;
      }
      if (req.url === '/v1internal:loadCodeAssist') {
        const isA = req.headers.authorization === 'Bearer fresh-at-for-rt-acct-a';
        res.writeHead(200).end(JSON.stringify({
          cloudaicompanionProject: 'aicode-consumers',
          currentTier: { id: 'standard-tier', name: 'Antigravity' },
          paidTier: isA ? { id: 'g1-pro-tier', name: 'Google AI Pro' } : { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
        }));
        return;
      }
      if (req.url === '/v1internal:fetchAvailableModels') {
        const parsed = JSON.parse(bodyStr);
        // Simulate Google AI Pro returning 400 when g1-pro-tier is named (`google.go:330-337`)
        if (parsed.entitlement?.userTier === 'g1-pro-tier') {
          res.writeHead(400).end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } }));
          return;
        }
        res.writeHead(200).end(JSON.stringify({
          models: {
            'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' } },
            'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (Thinking)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' } },
          },
        }));
        return;
      }
      if (req.url === '/v1internal:retrieveUserQuotaSummary') {
        const isA = req.headers.authorization === 'Bearer fresh-at-for-rt-acct-a';
        res.writeHead(200).end(JSON.stringify({
          groups: isA
            ? [
              { displayName: 'Gemini 4 Argon', description: '', buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2026-11-14T00:00:00Z' }] },
              { displayName: 'Claude and GPT models', description: 'Claude Opus', buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-14T00:00:00Z' }, { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' }] },
            ]
            : [
              { displayName: 'Gemini Models', description: 'Gemini Pro', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95, resetTime: '2026-11-14T00:00:00Z' }, { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T05:00:00Z' }] },
            ],
        }));
        return;
      }
      res.writeHead(404).end('{}');
    });

    await new Promise((resolve) => httpsUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = httpsUpstream.address().port;
    const baseOrigin = `https://127.0.0.1:${upstreamPort}`;

    const loginsContent = JSON.stringify([
      {
        agent: 'antigravity',
        user: 'alpha@example.test',
        // Note: `on` omitted on first entry! `side_logins.go:151` still marks primary account Active & On.
        auth: { access_token: 'expired-at', refresh_token: 'rt-acct-a', expiry_date: 1000 },
      },
      {
        agent: 'antigravity',
        user: 'beta@example.test',
        on: true,
        auth: { access_token: '', refresh_token: 'rt-acct-b', expiry_date: 0 },
      },
      {
        agent: 'antigravity',
        user: 'disabled@example.test',
        on: false,
        auth: { access_token: 'tok', refresh_token: 'rt-disabled', expiry_date: Date.now() + 999999 },
      },
    ], null, 2);
    const providersContent = JSON.stringify({
      providers: [
        {
          id: 'antigravity',
          accountNames: { 'alpha@example.test': 'Seat Alpha' },
          accountProxies: {
            'alpha@example.test': `http://acctA:${encodeURIComponent('pass:A@1')}@127.0.0.1:${httpProxy.port}`,
            'beta@example.test': `socks5h://acctB:${encodeURIComponent('s3cr3t!')}@127.0.0.1:${socksProxy.port}`,
          },
        },
      ],
    }, null, 2);

    const loginsPath = path.join(tmpDir, 'logins.json');
    const providersPath = path.join(tmpDir, 'providers.json');
    await fs.writeFile(loginsPath, loginsContent, 'utf8');
    await fs.writeFile(providersPath, providersContent, 'utf8');

    try {
      const batch = await collectMagpieAntigravityDirectQuotas({
        configDir: tmpDir,
        origin: baseOrigin,
        tokenUrl: `${baseOrigin}/oauth2/token`,
        ca: certPem,
        includeEmailInReadings: false,
        env: {},
        oauthClient: {
          clientId: 'synthetic-antigravity-client',
          clientSecret: 'synthetic-antigravity-secret',
        },
      });

      assert.equal(batch.protocol, COLLECTOR_PROTOCOL_ID);
      assert.equal(batch.schemaVersion, COLLECTOR_SCHEMA_VERSION);
      assert.equal(batch.accounts.length, 2);

      // Verify every single request (OAuth token refresh + 3 Code Assist calls; plus 1 retry for 400 tier on Alpha)
      // went through the respective account's bound proxy with valid proxy auth!
      const tokenBodies = upstreamHits.filter((hit) => hit.url === '/oauth2/token').map((hit) => hit.body);
      assert.equal(tokenBodies.length, 2);
      for (const body of tokenBodies) {
        const params = new URLSearchParams(body);
        assert.equal(params.get('client_id'), 'synthetic-antigravity-client');
        assert.equal(params.get('client_secret'), 'synthetic-antigravity-secret');
      }
      assert.equal(httpProxy.connectLog.length, 5); // token + load + models(400) + models(200) + summary
      assert.ok(httpProxy.connectLog.every((c) => c.authHeader === expectedHttpAuth));
      assert.equal(socksProxy.socksLog.length, 4); // token + load + models(200) + summary
      assert.ok(socksProxy.socksLog.every((c) => c.user === 'acctB'));

      // Verify sanitized output leaks zero secrets or emails
      const serialized = JSON.stringify(batch);
      assert.ok(!serialized.includes('alpha@example.test'));
      assert.ok(!serialized.includes('beta@example.test'));
      assert.ok(!serialized.includes('rt-acct-a'));
      assert.ok(!serialized.includes('fresh-at-for'));
      assert.ok(!serialized.includes('pass:A@1'));
      assert.ok(!serialized.includes('s3cr3t!'));

      // Verify Magpie store files were strictly read-only (byte-identical)
      assert.equal(await fs.readFile(loginsPath, 'utf8'), loginsContent);
      assert.equal(await fs.readFile(providersPath, 'utf8'), providersContent);

      // Verify adapter wrapper for 1299 (`MagpieAntigravityDirectQuotaService`)
      const service = new MagpieAntigravityDirectQuotaService({
        configDir: tmpDir,
        origin: baseOrigin,
        tokenUrl: `${baseOrigin}/oauth2/token`,
        ca: certPem,
        env: {},
      });
      const adapterResult = await service.adapter.read({ settings: {} });
      assert.ok(Array.isArray(adapterResult.readings) && adapterResult.readings.length > 0);
      assert.ok(adapterResult.readings.some((r) => r.accountId === 'alpha@example.test' && r.accountLabel === 'Seat Alpha'));
      for (const r of adapterResult.readings) validateHarnessQuotaReading(r);

      // Second call must reuse in-memory refreshed tokens and refused-tier memoization (0 new `/oauth2/token` hits, 0 new 400 tier hits)
      const tokenHitsAfterSecond = upstreamHits.filter((h) => h.url === '/oauth2/token').length;
      assert.equal(tokenHitsAfterSecond, 2); // Only 1 refresh for alpha and 1 for beta across BOTH batch reads!

      // Third call within 5-minute TTL on `MagpieAntigravityDirectQuotaService` must hit shared batch cache (0 new upstream hits)
      const totalHitsBeforeCachedRead = upstreamHits.length;
      const cachedAdapterResult = await service.adapter.read({ settings: {} });
      assert.deepEqual(cachedAdapterResult.readings, adapterResult.readings);
      assert.equal(upstreamHits.length, totalHitsBeforeCachedRead);

      // Verify missing proxy rejection (`requireProxy: true`) and relative path rejection
      await assert.rejects(
        () => resolveMagpieConfigDir({ configDir: 'relative/magpie-dir' }),
        /magpieConfigDir must be an absolute path/,
      );
      await assert.rejects(
        () => resolveMagpieConfigDir({ magpiePath: 'relative/magpie.exe' }),
        /magpiePath must be an absolute path/,
      );
      await fs.writeFile(providersPath, JSON.stringify({ providers: [{ id: 'antigravity', proxy: 'direct' }] }), 'utf8');
      await assert.rejects(
        () => loadMagpieAntigravityAccounts({ configDir: tmpDir, requireProxy: true }),
        /cannot be queried without a bound proxy/,
      );
    } finally {
      httpsUpstream.closeAllConnections?.();
      await Promise.all([
        httpProxy.close(),
        socksProxy.close(),
        new Promise((resolve) => httpsUpstream.close(resolve)),
      ]);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('six-account Antigravity direct snapshot fixture passes strict HarnessQuotaReading validation and preserves 12-window (4 eligible / 8 ineligible / 0 unknown) weekly semantics', async () => {
  const fixturePath = path.join(import.meta.dirname, 'fixtures', 'agy-six-accounts-snapshot.json');
  const snapshot = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

  assert.equal(snapshot.protocol, COLLECTOR_PROTOCOL_ID);
  assert.equal(snapshot.schemaVersion, COLLECTOR_SCHEMA_VERSION);
  assert.equal(snapshot.accounts.length, 6);
  assert.equal(snapshot.readings.length, 30);

  for (const reading of snapshot.readings) {
    validateHarnessQuotaReading(reading);
  }

  // Verify acct-05 (`Claude & GPT · 7 days` exhausted = 0% and `3p-5h` disabled -> unpooled per-model 5h readings at 0%)
  const acct5ExhaustedPool = snapshot.readings.find(
    (r) => r.accountId === 'acct-05@example.test' && r.pool === 'Claude & GPT' && r.window === '7 days',
  );
  assert.equal(acct5ExhaustedPool.remaining, 0);
  assert.equal(acct5ExhaustedPool.modelIds, undefined);
  const acct5Opus5h = snapshot.readings.find(
    (r) => r.accountId === 'acct-05@example.test' && r.window === '5 hours' && r.modelIds?.includes('claude-opus-5-5-high'),
  );
  assert.equal(acct5Opus5h.remaining, 0);

  // Evaluate the 12 weekly windows (6 accounts × {Opus, Argon}) against the 168h ± 6h fresh-weekly rule:
  // 4 eligible (1 Opus + 3 Argon), 8 ineligible, 0 unknown.
  let eligibleOpus = 0;
  let eligibleArgon = 0;
  let ineligible = 0;
  let unknown = 0;

  for (const acc of snapshot.accounts) {
    const readAtMs = Date.parse(acc.readAt);
    assert.ok(Number.isFinite(readAtMs));

    // Argon weekly
    assert.equal(acc.argonWeekly.status, 'known');
    assert.equal(acc.argonWeekly.offeredInCatalog, true);
    const argonHours = (Date.parse(acc.argonWeekly.resetAt) - readAtMs) / 3_600_000;
    if (acc.argonWeekly.remainingPercent === 100 && argonHours >= 162 && argonHours <= 174) {
      eligibleArgon += 1;
    } else {
      ineligible += 1;
    }

    // Opus weekly (`Claude & GPT` 7 days)
    const claudeGroup = acc.summaryGroups.find((g) => g.pool === 'Claude & GPT');
    const claude7d = claudeGroup?.buckets.find((b) => b.window === '7 days');
    if (!claude7d || typeof claude7d.remainingPercent !== 'number') {
      unknown += 1;
    } else {
      const opusHours = (Date.parse(claude7d.resetAt) - readAtMs) / 3_600_000;
      if (claude7d.remainingPercent === 100 && opusHours >= 162 && opusHours <= 174) {
        eligibleOpus += 1;
      } else {
        ineligible += 1;
      }
    }
  }

  assert.equal(eligibleOpus, 1);
  assert.equal(eligibleArgon, 3);
  assert.equal(eligibleOpus + eligibleArgon, 4);
  assert.equal(ineligible, 8);
  assert.equal(unknown, 0);
});

test('standalone desensitized CLI invocation (`node plugins/magpie-harness-quota/lib/antigravity-direct-quota.mjs`) outputs wake-script JSON protocol without leaking emails, tokens, or proxy credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-direct-cli-test-'));
  const upstreamSockets = new Set();
  const proxySockets = new Set();
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1internal:loadCodeAssist') {
      res.writeHead(200).end(JSON.stringify({ currentTier: { id: 'standard-tier' }, paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } }));
    } else if (req.url === '/v1internal:fetchAvailableModels') {
      res.writeHead(200).end(JSON.stringify({ models: { 'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-08T06:00:00Z' } } } }));
    } else if (req.url === '/v1internal:retrieveUserQuotaSummary') {
      res.writeHead(200).end(JSON.stringify({ groups: [{ displayName: 'Gemini Models', description: 'Gemini Pro', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-14T00:00:00Z' }, { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T06:00:00Z' }] }] }));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  upstream.on('connection', (s) => { upstreamSockets.add(s); s.on('close', () => upstreamSockets.delete(s)); });

  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    const p = http.request({
      hostname: u.hostname,
      port: Number(u.port) || 80,
      path: `${u.pathname}${u.search}`,
      method: req.method,
      headers: req.headers,
    }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    req.pipe(p);
  });
  proxy.on('connection', (s) => { proxySockets.add(s); s.on('close', () => proxySockets.delete(s)); });

  await Promise.all([
    new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
  ]);

  try {
    const magpieBinDir = path.join(dir, 'bin');
    const portableDataDir = path.join(magpieBinDir, 'data');
    await fs.mkdir(portableDataDir, { recursive: true });
    const fakeMagpieExe = path.join(magpieBinDir, 'magpie.exe');
    await fs.writeFile(fakeMagpieExe, '', 'utf8');
    await fs.writeFile(path.join(magpieBinDir, '.portable'), '', 'utf8');
    await fs.writeFile(path.join(portableDataDir, 'logins.json'), JSON.stringify([
      {
        agent: 'antigravity',
        user: 'secret-user@example.test',
        auth: { access_token: 'secret-access-token', refresh_token: 'secret-refresh-token', expiry_date: Date.now() + 3600_000 },
      },
    ]), 'utf8');
    await fs.writeFile(path.join(portableDataDir, 'providers.json'), JSON.stringify({
      providers: [
        {
          id: 'antigravity',
          accountProxies: {
            'secret-user@example.test': `http://proxy-user:secret-proxy-pass@127.0.0.1:${proxy.address().port}`,
          },
        },
      ],
    }), 'utf8');

    const collectorScript = path.resolve(import.meta.dirname, '..', 'lib', 'antigravity-direct-quota.mjs');
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        collectorScript,
        '--magpie-path', fakeMagpieExe,
        '--origin', `http://127.0.0.1:${upstream.address().port}`,
        '--include-desensitized-readings',
      ]);
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`CLI exited ${code}: ${err}`))));
    });

    assert.ok(!stdout.includes('secret-user@example.test'));
    assert.ok(!stdout.includes('secret-access-token'));
    assert.ok(!stdout.includes('secret-refresh-token'));
    assert.ok(!stdout.includes('secret-proxy-pass'));

    const payload = JSON.parse(stdout);
    assert.equal(payload.protocol, COLLECTOR_PROTOCOL_ID);
    assert.equal(payload.schemaVersion, COLLECTOR_SCHEMA_VERSION);
    assert.equal(payload.secretsIncluded, false);
    assert.equal(payload.fullEmailsIncluded, false);
    assert.equal(payload.accounts.length, 1);
    assert.equal(payload.accounts[0].status, 'ok');
    assert.equal(payload.accounts[0].argonWeekly.status, 'known');
    assert.equal(payload.readings.length, 2);
    for (const r of payload.readings) validateHarnessQuotaReading(r);
  } finally {
    for (const s of proxySockets) s.destroy();
    for (const s of upstreamSockets) s.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collector source ships no embedded OAuth client', async () => {
  const source = await fs.readFile(new URL('../lib/antigravity-direct-quota.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('googleusercontent.com'), false);
  assert.equal(source.includes('GOCSPX-'), false);
});

test('missing OAuth client marks only expired accounts unknown; a live token still queries, and settings inject the refresh client', async () => {
  clearCollectorRuntimeCaches();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-oauth-client-gap-'));
  try {
    const { keyPath, certPath } = generateTestSelfSignedCert(tmpDir);
    const [keyPem, certPem] = await Promise.all([
      fs.readFile(keyPath),
      fs.readFile(certPath),
    ]);
    const httpProxy = await startAuthenticatedConnectProxy({ expectedAuth: '' });
    const socksProxy = await startAuthenticatedSocks5Proxy({ expectedUser: 'beta', expectedPass: 'beta-pass' });
    const upstreamHits = [];
    const httpsUpstream = https.createServer({ key: keyPem, cert: certPem }, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      upstreamHits.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth2/token') {
        const params = new URLSearchParams(body);
        res.writeHead(200).end(JSON.stringify({
          access_token: `fresh-at-for-${params.get('refresh_token')}`,
          expires_in: 3600,
        }));
        return;
      }
      if (req.url === '/v1internal:loadCodeAssist') {
        res.writeHead(200).end(JSON.stringify({
          cloudaicompanionProject: 'proj-gap',
          currentTier: { id: 'standard-tier', name: 'Antigravity' },
        }));
        return;
      }
      if (req.url === '/v1internal:fetchAvailableModels') {
        res.writeHead(200).end(JSON.stringify({
          models: {
            'gemini-3.8-flash': {
              displayName: 'Gemini 3.8 Flash',
              quotaInfo: { remainingFraction: 0.5, resetTime: '2026-11-08T08:00:00Z' },
            },
          },
        }));
        return;
      }
      if (req.url === '/v1internal:retrieveUserQuotaSummary') {
        res.writeHead(200).end(JSON.stringify({ groups: [] }));
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise((resolve) => httpsUpstream.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${httpsUpstream.address().port}`;
    const tokenUrl = `${origin}/oauth2/token`;
    await fs.writeFile(path.join(tmpDir, 'logins.json'), JSON.stringify([
      {
        agent: 'antigravity',
        user: 'live@example.test',
        on: true,
        auth: {
          access_token: 'still-valid-alpha',
          refresh_token: 'rt-live',
          expiry_date: Date.now() + 3_600_000,
        },
      },
      {
        agent: 'antigravity',
        user: 'expired@example.test',
        on: true,
        auth: {
          access_token: 'expired-beta',
          refresh_token: 'rt-expired',
          expiry_date: 1_000,
        },
      },
    ]), 'utf8');
    await fs.writeFile(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [{
        id: 'antigravity',
        accountNames: {
          'live@example.test': 'Seat Live',
          'expired@example.test': 'Seat Expired',
        },
        accountProxies: {
          'live@example.test': `http://127.0.0.1:${httpProxy.port}`,
          'expired@example.test': `socks5://beta:beta-pass@127.0.0.1:${socksProxy.port}`,
        },
      }],
    }), 'utf8');

    try {
      const gap = await collectMagpieAntigravityDirectQuotas({
        configDir: tmpDir,
        origin,
        tokenUrl,
        ca: certPem,
        env: {},
        includeEmailInReadings: false,
      });
      const live = gap.accounts.find((account) => account.accountLabel === 'Seat Live');
      const expired = gap.accounts.find((account) => account.accountLabel === 'Seat Expired');
      assert.equal(live.status, 'ok');
      assert.equal(expired.status, 'unknown');
      assert.equal(expired.argonWeekly.status, 'unknown');
      assert.equal(upstreamHits.some((hit) => hit.url === '/oauth2/token'), false);
      assert.equal(upstreamHits.filter((hit) => hit.auth === 'Bearer still-valid-alpha').length, 3);
      assert.equal(httpProxy.connectLog.length, 3);
      assert.equal(socksProxy.socksLog.length, 0);
      assert.equal(JSON.stringify(gap).includes('rt-expired'), false);
      assert.equal(JSON.stringify(gap).includes('still-valid-alpha'), false);

      const hitsBeforeRefresh = upstreamHits.length;
      const service = new MagpieAntigravityDirectQuotaService({
        configDir: tmpDir,
        origin,
        tokenUrl,
        ca: certPem,
        env: {},
        minRefreshIntervalMs: 0,
      });
      const refreshed = await service.read({
        settings: {
          antigravityOAuthClientId: 'synthetic-antigravity-client',
          antigravityOAuthClientSecret: 'synthetic-antigravity-secret',
        },
      });
      assert.ok(Array.isArray(refreshed.readings) && refreshed.readings.length > 0);
      const tokenHits = upstreamHits.filter((hit) => hit.url === '/oauth2/token');
      assert.equal(tokenHits.length, 1);
      const params = new URLSearchParams(tokenHits[0].body);
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'rt-expired');
      assert.equal(params.get('client_id'), 'synthetic-antigravity-client');
      assert.equal(params.get('client_secret'), 'synthetic-antigravity-secret');
      assert.ok(upstreamHits.length > hitsBeforeRefresh);
      assert.equal(socksProxy.socksLog.length, 4);
      assert.ok(httpProxy.connectLog.length > 3);
      assert.equal(JSON.stringify(refreshed).includes('synthetic-antigravity-secret'), false);
      assert.equal(JSON.stringify(refreshed).includes('rt-expired'), false);
      for (const reading of refreshed.readings) validateHarnessQuotaReading(reading);
    } finally {
      httpsUpstream.closeAllConnections?.();
      await Promise.all([
        httpProxy.close(),
        socksProxy.close(),
        new Promise((resolve) => httpsUpstream.close(resolve)),
      ]);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('batch collector single-flights managed `magpie quota refresh antigravity --json` across multiple expired accounts when OAuth client is unconfigured, while preserving OAUTH_CLIENT_UNCONFIGURED on ENOENT or magpieRefresh: false', async () => {
  clearCollectorRuntimeCaches();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-cli-fallback-batch-'));
  const magpieDir = path.join(tmpDir, 'magpie');
  await fs.mkdir(magpieDir, { recursive: true });
  try {
    const httpProxy = await startAuthenticatedConnectProxy({ expectedAuth: '' });
    const { keyPath, certPath } = generateTestSelfSignedCert(tmpDir);
    const [keyPem, certPem] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    const upstreamHits = [];
    const httpsUpstream = https.createServer({ key: keyPem, cert: certPem }, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      upstreamHits.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1internal:loadCodeAssist') {
        res.writeHead(200).end(JSON.stringify({
          cloudaicompanionProject: 'proj-cli-fallback',
          currentTier: { id: 'standard-tier', name: 'Antigravity' },
        }));
        return;
      }
      if (req.url === '/v1internal:fetchAvailableModels') {
        res.writeHead(200).end(JSON.stringify({
          models: {
            'gemini-4-argon-high': {
              displayName: 'Gemini 4 Argon (High)',
              quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-11T12:00:00Z' },
            },
          },
        }));
        return;
      }
      if (req.url === '/v1internal:retrieveUserQuotaSummary') {
        res.writeHead(200).end(JSON.stringify({
          groups: [{
            displayName: 'Gemini 4 Argon',
            description: 'Argon weekly pool',
            buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-11-18T00:00:00Z' }],
          }],
        }));
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise((resolve) => httpsUpstream.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${httpsUpstream.address().port}`;
    const loginsPath = path.join(magpieDir, 'logins.json');
    const providersPath = path.join(magpieDir, 'providers.json');

    const writeExpiredSix = async () => {
      const logins = Array.from({ length: 6 }, (_, idx) => ({
        agent: 'antigravity',
        user: `seat-${idx + 1}@example.test`,
        on: true,
        auth: {
          access_token: `expired-at-${idx + 1}`,
          refresh_token: `rt-seat-${idx + 1}`,
          expiry_date: Date.now() + 30_000, // < 2 minutes margin -> triggers refresh
        },
      }));
      await fs.writeFile(loginsPath, JSON.stringify(logins, null, 2), 'utf8');
    };
    await writeExpiredSix();
    await fs.writeFile(providersPath, JSON.stringify({
      providers: [{ id: 'antigravity', proxy: `http://127.0.0.1:${httpProxy.port}` }],
    }, null, 2), 'utf8');

    try {
      // 1. Explicit `magpieRefresh: false` preserves OAUTH_CLIENT_UNCONFIGURED
      const accountsForDirectCheck = await loadMagpieAntigravityAccounts({ configDir: magpieDir, env: { XDG_CONFIG_HOME: tmpDir } });
      await assert.rejects(
        () => ensureFreshAccessToken(accountsForDirectCheck[0], {
          magpieRefresh: false,
          configDir: magpieDir,
          env: { XDG_CONFIG_HOME: tmpDir },
        }),
        (err) => err?.code === OAUTH_CLIENT_UNCONFIGURED,
      );

      // 2. Simulated missing binary (`ENOENT`) preserves OAUTH_CLIENT_UNCONFIGURED (-> status: 'unknown' in batch)
      const enoentBatch = await collectMagpieAntigravityDirectQuotas({
        configDir: magpieDir,
        origin,
        ca: certPem,
        env: { XDG_CONFIG_HOME: tmpDir },
        includeEmailInReadings: false,
        execFileFn: async () => {
          const err = new Error('spawn magpie ENOENT');
          err.code = 'ENOENT';
          throw err;
        },
      });
      assert.equal(enoentBatch.accounts.length, 6);
      assert.ok(enoentBatch.accounts.every((a) => a.status === 'unknown'));

      // 3. Batch refresh across 6 expired accounts triggers ONE single-flight `magpie quota refresh antigravity --json`
      let cliCalls = 0;
      const cliSeenArgs = [];
      const cliSeenEnv = [];
      const refreshedBatch = await collectMagpieAntigravityDirectQuotas({
        configDir: magpieDir,
        magpiePath: path.resolve(tmpDir, 'bin', 'magpie.exe'),
        origin,
        ca: certPem,
        env: { XDG_CONFIG_HOME: tmpDir },
        includeEmailInReadings: true,
        execFileFn: async (executable, args, options) => {
          cliCalls += 1;
          cliSeenArgs.push({ executable, args });
          cliSeenEnv.push(options.env?.XDG_CONFIG_HOME);
          const current = JSON.parse(await fs.readFile(loginsPath, 'utf8'));
          const nextExpiry = Date.now() + 3_600_000;
          for (let i = 0; i < current.length; i += 1) {
            current[i].auth.access_token = `cli-fresh-token-${i + 1}`;
            current[i].auth.expiry_date = nextExpiry;
          }
          await fs.writeFile(loginsPath, JSON.stringify(current, null, 2), 'utf8');
          return { stdout: '[]', stderr: '' };
        },
      });

      assert.equal(cliCalls, 1, '6 concurrent expired accounts must coalesce into 1 single-flight Magpie CLI invocation');
      assert.deepEqual(cliSeenArgs[0].args, ['quota', 'refresh', 'antigravity', '--json']);
      assert.equal(cliSeenEnv[0], tmpDir);
      assert.equal(refreshedBatch.accounts.length, 6);
      assert.ok(refreshedBatch.accounts.every((a) => a.status === 'ok'));
      for (let i = 1; i <= 6; i += 1) {
        assert.ok(upstreamHits.some((h) => h.auth === `Bearer cli-fresh-token-${i}`));
      }
      for (const r of refreshedBatch.readings) validateHarnessQuotaReading(r);

      // Subsequent read reuses tokenMemoryCache without spawning Magpie CLI again even if logins.json still had old mtime
      const secondBatch = await collectMagpieAntigravityDirectQuotas({
        configDir: magpieDir,
        magpiePath: path.resolve(tmpDir, 'bin', 'magpie.exe'),
        origin,
        ca: certPem,
        env: { XDG_CONFIG_HOME: tmpDir },
        includeEmailInReadings: true,
        execFileFn: async () => {
          throw new Error('must not invoke CLI while refreshed tokens remain cached in memory');
        },
      });
      assert.ok(secondBatch.accounts.every((a) => a.status === 'ok'));
    } finally {
      httpsUpstream.closeAllConnections?.();
      await Promise.all([
        httpProxy.close(),
        new Promise((resolve) => httpsUpstream.close(resolve)),
      ]);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
