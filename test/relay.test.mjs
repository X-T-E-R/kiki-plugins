import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { packageFiles } from '../scripts/package-files.mjs';
import { validateRegistration } from '../scripts/validate-registration.mjs';
import { register } from '../plugins/official/kiki-relay/entry.mjs';
import { definitions } from '../plugins/official/kiki-relay/lib/definitions.mjs';
import { RelayPluginService } from '../plugins/official/kiki-relay/lib/service.mjs';
import {
  RELAY_WS_SUBPROTOCOL,
  canonicalOriginPath,
  startKikiRelayServer,
} from '../plugins/official/kiki-relay/server/kiki-relay-server.mjs';
import { WebSocket } from '../plugins/official/kiki-relay/vendor/ws/wrapper.mjs';

const scratch = path.resolve('.tmp/relay-plugin/tests');

function generateHostIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const fp = createHash('sha256').update(spkiDer).digest('hex');
  return { publicKey, privateKey, spkiDer, fp };
}

function mintPairingTicket(capKeyHex, fp, expSec) {
  const mac = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`pair:${fp}:${expSec}`, 'utf8')
    .digest('hex');
  return `p.${expSec}.${mac}`;
}

function mintGrantTicket(capKeyHex, fp, grantId) {
  const mac = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`grant:${fp}:${grantId}`, 'utf8')
    .digest('hex');
  return `g.${grantId}.${mac}`;
}

function mintPoolToken(capKeyHex, fp, nonce, ticket = '') {
  return createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`pool:${fp}:${nonce}:${ticket}`, 'utf8')
    .digest('hex');
}

function waitForJsonFrame(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw, isBinary) => {
      if (isBinary) return;
      cleanup();
      resolve(JSON.parse(Buffer.from(raw).toString('utf8')));
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = (code) => { cleanup(); reject(new Error(`closed ${code}`)); };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

test('manifest, catalog entry, packaged server assets, and tool registrations match', async () => {
  const pluginRoot = path.resolve('plugins/official/kiki-relay');
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest['x-kiki'].activation, 'app');
  assert.equal(manifest['x-kiki'].panels[0].id, 'relay');
  assert.equal(manifest['x-kiki'].commands[0].name, 'relay-setup');
  assert.deepEqual(manifest['x-kiki'].tools, definitions);

  await validateRegistration(manifest, register);

  const catalog = JSON.parse(await readFile('plugins/marketplace.json', 'utf8'));
  const entry = catalog.plugins.find((item) => item.id === 'kiki-relay');
  assert.ok(entry);
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.source, './official/kiki-relay');

  const files = await packageFiles(pluginRoot);
  assert.ok(files.includes('server/kiki-relay-server.mjs'));
  assert.ok(files.includes('server/Dockerfile'));
  assert.ok(files.includes('server/docker-compose.yml'));
  assert.ok(files.includes('panel.html'));
  assert.ok(files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(files.includes('vendor/ws/wrapper.mjs'));
});

