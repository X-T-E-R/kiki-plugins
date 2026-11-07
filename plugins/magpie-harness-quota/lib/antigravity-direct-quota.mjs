#!/usr/bin/env node
// Standalone read-only direct Antigravity quota collector for Magpie-managed accounts.
// Zero third-party dependencies (Node >=24 built-ins only).
//
// Protected seams encapsulated here for reuse by `magpie-harness-quota` (1299) and `agy-weekly-wake.py`:
// 1. Read-only Magpie store loader (`logins.json` + `providers.json`) with per-account proxy & Proxy-Authorization / SOCKS5 auth binding.
//    Never mutates Magpie files on disk; rejects revoked/lapsed sign-ins (`lapsed` with `revoked:` mark) as unknown.
// 2. Per-account OAuth token refresh strictly routed through that account's bound proxy (`http://`, `https://`, `socks5://`, `socks5h://`, or `host:port`),
//    with in-process refresh caching and single-flight deduplication keyed by refresh token.
//    A still-valid access token is used as-is. Refresh needs an OAuth client supplied at runtime
//    (plugin settings or process environment), never a client compiled into this file.
//    When that client is absent, only the expired account is unknown; other accounts continue.
// 3. Single-origin Code Assist query (`GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL`: daily by default, prod when `prod`),
//    plus Magpie's tier-entitlement fallback (`paidTier` -> `currentTier` -> none on HTTP 400) for `fetchAvailableModels`,
//    with no cross-origin fallback and no redirect following.
// 4. Exact pool & family assignment ported from Magpie `internal/provider/google.go:1350-1531`:
//    - Versioned model-specific summary group (e.g. "Gemini 4 Argon" on Pro plans, `versioned(pool) && poolNames(pool, model)`)
//      claims its own models exclusively (whether or not it has a 5h bucket).
//    - Non-versioned family summary group with an active 5h bucket (`gr.five && !versioned(gr.pool) && gr.about.includes(vendor.toLowerCase())`)
//      claims remaining enabled models of that vendor (`antigravityVendor`: Gemini / Claude / GPT-OSS) returned by `fetchAvailableModels`.
//    - Never relies on accidental 100% quota equality or timestamp coincidence.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

export const COLLECTOR_PROTOCOL_ID = 'magpie-antigravity-direct-quota';
export const COLLECTOR_SCHEMA_VERSION = 1;
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CODE_ASSIST_DAILY_URL = 'https://daily-cloudcode-pa.googleapis.com';
export const CODE_ASSIST_PROD_URL = 'https://cloudcode-pa.googleapis.com';
export const DEFAULT_HUB_USER_AGENT = `antigravity/hub/2.29.0 ${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
export const DEFAULT_IDE_VERSION = '2.29.0';

export const DEFAULT_MIN_REFRESH_INTERVAL_MS = 300_000;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 120_000;
const TIER_REFUSED_TTL_MS = 24 * 60 * 60 * 1000;
const ANTIGRAVITY_HIDDEN_MODELS = new Set([
  'chat_20706',
  'chat_23310',
  'tab_flash_lite_preview',
  'tab_jump_flash_lite_preview',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
]);

// Process-local volatile cache keyed by SHA-256(refreshToken) so repeated reads across Host refresh cycles
// reuse valid access tokens, 24h refused-tier memoization, and >=5min batch throttling without touching Magpie's disk files.
const tokenMemoryCache = new Map();
const tokenRefreshInFlight = new Map();
const refusedTierCache = new Map();
const batchResultCache = new Map();
const batchInFlight = new Map();

export function clearCollectorRuntimeCaches() {
  tokenMemoryCache.clear();
  tokenRefreshInFlight.clear();
  refusedTierCache.clear();
  batchResultCache.clear();
  batchInFlight.clear();
}

export const OAUTH_CLIENT_UNCONFIGURED = 'OAUTH_CLIENT_UNCONFIGURED';

function firstConfiguredString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Resolves the Antigravity OAuth client used only when an access token must be refreshed.
 * Order: explicit `oauthClient`, then Kiki plugin settings (`antigravityOAuthClientId` and the
 * secret setting `antigravityOAuthClientSecret`, injected by the host into `read({ settings })`),
 * then `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` in the process environment.
 * There is no source fallback. Returns null when either half is missing. Never reads argv.
 */
export function resolveAntigravityOAuthClient({ oauthClient, settings, env = process.env } = {}) {
  const clientId = firstConfiguredString(
    oauthClient?.clientId,
    settings?.antigravityOAuthClientId,
    env?.ANTIGRAVITY_OAUTH_CLIENT_ID,
  );
  const clientSecret = firstConfiguredString(
    oauthClient?.clientSecret,
    settings?.antigravityOAuthClientSecret,
    env?.ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  );
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function oauthClientMissingError(userHash) {
  const err = new Error(`Antigravity account ${userHash} has an expired access token and no OAuth client is configured.`);
  err.code = OAUTH_CLIENT_UNCONFIGURED;
  return err;
}

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function refreshKeyOf(refreshToken) {
  return crypto.createHash('sha256').update(String(refreshToken), 'utf8').digest('hex');
}

export function redactEmailHash(email) {
  return crypto.createHash('sha256').update(String(email ?? '').trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Normalizes a Magpie proxy string (`internal/netproxy/netproxy.go:392-398`):
 * bare `host:port` means `http://host:port`. Returns `undefined` for empty or `"direct"`.
 */
