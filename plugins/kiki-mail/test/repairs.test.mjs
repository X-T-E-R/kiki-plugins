import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { readEvents } from '../lib/service.mjs';
import { startFixture } from './fixture.mjs';

const PASS = 'repair-secret-pass';

function message({ id, text, attachment, attachments }) {
  const headers = [
    'From: Bea <bea@example.test>',
    'To: Ada <ada@example.test>',
    'Subject: Repair',
    'Date: Mon, 18 Oct 2026 01:00:00 +0000',
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
  ];
  const parts = attachments ?? (attachment == null ? null : [attachment]);
  if (!parts) return Buffer.from(`${headers.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`);
  const boundary = 'kiki-repair-boundary';
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ];
  for (const part of parts) {
    lines.push(
      `--${boundary}`,
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="note.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(part).toString('base64'),
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'));
}

function box(messages, uidValidity = 7) {
  return { uidValidity, messages };
}

function account(fx, id = 'ada', extra = {}) {
  return {
    id,
    label: id,
    user: `${id}@example.test`,
    from: `${id} <${id}@example.test>`,
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

async function session(spec = {}) {
  const fx = await startFixture(spec);
  const dir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-repair-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const service = mailServiceForTests(spec.deps ?? {});
  const context = {
    settings,
    dataDir: dir,
    userHome: dir,
    kikiHome: dir,
    workspaceRoot: dir,
    approvedPaths: [],
    signal: new AbortController().signal,
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

async function save(active, value, credential = { password: PASS }) {
  const saved = await active.service.panel('save', { account: value, credential }, active.context);
  assert.equal(saved.ok, true, JSON.stringify(saved));
}

test('cancel and disconnect after SMTP DATA stay uncertain and are not resent', { timeout: 20000 }, async () => {
  const cancelled = await session({
    holdAfterData: true,
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(cancelled, account(cancelled.fx));
    const controller = new AbortController();
    const pending = tool(cancelled, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Hold', text: 'Hold', requestId: 'cancel-data',
    }, { ...cancelled.context, signal: controller.signal });
    await waitFor(() => cancelled.fx.state.held.length > 0, 'held data');
    assert.equal(cancelled.fx.state.smtpData, 1);
    controller.abort();
    const first = await pending;
    assert.equal(first.body.code, 'uncertain_send', JSON.stringify(first.body));
    assert.equal(first.body.outcome, 'uncertain');
    const blocked = await tool(cancelled, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Hold', text: 'Hold', requestId: 'cancel-data', confirmResend: true,
    });
    assert.equal(blocked.body.code, 'uncertain_not_resent');
    assert.equal(blocked.body.resent, false);
    assert.equal(cancelled.fx.state.smtpData, 1);
  } finally {
    await cancelled.stop();
  }

  const dropped = await session({
    dropAfterData: true,
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(dropped, account(dropped.fx));
    const first = await tool(dropped, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Drop', text: 'Drop', requestId: 'drop-data',
    });
    assert.equal(first.body.outcome, 'uncertain');
    assert.equal(dropped.fx.state.smtpData, 1);
    const blocked = await tool(dropped, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Other', text: 'Other', requestId: 'drop-data', confirmResend: true,
    });
    assert.equal(blocked.body.code, 'uncertain_not_resent');
    assert.equal(dropped.fx.state.smtpData, 1);
  } finally {
    await dropped.stop();
  }
});

test('an accepted send whose receipt write fails is not marked failed or resent', { timeout: 20000 }, async () => {
  const active = await session({
    deps: { failPersist: (record) => record.outcome === 'accepted' },
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(active, account(active.fx));
    const first = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Kept', text: 'Kept', requestId: 'accept-1',
    });
    assert.equal(first.isError, false, JSON.stringify(first.body));
    assert.equal(first.body.outcome, 'accepted');
    assert.equal(first.body.receiptStored, false);
    assert.equal(first.body.resent, false);
    assert.equal(active.fx.state.smtpData, 1);
    const stored = JSON.parse(await readFile(path.join(active.dir, 'sends', 'ada', 'accept-1.json'), 'utf8'));
    assert.equal(stored.phase, 'sending');
    assert.notEqual(stored.outcome, 'failed');
    const blocked = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Kept', text: 'Kept', requestId: 'accept-1', confirmResend: true,
    });
    assert.equal(blocked.body.outcome, 'uncertain');
    assert.equal(blocked.body.resent, false);
    assert.equal(active.fx.state.smtpData, 1);
    await active.service.deactivate();
    const restarted = mailServiceForTests();
    await restarted.activate(active.context);
    const again = await restarted.tool('MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Kept', text: 'Kept', requestId: 'accept-1',
    }, active.context);
    const body = JSON.parse(again.output);
    assert.equal(body.resent, false);
    assert.equal(active.fx.state.smtpData, 1);
    await restarted.deactivate();
  } finally {
    await active.stop();
  }
});