test('RelayPluginService discovers live kap-server from Kiki home, routes all CRUD/probe to /api/remote-connections/relays*, rejects cleartext public URLs, and runs embedded server without parallel state', async (t) => {
  await mkdir(scratch, { recursive: true });
  const kikiHome = await mkdtemp(path.join(scratch, 'home-'));
  t.after(() => rm(kikiHome, { recursive: true, force: true }));

  const pluginDataDir = path.join(kikiHome, 'plugins', 'data', 'kiki-relay');
  await mkdir(pluginDataDir, { recursive: true });
  await mkdir(path.join(kikiHome, 'server', 'instances'), { recursive: true });
  await writeFile(path.join(kikiHome, 'server.local-owner'), 'owner-secret-token-123\n', 'utf8');
  await writeFile(
    path.join(kikiHome, 'server', 'instances', 'srv-live.json'),
    JSON.stringify({
      server_id: 'srv-live',
      pid: process.pid,
      host: '127.0.0.1',
      port: 58627,
      started_at: Date.now(),
      heartbeat_at: Date.now(),
      workspaces: [],
    }),
    'utf8',
  );

  const kapNodes = [];
  const kapSubs = [];
  const calls = [];

  const buildKapStatus = () => ({
    schemaVersion: 1,
    inboundEnabled: true,
    ...(kapNodes[0] ? { homeNodeId: kapNodes[0].id } : {}),
    standbyNodeIds: kapNodes.slice(1, 3).map((n) => n.id),
    nodes: kapNodes.map((n, idx) => ({
      id: n.id,
      label: n.label,
      url: n.url,
      role: n.role,
      enabled: n.enabled,
      tokenConfigured: n.tokenConfigured,
      slot: idx === 0 ? 'home' : 'standby',
      connected: true,
      rttMs: 12 + idx * 10,
    })),
    subscriptions: kapSubs.map((s) => ({ ...s })),
  });

  const service = new RelayPluginService({
    fetchFn: async (url, init = {}) => {
      assert.equal(init.headers?.authorization, 'Bearer owner-secret-token-123');
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'http://127.0.0.1:58627');
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: parsed.pathname, body });

      if (init.method === 'GET' && parsed.pathname === '/api/remote-connections/relays') {
        return Response.json({ code: 0, msg: 'ok', data: buildKapStatus() });
      }
      if (init.method === 'POST' && parsed.pathname === '/api/remote-connections/relays/nodes') {
        kapNodes.push({
          id: 'node-hk',
          label: 'HK Home',
          url: 'wss://relay-hk.example.com/relay',
          role: 'auto',
          enabled: true,
          tokenConfigured: true,
        });
        return Response.json({ code: 0, msg: 'ok', data: buildKapStatus() });
      }
      if (init.method === 'POST' && parsed.pathname === '/api/remote-connections/relays/subscriptions') {
        kapSubs.push({
          id: 'sub-team',
          url: body.url,
          label: 'Team Relays',
          enabled: true,
          etag: '"rev-1"',
          lastSyncedAt: Date.now(),
        });
        kapNodes.push({
          id: 'sub:sub-team:sg',
          label: 'SG Standby',
          url: 'wss://relay-sg.example.com',
          role: 'auto',
          enabled: true,
          tokenConfigured: true,
        });
        return Response.json({ code: 0, msg: 'ok', data: buildKapStatus() });
      }
      if (init.method === 'POST' && parsed.pathname === '/api/remote-connections/relays/subscriptions/sub-team/refresh') {
        return Response.json({ code: 0, msg: 'ok', data: buildKapStatus() });
      }
      if (init.method === 'POST' && parsed.pathname === '/api/remote-connections/relays/probe') {
        return Response.json({ code: 0, msg: 'ok', data: { ok: true, url: body.url, rttMs: 14, version: 1 } });
      }
      throw new Error(`Unexpected request: ${init.method} ${url}`);
    },
  });
  t.after(() => service.deactivate());

  const initial = await service.activate({ dataDir: pluginDataDir, settings: {} });
  assert.deepEqual(initial.nodes, []);
  assert.deepEqual(initial.subscriptions, []);

  await assert.rejects(
    service.panel('addNode', { uri: 'ws://relay-hk.example.com/relay' }),
    /Invalid or insecure/,
  );
  await assert.rejects(
    service.panel('addNode', { uri: 'kiki-relay://relay-hk.example.com/relay?insecure=1&token=leak' }),
    /Invalid or insecure/,
  );
  await assert.rejects(
    service.panel('addSubscription', { url: 'http://team.example.com/relays.json' }),
    /HTTPS/,
  );

  const afterShare = await service.panel('addNode', {
    uri: 'kiki-relay://relay-hk.example.com/relay?name=HK%20Home&token=top-secret-token',
  });
  assert.equal(afterShare.nodes.length, 1);
  assert.equal(afterShare.nodes[0].tokenConfigured, true);
  assert.equal(JSON.stringify(afterShare).includes('top-secret-token'), false);
  assert.equal(afterShare.homeNodeId, 'node-hk');

  const afterSub = await service.panel('addSubscription', { url: 'https://team.example.com/relays.json' });
  assert.equal(afterSub.subscriptions.length, 1);
  assert.equal(afterSub.subscriptions[0].etag, '"rev-1"');
  assert.equal(afterSub.nodes.length, 2);

  await service.panel('refreshSubscription', { id: 'sub-team' });
  const probed = await service.panel('probe', { url: 'wss://relay-hk.example.com/relay' });
  assert.equal(probed.ok, true);
  assert.equal(probed.rttMs, 14);

  await assert.rejects(access(path.join(pluginDataDir, 'relay-state.json')));
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/remote-connections/relays/nodes'));
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/remote-connections/relays/subscriptions'));

  const guide = await service.panel('deployGuide', { publicHost: 'relay.example.com', proxyTarget: 'nginx' });
  assert.equal(guide.port, 9440);
  assert.match(guide.proxySnippet, /proxy_buffering off;/);
  assert.match(guide.npxCommand, /RELAY_SECRET=/);
  assert.match(guide.dockerCommand, /docker build -f server\/Dockerfile/);
  assert.equal(guide.dockerCommand.includes('ghcr.io'), false);

  const started = await service.panel('startLocalServer');
  assert.equal(started.localServer.state, 'running');
  assert.match(started.localServer.shareUri, /^kiki-relay:\/\/127\.0\.0\.1:\d+/);

  const stopped = await service.panel('stopLocalServer');
  assert.equal(stopped.localServer.state, 'stopped');
});