export function normalizeProxyAddress(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'direct') return undefined;
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`;
}

/**
 * Redacts userinfo (`username:password@`) from a proxy URL (`internal/netproxy/netproxy.go:426-440`).
 */
export function redactProxyEndpoint(proxyUrl) {
  const normalized = normalizeProxyAddress(proxyUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return 'invalid-proxy-url';
  }
}

function resolveDefaultMagpieDir(env = process.env, homedir = os.homedir()) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim();
  if (xdg) return path.join(xdg, 'magpie');
  return path.join(homedir, '.config', 'magpie');
}

/**
 * Resolves Magpie's config directory following `internal/appdir/appdir.go`:
 * explicit `configDir` > portable `data` folder beside `magpiePath` (when `.portable` exists or `data/logins.json` exists)
 * > `$XDG_CONFIG_HOME/magpie` > `~/.config/magpie`.
 */
export async function resolveMagpieConfigDir({ configDir, magpiePath, env = process.env, homedir = os.homedir() } = {}) {
  if (typeof configDir === 'string' && configDir.trim()) {
    const trimmedDir = configDir.trim();
    if (!path.isAbsolute(trimmedDir)) {
      throw new Error('magpieConfigDir must be an absolute path on the Kiki server, or omitted.');
    }
    return path.resolve(trimmedDir);
  }
  if (typeof magpiePath === 'string' && magpiePath.trim()) {
    const trimmedExe = magpiePath.trim();
    if (!path.isAbsolute(trimmedExe)) {
      throw new Error('magpiePath must be an absolute path on the Kiki server, or omitted.');
    }
    let realExe = trimmedExe;
    try {
      realExe = await fs.realpath(realExe);
    } catch {
      // Keep original absolute path if binary symlink target is unavailable in tests
    }
    const baseDir = path.dirname(realExe);
    const portableData = path.join(baseDir, 'data');
    try {
      const markerStat = await fs.stat(path.join(baseDir, '.portable'));
      if (!markerStat.isDirectory()) return portableData;
    } catch {
      // No .portable marker
    }
    try {
      await fs.access(path.join(portableData, 'logins.json'));
      return portableData;
    } catch {
      // Not portable
    }
  }
  return resolveDefaultMagpieDir(env, homedir);
}

/**
 * Resolves the single Code Assist origin per `GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL`
 * (`"" | "daily" | "sandbox"` -> daily; `"prod"` or other explicit non-empty mode -> prod).
 */
export function resolveCodeAssistOrigin({ baseUrl, env = process.env } = {}) {
  if (typeof baseUrl === 'string' && baseUrl.trim()) return baseUrl.trim().replace(/\/+$/, '');
  const raw = String(env.GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL ?? '').trim();
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  const mode = raw.toLowerCase();
  if (mode === '' || mode === 'daily' || mode === 'sandbox') return CODE_ASSIST_DAILY_URL;
  return CODE_ASSIST_PROD_URL;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms) || ms <= Date.UTC(1970, 0, 1)) return undefined;
  return new Date(ms).toISOString();
}

export function poolName(displayName) {
  let s = String(displayName ?? '').trim();
  if (!s) return '';
  if (s.toLowerCase().endsWith(' models')) s = s.slice(0, -' models'.length).trim();
  return s.replaceAll(' and ', ' & ');
}

export function versionedPool(pool) {
  return /[0-9]/.test(String(pool ?? ''));
}

export function poolNamesModel(pool, modelId, displayName = '') {
  if (!versionedPool(pool)) return false;
  const p = String(pool).toLowerCase();
  for (const raw of [displayName, String(modelId ?? '').replaceAll('-', ' ')]) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === p || s.startsWith(`${p} `) || s.startsWith(`${p}(`)) return true;
  }
  return false;
}

export function antigravityVendor(modelId, displayName = '') {
  const id = String(modelId ?? '').toLowerCase();
  if (id.startsWith('gemini')) return 'Gemini';
  if (id.startsWith('claude')) return 'Claude';
  if (id.startsWith('gpt-oss')) return 'GPT-OSS';
  const firstWord = String(displayName ?? '').trim().split(/\s+/)[0];
  if (firstWord) return firstWord;
  return String(modelId ?? '').split('-')[0] || '';
}

function cleanAccountLabel(raw) {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/\s+/g, ' ');
  return cleaned && [...cleaned].length <= 64 ? cleaned : undefined;
}

/**
 * Loads Magpie's Antigravity accounts (`internal/provider/side_logins.go:119-153` + `proxy.go:66-75`)
 * in read-only mode, binding each account to its exact proxy (`accountProxies[lower(user)] ?? provider.proxy`).
 *
 * Notice on `on` semantics (`side_logins.go:139-152`):
 * Magpie sets `out[first].Active = true, out[first].On = true` on the primary account (`first` = first entry with
 * `entry.first === true`, else index `0`), even if `entry.on` is omitted/`false` in `logins.json`; non-primary accounts
 * require `entry.on === true` when `onlyEnabled` is true.
 */
export async function loadMagpieAntigravityAccounts({
  configDir,
  magpiePath,
  env = process.env,
  homedir = os.homedir(),
  requireProxy = true,
  onlyEnabled = true,
} = {}) {
  const dir = await resolveMagpieConfigDir({ configDir, magpiePath, env, homedir });
  const [loginsRaw, providersRaw] = await Promise.all([
    fs.readFile(path.join(dir, 'logins.json'), 'utf8'),
    fs.readFile(path.join(dir, 'providers.json'), 'utf8').catch((err) => {
      if (err?.code === 'ENOENT') return '{"providers":[]}';
      throw err;
    }),
  ]);
  const logins = JSON.parse(loginsRaw);
  const providersParsed = JSON.parse(providersRaw);
  const providersList = Array.isArray(providersParsed)
    ? providersParsed
    : Array.isArray(providersParsed?.providers)
      ? providersParsed.providers
      : [];
  const agProvider = providersList.find((p) => isRecord(p) && p.id === 'antigravity') ?? {};
  const providerRawProxy = typeof agProvider.proxy === 'string' ? agProvider.proxy.trim() : '';

  const rawAccountProxies = new Map();
  if (isRecord(agProvider.accountProxies)) {
    for (const [k, v] of Object.entries(agProvider.accountProxies)) {
      if (typeof v === 'string' && v.trim()) {
        rawAccountProxies.set(k.trim().toLowerCase(), v.trim());
      }
    }
  }
  const accountNames = new Map();
  if (isRecord(agProvider.accountNames)) {
    for (const [k, v] of Object.entries(agProvider.accountNames)) {
      const label = cleanAccountLabel(v);
      if (k.trim() && label) accountNames.set(k.trim().toLowerCase(), label);
    }
  }

  // Reconstruct `listSideLogins` (`side_logins.go:119-153`) for `agent === "antigravity"`
  const usableEntries = [];
  for (const entry of Array.isArray(logins) ? logins : []) {
    if (!isRecord(entry) || String(entry.agent ?? '').toLowerCase() !== 'antigravity') continue;
    const user = String(entry.user ?? '').trim();
    if (!user) continue;
    if (!entry.auth || entry.auth === 'null') continue; // `own()` is unused for Antigravity (`googleSaved` requires non-empty `refresh_token`)
    let auth;
    try {
      auth = typeof entry.auth === 'string' ? JSON.parse(entry.auth) : entry.auth;
    } catch {
      continue;
    }
    if (!isRecord(auth) || typeof auth.refresh_token !== 'string' || !auth.refresh_token.trim()) continue;
    usableEntries.push({ entry, user, auth });
  }

  if (usableEntries.length === 0) return [];

  let firstIdx = usableEntries.findIndex((item) => item.entry.first === true);
  if (firstIdx < 0) firstIdx = 0;
  const ordered = [
    usableEntries[firstIdx],
    ...usableEntries.slice(0, firstIdx),
    ...usableEntries.slice(firstIdx + 1),
  ];

  const out = [];
  for (let idx = 0; idx < ordered.length; idx += 1) {
    const { entry, user, auth } = ordered[idx];
    const isActive = idx === 0;
    const isOn = isActive || Boolean(entry.on);
    if (onlyEnabled && !isOn) continue;

    const lowerUser = user.toLowerCase();
    // `ProxyOfLogin("antigravity", user)` (`proxy.go:66-75`): account's own choice (even if `"direct"`), else provider's `proxy`.
    const chosenRawProxy = rawAccountProxies.get(lowerUser) ?? providerRawProxy;
    const proxyUrl = normalizeProxyAddress(chosenRawProxy);
    const boundProxyKind = proxyUrl
      ? 'url'
      : String(chosenRawProxy ?? '').trim().toLowerCase() === 'direct'
        ? 'direct'
        : 'missing';
    if (requireProxy && !proxyUrl) {
      const why = chosenRawProxy.toLowerCase() === 'direct' ? 'explicitly set to direct' : 'missing bound proxy';
      throw new Error(`Antigravity account ${redactEmailHash(lowerUser)} cannot be queried without a bound proxy (${why} in Magpie providers.json).`);
    }

    const lapsed = typeof entry.lapsed === 'string' && entry.lapsed.trim() ? entry.lapsed.trim() : undefined;
    const project = (typeof entry.project === 'string' && entry.project.trim())
      || (typeof auth.project === 'string' && auth.project.trim())
      || '';
    const label = accountNames.get(lowerUser);

    const secretState = {
      accessToken: typeof auth.access_token === 'string' ? auth.access_token : '',
      refreshToken: auth.refresh_token.trim(),
      expiryMs: typeof auth.expiry_date === 'number' ? auth.expiry_date : 0,
      proxyUrl: proxyUrl ?? '',
    };

    const descriptor = {
      user,
      userHash: redactEmailHash(lowerUser),
      ...(label ? { accountLabel: label } : {}),
      active: isActive,
      on: isOn,
      ...(entry.paused === true ? { paused: true } : {}),
      ...(lapsed ? { lapsed } : {}),
      plan: typeof entry.plan === 'string' ? entry.plan : '',
      project,
      boundProxyKind,
      proxyEndpoint: redactProxyEndpoint(proxyUrl),
    };
    Object.defineProperty(descriptor, '_secrets', {
      value: secretState,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    out.push(descriptor);
  }
  return out;
}

/**
 * Establishes a TCP tunnel to `targetHost:targetPort` over a SOCKS5/SOCKS5h proxy (`internal/netproxy/bridge.go:162-275`),
 * supporting no-auth (`0x00`) and RFC 1929 username/password (`0x02`) authentication, sending domain names for remote DNS.
 */
function dialSocks5Tunnel(proxy, targetHost, targetPort, { timeoutMs = 15_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || 1080;
    const username = proxy.username ? decodeURIComponent(proxy.username) : '';
    const password = proxy.password ? decodeURIComponent(proxy.password) : '';
    const hasAuth = Boolean(proxy.username || proxy.password);

    const socket = net.connect({ host: proxy.hostname, port: proxyPort });
    let settled = false;
    let buf = Buffer.alloc(0);
    let waiter = null;

    const timer = setTimeout(() => fail(new Error(`SOCKS5 proxy connect timed out after ${timeoutMs}ms`)), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }

    function onAbort() {
      const err = new Error('The quota request was cancelled.');
      err.code = 'ABORT_ERR';
      fail(err);
    }

    function onError(err) {
      fail(err);
    }

    function onClose() {
      fail(new Error('SOCKS5 proxy closed connection during handshake'));
    }

    function pump() {
      if (waiter && buf.length >= waiter.n) {
        const { n, resolveRead } = waiter;
        const chunk = buf.subarray(0, n);
        buf = buf.subarray(n);
        waiter = null;
        resolveRead(chunk);
      }
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      pump();
    }

    function readExact(n) {
      return new Promise((resolveRead) => {
        waiter = { n, resolveRead };
        pump();
      });
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('data', onData);

    socket.once('connect', async () => {
      try {
        const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(methods);
        const methodReply = await readExact(2);
        if (methodReply[0] !== 0x05) throw new Error('Invalid SOCKS5 greeting version');
        if (methodReply[1] === 0x02) {
          if (!hasAuth) throw new Error('SOCKS5 proxy requires username/password authentication');
          const uBytes = Buffer.from(username, 'utf8');
          const pBytes = Buffer.from(password, 'utf8');
          if (uBytes.length > 255 || pBytes.length > 255) throw new Error('SOCKS5 proxy credentials exceed 255 bytes');
          socket.write(Buffer.concat([Buffer.from([0x01, uBytes.length]), uBytes, Buffer.from([pBytes.length]), pBytes]));
          const authReply = await readExact(2);
          if (authReply[1] !== 0x00) throw new Error('SOCKS5 proxy rejected username/password');
        } else if (methodReply[1] !== 0x00) {
          throw new Error(`SOCKS5 proxy rejected authentication methods (0x${methodReply[1].toString(16)})`);
        }

        const cleanHost = targetHost.startsWith('[') && targetHost.endsWith(']') ? targetHost.slice(1, -1) : targetHost;
        const ipVersion = net.isIP(cleanHost);
        let addrPart;
        if (ipVersion === 4) {
          addrPart = Buffer.from([0x01, ...cleanHost.split('.').map((x) => Number(x))]);
        } else if (ipVersion === 6) {
          // Send domain-style or let net/OS normalize; domain ATYP=0x03 works universally on SOCKS5 proxies,
          // while IPv4 uses 0x01. For IPv6 literals, encode 16-byte address.
          const expanded = expandIPv6(cleanHost);
          addrPart = Buffer.concat([Buffer.from([0x04]), expanded]);
        } else {
          const hostBytes = Buffer.from(cleanHost, 'utf8');
          if (hostBytes.length > 255) throw new Error('Target hostname too long for SOCKS5');
          addrPart = Buffer.concat([Buffer.from([0x03, hostBytes.length]), hostBytes]);
        }
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));

        const head = await readExact(4);
        if (head[0] !== 0x05 || head[1] !== 0x00) {
          throw new Error(`SOCKS5 CONNECT failed with code 0x${head[1].toString(16)}`);
        }
        if (head[3] === 0x01) {
          await readExact(4 + 2);
        } else if (head[3] === 0x04) {
          await readExact(16 + 2);
        } else if (head[3] === 0x03) {
          const lenByte = await readExact(1);
          await readExact(lenByte[0] + 2);
        } else {
          throw new Error(`SOCKS5 CONNECT returned unknown ATYP 0x${head[3].toString(16)}`);
        }

        if (settled) return;
        settled = true;
        cleanup();
        if (buf.length > 0) socket.unshift(buf);
        resolve(socket);
      } catch (err) {
        fail(err);
      }
    });
  });
}

function expandIPv6(ip) {
  const parts = ip.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    out.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
  }
  return out;
}

/**
 * Executes an HTTP/HTTPS request strictly through `proxyUrl` (`http://`, `https://`, `socks5://`, `socks5h://`, or `host:port`),
 * supporting `Proxy-Authorization` Basic auth and SOCKS5 RFC 1929 auth. Never follows 3xx redirects.
 */
export function requestViaProxy(targetUrl, {
  method = 'POST',
  headers = {},
  body = '',
  proxyUrl,
  timeoutMs = 15_000,
  signal,
  ca,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('The quota request was cancelled.');
      err.code = 'ABORT_ERR';
      reject(err);
      return;
    }
    const normalizedProxy = normalizeProxyAddress(proxyUrl);
    if (!normalizedProxy) {
      reject(new Error('Refusing direct outbound quota request: proxyUrl is required.'));
      return;
    }

    const target = new URL(targetUrl);
    const proxy = new URL(normalizedProxy);
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const reqHeaders = {
      Connection: 'close',
      ...headers,
      'Content-Length': String(bodyBuf.length),
    };

    let settled = false;
    let connectReq;
    let activeReq;
    let tunnelSocket;
    const timer = setTimeout(() => finish(new Error(`Upstream quota request timed out after ${timeoutMs}ms`)), timeoutMs);

    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        connectReq?.destroy();
        activeReq?.destroy();
        tunnelSocket?.destroy();
        reject(err);
      } else {
        resolve(val);
      }
    }

    function onAbort() {
      const err = new Error('The quota request was cancelled.');
      err.code = 'ABORT_ERR';
      finish(err);
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    function readResponse(res) {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          finish(new Error('Upstream quota response exceeded byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish(null, {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (err) => finish(err));
    }

    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

    if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') {
      dialSocks5Tunnel(proxy, target.hostname, targetPort, { timeoutMs, signal })
        .then((rawSocket) => {
          if (settled) {
            rawSocket.destroy();
            return;
          }
          tunnelSocket = rawSocket;
          if (target.protocol === 'https:') {
            const cleanTargetHost = target.hostname.startsWith('[') && target.hostname.endsWith(']')
              ? target.hostname.slice(1, -1)
              : target.hostname;
            activeReq = https.request({
              hostname: target.hostname,
              port: targetPort,
              path: `${target.pathname}${target.search}`,
              method,
              headers: reqHeaders,
              agent: false,
              socket: rawSocket,
              servername: net.isIP(cleanTargetHost) ? '' : cleanTargetHost,
              ...(ca ? { ca } : {}),
            }, readResponse);
          } else {
            activeReq = http.request({
              hostname: target.hostname,
              port: targetPort,
              path: `${target.pathname}${target.search}`,
              method,
              headers: reqHeaders,
              agent: false,
              createConnection: () => rawSocket,
            }, readResponse);
          }
          activeReq.on('error', (err) => finish(err));
          activeReq.end(bodyBuf);
        })
        .catch((err) => finish(err));
      return;
    }

    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      finish(new Error(`Unsupported proxy protocol: ${proxy.protocol}`));
      return;
    }
    const proxyAuth = proxy.username || proxy.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`, 'utf8').toString('base64')}`
      : undefined;
    const proxyMod = proxy.protocol === 'https:' ? https : http;
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);

    if (target.protocol === 'http:') {
      activeReq = proxyMod.request({
        host: proxy.hostname,
        port: proxyPort,
        method,
        path: target.toString(),
        agent: false,
        headers: {
          ...reqHeaders,
          Host: target.host,
          ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}),
        },
      }, readResponse);
      activeReq.on('error', (err) => finish(err));
      activeReq.end(bodyBuf);
      return;
    }

    connectReq = proxyMod.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      agent: false,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}),
      },
    });
    connectReq.on('connect', (res, socket, head) => {
      tunnelSocket = socket;
      if (res.statusCode !== 200) {
        finish(new Error(`Proxy CONNECT failed (HTTP ${res.statusCode})`));
        return;
      }
      if (head && head.length > 0) socket.unshift(head);
      const cleanTargetHost = target.hostname.startsWith('[') && target.hostname.endsWith(']')
        ? target.hostname.slice(1, -1)
        : target.hostname;
      activeReq = https.request({
        hostname: target.hostname,
        port: targetPort,
        path: `${target.pathname}${target.search}`,
        method,
        headers: reqHeaders,
        agent: false,
        socket,
        servername: net.isIP(cleanTargetHost) ? '' : cleanTargetHost,
        ...(ca ? { ca } : {}),
      }, readResponse);
      activeReq.on('error', (err) => finish(err));
      activeReq.end(bodyBuf);
    });
    connectReq.on('error', (err) => finish(err));
    connectReq.end();
  });
}

