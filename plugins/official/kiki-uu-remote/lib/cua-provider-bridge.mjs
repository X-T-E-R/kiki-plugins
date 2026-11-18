import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUA_PROVIDER_PROTOCOL = 'kiki.cua.provider.v1';
export const UU_PROVIDER_ID = 'kiki-uu-remote';
export const UU_PROVIDER_DISPLAY_NAME = 'NetEase UU Remote';

const LOOPBACK_ENDPOINT_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_TTL_MS = 35_000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function resolveCuaProviderBusDir({
  context = null,
  dataDir = null,
  pluginRoot = null,
  pluginId = UU_PROVIDER_ID,
  env = process.env,
  homedir = os.homedir,
} = {}) {
  if (env?.KIKI_CUA_BUS_DIR && String(env.KIKI_CUA_BUS_DIR).trim()) {
    return path.resolve(String(env.KIKI_CUA_BUS_DIR).trim());
  }

  const kikiHome = context?.kikiHome || env?.KIKI_HOME || env?.KIMI_CODE_HOME;
  if (kikiHome && String(kikiHome).trim()) {
    return path.join(path.resolve(String(kikiHome).trim()), 'plugins', 'data', 'kiki-cua', 'providers');
  }

  const effectiveDataDir = dataDir || context?.dataDir;
  if (effectiveDataDir && String(effectiveDataDir).trim()) {
    return path.join(path.dirname(path.resolve(String(effectiveDataDir).trim())), 'kiki-cua', 'providers');
  }

  const effectivePluginRoot = pluginRoot || env?.KIKI_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
  if (effectivePluginRoot) {
    const resolvedRoot = path.resolve(String(effectivePluginRoot));
    const normalized = resolvedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.endsWith(`/plugins/managed/${pluginId}`)) {
      const inferredHome = path.resolve(resolvedRoot, '..', '..', '..');
      return path.join(inferredHome, 'plugins', 'data', 'kiki-cua', 'providers');
    }
  }

  return path.join(homedir(), '.kiki', 'plugins', 'data', 'kiki-cua', 'providers');
}

function isLoopbackRemoteAddress(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1';
}

