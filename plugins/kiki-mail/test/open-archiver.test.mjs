import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { startFixture as startMailFixture } from './fixture.mjs';
import { FIXTURE_API_KEY, guardedLoopbackFetch, startOpenArchiverFixture } from './open-archiver-fixture.mjs';

const API_KEY = FIXTURE_API_KEY;

async function harness({ fixture = {}, timeoutMs = 2_000 } = {}) {
  const fx = await startOpenArchiverFixture(fixture);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-open-archiver-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const context = {
    settings,
    dataDir,
    workspaceRoot: dataDir,
    approvedPaths: [],
    async updateSettings(patch) { Object.assign(settings, patch); },
  };
  const service = mailServiceForTests({ archiveFetch: guardedLoopbackFetch(fx) });
  await service.activate(context);
  return {
    fx, dataDir, settings, context, service, timeoutMs,
    async saveArchive({ id = 'archive', credential, timeout = timeoutMs } = {}) {
      const account = { id, label: `Fixture ${id}`, preset: 'open-archiver', baseUrl: fx.baseUrl, timeoutMs: timeout };
      return service.panel('save', { account, ...(credential === undefined ? {} : { credential }) }, context);
    },
    async stop() {
      await service.deactivate();
      await fx.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function tool(active, name, args, context = active.context) {
  const result = await active.service.tool(name, args, context);
  return { isError: result.isError === true, body: JSON.parse(result.output) };
}

async function waitFor(check, label, timeoutMs = 4_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assertWithin(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  assert.notEqual(relative, '');
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`), false, `${file} escaped ${root}`);
}

test('Open Archiver HTTP auth, source metadata, empty browse, filters, and scoped pagination', { timeout: 20_000 }, async () => {
  const active = await harness();
  try {
    const saved = await active.saveArchive({ credential: { apiKey: API_KEY } });
    assert.equal(saved.ok, true);
    assert.deepEqual(
      (({ id, label, preset, baseUrl, timeoutMs }) => ({ id, label, preset, baseUrl, timeoutMs }))(saved.account),
      { id: 'archive', label: 'Fixture archive', preset: 'open-archiver', baseUrl: active.fx.baseUrl, timeoutMs: 2_000 },
    );
    assert.deepEqual(JSON.parse(active.settings.credentials), { archive: { apiKey: API_KEY } });
    assert.equal(saved.account.credentialStored, true);
    assert.equal(saved.account.hasApiKey, true);
    assert.equal(JSON.stringify(saved).includes(API_KEY), false);

    const tested = await active.service.panel('test', { accountId: 'archive' }, active.context);
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.equal(tested.authenticated, true);
    assert.equal(tested.auth, 'apiKey');
    assert.equal(tested.capabilities.send, false);
    assert.equal(tested.capabilities.read, true);
    assert.equal(tested.message.includes('Read-only'), true);
    assert.equal(active.fx.state.requests.filter((request) => request.status === 200).every((request) => request.apiKey === API_KEY && request.authorization === ''), true);

    await active.saveArchive({ id: 'missing-key', credential: {} });
    const beforeMissing = active.fx.state.requests.length;
    const missingKey = await active.service.panel('test', { accountId: 'missing-key' }, active.context);
    assert.equal(missingKey.code, 'auth_missing');
    assert.equal(active.fx.state.requests.length, beforeMissing, 'a missing local key must not make an HTTP request');

    await active.saveArchive({ id: 'wrong-key', credential: { apiKey: 'fixture-wrong-api-key' } });
    const wrongKey = await active.service.panel('test', { accountId: 'wrong-key' }, active.context);
    assert.equal(wrongKey.code, 'auth_failed');
    assert.equal(wrongKey.message.includes('fixture-wrong-api-key'), false);
    const wrongKeyRequest = active.fx.state.requests.at(-1);
    assert.equal(wrongKeyRequest.status, 401);
    assert.equal(wrongKeyRequest.apiKey, 'fixture-wrong-api-key');
    assert.equal(wrongKeyRequest.authorization, '', 'Open Archiver requests use the API key header without Basic Authorization');

    const sourceList = await tool(active, 'Mailbox', { action: 'sources' });
    assert.equal(sourceList.isError, false, JSON.stringify(sourceList.body));
    assert.equal(sourceList.body.accountId, 'archive');
    assert.deepEqual(sourceList.body.sources, [
      { id: 'source-alpha', name: 'Fixture archive alpha', provider: 'generic_imap', status: 'active', lastSyncStartedAt: '2026-11-08T11:59:00.000Z', lastSyncFinishedAt: '2026-11-08T12:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'source-beta', name: 'Fixture archive beta', provider: 'eml_import', status: 'imported', lastSyncStartedAt: '2026-11-07T11:59:00.000Z', lastSyncFinishedAt: '2026-11-07T12:00:00.000Z', createdAt: '2026-11-02T00:00:00.000Z' },
    ]);
    assert.equal('lastSyncStatusMessage' in sourceList.body.sources[0], false, 'free-text sync diagnostics are not exposed');
    assert.equal(JSON.stringify(sourceList).includes('fixture-poison-value'), false, 'credentials and sync state from source-list responses are not exposed');

    const first = await tool(active, 'Mailbox', { action: 'search', limit: 1 });
    assert.equal(first.isError, false, JSON.stringify(first.body));
    assert.equal(first.body.accountId, 'archive');
    assert.equal(first.body.total, 3);
    assert.equal(first.body.totalPages, 3);
    assert.equal(first.body.page, 1);
    assert.equal(first.body.messages.length, 1);
    assert.equal(first.body.messages[0].archiveId, 'archive-001');
    assert.equal(first.body.messages[0].provider, 'open-archiver');
    assert.equal(first.body.messages[0].sourceId, 'source-alpha');
    assert.equal(first.body.messages[0].mailboxOwner, 'owner-alpha@example.test');
    assert.equal(first.body.messages[0].date, new Date(Date.UTC(2026, 10, 9, 12)).toISOString());
    assert.equal('uid' in first.body.messages[0], false);
    assert.equal('uidValidity' in first.body.messages[0], false);
    const emptyBrowseSearch = active.fx.state.requests.filter((request) => request.path === '/api/v1/search').at(-1);
    assert.equal(emptyBrowseSearch.query.sources, 'source-alpha,source-beta');
    assert.equal(emptyBrowseSearch.query.limit, '1');
    assert.equal(emptyBrowseSearch.query.page, '1');

    const second = await tool(active, 'Mailbox', { action: 'search', limit: 1, cursor: first.body.nextCursor });
    const third = await tool(active, 'Mailbox', { action: 'search', limit: 1, cursor: second.body.nextCursor });
    assert.equal(second.body.messages[0].archiveId, 'archive-002');
    assert.equal(second.body.messages[0].sourceId, 'source-beta', 'a cursor page can cross source boundaries');
    assert.equal(third.body.messages[0].archiveId, 'archive-003');
    assert.equal(third.body.messages[0].sourceId, 'source-alpha');
    assert.equal(third.body.nextCursor, null);

    const filtered = await tool(active, 'Mailbox', {
      action: 'search', limit: 10, sourceIds: ['source-beta'], mailboxes: ['owner-beta@example.test'],
    });
    assert.equal(filtered.isError, false, JSON.stringify(filtered.body));
    assert.deepEqual(filtered.body.messages.map((message) => message.archiveId), ['archive-002']);
    const filteredQuery = active.fx.state.requests.filter((request) => request.path === '/api/v1/search').at(-1).query;
    assert.equal(filteredQuery.sources, 'source-beta');
    assert.equal(filteredQuery.mailboxes, 'owner-beta@example.test');

    const beforeCursorRejections = active.fx.state.requests.filter((request) => request.path === '/api/v1/search').length;
    for (const args of [
      { accountId: 'archive', limit: 2, cursor: first.body.nextCursor },
      { accountId: 'archive', limit: 1, sourceIds: ['source-alpha'], cursor: first.body.nextCursor },
    ]) {
      const rejected = await tool(active, 'Mailbox', { action: 'search', ...args });
      assert.equal(rejected.body.code, 'cursor_invalid');
    }
    await active.saveArchive({ id: 'archive-copy', credential: { apiKey: API_KEY } });
    const otherAccountCursor = await tool(active, 'Mailbox', { action: 'search', accountId: 'archive-copy', limit: 1, cursor: first.body.nextCursor });
    assert.equal(otherAccountCursor.body.code, 'cursor_invalid');
    assert.equal(active.fx.state.requests.filter((request) => request.path === '/api/v1/search').length, beforeCursorRejections, 'invalid cursors never fetch a search page');

    for (const filter of [{ sourceIds: ['*'] }, { mailboxes: ['*@*'] }]) {
      const invalid = await tool(active, 'Mailbox', { action: 'search', ...filter });
      assert.equal(invalid.body.code, 'archive_http');
      assert.equal(active.fx.state.requests.at(-1).status, 400);
    }

    active.fx.assertClean();
  } finally {
    await active.stop();
  }
});

test('Open Archiver reads complete MIME and stored attachments safely, without IMAP/SMTP read fallback', { timeout: 25_000 }, async () => {
  const mailFixture = await startMailFixture({ users: [{
    user: 'sender@example.test', password: 'fixture-smtp-password',
    mailboxes: { INBOX: { uidValidity: 17, messages: [] } },
  }] });
  const active = await harness();
  try {
    const direct = await active.service.panel('save', {
      account: {
        id: 'sender', label: 'Fixture SMTP sender', preset: 'custom', user: 'sender@example.test',
        from: 'Fixture Sender <sender@example.test>', auth: 'password', sendOnly: true,
        imapHost: '127.0.0.1', imapPort: mailFixture.imapPort, imapSecure: false,
        smtpHost: '127.0.0.1', smtpPort: mailFixture.smtpPort, smtpSecure: false,
        allowInsecureAuth: true, timeoutMs: 3_000,
      },
      credential: { password: 'fixture-smtp-password' },
    }, active.context);
    assert.equal(direct.ok, true);
    const archive = await active.saveArchive({ credential: { apiKey: API_KEY } });
    assert.equal(archive.ok, true);
    const selectedReader = await active.service.panel('defaultRead', { accountId: 'archive' }, active.context);
    assert.equal(selectedReader.ok, true);
    assert.equal(active.settings.defaultAccountId, 'sender');
    assert.equal(active.settings.defaultReadAccountId, 'archive');
    const accountState = await active.service.panel('state', {}, active.context);
    assert.equal(accountState.defaultAccountId, 'sender');
    assert.equal(accountState.defaultReadAccountId, 'archive');
    assert.equal(accountState.accounts.find((account) => account.id === 'sender').isDefault, true);
    assert.equal(accountState.accounts.find((account) => account.id === 'sender').isDefaultRead, false);
    assert.equal(accountState.accounts.find((account) => account.id === 'archive').isDefault, false);
    assert.equal(accountState.accounts.find((account) => account.id === 'archive').isDefaultRead, true);

    const sourceResult = await tool(active, 'Mailbox', { action: 'sources' });
    assert.equal(sourceResult.body.accountId, 'archive', 'omitted accountId reads from the independent default reader');
    const read = await tool(active, 'Mailbox', { action: 'read', archiveId: 'archive-001' });
    assert.equal(read.isError, false, JSON.stringify(read.body));
    assert.deepEqual(read.body.identity, { provider: 'open-archiver', accountId: 'archive', archiveId: 'archive-001' });
    assert.equal(read.body.sourceId, 'source-alpha');
    assert.equal(read.body.mailboxOwner, 'owner-alpha@example.test');
    assert.equal(read.body.textComplete, false);
    assert.equal(read.body.text.length, 4_000);
    assertWithin(active.dataDir, read.body.textPath);
    const fullBody = await readFile(read.body.textPath, 'utf8');
    assert.ok(fullBody.length > 20_000);
    assert.ok(fullBody.startsWith('OA-LONG-BEGIN'));
    assert.ok(fullBody.endsWith('OA-LONG-END'));
    assert.equal(read.body.text, fullBody.slice(0, 4_000));
    assert.equal('storagePath' in read.body, false);

    const emlPart = read.body.attachments.find((attachment) => attachment.attachmentId.startsWith('eml:'));
    const storedPart = read.body.attachments.find((attachment) => attachment.attachmentId === 'stored:stored-part-001');
    assert.ok(emlPart, 'the original MIME attachment is listed with an eml:<partId> attachmentId');
    assert.equal(emlPart.filename, 'mime-note.txt');
    assert.equal(storedPart.filename, '..\\..\\outside-fixture.bin');
    assert.equal(storedPart.mimeType, 'application/octet-stream');
    assert.equal(storedPart.size, Buffer.byteLength('Complete stored attachment bytes from fixture.'));
    assert.equal('storagePath' in storedPart, false, 'untrusted local storage paths from detail are not exposed');

    const savedEml = await tool(active, 'Mailbox', { action: 'attachment', archiveId: 'archive-001', attachmentId: emlPart.attachmentId });
    assert.equal(savedEml.isError, false, JSON.stringify(savedEml.body));
    assertWithin(active.dataDir, savedEml.body.path);
    assert.deepEqual(await readFile(savedEml.body.path), Buffer.from('Complete MIME attachment bytes from fixture.'));
    const savedStored = await tool(active, 'Mailbox', { action: 'attachment', archiveId: 'archive-001', attachmentId: storedPart.attachmentId });
    assert.equal(savedStored.isError, false, JSON.stringify(savedStored.body));
    assert.equal(savedStored.body.filename, '..\\..\\outside-fixture.bin');
    assertWithin(active.dataDir, savedStored.body.path);
    assert.deepEqual(await readFile(savedStored.body.path), Buffer.from('Complete stored attachment bytes from fixture.'));

    const storageRead = await tool(active, 'Mailbox', { action: 'read', archiveId: 'archive-002' });
    assert.equal(storageRead.isError, false, JSON.stringify(storageRead.body));
    assert.equal(storageRead.body.text.trimEnd(), 'Message fetched through the detail storagePath.');
    const downloads = active.fx.state.requests.filter((request) => request.path === '/api/v1/storage/download');
    assert.deepEqual(downloads.map((request) => request.query.path), [
      'fixture-storage/attachments/record-001',
      'fixture-storage/messages/archive-002.eml',
    ]);

    const beforeInvalidIds = active.fx.state.requests.length;
    for (const args of [
      { action: 'read' },
      { action: 'read', archiveId: '../archive-001' },
      { action: 'read', archiveId: 'archive-001', uid: '1' },
      { action: 'read', archiveId: 'archive-001', uidValidity: '17' },
      { action: 'read', archiveId: 'archive-001', identity: { accountId: 'some-other-account', archiveId: 'archive-001' } },
    ]) {
      const invalid = await tool(active, 'Mailbox', args);
      assert.ok(['identity_invalid', 'account_mismatch'].includes(invalid.body.code), JSON.stringify(invalid.body));
    }
    assert.equal(active.fx.state.requests.length, beforeInvalidIds, 'malformed, missing, IMAP-style, and cross-account identities are rejected before HTTP');

    const unknown = await tool(active, 'Mailbox', { action: 'read', archiveId: 'archive-not-found' });
    assert.equal(unknown.body.code, 'not_found');
    const mismatch = await tool(active, 'Mailbox', { action: 'read', archiveId: 'mismatch-id' });
    assert.equal(mismatch.body.code, 'archive_protocol', 'detail identity must match the requested archiveId');
    const missingAttachment = await tool(active, 'Mailbox', { action: 'attachment', archiveId: 'archive-001' });
    assert.equal(missingAttachment.body.code, 'not_found');
    const unknownAttachment = await tool(active, 'Mailbox', { action: 'attachment', archiveId: 'archive-001', attachmentId: 'stored:not-present' });
    assert.equal(unknownAttachment.body.code, 'not_found');
    assert.equal(mailFixture.state.imapAccepts, 0, 'Open Archiver read failures never fall through to direct IMAP');
    assert.equal(mailFixture.state.smtpData, 0, 'Open Archiver reads and attachments never use SMTP');

    const sendBlocked = await tool(active, 'MailSend', { action: 'send', accountId: 'archive', to: 'recipient@example.test', subject: 'Not sendable', text: 'No SMTP from archive' });
    assert.equal(sendBlocked.body.code, 'unsupported');
    assert.equal(mailFixture.state.smtpData, 0);
    const sent = await tool(active, 'MailSend', {
      action: 'send', accountId: 'sender', to: 'recipient@example.test', subject: 'Fixture direct send', text: 'Sent only by the direct account', requestId: 'fixture-direct-send',
    });
    assert.equal(sent.body.outcome, 'accepted', JSON.stringify(sent.body));
    assert.equal(sent.body.accountId, 'sender');
    assert.equal(mailFixture.state.smtpMessages.length, 1);
    assert.equal(mailFixture.state.smtpMessages[0].user, 'sender@example.test');
    assert.equal(mailFixture.state.smtpMessages[0].from, 'sender@example.test');
    assert.equal(mailFixture.state.imapAccepts, 0, 'the direct send-only sender is not used as a reader');

    active.fx.assertClean();
  } finally {
    await active.stop();
    await mailFixture.close();
  }
});

test('Open Archiver HTTP requests propagate cancellation and the configured timeout', { timeout: 10_000 }, async () => {
  const active = await harness({ fixture: { delays: { search: 1_200 } }, timeoutMs: 250 });
  try {
    await active.saveArchive({ credential: { apiKey: API_KEY } });

    const controller = new AbortController();
    const cancelledRequest = tool(active, 'Mailbox', { action: 'search', query: 'cancel fixture' }, { ...active.context, signal: controller.signal });
    await waitFor(() => active.fx.state.requests.some((request) => request.path === '/api/v1/search' && request.query.keywords === 'cancel fixture'), 'cancelled HTTP search');
    controller.abort();
    const cancelled = await cancelledRequest;
    assert.equal(cancelled.body.code, 'cancelled');

    const timedOut = await tool(active, 'Mailbox', { action: 'search', query: 'timeout fixture' });
    assert.equal(timedOut.body.code, 'timeout');
    assert.ok(active.fx.state.requests.some((request) => request.path === '/api/v1/search' && request.query.keywords === 'timeout fixture'));
    active.fx.assertClean();
  } finally {
    await active.stop();
  }
});