/**
 * Pure interpretation of raw `loadCodeAssist`, `fetchAvailableModels`, and `retrieveUserQuotaSummary`
 * payloads using Magpie's exact group/family assignment (`internal/provider/google.go:1350-1531`),
 * never relying on accidental 100% quota equality or timestamp coincidence.
 */
export function interpretAntigravityDirectQuota({
  account,
  origin,
  readAt,
  loadResp,
  modelsResp,
  summaryResp,
  entitlementUsed = '',
  includeEmailInReadings = true,
}) {
  const readAtIso = normalizeIsoTimestamp(readAt) ?? new Date().toISOString();
  const currentTier = isRecord(loadResp?.currentTier) ? loadResp.currentTier.id : loadResp?.currentTier;
  const paidTier = isRecord(loadResp?.paidTier) ? loadResp.paidTier.id : loadResp?.paidTier;
  const planName = (isRecord(loadResp?.paidTier) && loadResp.paidTier.name)
    || (isRecord(loadResp?.currentTier) && loadResp.currentTier.name)
    || account.plan
    || '';

  // 1. Parse non-hidden, non-disabled per-model windows from `fetchAvailableModels` (`google.go:1096-1130`)
  const rawModels = isRecord(modelsResp?.models) ? modelsResp.models : {};
  const modelWindows = [];
  for (const [id, info] of Object.entries(rawModels)) {
    if (!isRecord(info)) continue;
    if (ANTIGRAVITY_HIDDEN_MODELS.has(id) || id.startsWith('chat_') || id.startsWith('tab_')) continue;
    if (info.disabled === true) continue;

    const displayName = typeof info.displayName === 'string' && info.displayName.trim() ? info.displayName.trim() : id;
    const family = antigravityVendor(id, displayName);
    const q = isRecord(info.quotaInfo) ? info.quotaInfo : undefined;
    let remainingPercent;
    if (q) {
      const frac = typeof q.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)
        ? Math.max(0, Math.min(1, q.remainingFraction))
        : 0; // Antigravity omits remainingFraction inside quotaInfo once exhausted (`google.go:1122-1126`)
      remainingPercent = Number((frac * 100).toFixed(4));
    }
    modelWindows.push({
      id,
      displayName,
      family,
      pool: '',
      remainingPercent,
      usedPercent: remainingPercent !== undefined ? Number((100 - remainingPercent).toFixed(4)) : undefined,
      resetAt: normalizeIsoTimestamp(q?.resetTime),
    });
  }
  modelWindows.sort((a, b) => a.id.localeCompare(b.id));

  // 2. Parse summary groups from `retrieveUserQuotaSummary` (`google.go:1378-1418`)
  const rawGroups = Array.isArray(summaryResp?.groups) ? summaryResp.groups : [];
  const summaryGroups = [];
  for (const gr of rawGroups) {
    if (!isRecord(gr)) continue;
    const displayName = typeof gr.displayName === 'string' ? gr.displayName.trim() : '';
    const description = typeof gr.description === 'string' ? gr.description.trim() : '';
    const pool = poolName(displayName);
    if (!pool) continue;

    const buckets = [];
    let hasFiveHour = false;
    for (const b of Array.isArray(gr.buckets) ? gr.buckets : []) {
      if (!isRecord(b) || b.disabled === true) continue;
      const bucketId = typeof b.bucketId === 'string' ? b.bucketId.trim() : '';
      const rawWin = typeof b.window === 'string' ? b.window.trim() : '';
      const lowerWin = rawWin.toLowerCase();
      let windowLabel = '';
      if (lowerWin === '5h') {
        windowLabel = '5 hours';
        hasFiveHour = true;
      } else if (lowerWin === 'weekly') {
        windowLabel = '7 days';
      } else {
        windowLabel = String(b.displayName || rawWin || bucketId || '').trim();
      }
      if (!windowLabel) continue;
      const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
        ? Math.max(0, Math.min(1, b.remainingFraction))
        : 0;
      buckets.push({
        bucketId,
        period: rawWin || windowLabel,
        window: windowLabel,
        remainingPercent: Number((frac * 100).toFixed(4)),
        usedPercent: Number(((1 - frac) * 100).toFixed(4)),
        resetAt: normalizeIsoTimestamp(b.resetTime),
      });
    }
    if (buckets.length > 0) {
      summaryGroups.push({
        displayName,
        description,
        pool,
        about: `${displayName} ${description}`.toLowerCase(),
        versioned: versionedPool(pool),
        hasFiveHour,
        buckets,
      });
    }
  }

  // 3. Assign each model window to its pool strictly per Magpie `google.go:1419-1438`:
  //    a) Versioned model group ("Gemini 4 Argon") claims matching models first, regardless of group order or 5h presence.
  //    b) Non-versioned family group with an active 5h bucket (`hasFiveHour && !versioned && about.includes(family)`)
  //       claims remaining models of that vendor family.
  for (const mw of modelWindows) {
    if (!mw.family) continue;
    const modelGroup = summaryGroups.find((gr) => poolNamesModel(gr.pool, mw.id, mw.displayName));
    if (modelGroup) {
      mw.pool = modelGroup.pool;
      continue;
    }
    const familyLower = mw.family.toLowerCase();
    const familyGroup = summaryGroups.find((gr) => gr.hasFiveHour && !gr.versioned && gr.about.includes(familyLower));
    if (familyGroup) {
      mw.pool = familyGroup.pool;
    }
  }

  const modelIdsByPool = new Map();
  for (const mw of modelWindows) {
    if (!mw.pool) continue;
    if (!modelIdsByPool.has(mw.pool)) modelIdsByPool.set(mw.pool, []);
    modelIdsByPool.get(mw.pool).push(mw.id);
  }

  // 4. Derive Argon weekly provenance strictly from catalog presence + assigned summary group (no 100% / resetTime guessing)
  const argonModels = modelWindows.filter((m) => m.id.toLowerCase().includes('argon'));
  const assignedArgonPools = [...new Set(argonModels.map((m) => m.pool).filter(Boolean))];
  let argonWeekly = {
    status: 'unknown',
    offeredInCatalog: argonModels.length > 0,
    argonModelIds: argonModels.map((m) => m.id),
    poolMode: 'unknown',
    pool: null,
    groupDisplayName: null,
    weeklyBucketId: null,
    remainingPercent: null,
    usedPercent: null,
    resetAt: null,
  };

  if (argonModels.length > 0 && assignedArgonPools.length === 1) {
    const targetPool = assignedArgonPools[0];
    const grp = summaryGroups.find((g) => g.pool === targetPool);
    const wk = grp?.buckets.find((b) => b.window === '7 days');
    if (grp && wk) {
      argonWeekly = {
        status: 'known',
        offeredInCatalog: true,
        argonModelIds: argonModels.map((m) => m.id),
        poolMode: grp.versioned ? 'pro_independent_argon_group' : 'ultra_shared_family_group',
        pool: grp.pool,
        groupDisplayName: grp.displayName,
        weeklyBucketId: wk.bucketId,
        remainingPercent: wk.remainingPercent,
        usedPercent: wk.usedPercent,
        resetAt: wk.resetAt ?? null,
      };
    }
  }

  // 5. Emit Kiki `HarnessQuotaReading[]` conforming strictly to `@kiki/plugin-sdk/harness-quota`
  const accountIdOut = includeEmailInReadings ? account.user : account.userHash;
  const readings = [];
  if (summaryGroups.length > 0) {
    for (const grp of summaryGroups) {
      const claimedIds = modelIdsByPool.get(grp.pool);
      for (const b of grp.buckets) {
        readings.push({
          accountId: accountIdOut,
          ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
          ...(claimedIds && claimedIds.length > 0 ? { modelIds: claimedIds } : {}),
          pool: grp.pool,
          unit: 'percent',
          window: b.window,
          remaining: b.remainingPercent,
          ...(b.resetAt ? { resetAt: b.resetAt } : {}),
          readAt: readAtIso,
        });
      }
    }
    // Preserve unpooled 5h per-model windows (e.g. Pro Argon's own 5h when "Gemini 4 Argon" summary group has only 7d,
    // or Claude models when `3p-5h` is marked `disabled: true` on a weekly-exhausted account)
    for (const mw of modelWindows) {
      const poolHas5h = mw.pool && summaryGroups.find((g) => g.pool === mw.pool)?.hasFiveHour;
      if (!poolHas5h) {
        readings.push({
          accountId: accountIdOut,
          ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
          modelIds: [mw.id],
          ...(mw.pool ? { pool: mw.pool } : {}),
          unit: 'percent',
          window: '5 hours',
          ...(mw.remainingPercent !== undefined ? { remaining: mw.remainingPercent } : {}),
          ...(mw.resetAt ? { resetAt: mw.resetAt } : {}),
          readAt: readAtIso,
        });
      }
    }
  } else {
    // Summary missing/unavailable: emit per-model 5h windows only; never synthesize 7d windows
    for (const mw of modelWindows) {
      readings.push({
        accountId: accountIdOut,
        ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
        modelIds: [mw.id],
        unit: 'percent',
        window: '5 hours',
        ...(mw.remainingPercent !== undefined ? { remaining: mw.remainingPercent } : {}),
        ...(mw.resetAt ? { resetAt: mw.resetAt } : {}),
        readAt: readAtIso,
      });
    }
  }

  return {
    readings,
    sanitizedAccount: {
      userHash: account.userHash,
      ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
      active: Boolean(account.active),
      on: account.on !== false,
      proxyEndpoint: account.proxyEndpoint,
      origin: origin ?? null,
      plan: planName,
      currentTier: currentTier ?? null,
      paidTier: paidTier ?? null,
      entitlementUsed: entitlementUsed || null,
      readAt: readAtIso,
      status: 'ok',
      catalogModelCount: modelWindows.length,
      argonCatalogModels: argonModels.map((m) => ({
        modelId: m.id,
        displayName: m.displayName,
        assignedPool: m.pool || null,
        remaining5hPercent: m.remainingPercent ?? null,
        reset5hAt: m.resetAt ?? null,
      })),
      summaryGroups: summaryGroups.map((g) => ({
        displayName: g.displayName,
        description: g.description,
        pool: g.pool,
        versioned: g.versioned,
        claimedModelIds: modelIdsByPool.get(g.pool) ?? [],
        buckets: g.buckets.map((b) => ({
          bucketId: b.bucketId,
          period: b.period,
          window: b.window,
          remainingPercent: b.remainingPercent,
          usedPercent: b.usedPercent,
          resetAt: b.resetAt ?? null,
        })),
      })),
      argonWeekly,
    },
  };
}

