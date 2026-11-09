import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { loadState } from '../lib/accounts.mjs';
import { migrationStatus, verifyArchiveSample } from '../lib/archive-migration.mjs';

const account = { id: 'sender', preset: 'gmail', user: 'migrate@example.test', watch: true };
const archive = { id: 'archive', preset: 'open-archiver', baseUrl: 'https://archive.example.test' };
const planId = '14d16f9ed28a4c63aa845310920752ce';
const admin = 'fixture-management-key';
const sourceSecret = 'fixture-imap-app-password';

async function harness(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mail-migrate-'));
  const settings = { accounts: JSON.stringify([{ ...account, ...options.account }, archive]), credentials: JSON.stringify({ sender: { password: sourceSecret, refreshToken: 'unused-fixture-refresh' }, archive: { apiKey: 'fixture-read-key' } }) };
  const requests = [];
  const sources = [...(options.sources || [])];
  const service = mailServiceForTests({ archiveFetch: async (url, init) => {
    assert.equal(url.origin, archive.baseUrl);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-API-KEY'], admin);
    assert.equal('Authorization' in init.headers, false);
    requests.push([init.method, url.pathname]);
    if (init.method === 'GET' && url.pathname === '/api/v1/ingestion-sources') return Response.json(sources);
    if (init.method === 'GET' && /^\/api\/v1\/ingestion-sources\/(existing|created)\/stats$/.test(url.pathname)) return Response.json({ mailboxes: [{ userEmail: options.owner || account.user }] });
    if (init.method !== 'POST' || url.pathname !== '/api/v1/ingestion-sources') throw new Error('Unexpected fixture request');
    assert.deepEqual(JSON.parse(init.body), { name: `Kiki Mail: ${account.user}`, provider: 'generic_imap', preserveOriginalFile: true,
      providerConfig: { type: 'generic_imap', host: 'imap.gmail.com', port: 993, secure: true, allowInsecureCert: false, username: account.user, password: sourceSecret } });
    if (options.failedCreate) return Response.json({ providerError: sourceSecret, admin }, { status: 502 });
    const source = { id: 'created', name: `Kiki Mail: ${account.user}`, provider: 'generic_imap', status: 'auth_success', credentials: sourceSecret, syncState: admin };
    sources.push(source);
    return Response.json(source, { status: 201 });
  } });
  const context = { dataDir, settings, async updateSettings(patch) { Object.assign(settings, patch); } };
  await service.activate(context);
  t.after(async () => { await service.deactivate(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, settings, requests, context, async permit(overrides = {}) {
    await mkdir(path.join(dataDir, 'archive-migration'), { recursive: true });
    await writeFile(path.join(dataDir, 'archive-migration', `${planId}.json`), JSON.stringify({ version: 1, archiveAccountId: archive.id, baseUrl: archive.baseUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), accounts: [{ id: account.id, host: 'imap.gmail.com', port: 993, user: account.user }], ...overrides }));
  }, migrate(overrides = {}) { return service.panel('archiveMigrate', { planId, accountId: account.id, adminApiKey: admin, ...overrides }, context); } };
}

test('migration requires a local HTTPS permit bound to the configured archive and original password account', async (t) => {
  const h = await harness(t);
  assert.equal((await h.migrate()).code, 'migration_permit');
  await h.permit({ baseUrl: 'https://unexpected.example.test' });
  assert.equal((await h.migrate()).code, 'migration_mismatch');
  await h.permit({ baseUrl: 'http://localhost:1234' });
  assert.equal((await h.migrate()).code, 'migration_tls_required');
  await h.permit();
  assert.equal((await h.migrate({ accountId: 'another' })).code, 'migration_mismatch');
  assert.equal(h.requests.length, 0);
  const original = h.settings.credentials;
  const result = await h.migrate();
  assert.equal(result.outcome, 'created');
  assert.equal(result.source.id, 'created');
  assert.equal(JSON.stringify(result).includes(sourceSecret), false);
  assert.equal(JSON.stringify(result).includes(admin), false);
  assert.equal(h.settings.credentials, original);
  assert.equal(h.settings.defaultReadAccountId, undefined);
  assert.equal((await h.migrate()).outcome, 'existing');
  assert.equal(h.requests.filter(([method]) => method === 'POST').length, 1);
});

test('migration recognizes an existing mailbox and does not replay an uncertain create', async (t) => {
  const prior = await harness(t, { sources: [{ id: 'existing', name: 'Other local label', provider: 'generic_imap' }] });
  await prior.permit();
  assert.equal((await prior.migrate()).source.id, 'existing');
  assert.equal(prior.requests.some(([method]) => method === 'POST'), false);
  const conflict = await harness(t, { sources: [{ id: 'existing', name: `Kiki Mail: ${account.user}`, provider: 'generic_imap' }], owner: 'another@example.test' });
  await conflict.permit();
  assert.equal((await conflict.migrate()).code, 'migration_reconcile');
  assert.equal(conflict.requests.some(([method]) => method === 'POST'), false);
  const failed = await harness(t, { failedCreate: true });
  await failed.permit();
  const result = await failed.migrate();
  assert.equal(result.code, 'archive_http');
  assert.equal(JSON.stringify(result).includes(sourceSecret), false);
  assert.equal(JSON.stringify(result).includes(admin), false);
  assert.equal((await failed.migrate()).code, 'migration_reconcile');
  assert.equal(failed.requests.filter(([method]) => method === 'POST').length, 1);
});

test('OAuth and opportunistic IMAP TLS credentials are not transferred', async (t) => {
  const oauth = await harness(t, { account: { auth: 'oauth2' } });
  await oauth.permit();
  assert.equal((await oauth.migrate()).code, 'migration_reauthorize');
  assert.equal(oauth.requests.length, 0);
  const insecure = await harness(t, { account: { imapSecure: false } });
  await insecure.permit();
  assert.equal((await insecure.migrate()).code, 'migration_tls_required');
  assert.equal(insecure.requests.length, 0);
});


test('cutover requires indexed history and a verified mailbox after a completed healthy reconnect', () => {
  const requested = '2026-11-09T12:00:00.000Z';
  const mapped = { sourceId: 'created', verifiedAt: requested, verifiedSamples: 2, verifiedAttachments: 1, reconnectRequestedAt: requested };
  const stats = { status: 'active', lastSyncStartedAt: '2026-11-09T12:00:01.000Z', lastSyncFinishedAt: '2026-11-09T12:01:00.000Z',
    totalEmails: 123, indexedCount: 123, mailboxes: [{ userEmail: account.user.toUpperCase() }] };
  assert.deepEqual(migrationStatus(account, mapped, stats), { accountId: 'sender', sourceId: 'created', state: 'active', archived: 123, indexed: 123, reconnected: true, verifiedSamples: 2, verifiedAttachments: 1, ready: true });
  for (const mismatch of [{ status: 'importing' }, { status: 'syncing' }, { status: 'error' }, { indexedCount: 122 }, { mailboxes: [] },
    { lastSyncStartedAt: '2026-11-09T11:59:59.000Z' }, { lastSyncFinishedAt: '2026-11-09T12:00:00.000Z' }]) {
    assert.equal(migrationStatus(account, mapped, { ...stats, ...mismatch }).ready, false);
  }
  assert.equal(migrationStatus(account, { ...mapped, verifiedSamples: 0 }, stats).ready, false);
});

test('migration sample compares mapped source, body, date and MIME attachment bytes under EXAMINE', async (t) => {
  const h = await harness(t);
  await h.permit({ sources: { sender: { sourceId: 'created' } } });
  const state = loadState(h.settings);
  const id = '<compare@example.test>';
  const raw = Buffer.from(['From: sender@example.test', 'To: migrate@example.test', 'Subject: Fixture', 'Date: Mon, 09 Nov 2026 12:00:00 +0000',
    `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=fixture', '', '--fixture', 'Content-Type: text/plain', '',
    'sample text', '--fixture', 'Content-Type: application/octet-stream; name=sample.bin', 'Content-Disposition: attachment; filename=sample.bin',
    'Content-Transfer-Encoding: base64', '', 'YWJj', '--fixture--', ''].join('\r\n'));
  let owner = account.user;
  let direct = raw;
  let imapOpens = 0;
  const options = {
    async fetch(url, init) {
      assert.equal(url.href, `${archive.baseUrl}/api/v1/archived-emails/archived-sample`);
      assert.equal(init.headers['X-API-KEY'], 'fixture-read-key');
      return Response.json({ id: 'archived-sample', ingestionSourceId: 'created', userEmail: owner, raw });
    },
    createClient(_, auth) {
      assert.equal(auth.pass, sourceSecret);
      return { secureConnection: true, async connect() {}, async logout() {}, async list() { return [{ path: 'INBOX' }]; },
        async mailboxOpen(path, flags) { assert.equal(path, 'INBOX'); assert.deepEqual(flags, { readOnly: true }); imapOpens++; },
        async search(query, flags) { assert.deepEqual(query, { header: { 'Message-ID': id } }); assert.deepEqual(flags, { uid: true }); return [7]; },
        async *fetch(range, query, flags) { assert.equal(range, '7'); assert.deepEqual(query, { source: true }); assert.deepEqual(flags, { uid: true }); yield { source: direct }; },
      };
    },
  };
  const verify = () => verifyArchiveSample(state, h.context.dataDir, { planId, accountId: 'sender', archiveId: 'archived-sample' }, options,
    async () => ({ user: account.user, pass: sourceSecret }));
  assert.deepEqual(await verify(), { ok: true, verified: true, accountId: 'sender', sourceId: 'created', attachmentCount: 1 });
  direct = Buffer.from(raw.toString().replace('YWJj', 'YWJi'));
  await assert.rejects(verify(), { code: 'migration_mismatch', message: /attachment bytes/ });
  owner = 'another@example.test';
  await assert.rejects(verify(), { code: 'migration_mismatch', message: /mailbox owner/ });
  assert.equal(imapOpens, 2);
});
