import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUA_PROVIDER_PROTOCOL = 'kiki.cua.provider.v1';
export const DEFAULT_LEASE_TTL_MS = 35_000;
export const DEFAULT_HEARTBEAT_MS = 10_000;
const LOOPBACK_ENDPOINT_RE = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/;
const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve the shared kiki.cua.provider.v1 lease directory in strict 5-step precedence order.
 */
export function resolveCuaProviderBusDir({
  env = process.env,
  context = null,
  dataDir = null,
  pluginRoot = env?.KIKI_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT,
} = {}) {
  if (typeof env?.KIKI_CUA_BUS_DIR === 'string' && env.KIKI_CUA_BUS_DIR.trim()) {
    return path.resolve(env.KIKI_CUA_BUS_DIR.trim());
  }

  const kikiHome = context?.kikiHome || env?.KIKI_HOME || env?.KIMI_CODE_HOME;
  if (typeof kikiHome === 'string' && kikiHome.trim()) {
    return path.join(path.resolve(kikiHome.trim()), 'plugins', 'data', 'kiki-cua', 'providers');
  }

  if (typeof dataDir === 'string' && dataDir.trim()) {
    return path.join(path.dirname(path.resolve(dataDir.trim())), 'kiki-cua', 'providers');
  }

  if (typeof pluginRoot === 'string' && pluginRoot.trim()) {
    const resolvedRoot = path.resolve(pluginRoot.trim());
    const normalized = resolvedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/\/plugins\/managed\/[^/]+$/.test(normalized)) {
      const inferredHome = path.resolve(resolvedRoot, '..', '..', '..');
      return path.join(inferredHome, 'plugins', 'data', 'kiki-cua', 'providers');
    }
  }

  return path.join(os.homedir(), '.kiki', 'plugins', 'data', 'kiki-cua', 'providers');
}

export function isValidLoopbackEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false;
  const match = LOOPBACK_ENDPOINT_RE.exec(endpoint);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 10 && port <= 65535;
}

export function verifyBearerToken(authorizationHeader, expectedToken) {
  if (typeof authorizationHeader !== 'string' || typeof expectedToken !== 'string' || !expectedToken) {
    return false;
  }
  const match = /^Bearer\s+(\S+)$/.exec(authorizationHeader.trim());
  if (!match) return false;
  const actual = match[1];
  const digestActual = createHash('sha256').update(actual, 'utf8').digest();
  const digestExpected = createHash('sha256').update(expectedToken, 'utf8').digest();
  const digestsMatch = timingSafeEqual(digestActual, digestExpected);
  return digestsMatch && actual.length === expectedToken.length;
}

