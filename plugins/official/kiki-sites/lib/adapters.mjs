import path from 'node:path';
import { access } from 'node:fs/promises';
import { cliPackages } from './installer.mjs';
import { service } from './catalog.mjs';
import { run, request, SitesError } from './runtime.mjs';

export function cliEnvironment(connection) {
  const env = {};
  if (connection.token && connection.authMode === 'token') {
    const name = { github: connection.baseUrl === 'https://api.github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN', gitlab: 'GITLAB_TOKEN', vercel: 'VERCEL_TOKEN', netlify: 'NETLIFY_AUTH_TOKEN', 'cloudflare-pages': 'CLOUDFLARE_API_TOKEN', 'cloudflare-workers': 'CLOUDFLARE_API_TOKEN', railway: 'RAILWAY_API_TOKEN', fly: 'FLY_API_TOKEN' }[connection.service];
    if (name) env[name] = connection.token;
    if (connection.service === 'railway') env.RAILWAY_TOKEN = undefined;
    if (connection.service === 'fly') env.FLY_ACCESS_TOKEN = connection.token;
  }
  if (connection.service === 'github' && connection.baseUrl !== 'https://api.github.com') env.GH_HOST = new URL(connection.baseUrl).hostname;
  if (connection.service === 'gitlab') env.GITLAB_HOST = new URL(connection.baseUrl).hostname;
  if (connection.accountId && connection.service.startsWith('cloudflare-')) env.CLOUDFLARE_ACCOUNT_ID = connection.accountId;
  return env;
}
export function loginCommand(c) {
  const host = c.baseUrl ? new URL(c.baseUrl).hostname : undefined;
  return { github: ['auth', 'login', '--hostname', host === 'api.github.com' ? 'github.com' : host, '--web', '--git-protocol', 'https'], gitlab: ['auth', 'login', '--hostname', host, '--web'], vercel: ['login'], netlify: ['login'], 'cloudflare-pages': ['login'], 'cloudflare-workers': ['login'], railway: ['login', '--browserless'], fly: ['auth', 'login'] }[c.service];
}
export function authCommand(c) {
  return { github: ['api', 'user'], gitlab: ['api', 'user'], vercel: ['whoami'], netlify: ['api', 'getCurrentUser'], 'cloudflare-pages': ['whoami', '--json'], 'cloudflare-workers': ['whoami', '--json'], railway: ['whoami', '--json'], fly: ['auth', 'whoami'] }[c.service];
}
export function invocation(c, args) {
  return { command: c.cliPath || service(c.service).cli, args, env: cliEnvironment(c), secrets: [c.token] };
}
const parseJson = text => { try { return JSON.parse(text); } catch { throw new SitesError('invalid_cli_output', 'The official CLI returned unexpected data.', 'Check the documented compatible CLI and retry.'); } };
export class Adapters {
  constructor(deps = {}) { this.run = deps.run || run; this.fetchImpl = deps.fetchImpl || fetch; this.dataDirectory = deps.dataDirectory; }
  async cli(c, args, context = {}) {
    context.signal?.throwIfAborted();
    const pkg = cliPackages[c.service];
    if (!c.cliPath && pkg && this.dataDirectory) {
      const entry = path.join(this.dataDirectory, 'cli', `${pkg.package}-${pkg.version}`, 'node_modules', pkg.package, pkg.entry);
      if (await access(entry).then(() => true, () => false)) c = { ...c, cliPath: entry };
    }
    context.signal?.throwIfAborted();
    const spec = invocation(c, args); return this.run(spec.command, spec.args, { ...spec, ...context });
  }
  async api(c, suffix, context = {}) {
    let base = c.baseUrl || service(c.service).baseUrl;
    if (['gitea', 'forgejo'].includes(c.service)) base += '/api/v1';
    if (c.service === 'gitee') base += '/api/v5';
    if (c.service === 'gitlab') base += '/api/v4';
    if (c.service === 'render') base = 'https://api.render.com/v1';
    if (c.service === 'github' && base !== 'https://api.github.com') base += '/api/v3';
    return request(`${base.replace(/\/$/, '')}${suffix}`, { token: c.token, username: c.service === 'bitbucket' ? c.username : undefined, ...(['gitea', 'forgejo'].includes(c.service) ? { headers: { Authorization: `token ${c.token}` } } : {}), ...context, fetchImpl: this.fetchImpl });
  }
  async check(c, context = {}) {
    if (c.authMode === 'token' && !c.token) throw new SitesError('not_logged_in', 'No API token has been saved.', 'Save a token in the Sites panel.');
    if (service(c.service).cli && !(service(c.service).kind === 'code' && c.authMode === 'token')) {
      const result = await this.cli(c, authCommand(c), { ...context, timeout: 45000 });
      if (/not logged|not authenticated|not logged in/i.test(result.stdout + result.stderr)) throw new SitesError('not_logged_in', 'The official CLI has no usable local login.', 'Use Sign in in the Sites panel.');
      return;
    }
    await this.api(c, c.service === 'render' ? '/owners?limit=1' : '/user', context);
  }
  async repositories(c, { owner, page = 1 } = {}, context = {}) {
    const q = n => encodeURIComponent(n); let endpoint;
    if (c.service === 'github') endpoint = owner ? `/orgs/${q(owner)}/repos?per_page=30&page=${page}` : `/user/repos?per_page=30&page=${page}`;
    if (c.service === 'gitlab') endpoint = `/projects?membership=true&per_page=30&page=${page}`;
    if (['gitea', 'forgejo'].includes(c.service)) endpoint = owner ? `/users/${q(owner)}/repos?limit=30&page=${page}` : `/user/repos?limit=30&page=${page}`;
    if (c.service === 'gitee') endpoint = owner ? `/users/${q(owner)}/repos?per_page=30&page=${page}` : `/user/repos?per_page=30&page=${page}`;
    if (c.service === 'bitbucket') { if (!owner) throw new SitesError('input_required', 'Select a Bitbucket workspace.', 'Enter the workspace slug in Owner.'); endpoint = `/repositories/${q(owner)}?pagelen=30&page=${page}`; }
    if (!endpoint) throw new SitesError('wrong_kind', 'This is not a code hosting connection.');
    let payload;
    if (c.authMode === 'cli') payload = parseJson((await this.cli(c, ['api', endpoint.slice(1)], context)).stdout);
    else payload = await this.api(c, endpoint, context);
    const list = Array.isArray(payload) ? payload : payload.values || [];
    return { repositories: list.map(r => ({ id: String(r.id ?? r.uuid), name: r.full_name || r.path_with_namespace || r.name, url: r.html_url || r.web_url || r.links?.html?.href, cloneUrl: r.clone_url || r.http_url_to_repo || r.links?.clone?.find(l => l.name === 'https')?.href, private: r.private ?? r.is_private ?? r.visibility !== 'public' })), nextPage: (Array.isArray(payload) ? list.length === 30 : Boolean(payload.next)) ? page + 1 : null };
  }
  deploymentSpec(t) {
    const args = {
      vercel: ['deploy', '--project', t.projectId, '--yes', '--non-interactive', ...(t.production ? ['--prod'] : []), ...(t.prebuilt ? ['--prebuilt'] : [])],
      netlify: ['deploy', '--site', t.siteId, '--dir', t.directory, '--no-build', '--json', ...(t.production ? ['--prod'] : [])],
      'cloudflare-pages': ['pages', 'deploy', t.directory, '--project-name', t.projectName, '--branch', t.branch],
      'cloudflare-workers': ['deploy', '--config', t.config, ...(t.environment ? ['--env', t.environment] : [])],
      railway: ['up', '--project', t.projectId, '--service', t.serviceId, '--environment', t.environment, '--json'],
      fly: ['deploy', '--app', t.app, '--config', t.config, '--yes'],
    }[t.service];
    return args ? { args } : { request: { method: 'POST', path: `/services/${encodeURIComponent(t.serviceId)}/deploys`, body: { clearCache: 'do_not_clear' } } };
  }
  async deploy(c, target, context = {}) {
    if (target.service === 'render') {
      const data = await this.api(c, this.deploymentSpec(target).request.path, { ...context, method: 'POST', body: { clearCache: 'do_not_clear' } });
      return { state: 'submitted', remoteId: data.id, remoteStatus: data.status, source: 'existing_remote_repository', message: 'Render accepted the build. Check deployment status to confirm readiness.' };
    }
    const spec = this.deploymentSpec(target);
    const env = { ...cliEnvironment(c), ...(target.service === 'vercel' ? { VERCEL_PROJECT_ID: target.projectId, VERCEL_ORG_ID: target.orgId } : {}) };
    if (target.service === 'cloudflare-pages') {
      await this.cli(c, ['pages', 'deployment', 'list', '--project-name', target.projectName], { ...context, cwd: target.project, env });
    }
    const result = await this.cli(c, spec.args, { ...context, cwd: target.project, env });
    if (target.service === 'netlify') {
      const data = parseJson(result.stdout);
      return { state: data.deploy_url || data.url ? 'ready' : 'completed_without_url', url: data.deploy_url || data.url, remoteId: data.deploy_id, message: 'Official Netlify CLI completed its deploy.' };
    }
    if (target.service === 'railway') {
      const objects = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const final = objects.findLast(item => ['success', 'failed', 'crashed', 'unknown', 'queued'].includes(item.status));
      if (!final) return { state: 'unknown', message: 'Railway did not return a final deployment status. Check its dashboard before retrying.' };
      return { state: final.status === 'success' ? final.url ? 'ready' : 'completed_without_url' : final.status === 'queued' ? 'submitted' : final.status === 'unknown' ? 'unknown' : 'failed', remoteStatus: final.status, deploymentSucceeded: final.status === 'success', remoteId: final.deploymentId, url: final.url || undefined, message: final.status === 'success' && !final.url ? 'Railway reports success. This existing service returned no public URL; Sites did not create a domain.' : `Railway reports ${final.status}.` };
    }
    const text = target.service === 'vercel' ? result.stdout : `${result.stdout}\n${result.stderr}`;
    const urls = text.match(/https:\/\/[^\s<>"'\u001b)]+/g) || [];
    const url = urls.find(url => {
      try { const hostname = new URL(url).hostname; return { vercel: hostname.endsWith('.vercel.app'), 'cloudflare-pages': hostname.endsWith('.pages.dev'), 'cloudflare-workers': hostname.endsWith('.workers.dev'), fly: hostname.endsWith('.fly.dev') }[target.service]; } catch { return false; }
    });
    return { state: url ? 'ready' : 'completed_without_url', url, message: url ? 'Official CLI completed and returned a deployment URL.' : 'Official CLI completed but supplied no verified deployment URL. Check its dashboard; no URL was invented.' };
  }
  async status(c, target, result, context = {}) {
    if (target.service !== 'render') return result;
    if (!result.remoteId) throw new SitesError('missing_remote_id', 'The provider response did not include a deployment ID.', 'Inspect the service dashboard; do not blindly redeploy.');
    const deploy = await this.api(c, `/services/${encodeURIComponent(target.serviceId)}/deploys/${encodeURIComponent(result.remoteId)}`, context);
    const state = deploy.status === 'live' ? 'ready' : ['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(deploy.status) ? 'failed' : 'submitted';
    let url;
    if (state === 'ready') { const data = await this.api(c, `/services/${encodeURIComponent(target.serviceId)}`, context); url = data.serviceDetails?.url; }
    return { ...result, state, remoteStatus: deploy.status, url, message: state === 'ready' ? 'Render reports this deployment is live.' : `Render status: ${deploy.status}` };
  }
}