function resolveCandidateEntitlements(loadResp, rtKey, projectId) {
  const cur = isRecord(loadResp?.currentTier) ? String(loadResp.currentTier.id || '').trim() : '';
  const paid = isRecord(loadResp?.paidTier) ? String(loadResp.paidTier.id || '').trim() : '';
  const candidates = [];
  for (const t of [paid, cur]) {
    if (!t || t === 'free-tier' || t === 'legacy-tier' || candidates.includes(t)) continue;
    const refusedAt = refusedTierCache.get(`${rtKey}\0${projectId || ''}\0${t}`);
    if (refusedAt && Date.now() - refusedAt < TIER_REFUSED_TTL_MS) continue;
    candidates.push(t);
  }
  candidates.push('');
  return candidates;
}

export async function ensureFreshAccessToken(account, {
  tokenUrl = GOOGLE_TOKEN_URL,
  requestFn = requestViaProxy,
  timeoutMs = 15_000,
  signal,
  ca,
  oauthClient = null,
}) {
  const cancelled = () => Object.assign(new Error('The OAuth refresh was cancelled.'), { code: 'ABORT_ERR' });
  if (signal?.aborted) throw cancelled();
  const secrets = account._secrets;
  const cacheKey = refreshKeyOf(`${secrets.refreshToken}\0${tokenUrl}`);
  const cached = tokenMemoryCache.get(cacheKey);
  const candidateToken = cached?.accessToken || secrets.accessToken;
  const candidateExpiry = cached?.expiryMs || secrets.expiryMs || 0;

  if (candidateToken && candidateExpiry - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    secrets.accessToken = candidateToken;
    secrets.expiryMs = candidateExpiry;
    return candidateToken;
  }

  if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
    throw oauthClientMissingError(account.userHash);
  }

  const flightKey = refreshKeyOf(JSON.stringify([
    cacheKey, secrets.proxyUrl, oauthClient.clientId, oauthClient.clientSecret, timeoutMs, ca,
  ]));
  let flight = tokenRefreshInFlight.get(flightKey);
  if (!flight) {
    const controller = new AbortController();
    const promise = (async () => {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: secrets.refreshToken,
        client_id: oauthClient.clientId,
        client_secret: oauthClient.clientSecret,
      }).toString();
      const tokRes = await requestFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        proxyUrl: secrets.proxyUrl,
        timeoutMs,
        signal: controller.signal,
        ca,
      });
      if (controller.signal.aborted) throw cancelled();
      if (tokRes.status !== 200) {
        throw new Error(`OAuth token refresh failed for ${account.userHash} (HTTP ${tokRes.status})`);
      }
      let tokJson;
      try {
        tokJson = JSON.parse(tokRes.body);
      } catch {
        throw new Error(`OAuth token refresh returned unreadable JSON for ${account.userHash}`);
      }
      if (typeof tokJson.access_token !== 'string' || !tokJson.access_token) {
        throw new Error(`OAuth token refresh returned empty access_token for ${account.userHash}`);
      }
      const expiryMs = typeof tokJson.expires_in === 'number' && tokJson.expires_in > 0
        ? Date.now() + tokJson.expires_in * 1000
        : Date.now() + 3600_000;
      const token = { accessToken: tokJson.access_token, expiryMs };
      tokenMemoryCache.set(cacheKey, token);
      return token;
    })();
    flight = { controller, promise, waiters: 0 };
    tokenRefreshInFlight.set(flightKey, flight);
    const settled = () => {
      if (tokenRefreshInFlight.get(flightKey) === flight) tokenRefreshInFlight.delete(flightKey);
    };
    void promise.then(settled, settled);
  }

  flight.waiters++;
  let onAbort;
  try {
    const token = await (signal ? Promise.race([flight.promise, new Promise((_, reject) => {
      onAbort = () => reject(cancelled());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })]) : flight.promise);
    if (signal?.aborted) throw cancelled();
    secrets.accessToken = token.accessToken;
    secrets.expiryMs = token.expiryMs;
    return token.accessToken;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (--flight.waiters === 0 && tokenRefreshInFlight.get(flightKey) === flight) {
      tokenRefreshInFlight.delete(flightKey);
      flight.controller.abort();
    }
  }
}