test('send receipts are isolated by account, request id, and payload, including bad storage', { timeout: 20000 }, async () => {
  const users = [
    { user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } },
    { user: 'bea@example.test', password: PASS, mailboxes: { INBOX: box([]) } },
  ];
  let failIntent = true;
  const active = await session({
    deps: { failPersist: (record) => failIntent && record.phase === 'sending' },
    users,
  });
  try {
    await save(active, account(active.fx, 'ada'));
    await save(active, account(active.fx, 'bea'));
    const denied = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'One', text: 'One', requestId: 'shared-id',
    });
    assert.equal(denied.body.code, 'send_store_failed');
    assert.equal(denied.body.resent, false);
    assert.equal(active.fx.state.smtpData, 0);
    failIntent = false;
    const ada = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'One', text: 'One', requestId: 'shared-id',
    });
    const bea = await tool(active, 'MailSend', {
      action: 'send', accountId: 'bea', to: 'ada@example.test', subject: 'One', text: 'One', requestId: 'shared-id',
    });
    assert.equal(ada.body.outcome, 'accepted', JSON.stringify(ada.body));
    assert.equal(bea.body.outcome, 'accepted', JSON.stringify(bea.body));
    assert.equal(active.fx.state.smtpMessages.length, 2);
    assert.deepEqual(active.fx.state.smtpMessages.map((item) => item.user).sort(), ['ada@example.test', 'bea@example.test']);

    const conflict = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Two', text: 'Two', requestId: 'shared-id',
    });
    assert.equal(conflict.body.code, 'payload_conflict');
    assert.equal(active.fx.state.smtpMessages.length, 2);

    const corruptDir = path.join(active.dir, 'sends', 'ada');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, 'broken-id.json'), '{');
    const corrupt = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Broken', text: 'Broken', requestId: 'broken-id',
    });
    assert.equal(corrupt.body.code, 'receipt_unreadable');
    assert.equal(corrupt.body.resent, false);
    assert.equal(active.fx.state.smtpMessages.length, 2);

    await mkdir(path.join(corruptDir, 'dir-id.json'), { recursive: true });
    const unreadable = await tool(active, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Dir', text: 'Dir', requestId: 'dir-id',
    });
    assert.equal(unreadable.body.code, 'send_store_failed');
    assert.equal(active.fx.state.smtpMessages.length, 2);

    await writeFile(path.join(corruptDir, 'restart-id.json'), JSON.stringify({
      phase: 'sending', outcome: 'sending', requestId: 'restart-id', accountId: 'ada', fingerprint: 'stale', at: 1,
    }));
    await active.service.deactivate();
    const restarted = mailServiceForTests();
    await restarted.activate(active.context);
    const restartedSend = await restarted.tool('MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'One', text: 'One', requestId: 'restart-id',
    }, active.context);
    const restartedBody = JSON.parse(restartedSend.output);
    assert.equal(restartedBody.code, 'uncertain_not_resent');
    assert.equal(restartedBody.resent, false);
    assert.equal(active.fx.state.smtpMessages.length, 2);
    await restarted.deactivate();
  } finally {
    await active.stop();
  }
});

test('the same account and request id shares one SMTP flight', { timeout: 20000 }, async () => {
  const active = await session({
    holdAfterData: true,
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(active, account(active.fx));
    const args = { action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Flight', text: 'Flight', requestId: 'flight-1' };
    const first = tool(active, 'MailSend', args);
    const second = tool(active, 'MailSend', args);
    await waitFor(() => active.fx.state.held.length > 0, 'one flight');
    assert.equal(active.fx.state.smtpData, 1);
    active.fx.releaseHold();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].body.outcome, 'accepted');
    assert.equal(results[1].body.outcome, 'accepted');
    assert.equal(results[0].body.messageId, results[1].body.messageId);
    assert.equal(active.fx.state.smtpData, 1);
    assert.equal(active.fx.state.smtpMessages.length, 1);
  } finally {
    await active.stop();
  }
});

