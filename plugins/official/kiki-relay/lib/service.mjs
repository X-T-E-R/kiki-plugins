import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { startKikiRelayServer } from '../server/kiki-relay-server.mjs';

const INSTANCE_STALE_MS = 45_000;

function isLoopbackOrPrivateHost(hostname) {
  const bare = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (
    bare === 'localhost' ||
    bare === '::1' ||
    bare.startsWith('fe80:') ||
    bare.endsWith('.local') ||
    bare.endsWith('.ts.net')
  ) {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

export function isValidRelaySubscriptionUrl(raw) {
  try {
    const parsed = new URL(String(raw ?? '').trim());
    if (parsed.username || parsed.password || parsed.hash || !parsed.hostname) return false;
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') return isLoopbackOrPrivateHost(parsed.hostname);
    return false;
  } catch {
    return false;
  }
}

export function normalizeRelayBaseUrl(raw, options = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return undefined;
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const firstSegment = candidate.split(/[/?#]/, 1)[0] ?? '';
    const hostPart = firstSegment.startsWith('[')
      ? firstSegment.slice(0, firstSegment.indexOf(']') + 1)
      : (firstSegment.split(':', 1)[0] ?? '');
    candidate = `${isLoopbackOrPrivateHost(hostPart) ? 'ws' : 'wss'}://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    let protocol = parsed.protocol.toLowerCase();
    if (protocol === 'https:') protocol = 'wss:';
    else if (protocol === 'http:') protocol = 'ws:';
    if (protocol !== 'wss:' && protocol !== 'ws:') return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
      return undefined;
    }
    const allowInsecure = Boolean(options.allowInsecureWs) || isLoopbackOrPrivateHost(parsed.hostname);
    if (protocol === 'ws:' && !allowInsecure) return undefined;
    let pathname = parsed.pathname
      .replace(/\/v1\/(?:host|probe|health|stream|pool|mux|connect(?:\/[^/]*)?)\/?$/i, '')
      .replace(/\/+$/, '');
    if (pathname === '/') pathname = '';
    const defaultPort =
      (protocol === 'wss:' && parsed.port === '443') ||
      (protocol === 'ws:' && parsed.port === '80');
    const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
    return `${protocol}//${host}${pathname}`;
  } catch {
    return undefined;
  }
}

export function parseRelayShareUri(raw) {
  const text = String(raw ?? '').trim();
  if (!/^kiki-relay:\/\//i.test(text)) return undefined;
  try {
    const parsed = new URL(`https://${text.slice('kiki-relay://'.length)}`);
    if (parsed.username || parsed.password || parsed.hash || !parsed.hostname) return undefined;
    const insecureParam = parsed.searchParams.get('insecure');
    const insecure = insecureParam === '1' || insecureParam?.toLowerCase() === 'true';
    const roleRaw = parsed.searchParams.get('role');
    let role = 'auto';
    if (roleRaw) {
      if (roleRaw === 'backup' || roleRaw === 'backup-only') role = 'backup-only';
      else if (roleRaw === 'auto') role = 'auto';
      else return undefined;
    }
    const label = parsed.searchParams.get('name')?.trim() || undefined;
    const token = parsed.searchParams.get('token')?.trim() || undefined;
    const url = normalizeRelayBaseUrl(`${insecure ? 'ws' : 'wss'}://${parsed.host}${parsed.pathname}`);
    if (!url) return undefined;
    return { url, ...(label ? { label } : {}), ...(token ? { token } : {}), role, insecure };
  } catch {
    return undefined;
  }
}

export function generateRelayDeployGuide(options = {}) {
  const publicHost = String(options.publicHost ?? 'relay.example.com').trim().toLowerCase() || 'relay.example.com';
  const rawPath = String(options.basePath ?? '/kiki-relay').trim();
  const basePath = rawPath === '' || rawPath === '/' ? '' : `/${rawPath.replace(/^\/+|\/+$/g, '')}`;
  const port = Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535 ? options.port : 9440;
  const proxyTarget = ['nginx', 'caddy', 'openresty', 'cloudflare'].includes(options.proxyTarget)
    ? options.proxyTarget
    : 'caddy';
  const publicUrl = `wss://${publicHost}${basePath}`;
  const basePathArg = basePath === '' ? '' : ` --base-path ${basePath}`;

  const npxCommand =
    'export RELAY_HOST_TOKEN="$(openssl rand -hex 24)" RELAY_SECRET="$(openssl rand -hex 32)" && ' +
    `node server/kiki-relay-server.mjs --host 127.0.0.1 --port ${port}${basePathArg} --public-url ${publicUrl}`;

  const dockerCommand = [
    'export RELAY_HOST_TOKEN="$(openssl rand -hex 24)" RELAY_SECRET="$(openssl rand -hex 32)" && \\',
    'docker build -f server/Dockerfile -t kiki-relay:local . && \\',
    'docker run -d --name kiki-relay --restart unless-stopped \\',
    `  -p 127.0.0.1:${port}:${port} \\`,
    `  -e RELAY_PORT="${port}" \\`,
    ...(basePath === '' ? [] : [`  -e RELAY_BASE_PATH="${basePath}" \\`]),
    `  -e RELAY_PUBLIC_URL="${publicUrl}" \\`,
    '  -e RELAY_HOST_TOKEN="${RELAY_HOST_TOKEN:?Set RELAY_HOST_TOKEN}" \\',
    '  -e RELAY_SECRET="${RELAY_SECRET:?Set RELAY_SECRET}" \\',
    '  kiki-relay:local',
  ].join('\n');

  const dockerComposeYaml = [
    'services:',
    '  kiki-relay:',
    '    build:',
    '      context: .',
    '      dockerfile: server/Dockerfile',
    '    restart: unless-stopped',
    '    ports:',
    `      - "127.0.0.1:${port}:${port}"`,
    '    environment:',
    `      RELAY_PORT: "${port}"`,
    ...(basePath === '' ? [] : [`      RELAY_BASE_PATH: "${basePath}"`]),
    `      RELAY_PUBLIC_URL: "${publicUrl}"`,
    '      RELAY_HOST_TOKEN: "${RELAY_HOST_TOKEN:?Set RELAY_HOST_TOKEN}"',
    '      RELAY_SECRET: "${RELAY_SECRET:?Set RELAY_SECRET}"',
    '      RELAY_TRUST_PROXY: "1"',
  ].join('\n');

  const locationPath = basePath === '' ? '/v1' : basePath;
  let proxySnippet;
  if (proxyTarget === 'caddy') {
    proxySnippet =
      basePath === ''
        ? [
            `${publicHost} {`,
            `  reverse_proxy 127.0.0.1:${port} {`,
            '    flush_interval -1',
            '  }',
            '}',
          ].join('\n')
        : [
            `${publicHost} {`,
            `  handle ${basePath}* {`,
            `    reverse_proxy 127.0.0.1:${port} {`,
            '      flush_interval -1',
            '    }',
            '  }',
            '}',
          ].join('\n');
  } else if (proxyTarget === 'cloudflare') {
    proxySnippet = [
      'tunnel: <YOUR_TUNNEL_UUID>',
      'ingress:',
      `  - hostname: ${publicHost}`,
      ...(basePath === '' ? [] : [`    path: ^${basePath}(/.*)?$`]),
      `    service: http://127.0.0.1:${port}`,
      '    originRequest:',
      '      noHappyEyeballs: true',
      '      keepAliveTimeout: 300s',
      '  - service: http_status:404',
    ].join('\n');
  } else {
    proxySnippet = [
      `location ${locationPath}/ {`,
      `    proxy_pass http://127.0.0.1:${port};`,
      '    proxy_http_version 1.1;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection "upgrade";',
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
      '    proxy_read_timeout 3600s;',
      '    proxy_send_timeout 3600s;',
      '    proxy_buffering off;',
      '}',
    ].join('\n');
  }

  return {
    publicHost,
    basePath,
    port,
    proxyTarget,
    npxCommand,
    dockerCommand,
    dockerComposeYaml,
    proxySnippet,
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function deriveKikiHomeFromDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) return undefined;
  const resolved = path.resolve(dataDir);
  const parent = path.dirname(resolved);
  const grandParent = path.dirname(parent);
  if (path.basename(parent) === 'data' && path.basename(grandParent) === 'plugins') {
    return path.dirname(grandParent);
  }
  return resolved;
}

function formatHttpHost(host) {
  const clean = String(host ?? '127.0.0.1').trim();
  if (!clean || clean === '0.0.0.0') return '127.0.0.1';
  if (clean === '::') return '[::1]';
  if (clean.includes(':') && !clean.startsWith('[')) return `[${clean}]`;
  return clean;
}

async function discoverLiveKapOrigin(kikiHome, nowMs = Date.now()) {
  if (!kikiHome) return undefined;
  const instancesDir = path.join(kikiHome, 'server', 'instances');
  let names;
  try {
    names = await readdir(instancesDir);
  } catch {
    return undefined;
  }
  const live = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(instancesDir, name), 'utf8'));
      if (
        Number.isInteger(parsed?.pid) &&
        Number.isInteger(parsed?.port) &&
        parsed.port > 0 &&
        typeof parsed?.heartbeat_at === 'number' &&
        nowMs - parsed.heartbeat_at <= INSTANCE_STALE_MS &&
        pidAlive(parsed.pid)
      ) {
        live.push(parsed);
      }
    } catch {
      continue;
    }
  }
  live.sort((a, b) => b.heartbeat_at - a.heartbeat_at);
  const chosen = live[0];
  if (!chosen) return undefined;
  return `http://${formatHttpHost(chosen.host)}:${chosen.port}`;
}

