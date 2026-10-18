import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { readEvents } from '../lib/service.mjs';
import { parseMessage } from '../lib/parse.mjs';
import { startFixture } from './fixture.mjs';

const PASS = 'fixture-secret-pass';
const TOKEN = 'fixture-access-token';
const REFRESH = 'fixture-refresh-token';
const SECRET = 'fixture-client-secret';

function message({ id, from, to, subject, text, date = 'Mon, 18 Oct 2026 01:00:00 +0000', attachment }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
  ];
  if (!attachment) return Buffer.from(`${headers.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`);
  const boundary = 'kiki-mail-boundary';
  return Buffer.from([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    `--${boundary}`,
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="note.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(attachment).toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n'));
}

function box(messages, uidValidity = 7) {
  return { uidValidity, messages };
}

async function session(spec = {}) {
  const fx = await startFixture(spec);
  const dir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const service = mailServiceForTests(spec.deps ?? {});
  const context = {
    settings,
    dataDir: dir,
    userHome: dir,
    kikiHome: dir,
    workspaceRoot: dir,
    approvedPaths: [],
    async updateSettings(patch) { Object.assign(settings, patch); },
    onActivity() {},
    focusSession() {},
  };
  if (spec.im) context.im = spec.im;
  await service.activate(context);
  return {
    fx, dir, settings, service, context,
    async stop() {
      await service.deactivate();
      await fx.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function loopback(fx, extra = {}) {
  return {
    id: 'ada',
    label: 'Ada',
    user: 'ada@example.test',
    from: 'Ada <ada@example.test>',
    auth: 'password',
    imapHost: '127.0.0.1',
    imapPort: fx.imapPort,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: fx.smtpPort,
    smtpSecure: false,
    allowInsecureAuth: true,
    timeoutMs: 5000,
    ...extra,
  };
}

async function tool(active, name, args, context = active.context) {
  const result = await active.service.tool(name, args, context);
  return { isError: result.isError === true, body: JSON.parse(result.output) };
}

async function waitFor(check, label) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('localhost IMAP and SMTP cover config, page, body, attachment, reply, and isolation', { timeout: 20000 }, async () => {
  const ada = message({
    id: 'note-1@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
    subject: 'Fixture note', text: 'Hello fixture café', attachment: 'hello',
  });
  const project = message({
    id: 'note-2@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
    subject: 'Project update', text: 'Status is green',
  });
  const archive = message({
    id: 'note-3@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
    subject: 'Archive', text: 'Old note', date: 'Wed, 01 Jan 2020 00:00:00 +0000',
  });
  const long = message({
    id: 'note-4@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
    subject: 'Long note', text: `START${'A'.repeat(25000)}END`,
  });
  const onlyBea = message({
    id: 'bea-1@example.test', from: 'Ada <ada@example.test>', to: 'Bea <bea@example.test>',
    subject: 'Only Bea', text: 'Private to Bea',
  });
  const active = await session({
    users: [
      { user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([
        { uid: 1, flags: ['\\Seen'], raw: ada },
        { uid: 2, flags: [], raw: project },
        { uid: 3, flags: [], raw: archive },
        { uid: 4, flags: [], raw: long },
      ]), Sent: box([], 3) } },
      { user: 'bea@example.test', password: 'bea-other-secret', mailboxes: { INBOX: box([{ uid: 1, flags: [], raw: onlyBea }]) } },
    ],
  });
  try {
    const saved = await active.service.panel('save', {
      account: loopback(active.fx),
      credential: { password: PASS },
    }, active.context);
    assert.equal(saved.ok, true);
    assert.equal(saved.account.credentialStored, true);
    assert.equal(JSON.stringify(saved).includes(PASS), false);
    const rejected = await tool(active, 'MailAccount', { action: 'save', account: { ...loopback(active.fx), password: PASS } });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.body.code, 'credential_in_tool');
    assert.equal(rejected.body.message.includes(PASS), false);

    const tested = await tool(active, 'MailAccount', { action: 'test', accountId: 'ada' });
    assert.equal(tested.isError, false, JSON.stringify(tested.body));
    assert.equal(tested.body.authenticated, true);
    assert.equal(tested.body.oauthConsent, false);
    assert.equal(tested.body.mailboxCount, 2);

    const folders = await tool(active, 'Mailbox', { action: 'folders', accountId: 'ada' });
    assert.deepEqual(folders.body.mailboxes.map((item) => item.path).sort(), ['INBOX', 'Sent']);

    const page = await tool(active, 'Mailbox', { action: 'search', accountId: 'ada', limit: 2 });
    assert.deepEqual(page.body.messages.map((item) => item.uid), ['4', '3']);
    assert.equal(page.body.uidValidity, '7');
    assert.equal(page.body.nextCursor, '3');
    const next = await tool(active, 'Mailbox', { action: 'search', accountId: 'ada', limit: 2, cursor: page.body.nextCursor });
    assert.deepEqual(next.body.messages.map((item) => item.uid), ['2', '1']);
    const found = await tool(active, 'Mailbox', { action: 'search', accountId: 'ada', query: 'Project' });
    assert.deepEqual(found.body.messages.map((item) => item.subject), ['Project update']);
    const unseen = await tool(active, 'Mailbox', { action: 'search', accountId: 'ada', unseen: true, limit: 100 });
    assert.equal(unseen.body.messages.some((item) => item.uid === '1'), false);
    const recent = await tool(active, 'Mailbox', { action: 'search', accountId: 'ada', since: '2026-10-01', limit: 100 });
    assert.equal(recent.body.messages.some((item) => item.subject === 'Archive'), false);
    assert.equal(recent.body.messages.some((item) => item.subject === 'Fixture note'), true);

    const read = await tool(active, 'Mailbox', {
      action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1',
    });
    assert.equal(read.body.text, 'Hello fixture café');
    assert.equal(read.body.textComplete, true);
    assert.equal(read.body.attachments.length, 1);
    const part = read.body.attachments[0];
    const savedFile = await tool(active, 'Mailbox', {
      action: 'attachment', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1', partId: part.partId,
    });
    assert.equal(await readFile(savedFile.body.path, 'utf8'), 'hello');
    assert.equal(savedFile.body.sha256, part.sha256);

    const longRead = await tool(active, 'Mailbox', {
      action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '4',
    });
    assert.equal(longRead.body.textComplete, false);
    assert.equal(longRead.body.text.length, 4000);
    const full = await readFile(longRead.body.textPath, 'utf8');
    assert.equal(full.startsWith('START'), true);
    assert.equal(full.includes(`${'A'.repeat(100)}END`), true);
    assert.equal(full.length > 25000, true);
    assert.equal(longRead.body.text, full.slice(0, 4000));

    const mismatch = await tool(active, 'Mailbox', {
      action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '999', uid: '1',
    });
    assert.equal(mismatch.body.code, 'uidvalidity_mismatch');
    const crossed = await tool(active, 'Mailbox', {
      action: 'read', accountId: 'ada', identity: { accountId: 'bea', mailbox: 'INBOX', uidValidity: '7', uid: '1' },
    });
    assert.equal(crossed.body.code, 'account_mismatch');
    await active.service.panel('save', {
      account: loopback(active.fx, { id: 'bea', label: 'Bea', user: 'bea@example.test', from: 'Bea <bea@example.test>' }),
      credential: { password: 'bea-other-secret' },
    }, active.context);
    const beaPage = await tool(active, 'Mailbox', { action: 'search', accountId: 'bea' });
    assert.deepEqual(beaPage.body.messages.map((item) => item.subject), ['Only Bea']);
    const adaAgain = await tool(active, 'Mailbox', { action: 'search', accountId: 'ada', query: 'Only Bea' });
    assert.equal(adaAgain.body.messages.length, 0);

    const sent = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Outbound', text: 'Sent through SMTP', requestId: 'send-1',
    });
    assert.equal(sent.body.outcome, 'accepted');
    assert.equal(sent.body.finalDelivery, false);
    assert.equal(sent.body.automaticRetry, false);
    assert.deepEqual(sent.body.accepted, ['bea@example.test']);
    const parsed = await parseMessage(active.fx.state.smtpMessages[0].raw);
    assert.equal(parsed.subject, 'Outbound');
    assert.equal(parsed.text.trimEnd(), 'Sent through SMTP');

    const reply = await tool(active, 'MailSend', {
      action: 'reply', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1', text: 'Reply body', requestId: 'reply-1',
    });
    assert.equal(reply.body.outcome, 'accepted');
    const replied = await parseMessage(active.fx.state.smtpMessages.at(-1).raw);
    assert.equal(replied.subject, 'Re: Fixture note');
    assert.equal(replied.inReplyTo.includes('note-1@example.test'), true);
    assert.equal(replied.text.trimEnd(), 'Reply body');
  } finally {
    await active.stop();
  }
});

