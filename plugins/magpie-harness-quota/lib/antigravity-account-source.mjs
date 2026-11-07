import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  DEFAULT_HUB_USER_AGENT,
  DEFAULT_IDE_VERSION,
  GOOGLE_TOKEN_URL,
  OAUTH_CLIENT_UNCONFIGURED,
  antigravityCatalogModelIds,
  antigravityEntitlementCandidates,
  ensureFreshAccessToken,
  forgetAntigravityAccessToken,
  loadMagpieAntigravityAccounts,
  normalizeProxyAddress,
  requestViaProxy,
  resolveAntigravityOAuthClient,
  resolveCodeAssistOrigin,
  resolveMagpieConfigDir,
} from './antigravity-direct-quota.mjs';
import { antigravityAccountSourceDefinition } from './definitions.mjs';

const ENGINE_ID = 'agy-cli';
const PROXY_MODES = new Set(['system', 'direct', 'custom']);
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const SECRET_ENV = ['ANTIGRAVITY_OAUTH_CLIENT_ID', 'ANTIGRAVITY_OAUTH_CLIENT_SECRET'];
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 12_000;
const SIDECAR_READY_MS = 8_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortError() {
  const error = new Error('The account preparation was cancelled.');
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function textId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\s\u0000]/u.test(value)) {
    throw new Error(`Provide a valid ${label}.`);
  }
  return value;
}

function accountStatus(account) {
  if (account.lapsed) return 'signed_out';
  if (account.paused === true || account.on === false) return 'disabled';
  return 'ready';
}

function publicError(error, secrets = []) {
  if (error?.code === 'ABORT_ERR' || error?.name === 'AbortError') return abortError();
  const original = error instanceof Error ? error.message : String(error);
  let message = original;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) message = message.split(secret).join('[redacted]');
  }
  if (error?.code === OAUTH_CLIENT_UNCONFIGURED) {
    const clean = new Error(message);
    clean.code = OAUTH_CLIENT_UNCONFIGURED;
    return clean;
  }
  if (/access_token|refresh_token|client_secret|proxy-authorization/i.test(message)) {
    return new Error('Antigravity account preparation failed.');
  }
  return new Error(message || 'Antigravity account preparation failed.');
}

function stageError(stage, kind, httpStatus, projectPresent = false) {
  const status = httpStatus === undefined || httpStatus === null ? 'none' : String(httpStatus);
  return new Error(`Antigravity ${stage} failed (stage=${stage}, kind=${kind}, httpStatus=${status}, projectPresent=${projectPresent}).`);
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed) || /[\0\r\n]/u.test(trimmed)) {
    throw new Error(`${label} must be an absolute path on the Kiki server.`);
  }
  return trimmed;
}

function requestDirect(targetUrl, { method = 'POST', headers = {}, body = '', timeoutMs = HTTP_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const target = new URL(targetUrl);
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: { Connection: 'close', ...headers, 'Content-Length': String(bodyBuf.length) },
      agent: false,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          finish(new Error('Upstream response exceeded byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => finish(error));
    });
    const timer = setTimeout(() => finish(new Error(`Upstream request timed out after ${timeoutMs}ms`)), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        req.destroy();
        reject(error.code === 'ABORT_ERR' ? error : error);
      } else {
        resolve(value);
      }
    }
    function onAbort() {
      finish(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => finish(error));
    req.end(bodyBuf);
  });
}

function requestWithProxy(proxyUrl) {
  return (targetUrl, options = {}) => {
    if (!options.proxyUrl) return requestDirect(targetUrl, options);
    return requestViaProxy(targetUrl, { ...options, proxyUrl: options.proxyUrl || proxyUrl });
  };
}