async function readLocalOwnerToken(kikiHome) {
  if (!kikiHome) return undefined;
  try {
    const token = (await readFile(path.join(kikiHome, 'server.local-owner'), 'utf8')).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export class RelayPluginService {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.startServerFn = options.startServerFn ?? startKikiRelayServer;
    this.explicitHomeDir = options.homeDir;
    this.explicitKapOrigin = options.kapOrigin;
    this.explicitOwnerToken = options.ownerToken;
    this.nowFn = options.nowFn ?? Date.now;
    this.context = null;
    this.settings = {};
    this.localServer = { state: 'stopped' };
    this.serverHandle = null;
  }

  resolveKikiHome() {
    return (
      this.explicitHomeDir ||
      this.context?.kikiHome ||
      deriveKikiHomeFromDataDir(this.context?.dataDir) ||
      process.env.KIKI_HOME ||
      process.env.KIMI_CODE_HOME ||
      undefined
    );
  }

  async resolveKapConnection() {
    const kikiHome = this.resolveKikiHome();
    const rawOrigin =
      this.explicitKapOrigin ||
      this.context?.serverOrigin ||
      process.env.KIKI_SERVER_URL ||
      (await discoverLiveKapOrigin(kikiHome, this.nowFn()));
    const ownerToken =
      this.explicitOwnerToken ||
      this.context?.localOwnerToken ||
      process.env.KIKI_LOCAL_OWNER_TOKEN ||
      (await readLocalOwnerToken(kikiHome));

    if (!rawOrigin || !ownerToken) {
      throw new Error(
        'Kiki server is not running; start Kiki desktop or web to manage encrypted relay nodes.',
      );
    }
    return {
      origin: String(rawOrigin).replace(/\/+$/, ''),
      ownerToken: String(ownerToken).trim(),
    };
  }

  async requestKap(method, subPath = '', body = undefined) {
    const { origin, ownerToken } = await this.resolveKapConnection();
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${ownerToken}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const res = await this.fetchFn(`${origin}/api/remote-connections/relays${subPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok || !payload || payload.code !== 0) {
      throw new Error(payload?.msg || `Relay API error (HTTP ${res.status})`);
    }
    return payload.data;
  }

  withLocalServer(remoteStatus) {
    return {
      ...remoteStatus,
      localServer: { ...this.localServer },
    };
  }

  async tryStatus() {
    try {
      return await this.status();
    } catch {
      return {
        schemaVersion: 1,
        inboundEnabled: false,
        standbyNodeIds: [],
        nodes: [],
        subscriptions: [],
        localServer: { ...this.localServer },
      };
    }
  }

  async activate(context = {}) {
    this.context = context;
    this.settings = { ...(context.settings ?? {}) };
    if (this.settings.localServerEnabled === true && !this.serverHandle) {
      await this.startLocalServer().catch((err) => {
        this.localServer = {
          state: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      });
    }
    return this.tryStatus();
  }

  async deactivate() {
    if (this.serverHandle) {
      const handle = this.serverHandle;
      this.serverHandle = null;
      await handle.stop().catch(() => {});
    }
    this.localServer = { state: 'stopped' };
  }

  async status() {
    const remote = await this.requestKap('GET', '');
    return this.withLocalServer(remote);
  }

  async probe(url) {
    const normalized = normalizeRelayBaseUrl(url);
    if (!normalized) {
      return { ok: false, url: String(url ?? ''), error: 'Invalid or insecure relay URL' };
    }
    return this.requestKap('POST', '/probe', { url: normalized });
  }

  async addNode(input = {}) {
    if (typeof input.uri === 'string') {
      const trimmed = input.uri.trim();
      const parsed = /^kiki-relay:\/\//i.test(trimmed)
        ? parseRelayShareUri(trimmed)
        : normalizeRelayBaseUrl(trimmed);
      if (!parsed) throw new Error('Invalid or insecure relay share URI');
      const payload = {
        uri: trimmed,
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      };
      return this.withLocalServer(await this.requestKap('POST', '/nodes', payload));
    }
    const normalized = normalizeRelayBaseUrl(input.url);
    if (!normalized) throw new Error('Invalid or insecure relay node URL');
    const payload = {
      url: normalized,
      ...(typeof input.id === 'string' && input.id.trim() ? { id: input.id.trim() } : {}),
      ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
      ...(typeof input.token === 'string' && input.token.trim() ? { token: input.token.trim() } : {}),
      ...(input.role === 'auto' || input.role === 'backup-only' ? { role: input.role } : {}),
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    };
    return this.withLocalServer(await this.requestKap('POST', '/nodes', payload));
  }

  async updateNode(id, patch = {}) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Relay node id is required');
    const cleanPatch = {};
    if (patch.label === null || typeof patch.label === 'string') cleanPatch.label = patch.label;
    if (typeof patch.url === 'string') {
      const normalized = normalizeRelayBaseUrl(patch.url);
      if (!normalized) throw new Error('Invalid or insecure relay URL');
      cleanPatch.url = normalized;
    }
    if (patch.token === null || typeof patch.token === 'string') cleanPatch.token = patch.token;
    if (patch.role === 'auto' || patch.role === 'backup-only') cleanPatch.role = patch.role;
    if (typeof patch.enabled === 'boolean') cleanPatch.enabled = patch.enabled;
    return this.withLocalServer(
      await this.requestKap('PATCH', `/nodes/${encodeURIComponent(id.trim())}`, cleanPatch),
    );
  }

  async removeNode(id) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Relay node id is required');
    return this.withLocalServer(
      await this.requestKap('DELETE', `/nodes/${encodeURIComponent(id.trim())}`),
    );
  }

  async addSubscription(input = {}) {
    const rawUrl = String(input.url ?? '').trim();
    if (!isValidRelaySubscriptionUrl(rawUrl)) {
      throw new Error('Relay subscription URL must use HTTPS');
    }
    const payload = {
      url: new URL(rawUrl).toString(),
      ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    };
    return this.withLocalServer(await this.requestKap('POST', '/subscriptions', payload));
  }

  async refreshSubscription(id) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Relay subscription id is required');
    return this.withLocalServer(
      await this.requestKap('POST', `/subscriptions/${encodeURIComponent(id.trim())}/refresh`),
    );
  }

  async removeSubscription(id) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Relay subscription id is required');
    return this.withLocalServer(
      await this.requestKap('DELETE', `/subscriptions/${encodeURIComponent(id.trim())}`),
    );
  }

  async configure(values = {}) {
    const patch = {};
    for (const key of ['localServerEnabled', 'localServerPort', 'localServerBasePath', 'localServerPublicUrl', 'localServerToken']) {
      if (key in values) {
        if (values[key] === null) {
          delete this.settings[key];
          patch[key] = null;
        } else if (values[key] !== undefined) {
          this.settings[key] = values[key];
          patch[key] = values[key];
        }
      }
    }
    if (Object.keys(patch).length > 0 && typeof this.context?.updateSettings === 'function') {
      await this.context.updateSettings(patch);
    }
    if (values.localServerEnabled === false && this.serverHandle) {
      await this.stopLocalServer();
    } else if (values.localServerEnabled === true && !this.serverHandle) {
      await this.startLocalServer();
    }
    return this.tryStatus();
  }

  async startLocalServer() {
    if (this.serverHandle) return this.tryStatus();
    this.localServer = { state: 'starting' };
    try {
      const port = Number.isInteger(this.settings.localServerPort) ? this.settings.localServerPort : 0;
      const basePath = typeof this.settings.localServerBasePath === 'string' ? this.settings.localServerBasePath : '';
      const publicUrl = typeof this.settings.localServerPublicUrl === 'string' ? this.settings.localServerPublicUrl : '';
      const hostToken = typeof this.settings.localServerToken === 'string' && this.settings.localServerToken.trim()
        ? this.settings.localServerToken.trim()
        : randomUUID().replaceAll('-', '');

      const instance = await this.startServerFn({
        host: '127.0.0.1',
        port,
        basePath,
        publicUrl: publicUrl || undefined,
        hostToken,
      });
      this.serverHandle = instance;
      this.localServer = {
        state: 'running',
        port: instance.port,
        basePath: instance.basePath,
        shareUri: instance.shareUri,
        pid: process.pid,
      };
    } catch (err) {
      this.localServer = {
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
    return this.tryStatus();
  }

  async stopLocalServer() {
    if (this.serverHandle) {
      const handle = this.serverHandle;
      this.serverHandle = null;
      await handle.stop().catch(() => {});
    }
    this.localServer = { state: 'stopped' };
    return this.tryStatus();
  }

  async panel(action, args = {}) {
    switch (action) {
      case 'status':
        return this.status();
      case 'configure':
        return this.configure(args?.values ?? {});
      case 'addNode':
        return this.addNode(args);
      case 'updateNode':
        return this.updateNode(args?.id, args?.patch ?? {});
      case 'removeNode':
        return this.removeNode(args?.id);
      case 'addSubscription':
        return this.addSubscription(args);
      case 'refreshSubscription':
        return this.refreshSubscription(args?.id);
      case 'removeSubscription':
        return this.removeSubscription(args?.id);
      case 'probe':
        return this.probe(args?.url);
      case 'startLocalServer':
        return this.startLocalServer();
      case 'stopLocalServer':
        return this.stopLocalServer();
      case 'deployGuide':
        return generateRelayDeployGuide(args);
      default:
        throw new Error(`Unsupported kiki-relay panel action: ${String(action)}`);
    }
  }
}