test('bad auth, disconnect, cancel, redact, and uncertain send do not resend or leak secrets', { timeout: 20000 }, async () => {
  const raw = message({
    id: 'secret-body@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
    subject: 'Contains secret', text: `${PASS}${'B'.repeat(25000)}`,
  });
  const active = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([{ uid: 1, flags: [], raw }]) } }],
    failAuth: 'ada@example.test',
  });
  try {
    await active.service.panel('save', { account: loopback(active.fx), credential: { password: PASS } }, active.context);
    const failed = await tool(active, 'MailAccount', { action: 'test', accountId: 'ada' });
    assert.equal(failed.body.code, 'auth_failed');
    assert.equal(failed.body.message.includes(PASS), false);
    assert.equal(active.fx.state.smtpData, 0);
    assert.equal(active.fx.state.smtpMessages.length, 0);
  } finally {
    await active.stop();
  }

  const smtpFail = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
    failSmtpAuth: 'ada@example.test',
  });
  try {
    await smtpFail.service.panel('save', { account: loopback(smtpFail.fx), credential: { password: PASS } }, smtpFail.context);
    const denied = await tool(smtpFail, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'No', text: 'No', requestId: 'auth-1',
    });
    assert.equal(denied.body.code, 'auth_failed');
    assert.equal(denied.body.outcome, 'auth_failed');
    assert.equal(smtpFail.fx.state.smtpData, 0);
    const again = await tool(smtpFail, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'No', text: 'No', requestId: 'auth-1',
    });
    assert.equal(again.body.code, 'auth_failed');
    assert.equal(smtpFail.fx.state.smtpData, 0);
    assert.equal(smtpFail.fx.state.smtpAuthFailures, 2);
  } finally {
    await smtpFail.stop();
  }

  const dropped = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([{ uid: 1, flags: [], raw }]) } }],
    dropOnFetch: true,
  });
  try {
    await dropped.service.panel('save', { account: loopback(dropped.fx), credential: { password: PASS } }, dropped.context);
    const read = await tool(dropped, 'Mailbox', { action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1' });
    assert.equal(read.body.code, 'disconnected');
    assert.equal(read.body.message.includes(PASS), false);
  } finally {
    await dropped.stop();
  }

  const held = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([{ uid: 1, flags: [], raw }]) } }],
    holdFetch: true,
  });
  try {
    await held.service.panel('save', { account: loopback(held.fx), credential: { password: PASS } }, held.context);
    const controller = new AbortController();
    const pending = tool(held, 'Mailbox', {
      action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1',
    }, { ...held.context, signal: controller.signal });
    await waitFor(() => held.fx.state.held.length > 0, 'held fetch');
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.body.code, 'cancelled');
    await waitFor(() => held.fx.state.imapSockets === 0, 'socket cleanup');
  } finally {
    await held.stop();
  }

  const visible = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([{ uid: 1, flags: [], raw }]) } }],
  });
  try {
    await visible.service.panel('save', { account: loopback(visible.fx), credential: { password: PASS } }, visible.context);
    const read = await tool(visible, 'Mailbox', { action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1' });
    assert.equal(read.body.text.includes(PASS), false);
    assert.equal(read.body.text.includes('[redacted]'), true);
    const stored = await readFile(read.body.textPath, 'utf8');
    assert.equal(stored.includes(PASS), true);
  } finally {
    await visible.stop();
  }

  const uncertain = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
    dropAfterData: true,
  });
  try {
    await uncertain.service.panel('save', { account: loopback(uncertain.fx), credential: { password: PASS } }, uncertain.context);
    const first = await tool(uncertain, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Maybe', text: 'Maybe', requestId: 'uncertain-1',
    });
    assert.equal(first.body.code, 'uncertain_send');
    assert.equal(first.body.outcome, 'uncertain');
    assert.equal(uncertain.fx.state.smtpData, 1);
    const blocked = await tool(uncertain, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Maybe', text: 'Maybe', requestId: 'uncertain-1',
    });
    assert.equal(blocked.isError, false);
    assert.equal(blocked.body.code, 'uncertain_not_resent');
    assert.equal(blocked.body.resent, false);
    assert.equal(blocked.body.automaticRetry, false);
    assert.equal(uncertain.fx.state.smtpData, 1);
    const forced = await tool(uncertain, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Maybe', text: 'Maybe', requestId: 'uncertain-1', confirmResend: true,
    });
    assert.equal(forced.body.outcome, 'uncertain');
    assert.equal(uncertain.fx.state.smtpData, 2);
  } finally {
    await uncertain.stop();
  }
});

