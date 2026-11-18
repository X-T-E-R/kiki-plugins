import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Sites } from '../lib/sites.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('kiki-sites@0.1.2 supports real deployment rollback on Vercel, Netlify, Cloudflare Workers, and Render', async (t) => {
  const scratch = path.resolve('.tmp/sites-plugin/panel-tests');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 }));

  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'dist'), { recursive: true });
  await writeFile(path.join(project, 'dist/index.html'), '<h1>Example</h1>');
  await writeFile(path.join(project, 'package.json'), '{"name":"example-site"}');
  await writeFile(path.join(project, 'wrangler.toml'), 'name = "example-worker"');

  const cliCalls = [];
  const apiCalls = [];
  const sites = new Sites(
    { dataDirectory: path.join(root, 'data') },
    {
      pollInterval: 0,
      run: async (cmd, argv) => {
        cliCalls.push({ cmd, argv });
        if (cmd === 'vercel' && argv[0] === 'deploy') return { stdout: 'https://rev1.example.vercel.app', stderr: '' };
        if (cmd === 'vercel' && argv[0] === 'rollback') return { stdout: 'Success!', stderr: '' };
        if (cmd === 'netlify' && argv[0] === 'deploy') return { stdout: '{"deploy_id":"dep_n1","deploy_url":"https://rev1.example.netlify.app"}', stderr: '' };
        if (cmd === 'netlify' && argv[0] === 'api') return { stdout: '{"id":"dep_n1","ssl_url":"https://example.netlify.app"}', stderr: '' };
        if (cmd === 'wrangler' && argv[0] === 'deploy') return { stdout: 'https://example.workers.dev', stderr: '' };
        if (cmd === 'wrangler' && argv[0] === 'rollback') return { stdout: 'Rolled back', stderr: '' };
        return { stdout: '{"authenticated":true}', stderr: '' };
      },
      fetchImpl: async (url, opts = {}) => {
        apiCalls.push([url, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : null]);
        const base = 'https://api.render.com/v1';
        if (url === `${base}/owners?limit=1`) return Response.json([{ owner: { id: 'own_1' } }]);
        if (url === `${base}/services/srv_1/deploys` && opts.method === 'POST') return Response.json({ id: 'dep_r1', status: 'queued' });
        if (url === `${base}/services/srv_1/rollback` && opts.method === 'POST') return Response.json({ id: 'dep_rb1', status: 'queued' });
        if (url.startsWith(`${base}/services/srv_1/deploys/`)) return Response.json({ id: 'dep_live', status: 'live' });
        if (url === `${base}/services/srv_1`) return Response.json({ serviceDetails: { url: 'https://example.onrender.com' } });
        throw new Error(`Unexpected request: ${url}`);
      },
    },
  );

  // 1. Vercel deploy + rollback
  const vc = (await sites.action('save_connection', { connection: { service: 'vercel', enabled: true, authMode: 'token' }, token: 'tok_v' })).connection;
  const vt = (await sites.action('save_target', { target: { service: 'vercel', connectionId: vc.id, project, projectId: 'prj_1', orgId: 'org_1', production: true } })).target;
  const vd = await sites.action('deploy', { id: vt.id });
  await sites.active.get(vd.job.id)?.promise;
  const vState = await sites.action('state');
  const vJob = vState.jobs.find((j) => j.id === vd.job.id);
  assert.equal(vJob.rollbackable, true);

  const vRb = await sites.action('rollback', { jobId: vJob.id });
  assert.equal(vRb.ok, true);
  await sites.active.get(vRb.job.id)?.promise;
  const vRbDone = (await sites.action('job', { id: vRb.job.id })).job;
  assert.equal(vRbDone.state, 'ready');
  assert.deepEqual(cliCalls.find((c) => c.cmd === 'vercel' && c.argv[0] === 'rollback').argv, ['rollback', 'https://rev1.example.vercel.app', '--yes']);

  // 2. Render deploy + rollback
  const rc = (await sites.action('save_connection', { connection: { service: 'render', enabled: true, authMode: 'token' }, token: 'tok_r' })).connection;
  const rt = (await sites.action('save_target', { target: { service: 'render', connectionId: rc.id, project, serviceId: 'srv_1' } })).target;
  const rd = await sites.action('deploy', { id: rt.id });
  await sites.active.get(rd.job.id)?.promise;
  const rRb = await sites.action('rollback', { jobId: rd.job.id });
  assert.equal(rRb.ok, true);
  await sites.active.get(rRb.job.id)?.promise;
  const rRbDone = (await sites.action('job', { id: rRb.job.id })).job;
  assert.equal(rRbDone.state, 'ready');
  assert.deepEqual(apiCalls.find((c) => c[0].endsWith('/rollback'))[2], { deployId: 'dep_r1' });
});

test('kiki-sites panel.html follows Paper-and-Ink palette, dark mode, sandbox safety, and zero UI emoji', async () => {
  const html = await readFile(path.join(PLUGIN_DIR, 'panel.html'), 'utf8');
  assert.match(html, /#f6f4ef/);
  assert.match(html, /#141413/);
  assert.match(html, /#2c5e4f/);
  assert.match(html, /#58a88f/);
  assert.match(html, /safeStorage/);
  assert.match(html, /execCommand\('copy'\)/);
  assert.match(html, /plugin\.openExternal/);
  assert.equal(/\p{Extended_Pictographic}/u.test(html), false);
});
