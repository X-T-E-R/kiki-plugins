import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { safeSegment, storageKey } from '../lib/paths.mjs';
import { readEvents } from '../lib/service.mjs';
import { startFixture } from './fixture.mjs';

const PASS = 'durability-secret-pass';

function message({ id, text, filename = 'note.txt', body = 'note' }) {
  const headers = [
    'From: Bea <bea@example.test>',
    'To: Ada <ada@example.test>',
    'Subject: Durability',
    'Date: Mon, 18 Oct 2026 01:00:00 +0000',
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="kiki-durability"',
    '',
    '--kiki-durability',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '--kiki-durability',
    'Content-Type: application/octet-stream',
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64'),
    '--kiki-durability--',
    '',
  ];
  return Buffer.from(headers.join('\r\n'));
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
  const dir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-durability-'));
  let fx;
  try {
    fx = await startFixture(spec);
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
    await service.activate(context);
    return {
      fx, dir, settings, service, context,
      async stop() {
        await service.deactivate();
        await fx.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fx?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function tool(service, context, name, args, signal = context.signal) {
  const result = await service.tool(name, args, { ...context, signal });
  return { isError: result.isError === true, body: JSON.parse(result.output) };
}

async function save(active, value, extra = {}) {
  const saved = await active.service.panel('save', {
    account: value,
    credential: { password: PASS },
    ...extra,
  }, active.context);
  assert.equal(saved.ok, true, JSON.stringify(saved));
}

async function waitFor(check, label) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function receiptPath(dir, accountId, requestId) {
  return path.join(dir, 'sends', accountId, `${storageKey(requestId, 'send')}.json`);
}

async function plant(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(record)}\n`;
  await writeFile(file, bytes);
  return bytes;
}

function parkedWait() {
  const waits = [];
  const parked = [];
  return {
    waits,
    wait(ms, signal) {
      waits.push(ms);
      return new Promise((resolve) => {
        if (signal?.aborted) { resolve(true); return; }
        const finish = (aborted) => resolve(aborted === true);
        parked.push(finish);
        signal?.addEventListener('abort', () => finish(true), { once: true });
      });
    },
    release() {
      const finish = parked.shift();
      if (!finish) throw new Error('no parked watch wait');
      finish(false);
    },
  };
}

test('a failed receipt replace keeps the accepted fact and a fresh service does not resend', { timeout: 20000 }, async () => {
  const active = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  const requestId = 'replace-window';
  let fresh;
  try {
    await save(active, account(active.fx));
    const sent = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Kept', text: 'Kept', requestId,
    });
    assert.equal(sent.isError, false, JSON.stringify(sent.body));
    assert.equal(sent.body.outcome, 'accepted');
    assert.equal(active.fx.state.smtpData, 1);
    const file = receiptPath(active.dir, 'ada', requestId);
    const original = await readFile(file, 'utf8');
    assert.equal(original.includes('"outcome":"accepted"'), true);
    active.service.deps.failReceiptInstall = true;
    await assert.rejects(
      () => active.service.writeSend('ada', requestId, {
        phase: 'done', outcome: 'failed', requestId, accountId: 'ada', marker: 'REPLACE-SHOULD-NOT-LAND',
      }, active.context),
      (error) => error?.code === 'send_store_failed' && error.message === 'The send receipt could not be replaced.',
    );
    const backup = await readFile(`${file}.bak`, 'utf8');
    assert.equal(backup, original);
    await assert.rejects(() => readFile(file, 'utf8'), (error) => error?.code === 'ENOENT');
    assert.equal(backup.includes('REPLACE-SHOULD-NOT-LAND'), false);
    await active.service.deactivate();
    fresh = mailServiceForTests({});
    await fresh.activate(active.context);
    const again = await tool(fresh, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Kept', text: 'Kept', requestId,
    });
    assert.equal(again.body.code, 'already_accepted', JSON.stringify(again.body));
    assert.equal(again.body.resent, false);
    assert.equal(active.fx.state.smtpData, 1);
    assert.equal(await readFile(`${file}.bak`, 'utf8'), original);
  } finally {
    await fresh?.deactivate();
    await active.stop();
  }
});

test('legacy flat and nested receipts block the same account without dropping bytes or blocking another account', { timeout: 20000 }, async () => {
  const active = await session({
    users: [
      { user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } },
      { user: 'bea@example.test', password: PASS, mailboxes: { INBOX: box([]) } },
    ],
  });
  const flatId = 'flat-req';
  const nestedId = 'nest-req';
  try {
    await save(active, account(active.fx, 'ada'));
    await save(active, account(active.fx, 'bea'));
    const flatFile = path.join(active.dir, 'sends', `${safeSegment(flatId, 'send')}.json`);
    const nestedFile = path.join(active.dir, 'sends', safeSegment('ada', 'account'), `${safeSegment(nestedId, 'send')}.json`);
    const flatBytes = await plant(flatFile, {
      phase: 'done', outcome: 'accepted', requestId: flatId, accountId: 'ada', fingerprint: 'legacy-flat',
    });
    const nestedBytes = await plant(nestedFile, {
      phase: 'sending', requestId: nestedId, accountId: 'ada',
    });
    const flatSend = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'cy@example.test', subject: 'Other', text: 'Other', requestId: flatId,
    });
    assert.equal(flatSend.body.code, 'payload_conflict', JSON.stringify(flatSend.body));
    assert.equal(flatSend.body.resent, false);
    const nestedSend = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'cy@example.test', subject: 'Other', text: 'Other', requestId: nestedId,
    });
    assert.equal(nestedSend.body.code, 'uncertain_not_resent', JSON.stringify(nestedSend.body));
    assert.equal(nestedSend.body.outcome, 'uncertain');
    assert.equal(nestedSend.body.resent, false);
    assert.equal(active.fx.state.smtpData, 0);
    assert.equal(await readFile(flatFile, 'utf8'), flatBytes);
    assert.equal(await readFile(nestedFile, 'utf8'), nestedBytes);
    const other = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'bea', to: 'cy@example.test', subject: 'Other', text: 'Other', requestId: flatId,
    });
    assert.equal(other.isError, false, JSON.stringify(other.body));
    assert.equal(other.body.outcome, 'accepted');
    assert.equal(active.fx.state.smtpData, 1);
    assert.equal(await readFile(flatFile, 'utf8'), flatBytes);
    assert.equal(await readFile(nestedFile, 'utf8'), nestedBytes);
  } finally {
    await active.stop();
  }
});

test('a readable receipt with no usable state is unknown, and a pre-DATA failure can still be sent', { timeout: 20000 }, async () => {
  const active = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  const missingId = 'shape-missing';
  const unknownId = 'shape-unknown';
  const retryId = 'shape-retry';
  try {
    await save(active, account(active.fx));
    const missingFile = receiptPath(active.dir, 'ada', missingId);
    const unknownFile = receiptPath(active.dir, 'ada', unknownId);
    const retryFile = receiptPath(active.dir, 'ada', retryId);
    const missingBytes = await plant(missingFile, { requestId: missingId, accountId: 'ada' });
    const unknownBytes = await plant(unknownFile, {
      phase: 'done', outcome: 'queued', requestId: unknownId, accountId: 'ada',
    });
    await plant(retryFile, {
      phase: 'done', outcome: 'failed', requestId: retryId, accountId: 'ada', code: 'send_failed',
    });
    const missing = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'No', text: 'No', requestId: missingId,
    });
    const unknown = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'No', text: 'No', requestId: unknownId,
    });
    assert.equal(missing.isError, true, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'receipt_unreadable');
    assert.equal(missing.body.outcome, 'unknown');
    assert.equal(missing.body.resent, false);
    assert.equal(unknown.body.code, 'receipt_unreadable', JSON.stringify(unknown.body));
    assert.equal(unknown.body.outcome, 'unknown');
    assert.equal(unknown.body.resent, false);
    assert.equal(active.fx.state.smtpData, 0);
    assert.equal(await readFile(missingFile, 'utf8'), missingBytes);
    assert.equal(await readFile(unknownFile, 'utf8'), unknownBytes);
    const retried = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'Yes', text: 'Yes', requestId: retryId,
    });
    assert.equal(retried.isError, false, JSON.stringify(retried.body));
    assert.equal(retried.body.outcome, 'accepted');
    assert.equal(active.fx.state.smtpData, 1);
  } finally {
    await active.stop();
  }
});

test('folder names that safeSegment merges keep distinct body and attachment bytes', { timeout: 20000 }, async () => {
  const left = '项目/A';
  const right = '项目:A';
  assert.equal(safeSegment(left, 'box'), safeSegment(right, 'box'));
  assert.notEqual(storageKey(left, 'box'), storageKey(right, 'box'));
  const active = await session({
    users: [{
      user: 'ada@example.test',
      password: PASS,
      mailboxes: {
        [left]: box([{ uid: 1, flags: [], raw: message({ id: 'left@example.test', text: `A${'x'.repeat(21000)}`, filename: 'report.txt', body: 'alpha' }) }]),
        [right]: box([{ uid: 1, flags: [], raw: message({ id: 'right@example.test', text: `B${'y'.repeat(21000)}`, filename: 'report.txt', body: 'beta' }) }]),
      },
    }],
  });
  try {
    await save(active, account(active.fx));
    const oldPath = path.join(active.dir, 'bodies', 'ada', safeSegment(left, 'box'), '7', '1', 'body.txt');
    await mkdir(path.dirname(oldPath), { recursive: true });
    await writeFile(oldPath, 'kept-old');
    const leftRead = await tool(active.service, active.context, 'Mailbox', {
      action: 'read', accountId: 'ada', mailbox: left, uidValidity: '7', uid: '1',
    });
    const rightRead = await tool(active.service, active.context, 'Mailbox', {
      action: 'read', accountId: 'ada', mailbox: right, uidValidity: '7', uid: '1',
    });
    assert.equal(leftRead.isError, false, JSON.stringify(leftRead.body));
    assert.equal(rightRead.isError, false, JSON.stringify(rightRead.body));
    assert.equal(leftRead.body.textPath.includes(storageKey(left, 'box')), true);
    assert.equal(rightRead.body.textPath.includes(storageKey(right, 'box')), true);
    assert.notEqual(leftRead.body.textPath, rightRead.body.textPath);
    assert.equal((await readFile(leftRead.body.textPath, 'utf8')).startsWith('A'), true);
    assert.equal((await readFile(rightRead.body.textPath, 'utf8')).startsWith('B'), true);
    assert.equal(await readFile(oldPath, 'utf8'), 'kept-old');
    const leftFile = await tool(active.service, active.context, 'Mailbox', {
      action: 'attachment', accountId: 'ada', mailbox: left, uidValidity: '7', uid: '1', partId: leftRead.body.attachments[0].partId,
    });
    const rightFile = await tool(active.service, active.context, 'Mailbox', {
      action: 'attachment', accountId: 'ada', mailbox: right, uidValidity: '7', uid: '1', partId: rightRead.body.attachments[0].partId,
    });
    assert.equal(leftFile.isError, false, JSON.stringify(leftFile.body));
    assert.equal(rightFile.isError, false, JSON.stringify(rightFile.body));
    assert.equal(path.basename(leftFile.body.path), path.basename(rightFile.body.path));
    assert.notEqual(leftFile.body.path, rightFile.body.path);
    assert.equal(leftFile.body.path.includes(`${path.sep}${leftFile.body.partId}${path.sep}`), true);
    assert.equal(rightFile.body.path.includes(storageKey(right, 'box')), true);
    assert.equal(await readFile(leftFile.body.path, 'utf8'), 'alpha');
    assert.equal(await readFile(rightFile.body.path, 'utf8'), 'beta');
    assert.equal(await readFile(oldPath, 'utf8'), 'kept-old');
  } finally {
    await active.stop();
  }
});

test('request ids that safeSegment merges do not share a receipt', { timeout: 20000 }, async () => {
  const left = '项目/A';
  const right = '项目:A';
  assert.equal(safeSegment(left, 'send'), safeSegment(right, 'send'));
  assert.notEqual(storageKey(left, 'send'), storageKey(right, 'send'));
  const active = await session({
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(active, account(active.fx));
    const first = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'One', text: 'One', requestId: left,
    });
    const second = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'cy@example.test', subject: 'Two', text: 'Two', requestId: right,
    });
    assert.equal(first.body.outcome, 'accepted', JSON.stringify(first.body));
    assert.equal(second.body.outcome, 'accepted', JSON.stringify(second.body));
    assert.equal(active.fx.state.smtpData, 2);
    const leftFile = receiptPath(active.dir, 'ada', left);
    const rightFile = receiptPath(active.dir, 'ada', right);
    assert.notEqual(leftFile, rightFile);
    assert.equal(leftFile.includes(`${path.sep}ada${path.sep}`), true);
    assert.equal((await readFile(leftFile, 'utf8')).includes('"text":"One"') || (await readFile(leftFile, 'utf8')).includes('"outcome":"accepted"'), true);
    const leftText = await readFile(leftFile, 'utf8');
    const rightText = await readFile(rightFile, 'utf8');
    assert.equal(leftText.includes(left), true);
    assert.equal(rightText.includes(right), true);
    assert.equal(leftText.includes(right), false);
  } finally {
    await active.stop();
  }
});

test('an in-flight send does not report accepted for a different payload', { timeout: 20000 }, async () => {
  const active = await session({
    holdAfterData: true,
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await save(active, account(active.fx));
    const first = tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'bea@example.test', subject: 'One', text: 'One', requestId: 'same-flight',
    });
    await waitFor(() => active.fx.state.held.length > 0, 'held data');
    assert.equal(active.fx.state.smtpData, 1);
    const second = await tool(active.service, active.context, 'MailSend', {
      action: 'send', accountId: 'ada', to: 'cy@example.test', subject: 'Two', text: 'Two', requestId: 'same-flight',
    });
    assert.equal(second.body.code, 'payload_conflict', JSON.stringify(second.body));
    assert.equal(second.body.outcome, 'uncertain');
    assert.notEqual(second.body.outcome, 'accepted');
    assert.equal(second.body.resent, false);
    assert.equal(second.body.messageId, undefined);
    assert.equal(active.fx.state.smtpData, 1);
    active.fx.releaseHold();
    const done = await first;
    assert.equal(done.body.outcome, 'accepted', JSON.stringify(done.body));
    assert.equal(active.fx.state.smtpData, 1);
  } finally {
    active.fx.releaseHold();
    await active.stop();
  }
});

test('watch keeps reconnecting after more than four drops and close stops it', { timeout: 20000 }, async () => {
  const clock = parkedWait();
  const active = await session({
    dropFirst: 5,
    deps: { wait: clock.wait },
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await active.service.panel('save', {
      account: account(active.fx, 'ada', { watch: true, timeoutMs: 400 }),
      watchEnabled: true,
      credential: { password: PASS },
    }, active.context);
    for (let index = 1; index <= 5; index += 1) {
      await waitFor(() => clock.waits.length >= index, `wait ${index}`);
      assert.equal(clock.waits[index - 1], 1000 * (2 ** (index - 1)));
      clock.release();
    }
    await waitFor(() => active.fx.state.idling > 0, 'healthy idle');
    assert.equal(active.fx.state.imapAccepts, 6);
    assert.equal(clock.waits.length, 5);
    active.fx.dropSockets();
    await waitFor(() => clock.waits.length >= 6, 'reset wait');
    assert.equal(clock.waits[5], 1000);
    const accepts = active.fx.state.imapAccepts;
    await active.service.deactivate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(active.fx.state.imapAccepts, accepts);
    assert.equal(active.fx.state.imapSockets, 0);
  } finally {
    await active.stop();
  }
});

test('authentication and missing STARTTLS stop watch without another wait', { timeout: 20000 }, async () => {
  const authWaits = [];
  const auth = await session({
    failAuth: 'ada@example.test',
    deps: {
      wait(ms, signal) {
        authWaits.push(ms);
        return new Promise((resolve) => {
          if (signal?.aborted) { resolve(true); return; }
          signal?.addEventListener('abort', () => resolve(true), { once: true });
        });
      },
    },
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  const tlsWaits = [];
  const tls = await session({
    deps: {
      wait(ms, signal) {
        tlsWaits.push(ms);
        return new Promise((resolve) => {
          if (signal?.aborted) { resolve(true); return; }
          signal?.addEventListener('abort', () => resolve(true), { once: true });
        });
      },
    },
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: box([]) } }],
  });
  try {
    await auth.service.panel('save', {
      account: account(auth.fx, 'ada', { watch: true, timeoutMs: 400 }),
      watchEnabled: true,
      credential: { password: PASS },
    }, auth.context);
    await waitFor(async () => (await readEvents(auth.dir, 'ada')).some((event) => event.kind === 'watch-stopped' && event.code === 'auth_failed'), 'auth stop');
    assert.equal(authWaits.length, 0);
    assert.equal(auth.fx.state.imapAccepts, 1);

    await tls.service.panel('save', {
      account: account(tls.fx, 'ada', { watch: true, timeoutMs: 400, allowInsecureAuth: false }),
      watchEnabled: true,
      credential: { password: PASS },
    }, tls.context);
    await waitFor(async () => (await readEvents(tls.dir, 'ada')).some((event) => event.kind === 'watch-stopped' && event.code === 'tls_required'), 'tls stop');
    assert.equal(tlsWaits.length, 0);
    assert.equal(tls.fx.state.imapAuthCommands, 0);
  } finally {
    await auth.stop();
    await tls.stop();
  }
});