test('watch records only mail that arrives after startup, and an old host leaves IM unsupported', { timeout: 20000 }, async () => {
  const existing = message({
    id: 'old@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
    subject: 'Already there', text: `body ${PASS}`,
  });
  const active = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([{ uid: 1, flags: [], raw: existing }]) } }],
  });
  try {
    await active.service.panel('save', {
      watchEnabled: true,
      account: loopback(active.fx, { watch: true, imEnabled: true, imChannelId: 'telegram:desk', imRouteRevision: 'ab'.repeat(32) }),
      credential: { password: PASS },
    }, active.context);
    await active.service.deactivate();
    await active.service.activate(active.context);
    await waitFor(() => active.fx.state.idling > 0, 'idle');
    assert.equal((await readEvents(active.dir, 'ada')).length, 0);
    const fresh = message({
      id: 'new@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
      subject: 'Just arrived', text: 'A new note',
    });
    active.fx.append('ada@example.test', 'INBOX', fresh);
    await waitFor(async () => (await readEvents(active.dir, 'ada')).some((event) => event.kind === 'arrived'), 'arrival');
    const events = await readEvents(active.dir, 'ada');
    assert.equal(events.filter((event) => event.kind === 'arrived').length, 1);
    assert.equal(events[0].subject, 'Just arrived');
    assert.equal(events[0].im.diagnosticCode, 'im_unsupported');
    assert.equal(events[0].im.sent, false);
    assert.equal(JSON.stringify(events).includes(PASS), false);
    const state = await tool(active, 'MailAccount', { action: 'list' });
    assert.equal(state.body.imBridge.supported, false);
    assert.equal(state.body.imBridge.reason, 'unsupported');
    await active.service.deactivate();
    await waitFor(() => active.fx.state.imapSockets === 0, 'watch sockets closed');
  } finally {
    await active.stop();
  }

  const calls = [];
  const revision = 'cd'.repeat(32);
  const bridged = await session({
    im: {
      async capabilities() { return { outbound: true, inbound: false }; },
      async listRoutes() { return [{ channelId: 'telegram:desk', providerId: 'telegram', label: 'Desk', routeRevision: revision }]; },
      async send(request) { calls.push(request); return { status: 'accepted', retryable: false }; },
    },
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await bridged.service.panel('save', {
      watchEnabled: true,
      account: loopback(bridged.fx, {
        watch: true, imEnabled: true, imChannelId: 'telegram:desk', imRouteRevision: revision,
      }),
      credential: { password: PASS },
    }, bridged.context);
    await bridged.service.deactivate();
    await bridged.service.activate(bridged.context);
    await waitFor(() => bridged.fx.state.idling > 0, 'bridged idle');
    bridged.fx.append('ada@example.test', 'INBOX', message({
      id: 'ping@example.test', from: 'Bea <bea@example.test>', to: 'Ada <ada@example.test>',
      subject: 'Ping', text: `hidden ${PASS}`,
    }));
    await waitFor(() => calls.length === 1, 'im send');
    assert.equal(calls[0].channelId, 'telegram:desk');
    assert.equal(calls[0].routeRevision, revision);
    assert.equal(calls[0].accountRef, 'ada');
    assert.equal(calls[0].sessionId, undefined);
    assert.equal(calls[0].text.includes('Ping'), true);
    assert.equal(calls[0].text.includes(PASS), false);
    assert.equal(calls[0].idempotencyKey.includes(calls[0].routeRevision), false);
    const events = await readEvents(bridged.dir, 'ada');
    assert.equal(events[0].im.status, 'accepted');
    assert.equal(events[0].im.attempts, 1);
  } finally {
    await bridged.stop();
  }
});