/** Drops one in-memory access token so the next read refreshes it. Does not write Magpie's files. */
export function forgetAntigravityAccessToken(account, tokenUrl = GOOGLE_TOKEN_URL) {
  const secrets = account?._secrets;
  if (!secrets || typeof secrets.refreshToken !== 'string' || !secrets.refreshToken) return;
  const key = refreshKeyOf(`${secrets.refreshToken}\0${tokenUrl}`);
  if (tokenMemoryCache.get(key)?.accessToken === secrets.accessToken) tokenMemoryCache.delete(key);
  secrets.accessToken = '';
  secrets.expiryMs = 0;
}

export function antigravityEntitlementCandidates(loadResp, refreshToken, projectId) {
  return resolveCandidateEntitlements(loadResp, refreshKeyOf(refreshToken), projectId || '');
}

/**
 * Model ids from `fetchAvailableModels`, using the same hidden/disabled filter as quota readings.
 * Ids the harness connection schema rejects are omitted here and stay in quota readings.
 */
export function antigravityCatalogModelIds(modelsResp) {
  const rawModels = isRecord(modelsResp?.models) ? modelsResp.models : {};
  const ids = [];
  for (const [id, info] of Object.entries(rawModels)) {
    if (!isRecord(info)) continue;
    if (ANTIGRAVITY_HIDDEN_MODELS.has(id) || id.startsWith('chat_') || id.startsWith('tab_')) continue;
    if (info.disabled === true) continue;
    if (id === 'engine-default' || /[\s\u0000]/u.test(id)) continue;
    ids.push(id);
  }
  ids.sort((left, right) => left.localeCompare(right));
  return ids;
}

