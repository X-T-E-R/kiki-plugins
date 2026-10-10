import { stat, access } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { dependency, ASSETS } from './binary.mjs';
import { spawnOwned, stopOwned, command } from './process.mjs';
import { CloudflareAccount } from './account.mjs';

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SETTINGS = {
  cloudflaredPath: 'string', mode: 'string', tunnelToken: 'string', tokenFile: 'string', apiToken: 'string', accountId: 'string',
  tunnelId: 'string', certificatePath: 'string', configPath: 'string', credentialsFile: 'string', publicUrl: 'string', autoStart: 'boolean',
};
export function validateValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Provide Cloudflare settings.');
  for (const [key, value] of Object.entries(values)) {
    if (!SETTINGS[key] || (value !== null && typeof value !== SETTINGS[key])) throw new Error(`Invalid setting: ${key}.`);
    if (typeof value === 'string' && (value.length > 16384 || /[\r\n\0]/.test(value))) throw new Error(`Invalid setting: ${key}.`);
  }
  if (values.mode != null && !['token', 'local'].includes(values.mode)) throw new Error('Choose token or local configuration mode.');
  if (values.tunnelId && !UUID.test(values.tunnelId)) throw new Error('Tunnel ID must be a UUID.');
  if (values.accountId && !/^[a-f\d]{32}$/i.test(values.accountId)) throw new Error('Account ID must be 32 hexadecimal characters.');
  for (const key of ['cloudflaredPath', 'tokenFile', 'certificatePath', 'configPath', 'credentialsFile']) {
    if (values[key] && !path.isAbsolute(values[key])) throw new Error(`${key} must be an absolute path on the Kiki server.`);
  }
  if (values.publicUrl) {
    let url;
    try { url = new URL(values.publicUrl); } catch { throw new Error('Public URL must be a valid HTTPS endpoint.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Public URL must be HTTPS without credentials, query or fragment.');
  }
  return values;
}