test('kiki-relay-server enforces P-256 registration, single-use pool tokens, stateless p./g. stream tickets, warm pool 0ms handoff, and burst open fallback', async (t) => {
  const relay = await startKikiRelayServer({
    host: '127.0.0.1',
    port: 0,
    basePath: '/kiki-relay',
    hostToken: 'host-bearer-secret',
    secret: 'unit-test-hmac-secret',
  });
  t.after(() => relay.stop());

  const baseHttp = `http://127.0.0.1:${relay.port}/kiki-relay`;
  const baseWs = `ws://127.0.0.1:${relay.port}/kiki-relay`;

  const probeRes = await fetch(`${baseHttp}/v1/probe`);
  assert.equal(probeRes.status, 200);
  assert.equal(probeRes.headers.get('cache-control'), 'no-store');
  const probeBody = await probeRes.json();
  assert.equal(probeBody.ok, true);
  assert.equal(probeBody.version, 1);

  await assert.rejects(
    new Promise((resolve, reject) => {
      const bad = new WebSocket(`${baseWs}/v1/host`, [RELAY_WS_SUBPROTOCOL], {
        headers: { authorization: 'Bearer wrong-token' },
      });
      bad.on('open', resolve);
      bad.on('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`status:${res.statusCode}`));
      });
      bad.on('error', reject);
    }),
    /status:401/,
  );

  const hostId = generateHostIdentity();
  const controlWs = new WebSocket(`${baseWs}/v1/host`, [RELAY_WS_SUBPROTOCOL], {
    headers: { authorization: 'Bearer host-bearer-secret' },
    perMessageDeflate: false,
  });
  t.after(() => controlWs.terminate());

  const challenge = await waitForJsonFrame(controlWs);
  assert.equal(challenge.type, 'challenge');

  const originPath = canonicalOriginPath(baseWs);
  const sig = sign(
    'sha256',
    Buffer.from(`kiki-relay-host-v1:${originPath}:${hostId.fp}:${challenge.nonce}:${challenge.ts}`, 'utf8'),
    hostId.privateKey,
  );
  controlWs.send(
    JSON.stringify({
      type: 'register',
      spkiDer: hostId.spkiDer.toString('base64'),
      signature: sig.toString('base64'),
    }),
  );

  const registered = await waitForJsonFrame(controlWs);
  assert.equal(registered.type, 'registered');
  assert.equal(registered.fp, hostId.fp);
  assert.match(registered.capKey, /^[a-f0-9]{64}$/);

  const openPool = (nonce, ticket = '') => {
    const poolToken = mintPoolToken(registered.capKey, hostId.fp, nonce, ticket);
    const params = new URLSearchParams({ fp: hostId.fp, nonce, poolToken, ...(ticket ? { ticket } : {}) });
    return new WebSocket(`${baseWs}/v1/pool?${params.toString()}`, [RELAY_WS_SUBPROTOCOL], {
      headers: { authorization: 'Bearer host-bearer-secret' },
      perMessageDeflate: false,
    });
  };

  const warmNonce = randomBytes(16).toString('hex');
  const warmPoolWs = openPool(warmNonce);
  t.after(() => warmPoolWs.terminate());
  await new Promise((resolve, reject) => {
    warmPoolWs.once('open', resolve);
    warmPoolWs.once('error', reject);
  });

  await assert.rejects(
    new Promise((resolve, reject) => {
      const replay = openPool(warmNonce);
      replay.on('open', resolve);
      replay.on('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`status:${res.statusCode}`));
      });
      replay.on('error', reject);
    }),
    /status:403/,
  );

  await assert.rejects(
    new Promise((resolve, reject) => {
      const unticketed = new WebSocket(`${baseWs}/v1/stream?target=${hostId.fp}`, [RELAY_WS_SUBPROTOCOL]);
      unticketed.on('open', resolve);
      unticketed.on('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`status:${res.statusCode}`));
      });
      unticketed.on('error', reject);
    }),
    /status:403/,
  );

  let warmActivated = false;
  warmPoolWs.on('message', (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(Buffer.from(data).toString('utf8'));
      if (msg.type === 'activate') warmActivated = true;
      return;
    }
    warmPoolWs.send(Buffer.concat([Buffer.from('echo:'), Buffer.from(data)]), { binary: true, compress: false });
  });

  const replenishPromise = waitForJsonFrame(controlWs);
  const pairTicket = mintPairingTicket(registered.capKey, hostId.fp, Math.floor(Date.now() / 1000) + 600);
  const client1 = new WebSocket(
    `${baseWs}/v1/stream?target=${hostId.fp}&rt=${encodeURIComponent(pairTicket)}`,
    { perMessageDeflate: false },
  );
  t.after(() => client1.terminate());
  await new Promise((resolve, reject) => {
    client1.once('open', resolve);
    client1.once('error', reject);
  });

  const replenishMsg = await replenishPromise;
  assert.deepEqual(replenishMsg, { type: 'replenish', need: 1 });

  const echoed1 = await new Promise((resolve, reject) => {
    client1.once('message', (data, isBinary) => {
      assert.equal(isBinary, true);
      resolve(Buffer.from(data).toString('utf8'));
    });
    client1.once('error', reject);
    client1.send(Buffer.from('tls-client-hello-1'), { binary: true, compress: false });
  });
  assert.equal(warmActivated, true);
  assert.equal(echoed1, 'echo:tls-client-hello-1');
  client1.close();

  controlWs.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (msg.type === 'open' && typeof msg.ticket === 'string') {
      const burstWs = openPool(randomBytes(16).toString('hex'), msg.ticket);
      t.after(() => burstWs.terminate());
      burstWs.on('message', (d, bin) => {
        if (!bin) return;
        burstWs.send(Buffer.concat([Buffer.from('burst:'), Buffer.from(d)]), { binary: true, compress: false });
      });
    }
  });

  const grantTicket = mintGrantTicket(registered.capKey, hostId.fp, 'grant_01');
  const client2 = new WebSocket(
    `${baseWs}/v1/stream?target=${hostId.fp}&rt=${encodeURIComponent(grantTicket)}`,
    [RELAY_WS_SUBPROTOCOL],
    { perMessageDeflate: false },
  );
  t.after(() => client2.terminate());
  await new Promise((resolve, reject) => {
    client2.once('open', resolve);
    client2.once('error', reject);
  });
  const echoed2 = await new Promise((resolve, reject) => {
    client2.once('message', (data) => resolve(Buffer.from(data).toString('utf8')));
    client2.once('error', reject);
    client2.send(Buffer.from('tls-client-hello-2'), { binary: true, compress: false });
  });
  assert.equal(echoed2, 'burst:tls-client-hello-2');
  client2.close();
});