/**
 * Queries one Magpie Antigravity account directly through its bound proxy.
 */
export async function fetchOneAccountDirectQuota(account, {
  origin,
  tokenUrl = GOOGLE_TOKEN_URL,
  userAgent = DEFAULT_HUB_USER_AGENT,
  ideVersion = DEFAULT_IDE_VERSION,
  requestFn = requestViaProxy,
  timeoutMs = 15_000,
  signal,
  ca,
  env = process.env,
  oauthClient = null,
  includeEmailInReadings = true,
} = {}) {
  const secrets = account._secrets;
  if (!secrets || !secrets.proxyUrl) {
    throw new Error(`Refusing direct quota query for ${account.userHash}: missing bound account proxy.`);
  }
  if (account.lapsed) {
    throw new Error(`Account sign-in is marked lapsed in Magpie (${account.lapsed})`);
  }

  const baseUrl = resolveCodeAssistOrigin({ baseUrl: origin, env });
  const accessToken = await ensureFreshAccessToken(account, {
    tokenUrl,
    requestFn,
    timeoutMs,
    signal,
    ca,
    oauthClient,
  });

  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };

  let projectId = account.project;
  let loadResp = null;
  try {
    const loadRaw = await requestFn(`${baseUrl}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        mode: 'FULL_ELIGIBILITY_CHECK',
        ...(projectId ? { cloudaicompanionProject: projectId } : {}),
        metadata: {
          ideType: 'ANTIGRAVITY',
          ideVersion,
          ideName: 'antigravity',
          ...(projectId ? { duetProject: projectId } : {}),
        },
      }),
      proxyUrl: secrets.proxyUrl,
      timeoutMs,
      signal,
      ca,
    });
    if (loadRaw.status === 200) {
      loadResp = JSON.parse(loadRaw.body);
      if (!projectId) {
        const discProj = isRecord(loadResp?.cloudaicompanionProject)
          ? loadResp.cloudaicompanionProject.id
          : loadResp?.cloudaicompanionProject;
        if (typeof discProj === 'string' && discProj.trim()) {
          projectId = discProj.trim();
        }
      }
    }
  } catch (err) {
    if (err?.code === 'ABORT_ERR') throw err;
  }

  // Query `fetchAvailableModels` with Magpie's tier-entitlement fallback (`google.go:1060-1091`)
  const rtKey = refreshKeyOf(secrets.refreshToken);
  const candidateTiers = resolveCandidateEntitlements(loadResp, rtKey, projectId);
  let modelsResp = null;
  let entitlementUsed = '';
  let lastModelsStatus = 0;

  for (const tier of candidateTiers) {
    const reqBody = {
      ...(projectId ? { project: projectId } : {}),
      ...(tier ? { entitlement: { userTier: tier } } : {}),
    };
    const modelsRaw = await requestFn(`${baseUrl}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify(reqBody),
      proxyUrl: secrets.proxyUrl,
      timeoutMs,
      signal,
      ca,
    });
    lastModelsStatus = modelsRaw.status;
    if (modelsRaw.status === 200) {
      modelsResp = JSON.parse(modelsRaw.body);
      entitlementUsed = tier;
      break;
    }
    if (tier && modelsRaw.status === 400) {
      refusedTierCache.set(`${rtKey}\0${projectId || ''}\0${tier}`, Date.now());
      continue;
    }
    throw new Error(`fetchAvailableModels failed for ${account.userHash} (HTTP ${modelsRaw.status})`);
  }

  if (!modelsResp) {
    throw new Error(`fetchAvailableModels failed for ${account.userHash} (HTTP ${lastModelsStatus})`);
  }

  let summaryResp = null;
  try {
    const sumRaw = await requestFn(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify(projectId ? { project: projectId } : {}),
      proxyUrl: secrets.proxyUrl,
      timeoutMs,
      signal,
      ca,
    });
    if (sumRaw.status === 200) {
      summaryResp = JSON.parse(sumRaw.body);
    }
  } catch (err) {
    if (err?.code === 'ABORT_ERR') throw err;
    summaryResp = null;
  }

  return interpretAntigravityDirectQuota({
    account,
    origin: baseUrl,
    readAt: new Date().toISOString(),
    loadResp,
    modelsResp,
    summaryResp,
    entitlementUsed,
    includeEmailInReadings,
  });
}