async function regularFile(file) {
  if (!file) return false;
  try { const info = await stat(file); await access(file); return info.isFile() && info.size > 0; } catch { return false; }
}
async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class CloudflareService {
  constructor({ spawnFn = spawnOwned, commandFn = command, fetchFn = fetch, portFn = reservePort, retryDelayMs = 1000, probeMs = 1000 } = {}) {
    this.spawn = spawnFn; this.command = commandFn; this.fetch = fetchFn; this.port = portFn;
    this.retryDelayMs = retryDelayMs; this.probeMs = probeMs;
    this.settings = {}; this.service = { state: 'unconfigured', ready: false, manualStop: false, retryCount: 0 };
    this.loginState = { state: 'idle' }; this.closed = true; this.queue = Promise.resolve(); this.generation = 0;
  }
  serial(work) { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  certificate() { return this.settings.certificatePath || path.join(this.userHome, '.cloudflared', 'cert.pem'); }
  env(extra = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(TUNNEL_|CLOUDFLARE_)/.test(key)) delete env[key];
    return { ...env, HOME: this.userHome, USERPROFILE: this.userHome, ...extra };
  }
  configured() { return this.settings.mode === 'local' ? Boolean(this.settings.tunnelId && this.settings.configPath) : Boolean(this.settings.tunnelToken || this.settings.tokenFile); }
  async activate(context) {
    return this.serial(async () => {
      if (!path.isAbsolute(context.userHome ?? '') || !path.isAbsolute(context.dataDir ?? '')) throw new Error('This plugin requires Kiki App lifecycle support.');
      this.userHome = context.userHome; this.dataDir = context.dataDir; this.updateSettings = context.updateSettings;
      const next = { ...context.settings };
      validateValues(next);
      const { autoStart: _nextAuto, ...nextLaunch } = next;
      const { autoStart: _oldAuto, ...oldLaunch } = this.settings;
      const changed = JSON.stringify(nextLaunch) !== JSON.stringify(oldLaunch);
      this.settings = next; this.dep = undefined;
      const wasClosed = this.closed;
      this.closed = false;
      if (changed && this.child) await this.stopInternal(false);
      if (wasClosed) this.service.manualStop = false;
      if (this.configured() && this.settings.autoStart !== false && !this.service.manualStop) await this.startInternal();
      else if (!this.child) this.service.state = this.configured() ? 'stopped' : 'unconfigured';
      return this.status();
    });
  }
  async status() {
    if (!this.userHome) throw new Error('This plugin requires Kiki App lifecycle support.');
    this.dep ??= await dependency(this.settings, this.command);
    return {
      schemaVersion: 1, dependency: { ...this.dep, installable: Boolean(ASSETS[`${process.platform}/${process.arch}`]) },
      account: { certificate: await regularFile(this.certificate()), apiToken: Boolean(this.settings.apiToken) },
      configuration: { mode: this.settings.mode ?? 'token', tunnelId: this.settings.tunnelId ?? '', configPath: this.settings.configPath ?? '',
        tokenFile: this.settings.tokenFile ?? '', credentialsFile: this.settings.credentialsFile ?? '', certificatePath: this.certificate(),
        publicUrl: this.settings.publicUrl ?? '', accountId: this.settings.accountId ?? '', cloudflaredPath: this.settings.cloudflaredPath ?? '', autoStart: this.settings.autoStart !== false,
        tokenConfigured: Boolean(this.settings.tunnelToken || this.settings.tokenFile), source: 'plugin-settings',
        credentialSource: this.settings.mode === 'local' ? (this.settings.configPath ? 'existing-local-config' : 'none') : this.settings.tunnelToken ? 'plugin-secret-store' : this.settings.tokenFile ? 'existing-token-file' : 'none' },
      service: { ...this.service, pid: this.child?.pid }, login: { ...this.loginState },
    };
  }
  async configure(values) {
    validateValues(values);
    if (typeof this.updateSettings !== 'function') throw new Error('Kiki cannot save this plugin configuration. Update Kiki with App lifecycle support.');
    return this.serial(async () => {
      const next = { ...this.settings };
      for (const [key, value] of Object.entries(values)) { if (value === null) delete next[key]; else next[key] = value; }
      const changesConnector = Object.keys(values).some((key) => !['autoStart', 'apiToken', 'accountId', 'certificatePath', 'publicUrl'].includes(key));
      await this.updateSettings(values);
      this.settings = next; this.dep = undefined;
      if (changesConnector) {
        await this.stopInternal(false);
        this.service.manualStop = false;
        if (this.configured()) await this.startInternal();
      }
      return this.status();
    });
  }
  start() { return this.serial(async () => { this.service.manualStop = false; this.service.retryCount = 0; this.dep = undefined; await this.startInternal(); return this.status(); }); }
  stop() { return this.serial(async () => { await this.stopInternal(true); return this.status(); }); }
  async launchSpec() {
    this.dep ??= await dependency(this.settings, this.command);
    if (this.dep.state !== 'ready') throw new Error('Install cloudflared (2025.4.0 or later) or choose a working executable.');
    if (!this.configured()) throw new Error('Save a tunnel token or select an existing local tunnel configuration first.');
    const args = ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${this.metricsPort}`, '--loglevel', 'error'];
    const extra = {};
    if (this.settings.mode === 'local') {
      if (!UUID.test(this.settings.tunnelId ?? '') || !await regularFile(this.settings.configPath)) throw new Error('Choose an existing cloudflared config file and tunnel UUID.');
      args.push('--config', this.settings.configPath, 'run');
      if (this.settings.credentialsFile) {
        if (!await regularFile(this.settings.credentialsFile)) throw new Error('The tunnel credentials file is missing or unreadable.');
        args.push('--credentials-file', this.settings.credentialsFile);
      }
      args.push(this.settings.tunnelId);
    } else {
      args.push('run');
      if (this.settings.tunnelToken) extra.TUNNEL_TOKEN = this.settings.tunnelToken;
      else {
        if (!await regularFile(this.settings.tokenFile)) throw new Error('The tunnel token file is missing or unreadable.');
        args.push('--token-file', this.settings.tokenFile);
      }
    }
    return { args, env: this.env(extra) };
  }
  async startInternal() {
    if (this.closed || this.child) return;
    clearTimeout(this.retry);
    this.metricsPort = await this.port();
    let spec;
    try { spec = await this.launchSpec(); }
    catch (error) { this.service = { ...this.service, state: 'error', ready: false, error: error.message }; return; }
    const generation = ++this.generation;
    this.service = { ...this.service, state: 'starting', ready: false, error: undefined };
    const child = this.spawn(this.dep.path, spec.args, { env: spec.env });
    this.child = child;
    child.stdout.resume(); child.stderr.resume();
    const ended = () => {
      if (this.generation !== generation || this.child !== child) return;
      this.child = undefined; clearTimeout(this.probeTimer);
      this.service.ready = false;
      if (this.closed || this.service.manualStop) return;
      this.service.retryCount++;
      if (this.service.retryCount > 5) {
        this.service.state = 'error'; this.service.error = 'cloudflared repeatedly exited. Check credentials and configuration, then Start to retry.'; return;
      }
      this.service.state = 'retrying'; this.service.error = 'cloudflared exited; reconnecting.';
      this.retry = setTimeout(() => { void this.serial(() => this.startInternal()); }, Math.min(this.retryDelayMs * 2 ** (this.service.retryCount - 1), 30000));
    };
    child.once('error', ended); child.once('exit', ended);
    const probe = async () => {
      if (this.generation !== generation || this.child !== child) return;
      let ready = false;
      try { ready = (await this.fetch(`http://127.0.0.1:${this.metricsPort}/ready`, { signal: AbortSignal.timeout(2000), redirect: 'error' })).status === 200; } catch {}
      if (this.generation !== generation || this.child !== child) return;
      this.service.ready = ready; this.service.state = ready ? 'running' : 'starting';
      this.probeTimer = setTimeout(probe, this.probeMs);
    };
    void probe();
  }
  async stopInternal(manual) {
    this.generation++; clearTimeout(this.retry); clearTimeout(this.probeTimer);
    const child = this.child; this.child = undefined;
    if (manual) this.service.manualStop = true;
    await stopOwned(child);
    this.service = { ...this.service, state: this.configured() ? 'stopped' : 'unconfigured', ready: false, error: undefined };
  }
  async login() {
    if (this.loginChild) return this.status();
    if (await regularFile(this.certificate())) { this.loginState = { state: 'complete' }; return this.status(); }
    if (this.settings.certificatePath && this.settings.certificatePath !== path.join(this.userHome, '.cloudflared', 'cert.pem')) throw new Error('Choose an existing certificate file, or clear its custom path before browser login.');
    this.dep ??= await dependency(this.settings, this.command);
    if (this.dep.state !== 'ready') throw new Error('Install cloudflared before browser login.');
    this.loginState = { state: 'pending' };
    const child = this.spawn(this.dep.path, ['tunnel', 'login'], { env: this.env() });
    this.loginChild = child;
    let tail = '';
    const output = (bytes) => {
      tail = (tail + bytes.toString()).slice(-8192);
      const candidate = /https:\/\/dash\.cloudflare\.com\/argotunnel[^\s"<>]*/.exec(tail)?.[0];
      if (candidate) this.loginState.url = candidate;
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    const finish = async (code) => {
      if (this.loginChild !== child) return;
      this.loginChild = undefined; clearTimeout(this.loginTimeout);
      const exists = await regularFile(this.certificate());
      this.loginState = exists && code === 0 ? { state: 'complete' } : { state: 'error', error: 'Browser login did not save a certificate. Retry or select an existing certificate.' };
    };
    child.once('exit', (code) => { void finish(code); }); child.once('error', () => { void finish(1); });
    this.loginTimeout = setTimeout(() => { void this.cancelLogin(); }, 5 * 60 * 1000);
    return this.status();
  }
  async cancelLogin() {
    clearTimeout(this.loginTimeout);
    const child = this.loginChild; this.loginChild = undefined;
    await stopOwned(child); this.loginState = { state: 'idle' }; return this.status();
  }
  account() { return new CloudflareAccount(this.settings, { fetchFn: this.fetch }); }
  async tunnels() {
    if (this.settings.apiToken) return { items: await this.account().tunnels() };
    this.dep ??= await dependency(this.settings, this.command);
    if (this.dep.state !== 'ready' || !await regularFile(this.certificate())) throw new Error('Use Browser login or add an API token to list tunnels.');
    const text = await this.command(this.dep.path, ['tunnel', '--origincert', this.certificate(), 'list', '--output', 'json'], { env: this.env() });
    const items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error('cloudflared did not return a tunnel list.');
    return { items: items.map(({ id, name, status }) => ({ id, name, status })) };
  }
  async selectTunnel(id) {
    if (!UUID.test(id ?? '')) throw new Error('Select a valid tunnel UUID.');
    let token;
    if (this.settings.apiToken) token = await this.account().tunnelToken(id);
    else {
      this.dep ??= await dependency(this.settings, this.command);
      if (this.dep.state !== 'ready' || !await regularFile(this.certificate())) throw new Error('Use Browser login or add an API token to select a tunnel.');
      token = (await this.command(this.dep.path, ['tunnel', '--origincert', this.certificate(), 'token', id], { env: this.env(), limit: 16384 })).trim();
    }
    if (!token) throw new Error('No connector token was returned. Use an existing local config for a locally-managed tunnel.');
    return this.configure({ mode: 'token', tunnelId: id, tunnelToken: token });
  }
  async deactivate() {
    this.closed = true;
    await this.serial(async () => { await this.stopInternal(false); await this.cancelLogin(); });
  }
  async panel(action, args = {}) {
    if (this.closed) throw new Error('Cloudflare service is not activated by Kiki.');
    if (action === 'setup') return { url: 'https://dash.cloudflare.com/?to=/:account/tunnels', docsUrl: 'https://developers.cloudflare.com/tunnel/get-started/', managedExternally: true };
    if (action === 'status') return this.status();
    if (action === 'configure') return this.configure(args.values);
    if (action === 'start') return this.start();
    if (action === 'stop') return this.stop();
    if (action === 'login') return this.login();
    if (action === 'cancelLogin') return this.cancelLogin();
    if (action === 'tunnels') return this.tunnels();
    if (action === 'accounts') return { items: await this.account().accounts() };
    if (action === 'selectTunnel') return this.selectTunnel(args.id);
    throw new Error('Unknown Cloudflare action.');
  }
}