function verifyBearerToken(authHeader, expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) {
    return false;
  }
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const supplied = authHeader.slice('Bearer '.length).trim();
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw Object.assign(new Error('Request JSON body exceeds 1 MiB limit.'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON request body.'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function probeExistingPeerLease(leasePath, nowMs) {
  try {
    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    if (
      lease?.protocol !== CUA_PROVIDER_PROTOCOL ||
      lease?.providerId !== UU_PROVIDER_ID ||
      !LOOPBACK_ENDPOINT_RE.test(String(lease.endpoint || '')) ||
      typeof lease.authToken !== 'string' ||
      lease.authToken.length < 16
    ) {
      return null;
    }
    const ttl = Number(lease.ttlMs) || DEFAULT_TTL_MS;
    if (nowMs - Number(lease.updatedAtMs || 0) >= ttl) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    timer.unref?.();
    try {
      const resp = await fetch(`${lease.endpoint}/v1/health`, {
        headers: { Authorization: `Bearer ${lease.authToken}` },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const health = await resp.json();
      if (health?.ok && health.providerId === UU_PROVIDER_ID) {
        return {
          mode: 'peer_app_server',
          busDir: path.dirname(leasePath),
          leasePath,
          endpoint: lease.endpoint,
          pid: health.pid,
          updatedAtMs: lease.updatedAtMs,
          ttlMs: ttl,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // No healthy peer lease.
  }
  return null;
}

export function createCuaProviderBridge({
  uuService,
  providerId = UU_PROVIDER_ID,
  displayName = UU_PROVIDER_DISPLAY_NAME,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  ttlMs = DEFAULT_TTL_MS,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  env = process.env,
  nowFn = Date.now,
} = {}) {
  let server = null;
  let activeBusDir = null;
  let activeLeasePath = null;
  let endpoint = null;
  let authToken = null;
  let startedAtMs = 0;
  let updatedAtMs = 0;
  let heartbeatTimer = null;
  let latestSettings = {};
  let latestContext = {};
  let startPromise = null;
  let writeChain = Promise.resolve();

  function updateRuntimeContext(ctx = {}) {
    if (ctx && typeof ctx === 'object') {
      if (ctx.settings && typeof ctx.settings === 'object') {
        latestSettings = ctx.settings;
      }
      latestContext = {
        ...latestContext,
        ...(ctx.kikiHome ? { kikiHome: ctx.kikiHome } : {}),
        ...(ctx.dataDir ? { dataDir: ctx.dataDir } : {}),
        settings: latestSettings,
      };
    }
  }

  function buildLeaseRecord() {
    return {
      protocol: CUA_PROVIDER_PROTOCOL,
      providerId,
      displayName,
      pid: process.pid,
      endpoint,
      authToken,
      startedAtMs,
      updatedAtMs,
      ttlMs,
      capabilities: ['targets', 'observe', 'act', 'clipboard', 'takeover'],
    };
  }

  function writeLeaseAtomic() {
    if (!activeBusDir || !activeLeasePath || !endpoint || !authToken) {
      return Promise.resolve();
    }
    const run = async () => {
      updatedAtMs = nowFn();
      await mkdir(activeBusDir, { recursive: true });
      const tmpPath = `${activeLeasePath}.${process.pid}.tmp`;
      const record = buildLeaseRecord();
      await writeFile(tmpPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      await rename(tmpPath, activeLeasePath);
    };
    writeChain = writeChain.then(run, run);
    return writeChain;
  }

  async function handleHttpRequest(req, res) {
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, code: 'loopback_required', message: 'Loopback requests only.' });
      return;
    }

    if (!verifyBearerToken(req.headers.authorization, authToken)) {
      sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'Invalid or missing Bearer token.' });
      return;
    }

    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    try {
      if (req.method === 'GET' && pathname === '/v1/health') {
        sendJson(res, 200, {
          ok: true,
          providerId,
          pid: process.pid,
          updatedAtMs,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/targets') {
        const targets = await uuService.listCuaTargets(latestContext);
        sendJson(res, 200, { ok: true, targets });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/observe') {
        const body = await readJsonBody(req);
        const obs = await uuService.observeCuaTarget(body, latestContext);
        sendJson(res, 200, obs);
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/act') {
        const body = await readJsonBody(req);
        const result = await uuService.actOnCuaTarget(body, latestContext);
        const status = result.ok ? 200 : (result.status || 409);
        const { status: _omitStatus, ...publicBody } = result;
        sendJson(res, status, publicBody);
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/takeover') {
        const body = await readJsonBody(req);
        const result = await uuService.setTakeover(body, latestContext);
        sendJson(res, 200, {
          ok: true,
          targetId: result.targetId,
          takeoverActive: result.takeoverActive,
          controlledBy: result.controlledBy,
        });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not_found', message: `Unknown route: ${req.method} ${pathname}` });
    } catch (error) {
      const code = error?.statusCode || 500;
      sendJson(res, code, {
        ok: false,
        code: code === 400 ? 'bad_request' : 'provider_error',
        message: error?.message || String(error),
      });
    }
  }

  async function start(context = {}, { preferExistingPeer = false } = {}) {
    updateRuntimeContext(context);
    const targetBusDir = resolveCuaProviderBusDir({
      context: latestContext,
      dataDir: context?.dataDir ?? latestContext.dataDir,
      pluginRoot,
      pluginId: providerId,
      env,
    });
    const targetLeasePath = path.join(targetBusDir, `${providerId}.json`);

    if (server && activeBusDir === targetBusDir) {
      return {
        registered: true,
        mode: 'in_process',
        busDir: activeBusDir,
        leasePath: activeLeasePath,
        endpoint,
        pid: process.pid,
        updatedAtMs,
        ttlMs,
      };
    }

    if (preferExistingPeer && !server) {
      const peer = await probeExistingPeerLease(targetLeasePath, nowFn());
      if (peer) {
        return { registered: true, ...peer };
      }
    }

    if (startPromise) return startPromise;

    startPromise = (async () => {
      if (server) {
        await stop();
      }
      authToken = randomBytes(32).toString('hex');
      startedAtMs = nowFn();
      updatedAtMs = startedAtMs;
      activeBusDir = targetBusDir;
      activeLeasePath = targetLeasePath;

      const srv = http.createServer((req, res) => {
        void handleHttpRequest(req, res);
      });

      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', reject);
          resolve();
        });
      });
      srv.unref?.();

      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const candidateEndpoint = `http://127.0.0.1:${port}`;
      if (!LOOPBACK_ENDPOINT_RE.test(candidateEndpoint)) {
        srv.close();
        throw new Error(`Bound endpoint failed loopback check: ${candidateEndpoint}`);
      }

      server = srv;
      endpoint = candidateEndpoint;
      await writeLeaseAtomic();

      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          void writeLeaseAtomic().catch(() => {});
        }, heartbeatMs);
        heartbeatTimer.unref?.();
      }

      return {
        registered: true,
        mode: 'in_process',
        busDir: activeBusDir,
        leasePath: activeLeasePath,
        endpoint,
        pid: process.pid,
        updatedAtMs,
        ttlMs,
      };
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function inspectStatus(context = {}) {
    updateRuntimeContext(context);
    if (server && endpoint) {
      return {
        registered: true,
        mode: 'in_process',
        busDir: activeBusDir,
        leasePath: activeLeasePath,
        endpoint,
        pid: process.pid,
        updatedAtMs,
        ttlMs,
      };
    }
    const info = await start(context, { preferExistingPeer: true }).catch((error) => ({
      registered: false,
      error: error?.message || String(error),
    }));
    return info;
  }

  async function stop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const srv = server;
    const leaseToClean = activeLeasePath;
    const myToken = authToken;
    server = null;
    endpoint = null;
    activeBusDir = null;
    activeLeasePath = null;

    await writeChain.catch(() => {});

    if (leaseToClean && myToken) {
      try {
        const current = JSON.parse(await readFile(leaseToClean, 'utf8'));
        if (current?.authToken === myToken) {
          await rm(leaseToClean, { force: true });
        }
      } catch {
        await rm(leaseToClean, { force: true }).catch(() => {});
      }
    }

    if (srv) {
      await new Promise((resolve) => {
        srv.close(() => resolve());
      });
    }
    authToken = null;
  }

  return {
    start,
    stop,
    inspectStatus,
    updateRuntimeContext,
    getEndpoint: () => endpoint,
    getLeasePath: () => activeLeasePath,
  };
}