test('oauth refresh uses the token endpoint, and cleartext off loopback is refused', { timeout: 20000 }, async () => {
  const active = await session({
    refreshToken: REFRESH,
    accessToken: TOKEN,
    users: [{ user: 'ada@example.test', password: PASS, accessToken: TOKEN, mailboxes: { INBOX: box([]) } }],
  });
  try {
    const saved = await active.service.panel('save', {
      account: loopback(active.fx, {
        auth: 'oauth2',
        oauthClientId: 'client-1',
        oauthTokenUrl: `http://127.0.0.1:${active.fx.tokenPort}/token`,
      }),
      credential: { refreshToken: REFRESH, clientSecret: SECRET },
    }, active.context);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const tested = await tool(active, 'MailAccount', { action: 'test', accountId: 'ada' });
    assert.equal(tested.isError, false, JSON.stringify(tested.body));
    assert.equal(tested.body.oauthConsent, false);
    assert.equal(tested.body.message.includes('consent screen'), true);
    assert.equal(active.fx.state.tokenRequests >= 1, true);
    assert.equal(tested.body.message.includes(TOKEN), false);
    assert.equal(tested.body.message.includes(SECRET), false);
    const stored = JSON.parse(active.settings.credentials);
    assert.equal(stored.ada.accessToken, TOKEN);
    const listed = await tool(active, 'MailAccount', { action: 'list' });
    assert.equal(JSON.stringify(listed.body).includes(TOKEN), false);
    assert.equal(JSON.stringify(listed.body).includes(SECRET), false);
    const remote = await tool(active, 'MailAccount', {
      action: 'save',
      account: {
        id: 'remote', user: 'ada@example.test', auth: 'password',
        imapHost: 'imap.example.com', imapPort: 143, imapSecure: false,
        smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false,
        allowInsecureAuth: true,
      },
    });
    assert.equal(remote.body.code, 'tls_required');
    const httpToken = await tool(active, 'MailAccount', {
      action: 'save',
      account: loopback(active.fx, { id: 'public-token', auth: 'oauth2', oauthTokenUrl: 'http://login.example.com/token' }),
    });
    assert.equal(httpToken.body.code, 'account_invalid');
  } finally {
    await active.stop();
  }
});

test('catalog and pinned licenses stay outside the official market', async () => {
  const catalog = JSON.parse(await readFile(new URL('../../marketplace.json', import.meta.url), 'utf8'));
  assert.equal(catalog.plugins.some((plugin) => plugin.id === 'kiki-mail'), false);
  const versions = JSON.parse(await readFile(new URL('../vendor/versions.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(versions.nodemailer.version, lock.packages['node_modules/nodemailer'].version);
  assert.equal(versions.nodemailer.license, 'MIT-0');
  assert.equal(versions.imapflow.license, 'MIT');
  assert.equal(versions['postal-mime'].license, 'MIT-0');
  assert.equal(versions.imapflow.version, '2.5.4');
  assert.equal(versions['postal-mime'].version, '4.0.8');
});