function cloneAccount(account, proxyUrl) {
  const source = account._secrets ?? {};
  const secrets = {
    accessToken: typeof source.accessToken === 'string' ? source.accessToken : '',
    refreshToken: typeof source.refreshToken === 'string' ? source.refreshToken : '',
    expiryMs: typeof source.expiryMs === 'number' ? source.expiryMs : 0,
    proxyUrl,
  };
  const copy = { ...account };
  Object.defineProperty(copy, '_secrets', {
    value: secrets,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return copy;
}

function bearerFrom(account) {
  const secrets = account._secrets;
  return {
    access_token: secrets.accessToken,
    expires_at: Math.floor(secrets.expiryMs / 1000),
    project_id: account.project,
    account_id: account.user,
    email: account.user,
  };
}

function proxyChoice(input, account) {
  const proxy = input?.proxy;
  if (!isRecord(proxy) || !PROXY_MODES.has(proxy.mode)) {
    throw new Error('Choose a proxy mode: system, direct, or custom.');
  }
  if (proxy.mode === 'direct') return { proxyUrl: '', sidecarProxy: 'direct' };
  if (proxy.mode === 'custom') {
    const normalized = normalizeProxyAddress(proxy.url);
    if (!normalized) throw new Error('Custom proxy mode requires a proxy URL.');
    let parsed;
    try { parsed = new URL(normalized); } catch { throw new Error('Custom proxy URL must be a valid URL.'); }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('Custom proxy URL must use HTTP, HTTPS, SOCKS5, or SOCKS5H.');
    }
    return { proxyUrl: normalized, sidecarProxy: normalized };
  }
  if (account.boundProxyKind === 'url' && account._secrets?.proxyUrl) {
    return { proxyUrl: account._secrets.proxyUrl, sidecarProxy: account._secrets.proxyUrl };
  }
  if (account.boundProxyKind === 'direct') return { proxyUrl: '', sidecarProxy: 'direct' };
  throw new Error('Antigravity account has no Magpie proxy binding. Choose a direct or custom instance proxy, or bind a proxy on that Magpie account.');
}

function sidecarEnvironment(baseEnv) {
  const env = { ...baseEnv };
  for (const key of [...PROXY_ENV, ...SECRET_ENV]) delete env[key];
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

async function destroyChild(child) {
  if (!child) return;
  try { child.stdin?.destroy(); } catch { /* already closed */ }
  if (child.exitCode !== null || child.signalCode) return;
  try { child.kill(); } catch { return; }
  await Promise.race([
    once(child, 'exit').catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

/**
 * Magpie Antigravity account source for agy-cli.
 * List reads public login metadata only. Prepare opens one scoped sidecar for the
 * selected account; refresh reuses that lease and does not read the catalog again.
 */
export class MagpieAntigravityAccountService {
  constructor(options = {}) {
    this.options = options;
    this.leases = new Map();
    this.adapter = {
      list: (input, context) => this.list(input, context),
      prepare: (input, context) => this.prepare(input, context),
      release: (input, context) => this.release(input, context),
    };
  }

  adapterFor(sourceId) {
    if (sourceId !== antigravityAccountSourceDefinition.id) {
      throw new Error(`Unknown Magpie harness account source: ${sourceId}`);
    }
    return this.adapter;
  }

  #env(override) {
    return override ?? this.options.env ?? process.env;
  }

  async #storeOptions(settings, env) {
    const magpiePath = typeof settings.magpiePath === 'string' && settings.magpiePath.trim()
      ? settings.magpiePath.trim()
      : undefined;
    const configDir = typeof settings.magpieConfigDir === 'string' && settings.magpieConfigDir.trim()
      ? settings.magpieConfigDir.trim()
      : this.options.configDir;
    return {
      configDir: await resolveMagpieConfigDir({ configDir, magpiePath, env, homedir: this.options.homedir }),
      magpiePath,
      env,
      homedir: this.options.homedir,
      requireProxy: false,
      onlyEnabled: false,
    };
  }

  async #loadedAccounts(settings, env) {
    return loadMagpieAntigravityAccounts(await this.#storeOptions(settings, env));
  }

  async list(input, context = {}) {
    const signal = context.signal;
    throwIfAborted(signal);
    if (input?.engineId !== ENGINE_ID) throw new Error('This account source only lists agy-cli.');
    const env = this.#env();
    const settings = isRecord(context.settings) ? context.settings : {};
    const loaded = await this.#loadedAccounts(settings, env);
    throwIfAborted(signal);
    const accounts = [];
    const seen = new Set();
    for (const account of loaded) {
      if (seen.has(account.user) || /[\s\u0000]/u.test(account.user) || account.user.length > 1024) continue;
      seen.add(account.user);
      accounts.push({
        id: account.user,
        label: account.accountLabel || account.user,
        status: accountStatus(account),
      });
    }
    const store = await this.#storeOptions(settings, env);
    const raw = JSON.parse(await fs.readFile(path.join(store.configDir, 'logins.json'), 'utf8'));
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (!isRecord(entry) || String(entry.agent ?? '').toLowerCase() !== 'antigravity') continue;
      const user = String(entry.user ?? '').trim();
      if (!user || seen.has(user) || /[\s\u0000]/u.test(user) || user.length > 1024) continue;
      seen.add(user);
      accounts.push({ id: user, label: user, status: 'signed_out' });
    }
    return accounts;
  }

  async #session(account, { origin, tokenUrl, oauthClient, signal }) {
    const requestFn = requestWithProxy(account._secrets.proxyUrl);
    const accessToken = await ensureFreshAccessToken(account, {
      tokenUrl,
      requestFn,
      timeoutMs: HTTP_TIMEOUT_MS,
      signal,
      oauthClient,
    });
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': DEFAULT_HUB_USER_AGENT,
    };
    let projectId = account.project || '';
    let loadResp = null;
    if (!projectId) {
      let loadRaw;
      try {
        loadRaw = await requestFn(`${origin}/v1internal:loadCodeAssist`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            mode: 'FULL_ELIGIBILITY_CHECK',
            metadata: { ideType: 'ANTIGRAVITY', ideVersion: DEFAULT_IDE_VERSION, ideName: 'antigravity' },
          }),
          proxyUrl: account._secrets.proxyUrl,
          timeoutMs: HTTP_TIMEOUT_MS,
          signal,
        });
      } catch (error) {
        if (error?.code === 'ABORT_ERR') throw error;
        throw stageError('loadCodeAssist', 'transport', 'none', false);
      }
      if (loadRaw.status !== 200) throw stageError('loadCodeAssist', 'http_error', loadRaw.status, false);
      try {
        loadResp = JSON.parse(loadRaw.body);
      } catch {
        throw stageError('loadCodeAssist', 'invalid_json', loadRaw.status, false);
      }
      const discovered = isRecord(loadResp?.cloudaicompanionProject)
        ? loadResp.cloudaicompanionProject.id
        : loadResp?.cloudaicompanionProject;
      if (typeof discovered !== 'string' || !discovered.trim()) {
        throw stageError('loadCodeAssist', 'project_missing', loadRaw.status, false);
      }
      projectId = discovered.trim();
    }
    const catalogProject = projectId.trim() === 'aicode-consumers' ? '' : projectId.trim();
    const tiers = antigravityEntitlementCandidates(loadResp, account._secrets.refreshToken, catalogProject);
    let modelsResp = null;
    let lastStatus = 0;
    for (const tier of tiers) {
      const modelsRaw = await requestFn(`${origin}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(catalogProject ? { project: catalogProject } : {}),
          ...(tier ? { entitlement: { userTier: tier } } : {}),
        }),
        proxyUrl: account._secrets.proxyUrl,
        timeoutMs: HTTP_TIMEOUT_MS,
        signal,
      });
      lastStatus = modelsRaw.status;
      if (modelsRaw.status === 200) {
        try {
          modelsResp = JSON.parse(modelsRaw.body);
        } catch {
          throw stageError('fetchAvailableModels', 'invalid_json', modelsRaw.status, Boolean(projectId));
        }
        break;
      }
      if (tier && modelsRaw.status === 400) continue;
      throw stageError('fetchAvailableModels', 'http_error', modelsRaw.status, Boolean(projectId));
    }
    if (!modelsResp) throw stageError('fetchAvailableModels', 'http_error', lastStatus, Boolean(projectId));
    const modelIds = antigravityCatalogModelIds(modelsResp);
    if (modelIds.length === 0) throw new Error('Antigravity model catalog did not include a usable model.');
    account.project = projectId;
    return { modelIds };
  }

  #issueBearer(lease, rejected) {
    const run = lease.refresh.then(async () => {
      const secrets = lease.account._secrets;
      if (rejected && rejected === secrets.accessToken) forgetAntigravityAccessToken(lease.account, lease.tokenUrl);
      await ensureFreshAccessToken(lease.account, {
        tokenUrl: lease.tokenUrl,
        requestFn: requestWithProxy(secrets.proxyUrl),
        timeoutMs: HTTP_TIMEOUT_MS,
        signal: lease.signal,
        oauthClient: lease.oauthClient,
      });
      const bearer = bearerFrom(lease.account);
      if (!bearer.access_token || bearer.expires_at * 1000 <= Date.now()) {
        throw new Error('Antigravity authorization expired.');
      }
      return bearer;
    });
    lease.refresh = run.then(() => undefined, () => undefined);
    return run;
  }

  #sidecarPath(settings, env) {
    const configured = absolutePath(settings.antigravitySidecarPath, 'antigravitySidecarPath')
      || absolutePath(env.ANTIGRAVITY_SIDECAR_PATH, 'ANTIGRAVITY_SIDECAR_PATH')
      || absolutePath(env.MAGPIE_AGY_SIDECAR_PATH, 'MAGPIE_AGY_SIDECAR_PATH');
    if (!configured) {
      throw new Error('Configure antigravitySidecarPath to the cockpit-cliproxy binary before preparing an Antigravity account.');
    }
    return configured;
  }

  #tokenUrl(settings, env) {
    const raw = [settings.antigravityTokenUrl, env.ANTIGRAVITY_TOKEN_URL, this.options.tokenUrl]
      .find((value) => typeof value === 'string' && value.trim());
    if (!raw) return GOOGLE_TOKEN_URL;
    let parsed;
    try { parsed = new URL(raw.trim()); } catch { throw new Error('ANTIGRAVITY_TOKEN_URL must be an HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('ANTIGRAVITY_TOKEN_URL must be an HTTP or HTTPS URL.');
    return parsed.toString();
  }

  async #openSidecar(lease, signal) {
    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(lease.sidecarPath, ['--harness-scoped', '--parent-pid', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: sidecarEnvironment(lease.env),
    });
    lease.child = child;
    child.stderr?.resume();
    const lines = createInterface({ input: child.stdout });
    const { promise: readyPromise, resolve, reject } = Promise.withResolvers();
    let ready = false;
    let failure;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      reject(error);
      if (ready && this.leases.delete(lease.leaseId)) void destroyChild(child);
    };
    const onAbort = () => fail(abortError());
    const onPipeError = () => fail(new Error('Antigravity sidecar input pipe closed.'));
    const writeMessage = (message) => {
      if (failure || child.exitCode !== null || child.signalCode) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) onPipeError(); });
      } catch { onPipeError(); }
    };
    const timer = setTimeout(() => fail(new Error('Antigravity sidecar did not become ready.')), SIDECAR_READY_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdin.on('error', onPipeError);
    child.on('error', () => fail(new Error('Antigravity sidecar could not start or communicate.')));
    child.once('exit', () => fail(new Error('Antigravity sidecar stopped.')));
    lines.on('line', (line) => {
      if (failure) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!ready) {
        if (message?.type !== 'harness_ready' || !Number.isInteger(message.port) || message.port <= 0 || message.port > 65535) {
          fail(new Error('Antigravity sidecar returned an invalid ready message.'));
          return;
        }
        ready = true;
        resolve(message.port);
        return;
      }
      if (message?.type === 'harness_refresh') {
        void this.#issueBearer(lease, typeof message.rejected_bearer === 'string' ? message.rejected_bearer : '')
          .then(
            (bearer) => writeMessage({ type: 'harness_refresh_result', bearer }),
            (error) => writeMessage({ type: 'harness_refresh_result', error: publicError(error, lease.redactions).message }),
          );
      }
    });
    const configure = {
      type: 'harness_configure',
      provider: 'antigravity',
      account_id: lease.account.user,
      instance_id: lease.instanceId,
      capability: lease.capability,
      proxy_url: lease.sidecarProxy,
      base_url: lease.origin,
      model_ids: lease.modelIds,
      bearer: bearerFrom(lease.account),
    };
    if (signal.aborted) onAbort();
    writeMessage(configure);
    try {
      const port = await readyPromise;
      if (failure) throw failure;
      return port;
    } catch (error) {
      lines.close();
      await destroyChild(child);
      lease.child = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async prepare(input, context = {}) {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    if (input?.engineId !== ENGINE_ID) throw new Error('This account source only prepares agy-cli.');
    const accountId = textId(input?.accountId, 'account id');
    const instanceId = textId(input?.instanceId, 'instance id');
    const env = this.#env();
    const settings = isRecord(context.settings) ? context.settings : {};
    const loaded = await this.#loadedAccounts(settings, env);
    const selected = loaded.find((account) => account.user === accountId);
    if (!selected) throw new Error('Selected account was not found.');
    const status = accountStatus(selected);
    if (status === 'signed_out') throw new Error('Selected account is signed out.');
    if (status === 'disabled') throw new Error('Selected account is disabled.');
    const choice = proxyChoice(input, selected);
    const oauthClient = resolveAntigravityOAuthClient({ settings, env });
    const origin = resolveCodeAssistOrigin({
      baseUrl: typeof settings.antigravityCodeAssistOrigin === 'string' ? settings.antigravityCodeAssistOrigin : undefined,
      env,
    });
    const sidecarPath = this.#sidecarPath(settings, env);
    const tokenUrl = this.#tokenUrl(settings, env);
    const account = cloneAccount(selected, choice.proxyUrl);
    let child;
    const redactions = [account._secrets.accessToken, account._secrets.refreshToken, oauthClient?.clientSecret, choice.proxyUrl];
    try {
      throwIfAborted(signal);
      const session = await this.#session(account, { origin, tokenUrl, oauthClient, signal });
      throwIfAborted(signal);
      const capability = crypto.randomBytes(32).toString('base64url');
      const leaseId = `lease_${crypto.randomBytes(18).toString('base64url')}`;
      const lease = {
        leaseId,
        account,
        instanceId,
        capability,
        sidecarProxy: choice.sidecarProxy,
        origin,
        tokenUrl,
        oauthClient,
        modelIds: session.modelIds,
        env,
        signal,
        sidecarPath,
        redactions: [...redactions, capability],
        refresh: Promise.resolve(),
      };
      const port = await this.#openSidecar(lease, signal);
      child = lease.child;
      throwIfAborted(signal);
      this.leases.set(leaseId, lease);
      return {
        leaseId,
        connection: {
          protocol: 'gemini-v1beta',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: capability,
          modelIds: [...lease.modelIds],
        },
      };
    } catch (error) {
      if (child && ![...this.leases.values()].some((lease) => lease.child === child)) await destroyChild(child);
      throw publicError(error, redactions.filter(Boolean));
    }
  }

  async release(input) {
    const leaseId = typeof input?.leaseId === 'string' ? input.leaseId : '';
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);
    await destroyChild(lease.child);
  }
}
