import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CloudflareService } from '../lib/service.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZONE_ID = '0123456789abcdef0123456789abcdef';
const REC_1 = 'fedcba9876543210fedcba9876543210';
const REC_2 = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';

test('kiki-cloudflare@0.1.3 manages Zones, DNS records, and Worker routes via Cloudflare v4 API without leaking apiToken', async (t) => {
  const scratch = path.resolve('.tmp/cloudflare-plugin/panel-tests');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 }));

  const records = [
    {
      id: REC_1,
      type: 'A',
      name: 'api.example.com',
      content: '203.0.113.10',
      proxied: true,
      proxiable: true,
      ttl: 1,
      modified_on: '2026-11-18T00:00:00Z',
    },
  ];

  const api = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer cf_test_token_redacted');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;

    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url.startsWith('/client/v4/zones?')) {
      res.end(JSON.stringify({
        success: true,
        result: [{ id: ZONE_ID, name: 'example.com', status: 'active', plan: { name: 'Free Website' } }],
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith(`/client/v4/zones/${ZONE_ID}/dns_records`)) {
      res.end(JSON.stringify({ success: true, result: records }));
      return;
    }
    if (req.method === 'GET' && req.url === `/client/v4/zones/${ZONE_ID}/workers/routes`) {
      res.end(JSON.stringify({
        success: true,
        result: [{ id: 'rt_1', pattern: 'api.example.com/*', script: 'edge-gateway' }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === `/client/v4/zones/${ZONE_ID}/dns_records`) {
      const created = {
        id: REC_2,
        type: body.type,
        name: body.name,
        content: body.content,
        proxied: Boolean(body.proxied),
        proxiable: true,
        ttl: body.ttl || 1,
      };
      records.push(created);
      res.end(JSON.stringify({ success: true, result: created }));
      return;
    }
    if (req.method === 'PATCH' && req.url === `/client/v4/zones/${ZONE_ID}/dns_records/${REC_1}`) {
      records[0] = { ...records[0], proxied: Boolean(body.proxied), content: body.content };
      res.end(JSON.stringify({ success: true, result: records[0] }));
      return;
    }
    if (req.method === 'DELETE' && req.url === `/client/v4/zones/${ZONE_ID}/dns_records/${REC_2}`) {
      const idx = records.findIndex((r) => r.id === REC_2);
      if (idx !== -1) records.splice(idx, 1);
      res.end(JSON.stringify({ success: true, result: { id: REC_2 } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, errors: [{ message: `unexpected ${req.method} ${req.url}` }] }));
  });

  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => api.close());
  const port = api.address().port;

  const service = new CloudflareService({
    commandFn: async () => 'cloudflared version 2026.10.0',
    fetchFn: (url, opts) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, 'https://api.cloudflare.com');
      return fetch(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, opts);
    },
  });
  t.after(() => service.deactivate());

  const stored = { apiToken: 'cf_test_token_redacted', autoStart: false };
  await service.activate({
    settings: stored,
    userHome: root,
    dataDir: path.join(root, 'data'),
    updateSettings: async (patch) => Object.assign(stored, patch),
  });

  const st = await service.panel('status');
  assert.equal(JSON.stringify(st).includes('cf_test_token_redacted'), false);
  assert.equal(st.account.apiToken, true);

  const zonesRes = await service.panel('zones');
  assert.equal(zonesRes.items.length, 1);
  assert.equal(zonesRes.items[0].name, 'example.com');

  const overview = await service.panel('zoneOverview', { zoneId: ZONE_ID });
  assert.equal(overview.records.length, 1);
  assert.equal(overview.workerRoutes.supported, true);
  assert.equal(overview.workerRoutes.items[0].script, 'edge-gateway');

  const created = await service.panel('saveDnsRecord', {
    zoneId: ZONE_ID,
    record: { type: 'CNAME', name: 'docs.example.com', content: 'example.pages.dev', proxied: true, ttl: 1 },
  });
  assert.equal(created.record.id, REC_2);
  assert.equal(created.record.proxied, true);

  const toggled = await service.panel('saveDnsRecord', {
    zoneId: ZONE_ID,
    record: { id: REC_1, type: 'A', name: 'api.example.com', content: '203.0.113.10', proxied: false, ttl: 1 },
  });
  assert.equal(toggled.record.proxied, false);

  const del = await service.panel('deleteDnsRecord', { zoneId: ZONE_ID, recordId: REC_2 });
  assert.equal(del.deleted, true);
  assert.equal(records.length, 1);
});

test('kiki-cloudflare panel.html follows Paper-and-Ink palette, sandbox safety, and zero UI emoji', async () => {
  const html = await readFile(path.join(PLUGIN_DIR, 'panel.html'), 'utf8');
  assert.match(html, /#f6f4ef/);
  assert.match(html, /#141413/);
  assert.match(html, /#2c5e4f/);
  assert.match(html, /#58a88f/);
  assert.match(html, /safeStorage/);
  assert.match(html, /execCommand\('copy'\)/);
  assert.match(html, /plugin\.openExternal/);
  assert.match(html, /statusInFlight/);
  assert.match(html, /if \(pageUnloaded \|\| installing\) return/);
  assert.match(html, /addEventListener\('pagehide'/);
  assert.equal(/\p{Extended_Pictographic}/u.test(html), false);
});

test('CloudflareAccount caps pagination at 100 pages, cancels non-OK bodies, and CloudflareService deactivates on context.signal abort', async (t) => {
  const { CloudflareAccount } = await import('../lib/account.mjs');
  let canceled = 0;
  let pages = 0;
  const errAccount = new CloudflareAccount({ apiToken: 'tok' }, {
    fetchFn: async () => new Response(new ReadableStream({ pull() {}, cancel() { canceled += 1; } }), { status: 500 }),
  });
  await assert.rejects(() => errAccount.request('/zones'), /HTTP 500/);
  assert.equal(canceled, 1);

  const pagedAccount = new CloudflareAccount({ apiToken: 'tok' }, {
    fetchFn: async () => {
      pages += 1;
      return Response.json({ success: true, result: [{ id: `z-${pages}`, name: `z${pages}.example.test` }], result_info: { total_pages: 500 } });
    },
  });
  const list = await pagedAccount.list('/zones');
  assert.equal(pages, 100);
  assert.equal(list.length, 100);

  const scratch = path.resolve('.tmp/cloudflare-plugin/signal-tests');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 }));
  const ac = new AbortController();
  const service = new CloudflareService({ commandFn: async () => 'cloudflared version 2026.10.0' });
  await service.activate({
    settings: { autoStart: false },
    userHome: root,
    dataDir: path.join(root, 'data'),
    signal: ac.signal,
    updateSettings: async () => {},
  });
  assert.equal(service.closed, false);
  ac.abort();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(service.closed, true);
});