/**
 * Batch collector entry point for both plugin in-process consumption (`includeEmailInReadings: true`)
 * and desensitized JSON protocol output (`includeEmailInReadings: false`).
 * Supports optional single-flight + TTL batch caching via `minRefreshIntervalMs` (default `0` for raw collector;
 * `DEFAULT_MIN_REFRESH_INTERVAL_MS` = 300_000ms on `MagpieAntigravityDirectQuotaService` unless overridden).
 */
export async function collectMagpieAntigravityDirectQuotas({
  configDir,
  magpiePath,
  origin,
  tokenUrl,
  userAgent = DEFAULT_HUB_USER_AGENT,
  requestFn = requestViaProxy,
  timeoutMs = 15_000,
  minRefreshIntervalMs = 0,
  forceRefresh = false,
  signal,
  ca,
  env = process.env,
  homedir = os.homedir(),
  requireProxy = true,
  onlyEnabled = true,
  includeEmailInReadings = true,
  oauthClient,
  settings,
} = {}) {
  if (signal?.aborted) {
    const err = new Error('The quota read was cancelled.');
    err.code = 'ABORT_ERR';
    throw err;
  }
  const resolvedOrigin = resolveCodeAssistOrigin({ baseUrl: origin, env });
  const resolvedDir = await resolveMagpieConfigDir({ configDir, magpiePath, env, homedir });
  const resolvedOAuthClient = resolveAntigravityOAuthClient({ oauthClient, settings, env });
  const cacheKey = `${resolvedDir}\0${resolvedOrigin}\0${onlyEnabled ? '1' : '0'}\0${includeEmailInReadings ? '1' : '0'}\0${resolvedOAuthClient ? '1' : '0'}`;

  if (!forceRefresh && minRefreshIntervalMs > 0) {
    const cached = batchResultCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAtMs < minRefreshIntervalMs) {
      return cached.batch;
    }
    if (batchInFlight.has(cacheKey)) {
      return batchInFlight.get(cacheKey);
    }
  }

  const runBatch = async () => {
    const accounts = await loadMagpieAntigravityAccounts({
      configDir: resolvedDir,
      env,
      homedir,
      requireProxy,
      onlyEnabled,
    });
    const readings = [];
    const sanitizedAccounts = [];

    const settled = await Promise.all(accounts.map(async (acc) => {
      try {
        const res = await fetchOneAccountDirectQuota(acc, {
          origin: resolvedOrigin,
          tokenUrl,
          userAgent,
          requestFn,
          timeoutMs,
          signal,
          ca,
          env,
          oauthClient: resolvedOAuthClient,
          includeEmailInReadings,
        });
        return { ok: true, acc, res };
      } catch (err) {
        if (err?.code === 'ABORT_ERR') throw err;
        return { ok: false, acc, err };
      }
    }));

    for (const item of settled) {
      if (item.ok) {
        readings.push(...item.res.readings);
        sanitizedAccounts.push(item.res.sanitizedAccount);
      } else {
        const nowIso = new Date().toISOString();
        readings.push({
          accountId: includeEmailInReadings ? item.acc.user : item.acc.userHash,
          ...(item.acc.accountLabel ? { accountLabel: item.acc.accountLabel } : {}),
          unit: 'percent',
          readAt: nowIso,
        });
        const unconfigured = item.err?.code === OAUTH_CLIENT_UNCONFIGURED;
        sanitizedAccounts.push({
          userHash: item.acc.userHash,
          ...(item.acc.accountLabel ? { accountLabel: item.acc.accountLabel } : {}),
          active: Boolean(item.acc.active),
          on: item.acc.on !== false,
          proxyEndpoint: item.acc.proxyEndpoint,
          origin: resolvedOrigin,
          plan: item.acc.plan,
          currentTier: null,
          paidTier: null,
          entitlementUsed: null,
          readAt: nowIso,
          status: unconfigured ? 'unknown' : 'error',
          error: item.err instanceof Error ? item.err.message : String(item.err),
          catalogModelCount: 0,
          argonCatalogModels: [],
          summaryGroups: [],
          argonWeekly: {
            status: 'unknown',
            offeredInCatalog: false,
            argonModelIds: [],
            poolMode: 'unknown',
            pool: null,
            groupDisplayName: null,
            weeklyBucketId: null,
            remainingPercent: null,
            usedPercent: null,
            resetAt: null,
          },
        });
      }
    }

    const batchTimes = sanitizedAccounts.map((a) => Date.parse(a.readAt)).filter(Number.isFinite);
    const batchReadAt = batchTimes.length > 0 ? new Date(Math.max(...batchTimes)).toISOString() : new Date().toISOString();

    const batch = {
      protocol: COLLECTOR_PROTOCOL_ID,
      schemaVersion: COLLECTOR_SCHEMA_VERSION,
      source: 'magpie-antigravity-direct-codeassist',
      origin: resolvedOrigin,
      userAgent,
      batchReadAt,
      readings,
      accounts: sanitizedAccounts,
    };
    if (minRefreshIntervalMs > 0 && sanitizedAccounts.some((a) => a.status === 'ok')) {
      batchResultCache.set(cacheKey, { fetchedAtMs: Date.now(), batch });
    }
    return batch;
  };

  if (!forceRefresh && minRefreshIntervalMs > 0) {
    const p = runBatch();
    batchInFlight.set(cacheKey, p);
    try {
      return await p;
    } finally {
      batchInFlight.delete(cacheKey);
    }
  }
  return runBatch();
}

