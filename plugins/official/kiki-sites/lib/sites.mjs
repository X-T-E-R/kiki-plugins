import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { catalog, service, guidance, slug } from './catalog.mjs';
import { Store, dataDirectory, SitesError, errorView } from './runtime.mjs';
import { Adapters, loginCommand } from './adapters.mjs';
import { cliPackages, installCli } from './installer.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicConnection = ({ token, ...c }) => ({ ...c, hasToken: Boolean(token) });
const publicJob = ({ target, ...job }) => job;
const connection = (state, id, enabled = true) => {
  const c = state.connections.find(c => c.id === id);
  if (!c) throw new SitesError('connection_missing', 'This connection no longer exists.', 'Select an existing connection.');
  if (enabled && !c.enabled) throw new SitesError('disabled', 'This service connection is disabled.', 'Enable the connection in Sites.'); return c;
};
const targetOf = (state, id) => { const t = state.targets.find(t => t.id === id); if (!t) throw new SitesError('target_missing', 'This deployment target no longer exists.'); return t; };
const bounded = (value, label, max = 512) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new SitesError('invalid_input', `Provide a valid ${label}.`); return value.trim(); };
export class Sites {
  constructor(settings = {}, deps = {}) { this.store = deps.store || new Store(dataDirectory(settings)); this.adapters = deps.adapters || new Adapters({ ...deps, dataDirectory: this.store.directory }); this.active = new Map(); this.pollInterval = deps.pollInterval ?? 3000; this.installRunner = deps.installRunner; }
  async reconcile() {
    await this.store.update(state => {
      for (const job of state.jobs) if (job.state === 'running' && !this.active.has(job.id)) { job.state = job.kind === 'deploy' ? 'unknown' : 'interrupted'; job.error = { code: 'interrupted', message: job.kind === 'deploy' ? 'The runtime restarted while waiting; the remote submission may already exist.' : 'The local operation was interrupted.', recovery: job.kind === 'deploy' ? 'Check the provider before deploying again.' : 'Start the operation again.' }; }
    });
  }
  async state() { await this.reconcile(); const s = await this.store.read(); return { catalog: catalog.map(c => ({ ...c, installable: cliPackages[c.id] })), connections: s.connections.map(publicConnection), targets: s.targets, jobs: s.jobs.map(publicJob), guidance: guidance(s) }; }
  async saveConnection(input) {
    const data = input.connection || {}; const spec = service(data.service);
    if (!spec.authModes.includes(data.authMode)) throw new SitesError('invalid_auth_mode', 'This service does not support that authentication mode.');
    const baseUrl = data.baseUrl || spec.baseUrl;
    if (spec.kind === 'code') {
      let url; try { url = new URL(baseUrl); } catch { throw new SitesError('invalid_url', 'Provide an HTTPS service base URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new SitesError('invalid_url', 'Use an HTTPS base URL without credentials, query or fragment.');
      if (['gitee', 'bitbucket'].includes(spec.id) && baseUrl.replace(/\/$/, '') !== spec.baseUrl) throw new SitesError('unsupported_instance', 'This adapter supports the public cloud service only.');
    } else if (data.baseUrl) throw new SitesError('unsupported_instance', 'This service uses its official deployment endpoint.');
    if (data.cliPath && !path.isAbsolute(data.cliPath)) throw new SitesError('invalid_cli_path', 'Choose an absolute executable or official CLI JavaScript path.');
    if (input.token !== undefined) bounded(input.token, 'API token', 16384);
    return this.store.update(s => {
      const existing = data.id ? connection(s, data.id, false) : undefined;
      if (existing && existing.service !== spec.id) throw new SitesError('service_immutable', 'Create a new connection to change service.');
      const value = { id: existing?.id || randomUUID(), service: spec.id, label: data.label ? bounded(data.label, 'label', 100) : spec.label, enabled: data.enabled === true, authMode: data.authMode, baseUrl: baseUrl?.replace(/\/$/, ''), cliPath: data.cliPath, accountId: data.accountId ? bounded(data.accountId, 'account ID', 100) : undefined, username: data.username ? bounded(data.username, 'account email', 200) : undefined, token: input.clearToken ? undefined : input.token ?? existing?.token, auth: { state: 'unchecked', message: 'Authentication has not been checked.' } };
      if (data.authMode === 'cli') value.token = undefined;
      if (value.service === 'bitbucket' && !value.username) throw new SitesError('input_required', 'Bitbucket API token requires your Atlassian account email.');
      if (existing) s.connections[s.connections.indexOf(existing)] = value; else s.connections.push(value);
      return { connection: publicConnection(value) };
    });
  }
  async check(id, context = {}) {
    const c = connection(await this.store.read(), id); let auth;
    try { await this.adapters.check(c, context); auth = { state: 'valid', message: 'Authentication accepted.', checkedAt: new Date().toISOString() }; }
    catch (error) { auth = { state: error.code || 'error', ...errorView(error), checkedAt: new Date().toISOString() }; }
    await this.store.update(s => { const current = connection(s, id, false); if (digest(current) === digest(c)) current.auth = auth; }); return { auth };
  }
  async saveTarget(input) {
    const data = input.target || {}; const spec = service(data.service);
    if (spec.kind !== 'deploy') throw new SitesError('wrong_kind', 'Choose a deployment service, not a code hosting connection.');
    if (!path.isAbsolute(data.project || '')) throw new SitesError('invalid_project', 'Choose an absolute project directory on the Kiki server.');
    const t = { id: data.id || randomUUID(), service: spec.id, connectionId: bounded(data.connectionId, 'connection'), label: data.label ? bounded(data.label, 'target label', 100) : spec.label, project: path.resolve(data.project) };
    for (const f of spec.fields) {
      if (f.type === 'boolean') t[f.key] = data[f.key] === true;
      else if (data[f.key]) { t[f.key] = bounded(data[f.key], f.label); if (!['directory', 'config'].includes(f.key) && !slug(t[f.key])) throw new SitesError('invalid_identifier', `Use a valid ${f.label}.`); }
      else if (f.required) throw new SitesError('input_required', `${f.label} is required.`);
    }
    return this.store.update(s => { const c = connection(s, t.connectionId, false); if (c.service !== t.service) throw new SitesError('service_mismatch', 'The connection must match the deployment service.'); const existing = data.id ? targetOf(s, data.id) : undefined; if (existing) s.targets[s.targets.indexOf(existing)] = t; else s.targets.push(t); return { target: t }; });
  }
  async projectEvidence(t) {
    const root = await realpath(t.project).catch(() => { throw new SitesError('project_missing', 'The project directory does not exist.'); });
    if (!(await stat(root)).isDirectory()) throw new SitesError('invalid_project', 'The project path is not a directory.');
    for (const key of ['directory', 'config']) if (t[key]) {
      const file = await realpath(path.resolve(root, t[key])).catch(() => { throw new SitesError('project_input_missing', `${key} does not exist.`, 'Build the project or correct the target path.'); });
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SitesError('outside_project', `${key} must stay inside the project.`);
      const info = await stat(file); if ((key === 'directory' && !info.isDirectory()) || (key === 'config' && !info.isFile())) throw new SitesError('invalid_project_input', `Choose a valid ${key}.`);
    }
    const configs = [];
    for (const name of new Set(['package.json', '.vercel/project.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'fly.toml', '.railway/config.json', '.gitignore', '.vercelignore', '.netlifyignore', ...(t.config ? [t.config] : [])])) {
      try { const file = await realpath(path.resolve(root, name)); if (path.relative(root, file).startsWith('..')) continue; if ((await stat(file)).size > 1024 * 1024) throw new SitesError('config_too_large', 'Deployment configuration exceeds 1 MiB.'); configs.push({ name, hash: createHash('sha256').update(await readFile(file)).digest('hex') }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { root, configs };
  }
  async preview(id) {
    const s = await this.store.read(); const t = targetOf(s, id); const c = connection(s, t.connectionId); const evidence = await this.projectEvidence(t); const spec = this.adapters.deploymentSpec(t);
    const preview = { id: randomUUID(), targetId: t.id, project: evidence.root, service: t.service, mode: t.production ? 'production' : ['netlify', 'vercel'].includes(t.service) ? 'preview' : 'configured_target', source: t.service === 'render' ? { kind: 'existing_remote_repository', serviceId: t.serviceId, localUpload: false } : { kind: t.directory ? 'built_assets' : t.prebuilt ? 'prebuilt_output' : 'project', directory: t.directory || (t.prebuilt ? '.vercel/output' : '.'), configurationFiles: evidence.configs.map(c => c.name) }, command: spec.args ? { executable: c.cliPath || service(c.service).cli, argv: spec.args, environmentKeys: t.service === 'vercel' ? ['VERCEL_PROJECT_ID', 'VERCEL_ORG_ID'] : [], before: t.service === 'cloudflare-pages' ? ['wrangler', 'pages', 'deployment', 'list', '--project-name', t.projectName] : undefined } : undefined, request: spec.request, warnings: [service(t.service).notes, 'Provider billing and quotas apply.', ...(t.service !== 'render' ? ['Official CLI selects uploads/ignores and may update local linking files. This is an operation preview, not an exact file inventory.'] : [])], createdAt: new Date().toISOString() };
    await this.store.update(s => { s.previews = [...s.previews.slice(-19), { ...preview, fingerprint: digest({ t, evidence }), target: t }]; }); return { preview };
  }
  async createJob(kind, c, t, perform, externalSignal) {
    const job = { id: randomUUID(), kind, connectionId: c.id, targetId: t?.id, target: t, state: 'running', createdAt: new Date().toISOString() }; const controller = new AbortController(); this.active.set(job.id, controller);
    const cancel = () => controller.abort(); externalSignal?.addEventListener('abort', cancel, { once: true }); if (externalSignal?.aborted) cancel();
    await this.store.update(s => { s.jobs = [...s.jobs.slice(-49), job]; });
    controller.promise = Promise.resolve().then(() => perform(controller.signal, job)).then(async result => { await this.store.update(s => { const j = s.jobs.find(j => j.id === job.id); j.state = kind === 'login' ? 'completed' : result.state; j.result = result; }); }, async error => {
      if (controller.signal.aborted) error = new SitesError('cancelled', kind === 'deploy' ? 'Stopped local waiting; the remote result may be unknown.' : 'The local operation was cancelled.', kind === 'deploy' ? 'Check the provider before deploying again.' : 'Start the operation again when ready.');
      await this.store.update(s => { const j = s.jobs.find(j => j.id === job.id); j.state = kind !== 'deploy' ? error.code === 'cancelled' ? 'cancelled' : 'failed' : ['cancelled', 'timeout', 'offline', 'result_unknown'].includes(error.code) ? 'unknown' : 'failed'; j.error = errorView(error); });
    }).finally(() => { externalSignal?.removeEventListener('abort', cancel); this.active.delete(job.id); });
    return { job: publicJob(job) };
  }
  async login(id) {
    const c = connection(await this.store.read(), id); const args = loginCommand(c);
    if (c.authMode !== 'cli' || !args) throw new SitesError('token_required', 'This connection uses an API token, not browser OAuth.', `Create a token using ${service(c.service).docs}, then save it in Sites.`);
    return this.createJob('login', c, undefined, async (signal, job) => {
      let latest = '';
      await this.adapters.cli(c, args, { signal, timeout: 5 * 60 * 1000, onText: text => {
        latest = (latest + text).slice(-4096); const match = latest.match(/https:\/\/[^\s<>"']+/); const code = latest.match(/(?:one.time code|user code|code:)\s*([A-Z0-9]{4}[- ][A-Z0-9]{4})/i);
        if (match || code) void this.store.update(s => { const j = s.jobs.find(j => j.id === job.id); if (match) { try { const u = new URL(match[0]); const allowed = ['github.com', 'gitlab.com', 'vercel.com', 'app.netlify.com', 'dash.cloudflare.com', 'railway.com', 'railway.app', 'fly.io', ...(c.baseUrl ? [new URL(c.baseUrl).hostname] : [])]; if (allowed.includes(u.hostname)) j.loginUrl = u.href; } catch {} } if (code) j.deviceCode = code[1]; }).catch(() => {});
      } });
      const result = await this.check(c.id, { signal }); if (result.auth.state !== 'valid') throw new SitesError(result.auth.state, result.auth.message, result.auth.recovery); return result;
    });
  }
  async deploy(args, context = {}) {
    context.signal?.throwIfAborted();
    const previewId = args.previewId || (await this.preview(args.id)).preview.id;
    const s = await this.store.read(); const preview = s.previews.find(p => p.id === previewId);
    if (!preview || preview.consumed) throw new SitesError('preview_required', 'Create a fresh deployment preview.');
    const t = targetOf(s, preview.targetId); const c = connection(s, t.connectionId); const evidence = await this.projectEvidence(t);
    if (digest({ t, evidence }) !== preview.fingerprint) throw new SitesError('preview_stale', 'Target or configuration changed since preview.', 'Refresh the target preview.');
    const auth = await this.check(c.id, context); context.signal?.throwIfAborted(); if (auth.auth.state !== 'valid') throw new SitesError(auth.auth.state, auth.auth.message, auth.auth.recovery);
    await this.store.update(s => { const p = s.previews.find(p => p.id === previewId); if (p.consumed) throw new SitesError('preview_used', 'This preview was already deployed.'); connection(s, c.id); p.consumed = true; });
    return this.createJob('deploy', c, t, async (signal, job) => {
      signal.throwIfAborted();
      let result = await this.adapters.deploy(c, t, { signal });
      if (t.service === 'render') {
        for (let poll = 0; result.state === 'submitted' && poll < 400; poll++) {
          await this.store.update(s => { s.jobs.find(j => j.id === job.id).result = result; });
          await delay(this.pollInterval, undefined, { signal });
          result = await this.adapters.status(c, t, result, { signal });
        }
      }
      return result;
    }, context.signal);
  }
  async install(id) {
    const c = connection(await this.store.read(), id, false);
    if (!cliPackages[c.service]) throw new SitesError('external_cli', 'Use the official installer for this CLI.', `See ${service(c.service).docs}.`);
    return this.createJob('install', c, undefined, async signal => {
      const result = await installCli(c.service, this.store.directory, signal, this.installRunner);
      await this.store.update(s => { connection(s, id, false).cliPath = result.cliPath; });
      return { state: 'completed', ...result };
    });
  }
  async action(action, args = {}, context = {}) {
    try {
      let result;
      switch (action) {
        case 'state': result = await this.state(); break;
        case 'guidance': result = { guidance: guidance(await this.store.read()) }; break;
        case 'save_connection': result = await this.saveConnection(args); break;
        case 'install_cli': result = await this.install(args.id); break;
        case 'remove_connection': result = await this.store.update(s => { connection(s, args.id, false); if (s.targets.some(t => t.connectionId === args.id)) throw new SitesError('connection_in_use', 'Remove its deployment targets first.'); s.connections = s.connections.filter(c => c.id !== args.id); return { removed: true }; }); break;
        case 'set_enabled': result = await this.store.update(s => { const c = connection(s, args.id, false); c.enabled = args.enabled === true; return { connection: publicConnection(c), guidance: guidance(s) }; }); break;
        case 'check_auth': result = await this.check(args.id, context); break;
        case 'repositories': result = await this.adapters.repositories(connection(await this.store.read(), args.id), args, context); break;
        case 'save_target': result = await this.saveTarget(args); break;
        case 'remove_target': result = await this.store.update(s => { targetOf(s, args.id); s.targets = s.targets.filter(t => t.id !== args.id); return { removed: true }; }); break;
        case 'preview': result = await this.preview(args.id); break;
        case 'deploy': result = await this.deploy(args, context); break;
        case 'login': result = await this.login(args.id); break;
        case 'cancel_job': { const running = this.active.get(args.id); running?.abort(); await running?.promise; return this.action('job', args); }
        case 'job': { await this.reconcile(); const job = (await this.store.read()).jobs.find(j => j.id === args.id); if (!job) throw new SitesError('job_missing', 'This job no longer exists.'); result = { job: publicJob(job) }; break; }
        case 'deployment_status': {
          const s = await this.store.read(); const job = s.jobs.find(j => j.id === args.jobId);
          if (!job || job.kind !== 'deploy' || !job.result) throw new SitesError('job_not_submitted', 'There is no accepted deployment to check.');
          const c = connection(s, job.connectionId); const current = await this.adapters.status(c, job.target, job.result, context);
          await this.store.update(s => { const j = s.jobs.find(j => j.id === job.id); j.result = current; j.state = current.state; }); return this.action('job', { id: job.id });
        }
        default: throw new SitesError('unknown_action', 'Unsupported Sites action.');
      }
      return { ok: true, ...result };
    } catch (error) { if (context.signal?.aborted && error.name === 'AbortError') error = new SitesError('cancelled', 'The operation was cancelled before submission.', 'Start the operation again when ready.'); return { ok: false, error: errorView(error) }; }
  }
}
