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
const connectionRejection = (status = 400) => Response.json({ message: `IMAP Connection Error: rejected ${sourceSecret} ${admin}` }, { status });

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
    if (init.method === 'GET' && url.pathname === '/api/v1/ingestion-sources') return options.listSources?.(sources) ?? Response.json(sources);
    if (init.method === 'GET' && /^\/api\/v1\/ingestion-sources\/(existing|created)\/stats$/.test(url.pathname)) return Response.json({ mailboxes: [{ userEmail: options.owner || account.user }] });
    if (init.method !== 'POST' || url.pathname !== '/api/v1/ingestion-sources') throw new Error('Unexpected fixture request');
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { name: `Kiki Mail: ${account.user}`, provider: 'generic_imap', preserveOriginalFile: true,
      providerConfig: { type: 'generic_imap', host: 'imap.gmail.com', port: 993, secure: true, allowInsecureCert: false, username: account.user, password: JSON.parse(settings.credentials).sender.password } });
    if (options.createResponse) {
      const response = await options.createResponse(body, sources);
      if (response) return response;
    }
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
  const failed = await harness(t, { createResponse: () => connectionRejection(502) });
  await failed.permit();
  const result = await failed.migrate();
  assert.equal(result.code, 'archive_http');
  assert.equal(JSON.stringify(result).includes(sourceSecret), false);
  assert.equal(JSON.stringify(result).includes(admin), false);
  assert.equal((await failed.migrate()).code, 'migration_reconcile');
  assert.equal(failed.requests.filter(([method]) => method === 'POST').length, 1);

  const committed = await harness(t, { createResponse(body, sources) {
    sources.push({ id: 'existing', name: body.name, provider: 'generic_imap' });
    return connectionRejection(502);
  } });
  await committed.permit();
  assert.equal((await committed.migrate()).code, 'archive_http');
  assert.equal((await committed.migrate()).outcome, 'existing');
  assert.equal(committed.requests.filter(([method]) => method === 'POST').length, 1);
});

test('confirmed connection rollback releases the create lock only after source reconciliation', async (t) => {
  const attempted = Promise.withResolvers();
  const rejected = Promise.withResolvers();
  const corrected = 'fixture-corrected-app-password';
  const attemptedPasswords = [];
  const h = await harness(t, { async createResponse(body) {
    const password = body.providerConfig.password;
    attemptedPasswords.push(password);
    if (password !== sourceSecret) return;
    attempted.resolve();
    return rejected.promise;
  } });
  await h.permit();
  const first = h.migrate();
  await attempted.promise;
  try {
    assert.equal((await h.migrate()).code, 'migration_reconcile');
    assert.deepEqual(attemptedPasswords, [sourceSecret]);
  } finally { rejected.resolve(connectionRejection()); }
  const refusal = await first;
  assert.equal(refusal.code, 'migration_source_rejected');
  assert.doesNotMatch(JSON.stringify(refusal), /IMAP Connection Error|fixture-imap-app-password|fixture-management-key/);
  assert.deepEqual(h.requests.map(([method]) => method), ['GET', 'POST', 'GET', 'GET']);

  const updated = await h.service.panel('save', { account, credential: { password: corrected } }, h.context);
  assert.equal(updated.ok, true);
  assert.equal((await h.migrate()).outcome, 'created');
  assert.equal((await h.migrate()).outcome, 'existing');
  assert.deepEqual(attemptedPasswords, [sourceSecret, corrected]);
});