/**
 * Drop-in adapter service matching `HarnessQuotaAdapter.read({ signal, settings, kikiHome }) -> { readings }`
 * for `magpie-harness-quota` (1299), with built-in single-flight + 5-minute shared cache floor.
 */
export class MagpieAntigravityDirectQuotaService {
  constructor(options = {}) {
    this.options = options;
    this.adapter = {
      read: (context) => this.read(context),
    };
  }

  async read(context = {}) {
    const signal = context?.signal;
    const settings = isRecord(context?.settings) ? context.settings : {};
    const magpiePath = typeof settings.magpiePath === 'string' && settings.magpiePath.trim()
      ? settings.magpiePath.trim()
      : undefined;
    const configDir = typeof settings.magpieConfigDir === 'string' && settings.magpieConfigDir.trim()
      ? settings.magpieConfigDir.trim()
      : this.options.configDir;
    const env = this.options.env ?? process.env;
    const batch = await collectMagpieAntigravityDirectQuotas({
      minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
      ...this.options,
      configDir,
      magpiePath,
      signal,
      requireProxy: true,
      onlyEnabled: true,
      includeEmailInReadings: true,
      settings,
      env,
      oauthClient: resolveAntigravityOAuthClient({
        oauthClient: this.options.oauthClient,
        settings,
        env,
      }),
    });
    return { readings: batch.readings };
  }
}

// Standalone desensitized CLI (`node magpie-antigravity-direct-quota.mjs [--sanitized-json] [--include-disabled]`)
// Never prints emails, OAuth tokens/client_secret, or proxy credentials to stdout.
async function runCli(argv) {
  let configDir;
  let magpiePath;
  let origin;
  let includeReadings = false;
  let onlyEnabled = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config-dir' && argv[i + 1]) {
      configDir = path.resolve(argv[++i]);
    } else if (arg === '--magpie-path' && argv[i + 1]) {
      magpiePath = path.resolve(argv[++i]);
    } else if (arg === '--origin' && argv[i + 1]) {
      origin = argv[++i];
    } else if (arg === '--include-desensitized-readings') {
      includeReadings = true;
    } else if (arg === '--include-disabled') {
      onlyEnabled = false;
    }
  }
  const result = await collectMagpieAntigravityDirectQuotas({
    configDir,
    magpiePath,
    origin,
    requireProxy: true,
    onlyEnabled,
    includeEmailInReadings: false,
  });
  process.stdout.write(`${JSON.stringify({
    protocol: result.protocol,
    schemaVersion: result.schemaVersion,
    source: result.source,
    origin: result.origin,
    userAgent: result.userAgent,
    batchReadAt: result.batchReadAt,
    ...(includeReadings ? { readings: result.readings } : {}),
    accounts: result.accounts,
    secretsIncluded: false,
    fullEmailsIncluded: false,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  });
}