test('saving watch or IM settings reconciles the watcher, and reconnect does not replay mail', { timeout: 20000 }, async () => {
  const calls = [];
  const revision = 'ab'.repeat(32);
  const active = await session({
    im: {
      async capabilities() { return { outbound: true, inbound: false }; },
      async listRoutes() { return [{ channelId: 'telegram:desk', providerId: 'telegram', label: 'Desk', routeRevision: revision }]; },
      async send(request) { calls.push(request); return { status: 'accepted', retryable: false }; },
    },
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(active, account(active.fx, 'ada', {
      watch: true, imEnabled: true, imChannelId: 'telegram:desk', imRouteRevision: revision,
    }));
    await active.service.panel('save', { account: account(active.fx, 'ada', { watch: true }), watchEnabled: true, credential: { password: PASS } }, active.context);
    await waitFor(() => active.fx.state.idling > 0, 'idle');
    assert.equal(active.fx.state.imapSockets, 1);
    const before = active.fx.state.imapAccepts;
    await active.service.panel('save', {
      account: account(active.fx, 'ada', { watch: true, imEnabled: true, imChannelId: 'telegram:desk', imRouteRevision: revision }),
      watchEnabled: true,
      credential: { password: PASS },
    }, active.context);
    await waitFor(() => active.fx.state.imapAccepts > before && active.fx.state.idling > 0, 'reconciled');
    assert.equal(active.fx.state.imapSockets, 1);

    active.fx.append('ada@example.test', 'INBOX', message({ id: 'one@example.test', text: 'one' }));
    await waitFor(() => calls.length === 1, 'first digest');
    active.fx.dropSockets();
    await waitFor(() => active.fx.state.idling > 0 && calls.length === 1, 'reconnected without replay');
    const events = await readEvents(active.dir, 'ada');
    assert.equal(events.filter((event) => event.kind === 'arrived').length, 1);
    active.fx.append('ada@example.test', 'INBOX', message({ id: 'two@example.test', text: 'two' }));
    await waitFor(() => calls.length === 2, 'second digest');
    assert.equal((await readEvents(active.dir, 'ada')).filter((event) => event.kind === 'arrived').length, 2);

    const accepts = active.fx.state.imapAccepts;
    await active.service.panel('save', { account: account(active.fx, 'ada', { watch: false }), watchEnabled: false, credential: { password: PASS } }, active.context);
    await waitFor(() => active.fx.state.imapSockets === 0, 'watch off');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(active.fx.state.imapAccepts, accepts);
  } finally {
    await active.stop();
  }
});

test('body and attachment paths keep the mailbox and part id', { timeout: 20000 }, async () => {
  const inbox = message({ id: 'inbox@example.test', text: `A${'x'.repeat(21000)}`, attachments: ['alpha', 'beta'] });
  const archive = message({ id: 'archive@example.test', text: `B${'y'.repeat(21000)}`, attachments: ['gamma'] });
  const active = await session({
    users: [{
      user: 'ada@example.test',
      password: PASS,
      mailboxes: {
        INBOX: box([{ uid: 1, flags: [], raw: inbox }]),
        Archive: box([{ uid: 1, flags: [], raw: archive }]),
      },
    }],
  });
  try {
    await save(active, account(active.fx));
    const inboxRead = await tool(active, 'Mailbox', { action: 'read', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1' });
    const archiveRead = await tool(active, 'Mailbox', { action: 'read', accountId: 'ada', mailbox: 'Archive', uidValidity: '7', uid: '1' });
    assert.equal(inboxRead.body.textComplete, false);
    assert.equal(inboxRead.body.textPath.includes(`${path.sep}INBOX`), true);
    assert.equal(archiveRead.body.textPath.includes(`${path.sep}Archive`), true);
    assert.notEqual(inboxRead.body.textPath, archiveRead.body.textPath);
    assert.equal((await readFile(inboxRead.body.textPath, 'utf8')).startsWith('A'), true);
    assert.equal((await readFile(archiveRead.body.textPath, 'utf8')).startsWith('B'), true);
    assert.equal(inboxRead.body.attachments.length, 2);
    const saved = [];
    for (const part of inboxRead.body.attachments) {
      const result = await tool(active, 'Mailbox', {
        action: 'attachment', accountId: 'ada', mailbox: 'INBOX', uidValidity: '7', uid: '1', partId: part.partId,
      });
      assert.equal(result.isError, false, JSON.stringify(result.body));
      saved.push(result.body);
    }
    assert.equal(saved[0].path.includes(`${path.sep}${saved[0].partId}${path.sep}`), true);
    assert.equal(saved[1].path.includes(`${path.sep}${saved[1].partId}${path.sep}`), true);
    assert.notEqual(saved[0].path, saved[1].path);
    assert.equal((await readFile(saved[0].path)).toString('utf8'), 'alpha');
    assert.equal((await readFile(saved[1].path)).toString('utf8'), 'beta');
    const other = await tool(active, 'Mailbox', {
      action: 'attachment', accountId: 'ada', mailbox: 'Archive', uidValidity: '7', uid: '1', partId: archiveRead.body.attachments[0].partId,
    });
    assert.equal(other.body.path.includes(`${path.sep}Archive`), true);
    assert.notEqual(other.body.path, saved[0].path);
    assert.equal((await readFile(other.body.path)).toString('utf8'), 'gamma');
  } finally {
    await active.stop();
  }
});

test('IMAP without STARTTLS does not send LOGIN or AUTH', { timeout: 20000 }, async () => {
  const active = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(active, account(active.fx, 'ada', { allowInsecureAuth: false }));
    const tested = await tool(active, 'MailAccount', { action: 'test', accountId: 'ada' });
    assert.equal(tested.body.code, 'tls_required', JSON.stringify(tested.body));
    assert.equal(active.fx.state.imapAuthCommands, 0);
    assert.equal(tested.body.message.includes(PASS), false);
  } finally {
    await active.stop();
  }
});