test('unrecognized 400 and unconfirmed rollback reconciliation both keep the create lock', async (t) => {
  const invalid = await harness(t, { createResponse: () => Response.json({ message: 'Failed to create ingestion source.' }, { status: 400 }) });
  await invalid.permit();
  assert.equal((await invalid.migrate()).code, 'archive_http');
  assert.equal((await invalid.migrate()).code, 'migration_reconcile');
  assert.equal(invalid.requests.filter(([method]) => method === 'POST').length, 1);

  let sourceLists = 0;
  const unreachable = await harness(t, { createResponse: () => connectionRejection(), listSources(sources) {
    return ++sourceLists === 2 ? new Response('proxy failed', { status: 502 }) : Response.json(sources);
  } });
  await unreachable.permit();
  assert.equal((await unreachable.migrate()).code, 'migration_reconcile');
  assert.equal((await unreachable.migrate()).code, 'migration_reconcile');
  assert.equal(unreachable.requests.filter(([method]) => method === 'POST').length, 1);
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

test('EXAMINE sample verification compares original EML and detached OA attachment multisets', async (t) => {
  const h = await harness(t);
  await h.permit({ sources: { sender: { sourceId: 'existing' } } });
  const state = loadState(h.settings);
  const id = '<compare@example.test>';
  const file = { filename: 'sample.bin', mimeType: 'application/octet-stream', content: Buffer.from('abc') };
  const inline = { filename: 'logo.png', mimeType: 'image/png', content: Buffer.from('png fixture'), inline: true };
  const message = (parts) => Buffer.from(['From: sender@example.test', 'To: migrate@example.test', 'Subject: Fixture', 'Date: Mon, 09 Nov 2026 12:00:00 +0000',
    `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=fixture', '', '--fixture', 'Content-Type: text/plain', '', 'sample text',
    ...parts.flatMap((part) => ['--fixture', `Content-Type: ${part.mimeType}; name="${part.filename}"`, `Content-Disposition: ${part.inline ? 'inline' : 'attachment'}; filename="${part.filename}"`,
      ...(part.inline ? ['Content-ID: <fixture-logo>'] : []), 'Content-Transfer-Encoding: base64', '', part.content.toString('base64')]), '--fixture--', ''].join('\r\n'));
  const storedPart = (part, key) => ({ id: key, filename: part.filename, mimeType: part.mimeType, sizeBytes: part.content.length, storagePath: `fixture/${key}` });
  let owner = account.user;
  let direct = message([file]);
  let archived = direct;
  let attachments = [];
  const storage = new Map([['fixture/file', file.content], ['fixture/inline', inline.content], ['fixture/another', file.content]]);
  let imapOpens = 0;
  const downloads = [];
  const options = {
    async fetch(url, init) {
      assert.equal(url.origin, archive.baseUrl);
      assert.equal(init.headers['X-API-KEY'], 'fixture-read-key');
      assert.equal(init.method, 'GET');
      if (url.pathname === '/api/v1/archived-emails/archived-sample') return Response.json({ id: 'archived-sample', ingestionSourceId: 'existing', userEmail: owner, raw: archived, attachments });
      assert.equal(url.pathname, '/api/v1/storage/download');
      const key = url.searchParams.get('path');
      assert.ok(attachments.some((part) => part.storagePath === key));
      assert.ok(storage.has(key));
      downloads.push(key);
      return new Response(storage.get(key));
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
  const passes = async (count) => assert.deepEqual(await verify(), { ok: true, verified: true, accountId: 'sender', sourceId: 'existing', attachmentCount: count });
  const rejects = () => assert.rejects(verify(), { code: 'migration_mismatch', message: /attachments/ });

  await passes(1); // preserveOriginalFile:true, no independent attachment records.
  direct = message([{ ...file, content: Buffer.from('abd') }]);
  await rejects();
  direct = message([file]);
  archived = message([]); // Default mode removes non-inline parts, with no placeholders.
  attachments = [storedPart(file, 'file')];
  await passes(1);
  assert.deepEqual(downloads, ['fixture/file']);
  attachments = [];
  await rejects();
  attachments = [storedPart(file, 'file')];
  storage.set('fixture/file', Buffer.from('abd'));
  await rejects();
  storage.set('fixture/file', file.content);
  attachments = [{ ...storedPart(file, 'file'), filename: 'another.bin' }];
  await rejects();
  attachments = [{ ...storedPart(file, 'file'), mimeType: 'text/plain' }];
  await rejects();
  attachments = [storedPart(file, 'file'), storedPart(file, 'another')];
  await rejects();
  direct = message([file, file]);
  await passes(2);
  attachments = [storedPart(file, 'file')];
  await rejects();

  direct = message([inline, file]);
  archived = message([inline]);
  attachments = [storedPart(file, 'file'), storedPart(inline, 'inline')]; // Storage order is not MIME order; the inline part appears twice.
  await passes(2);
  attachments = [storedPart(file, 'file')];
  await rejects();
  attachments = [storedPart(file, 'file'), storedPart(inline, 'inline')];
  archived = direct; // OA also retains all MIME parts when stripping fails.
  await passes(2);
  archived = message([{ ...inline, content: Buffer.from('changed inline bytes') }, file]);
  await rejects();

  owner = 'another@example.test';
  const before = imapOpens;
  await assert.rejects(verify(), { code: 'migration_mismatch', message: /mailbox owner/ });
  assert.equal(imapOpens, before);
});
