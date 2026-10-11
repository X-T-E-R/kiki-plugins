const field = (key, label, required = true, type = 'string') => ({ key, label, required, type });
const code = (id, label, cli, baseUrl, docs, notes = '') => ({ id, label, kind: 'code', cli, baseUrl, authModes: cli ? ['cli', 'token'] : ['token'], fields: [], docs, notes });
const deploy = (id, label, cli, fields, docs, notes = '') => ({ id, label, kind: 'deploy', cli, authModes: cli ? ['cli', 'token'] : ['token'], fields, docs, notes });
export const catalog = [
  code('github', 'GitHub', 'gh', 'https://api.github.com', 'https://cli.github.com/manual/gh_auth_login', 'GitHub Enterprise hostname supported; code connection does not enable Pages.'),
  code('gitlab', 'GitLab', 'glab', 'https://gitlab.com', 'https://docs.gitlab.com/cli/auth/login/', 'Self-managed GitLab base URL supported.'),
  code('gitea', 'Gitea', null, '', 'https://docs.gitea.com/development/api-usage', 'Supply your HTTPS instance URL and personal access token.'),
  code('forgejo', 'Forgejo', null, '', 'https://forgejo.org/docs/latest/user/api-usage/', 'Supply your HTTPS instance URL and personal access token.'),
  code('gitee', 'Gitee', null, 'https://gitee.com', 'https://gitee.com/api/v5/swagger', 'Personal access token, no instant browser OAuth.'),
  code('bitbucket', 'Bitbucket Cloud', null, 'https://api.bitbucket.org/2.0', 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/', 'API token plus Atlassian email; repository listing needs workspace owner. Data Center API is not this adapter.'),
  deploy('vercel', 'Vercel', 'vercel', [field('projectId', 'Existing project ID'), field('orgId', 'Team / user ID'), field('production', 'Production', false, 'boolean'), field('prebuilt', 'Use .vercel/output', false, 'boolean')], 'https://vercel.com/docs/cli/deploy', 'Uploads project source or prebuilt output; official remote build can run project code. Existing IDs avoid creating an unintended project.'),
  deploy('netlify', 'Netlify', 'netlify', [field('siteId', 'Existing site ID'), field('directory', 'Built publish directory'), field('production', 'Production', false, 'boolean')], 'https://cli.netlify.com/commands/deploy/', 'Deploy built assets with --no-build; functions/redirects follow netlify.toml. Does not run your build command.'),
  deploy('cloudflare-pages', 'Cloudflare Pages', 'wrangler', [field('projectName', 'Existing direct-upload Pages project'), field('branch', 'Deployment branch')], 'https://developers.cloudflare.com/pages/get-started/direct-upload/', 'Set directory to built assets; branch selects production/preview. Wrangler login/account loader reused; no tunnel/account subsystem.'),
  deploy('cloudflare-workers', 'Cloudflare Workers', 'wrangler', [field('config', 'Wrangler config file'), field('environment', 'Wrangler environment', false)], 'https://developers.cloudflare.com/workers/wrangler/commands/#deploy', 'Deploy bundles/assets using your Wrangler configuration; bindings and routes can change. Pages and Workers are separate targets.'),
  deploy('railway', 'Railway', 'railway', [field('projectId', 'Project ID'), field('serviceId', 'Service ID'), field('environment', 'Environment ID / name')], 'https://docs.railway.com/guides/cli', 'Uploads project to an existing service; upstream build may consume billable resources.'),
  deploy('fly', 'Fly.io', 'flyctl', [field('app', 'Existing app name'), field('config', 'fly.toml path')], 'https://fly.io/docs/flyctl/deploy/', 'Deploy/build to an existing app; machines and volumes may incur charges. Does not create app or purchase resources separately.'),
  deploy('render', 'Render', null, [field('serviceId', 'Existing Git-backed service ID')], 'https://api-docs.render.com/reference/create-deploy', 'Triggers the existing service repository deployment, not local upload; configure/push the repository separately.'),
];
catalog.find(s => s.id === 'cloudflare-pages').fields.push(field('directory', 'Built publish directory'));
export function service(id) { const found = catalog.find(s => s.id === id); if (!found) throw new Error('Unsupported service'); return found; }
export const slug = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/.test(value);
export function guidance(state) {
  const enabled = state.connections.filter(c => c.enabled);
  return { schemaVersion: 1, services: enabled.map(c => ({ connectionId: c.id, service: c.service, kind: service(c.service).kind, label: c.label, operations: service(c.service).kind === 'code' ? ['check_auth', 'repositories'] : ['check_auth', 'save_target', 'preview', 'deploy', 'deployment_status'], notes: service(c.service).notes, docs: service(c.service).docs })), instruction: 'Use current enabled connections only. Code hosting is not a deployment. Preview the selected target before publishing; report ready only when provider evidence supports it. Login/token setup is in the Sites panel. Do not invent URLs or retry an unknown submission.' };
}