export function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export async function writeProviderLeaseAtomically(busDir, lease) {
  if (!lease || typeof lease.providerId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(lease.providerId)) {
    throw new Error('Invalid providerId in CUA lease');
  }
  if (!isValidLoopbackEndpoint(lease.endpoint)) {
    throw new Error(`Provider endpoint must match ^http://127\\.0\\.0\\.1:\\d{2,5}$: ${String(lease.endpoint)}`);
  }
  await mkdir(busDir, { recursive: true });
  const finalPath = path.join(busDir, `${lease.providerId}.json`);
  const tmpPath = path.join(busDir, `${lease.providerId}.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const payload = JSON.stringify(lease, null, 2) + '\n';
  await writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Scan `<busDir>/*.json`, prune expired or dead-PID leases, reject non-loopback SSRF endpoints,
 * and return active validated provider descriptors.
 */
export async function discoverCuaProviders({
  busDir,
  nowMs = Date.now(),
  pruneDead = true,
  checkPid = isProcessAlive,
} = {}) {
  let entries;
  try {
    entries = await readdir(busDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { providers: [], rejected: [] };
    throw err;
  }

  const providers = [];
  const rejected = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(busDir, entry.name);
    let raw;
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      rejected.push({ file: entry.name, reason: 'invalid_json' });
      continue;
    }

    if (!raw || raw.protocol !== CUA_PROVIDER_PROTOCOL || typeof raw.providerId !== 'string') {
      rejected.push({ file: entry.name, reason: 'unsupported_protocol' });
      continue;
    }

    if (!isValidLoopbackEndpoint(raw.endpoint)) {
      rejected.push({
        file: entry.name,
        providerId: raw.providerId,
        endpoint: raw.endpoint,
        reason: 'invalid_non_loopback_endpoint',
      });
      continue;
    }

    if (typeof raw.authToken !== 'string' || raw.authToken.length < 16) {
      rejected.push({ file: entry.name, providerId: raw.providerId, reason: 'invalid_auth_token' });
      continue;
    }

    const ttlMs = Number.isFinite(Number(raw.ttlMs)) && Number(raw.ttlMs) > 0
      ? Number(raw.ttlMs)
      : DEFAULT_LEASE_TTL_MS;
    const updatedAtMs = Number(raw.updatedAtMs) || 0;
    const expired = nowMs - updatedAtMs > ttlMs;
    const pidDead = Number.isInteger(raw.pid) && raw.pid > 0 ? !checkPid(raw.pid) : false;

    if (expired || pidDead) {
      rejected.push({
        file: entry.name,
        providerId: raw.providerId,
        reason: expired ? 'lease_expired' : 'pid_dead',
      });
      if (pruneDead) {
        await rm(filePath, { force: true }).catch(() => {});
      }
      continue;
    }

    providers.push({
      protocol: CUA_PROVIDER_PROTOCOL,
      providerId: raw.providerId,
      displayName: String(raw.displayName || raw.providerId),
      pid: raw.pid,
      endpoint: raw.endpoint,
      authToken: raw.authToken,
      startedAtMs: Number(raw.startedAtMs) || updatedAtMs,
      updatedAtMs,
      ttlMs,
      capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    });
  }

  return { providers, rejected };
}

async function requestProviderJson(provider, method, routePath, body = undefined, { signal, timeoutMs = 15_000 } = {}) {
  if (!isValidLoopbackEndpoint(provider?.endpoint)) {
    throw new Error(`Refusing non-loopback CUA provider endpoint: ${String(provider?.endpoint)}`);
  }
  const url = `${provider.endpoint}${routePath}`;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const headers = {
    Authorization: `Bearer ${provider.authToken}`,
    Accept: 'application/json',
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: combinedSignal,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Provider ${provider.providerId} returned non-JSON HTTP ${response.status}`);
  }

  if (response.status === 409 || data?.code === 'human_takeover_active') {
    return {
      httpStatus: response.status,
      ok: false,
      code: 'human_takeover_active',
      takeoverActive: true,
      message: data?.message || 'Target is currently locked under Human Takeover.',
      ...data,
    };
  }

  if (!response.ok) {
    const err = new Error(data?.message || data?.error || `Provider ${provider.providerId} HTTP ${response.status}`);
    err.status = response.status;
    err.code = data?.code || (response.status === 401 ? 'unauthorized' : 'provider_http_error');
    throw err;
  }

  return data;
}

export async function fetchProviderTargets(provider, options = {}) {
  const res = await requestProviderJson(provider, 'GET', '/v1/targets', undefined, { timeoutMs: 4_000, ...options });
  if (!res?.ok || !Array.isArray(res.targets)) return [];
  return res.targets.map((target) => ({
    ...target,
    providerId: target.providerId || provider.providerId,
    providerDisplayName: provider.displayName,
  }));
}

export async function observeProviderTarget(provider, requestBody, options = {}) {
  return requestProviderJson(provider, 'POST', '/v1/observe', requestBody, { timeoutMs: 15_000, ...options });
}

export async function actProviderTarget(provider, requestBody, options = {}) {
  return requestProviderJson(provider, 'POST', '/v1/act', requestBody, { timeoutMs: 30_000, ...options });
}

export async function setProviderTakeover(provider, requestBody, options = {}) {
  return requestProviderJson(provider, 'POST', '/v1/takeover', requestBody, { timeoutMs: 8_000, ...options });
}

async function readJsonRequestBody(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request payload exceeds limit');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

/**
 * Create an in-process kiki.cua.provider.v1 loopback server + atomic lease heartbeat publisher.
 * Suitable for companion remote target provider plugins and integration tests.
 */
export async function createCuaProviderServer({
  providerId,
  displayName = providerId,
  busDir,
  authToken = randomBytes(32).toString('hex'),
  ttlMs = DEFAULT_LEASE_TTL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  capabilities = ['targets', 'observe', 'act', 'clipboard', 'takeover'],
  pid = process.pid,
  handlers = {},
} = {}) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('createCuaProviderServer requires providerId');
  }
  const resolvedBusDir = busDir ? path.resolve(busDir) : resolveCuaProviderBusDir();
  const startedAtMs = Date.now();
  let updatedAtMs = startedAtMs;
  let closed = false;

  const server = http.createServer(async (req, res) => {
    try {
      if (!verifyBearerToken(req.headers.authorization, authToken)) {
        sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'Invalid or missing Bearer token' });
        return;
      }

      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && reqUrl.pathname === '/v1/health') {
        sendJson(res, 200, { ok: true, providerId, pid, updatedAtMs });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/targets') {
        const targets = typeof handlers.listTargets === 'function' ? await handlers.listTargets() : [];
        sendJson(res, 200, { ok: true, targets });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/v1/observe') {
        if (typeof handlers.observe !== 'function') {
          sendJson(res, 501, { ok: false, code: 'unsupported', message: 'observe not implemented' });
          return;
        }
        const body = await readJsonRequestBody(req);
        const out = await handlers.observe(body);
        sendJson(res, out?.httpStatus || 200, out);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/v1/act') {
        if (typeof handlers.act !== 'function') {
          sendJson(res, 501, { ok: false, code: 'unsupported', message: 'act not implemented' });
          return;
        }
        const body = await readJsonRequestBody(req);
        const out = await handlers.act(body);
        if (out?.ok === false && out?.code === 'human_takeover_active') {
          sendJson(res, 409, out);
          return;
        }
        sendJson(res, out?.httpStatus || 200, out);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/v1/takeover') {
        if (typeof handlers.takeover !== 'function') {
          sendJson(res, 501, { ok: false, code: 'unsupported', message: 'takeover not implemented' });
          return;
        }
        const body = await readJsonRequestBody(req);
        const out = await handlers.takeover(body);
        sendJson(res, out?.httpStatus || 200, out);
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not_found', message: `Unknown route: ${req.method} ${reqUrl.pathname}` });
    } catch (err) {
      sendJson(res, err?.statusCode || 500, {
        ok: false,
        code: err?.code || 'internal_error',
        message: err?.message || String(err),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const endpoint = `http://127.0.0.1:${addr.port}`;

  async function publishLease() {
    if (closed) return null;
    updatedAtMs = Date.now();
    return writeProviderLeaseAtomically(resolvedBusDir, {
      protocol: CUA_PROVIDER_PROTOCOL,
      providerId,
      displayName,
      pid,
      endpoint,
      authToken,
      startedAtMs,
      updatedAtMs,
      ttlMs,
      capabilities,
    });
  }

  const leasePath = await publishLease();
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => { void publishLease().catch(() => {}); }, heartbeatMs)
    : null;
  heartbeatTimer?.unref?.();

  async function close() {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await rm(leasePath, { force: true }).catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    providerId,
    displayName,
    endpoint,
    authToken,
    leasePath,
    busDir: resolvedBusDir,
    publishLease,
    close,
  };
}
