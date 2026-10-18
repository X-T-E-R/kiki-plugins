import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mailServiceForTests } from '../entry.mjs';
import { startFixture } from './fixture.mjs';

const PASS = 'panel-secret-pass';

test('mail panel saves, tests, and does not resend an uncertain message', { timeout: 20000 }, async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  assert.equal(html.includes('Connected'), false);
  assert.equal(html.includes('OAuth connected'), false);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const fx = await startFixture({
    dropAfterData: true,
    users: [{ user: 'ada@example.test', password: PASS, mailboxes: { INBOX: { uidValidity: 7, messages: [] } } }],
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-panel-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const service = mailServiceForTests();
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
  await service.activate(context);
  const elements = new Map();
  const element = () => ({ value: '', checked: false, disabled: false, hidden: false, textContent: '' });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const requests = [];
  let receive;
  const parent = {
    postMessage(request) {
      assert.equal(request.channel, 'kiki.panel.v1');
      assert.equal(request.method, 'plugin.call');
      assert.equal(Number.isSafeInteger(request.id), true);
      requests.push(request);
      queueMicrotask(async () => {
        const result = await service.panel(request.action, request.args, context);
        receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: true, result } });
      });
    },
  };
  try {
    runInNewContext(script, {
      document: { getElementById: get },
      window: { addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; } },
      parent,
      crypto: { randomUUID: () => 'panel-request-1' },
    });
    receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'init' } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get('status').textContent, 'Not tested');
    assert.equal(get('im').textContent.includes('unsupported'), true);
    assert.equal(get('sendAgain').hidden, true);

    get('id').value = 'ada';
    get('label').value = 'Ada';
    get('user').value = 'ada@example.test';
    get('from').value = 'Ada <ada@example.test>';
    get('preset').value = 'custom';
    get('auth').value = 'password';
    get('imapHost').value = '127.0.0.1';
    get('imapPort').value = String(fx.imapPort);
    get('smtpHost').value = '127.0.0.1';
    get('smtpPort').value = String(fx.smtpPort);
    get('imapSecure').checked = false;
    get('smtpSecure').checked = false;
    get('allowInsecure').checked = true;
    get('password').value = PASS;
    await get('save').onclick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get('password').value, '');
    assert.equal(get('accounts').textContent.includes('Password saved'), true);
    assert.equal(get('accounts').textContent.includes(PASS), false);
    assert.equal(get('status').textContent.includes(PASS), false);
    assert.equal(JSON.parse(settings.credentials).ada.password, PASS);
    const saveCall = requests.find((request) => request.action === 'save');
    assert.equal(saveCall.args.credential.password, PASS);

    await get('test').onclick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get('status').textContent.includes('accepted the saved password'), true);
    assert.equal(/\bconnected\b/i.test(get('status').textContent), false);
    assert.equal(get('result').textContent.includes(PASS), false);
    assert.equal(fx.state.smtpData, 0);

    get('to').value = 'bea@example.test';
    get('subject').value = 'Panel note';
    get('text').value = 'From the panel';
    await get('send').onclick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get('sendAgain').hidden, true);
    assert.equal(fx.state.smtpData, 1);
    const sendCalls = () => requests.filter((request) => request.action === 'send');
    assert.equal(sendCalls().length, 1);
    assert.equal(sendCalls()[0].args.requestId, 'panel-request-1');
    assert.equal(sendCalls()[0].args.confirmResend, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fx.state.smtpData, 1);
    assert.equal(sendCalls().length, 1);
    assert.equal(requests.every((request) => request.method === 'plugin.call'), true);
  } finally {
    await service.deactivate();
    await fx.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function createDomHarness() {
  const elements = new Map();
  const makeNode = (tag = 'div', id = '') => {
    const attrs = new Map();
    const styleProps = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      id,
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      open: false,
      className: '',
      textContent: '',
      lang: 'en',
      dataset: {},
      children: [],
      style: {
        setProperty(k, v) { styleProps.set(k, v); },
        getPropertyValue(k) { return styleProps.get(k) || ''; },
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      append(...nodes) { this.children.push(...nodes); },
      focus() { node.focused = true; },
    };
    return node;
  };
  const documentElement = makeNode('html', 'root');
  const get = (id) => {
    if (!elements.has(id)) {
      const node = makeNode('div', id);
      if (id === 'mailbox') node.value = 'INBOX';
      if (id === 'limit') node.value = '20';
      if (id === 'preset') node.value = 'custom';
      if (id === 'auth') node.value = 'password';
      elements.set(id, node);
    }
    return elements.get(id);
  };
  return {
    elements,
    get,
    document: {
      documentElement,
      getElementById: get,
      createElement: (tag) => makeNode(tag),
      querySelectorAll: () => [],
    },
  };
}

test('mail panel supports humanized multi-account switching, presets, folder/message browsing, attachments, reply binding, and pre-DATA retry', { timeout: 25000 }, async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const longBody = `Line 1 with   internal   spaces\r\nLine 2\r\n${'A'.repeat(20_500)}`;
  const msg1Raw = [
    'From: Beaumont <bea@example.test>',
    'To: Ada <ada@example.test>',
    'Subject: Quarterly Plan',
    'Date: Sun, 18 Oct 2026 09:00:00 +0000',
    'Message-ID: <msg-1@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    longBody,
    '--b1',
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    '',
    'Attached note bytes',
    '--b1--',
    '',
  ].join('\r\n');

  const msg2Raw = [
    'From: Carol <carol@example.test>',
    'To: Ada <ada@example.test>',
    'Subject: Second Item',
    'Date: Sun, 18 Oct 2026 10:00:00 +0000',
    'Message-ID: <msg-2@example.test>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Short second message.',
    '',
  ].join('\r\n');

  const fx = await startFixture({
    users: [
      {
        user: 'ada@example.test',
        password: PASS,
        mailboxes: {
          INBOX: {
            uidValidity: 7,
            messages: [
              { uid: 10, flags: [], raw: Buffer.from(msg1Raw, 'utf8') },
              { uid: 11, flags: ['\\Seen'], raw: Buffer.from(msg2Raw, 'utf8') },
            ],
          },
          Archive: {
            uidValidity: 99,
            messages: [],
          },
        },
      },
      {
        user: 'bob@example.test',
        password: PASS,
        mailboxes: {
          INBOX: { uidValidity: 12, messages: [] },
        },
      },
    ],
  });

  const dir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-panel-human-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const service = mailServiceForTests();
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
  await service.activate(context);

  const { get, document } = createDomHarness();
  const requests = [];
  let receive;
  let uuidSeq = 0;
  let holdSendResponse = null;
  let rejectNextSendPreData = false;

  const parent = {
    postMessage(request) {
      requests.push(request);
      queueMicrotask(async () => {
        if ((request.action === 'send' || request.action === 'reply') && rejectNextSendPreData) {
          rejectNextSendPreData = false;
          const result = {
            ok: false,
            outcome: 'rejected',
            code: 'smtp_rejected',
            message: 'SMTP recipient rejected before DATA (550). Safe to retry after fixing recipient.',
            requestId: request.args.requestId,
          };
          receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: true, result } });
          return;
        }
        const result = await service.panel(request.action, request.args, context);
        const deliver = () => receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: true, result } });
        if ((request.action === 'send' || request.action === 'reply') && holdSendResponse) {
          holdSendResponse(deliver);
          holdSendResponse = null;
        } else {
          deliver();
        }
      });
    },
  };

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  try {
    runInNewContext(script, {
      document,
      window: { addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; } },
      navigator: { language: 'en-US' },
      parent,
      crypto: { randomUUID: () => `req-uuid-${++uuidSeq}` },
    });

    receive({
      source: parent,
      data: {
        channel: 'kiki.panel.v1',
        kind: 'init',
        presentation: { locale: 'zh-CN', theme: 'dark', tokens: { '--color-accent': '#c8401a' } },
      },
    });
    await flush();
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(document.documentElement.style.getPropertyValue('--color-accent'), '#c8401a');

    // Toggle back to English so status assertions match English copy
    get('langToggle').onclick();
    assert.equal(document.documentElement.lang, 'en');

    // 1. Preset & conditional auth visibility
    get('preset').value = 'outlook';
    get('preset').onchange();
    assert.equal(get('auth').value, 'oauth2');
    assert.equal(get('passwordGroup').hidden, true);
    assert.equal(get('oauthGroup').hidden, false);
    assert.equal(get('imapHost').value, 'outlook.office365.com');

    get('preset').value = 'gmail';
    get('preset').onchange();
    assert.equal(get('auth').value, 'password');
    assert.equal(get('imapHost').value, 'imap.gmail.com');
    assert.equal(get('passwordGroup').hidden, false);
    assert.equal(get('oauthGroup').hidden, true);

    get('preset').value = 'custom';
    get('preset').onchange();

    // 2. Failed save preserves user inputs
    get('user').value = 'ada@example.test';
    get('label').value = 'Ada Work';
    get('imapHost').value = '';
    get('smtpHost').value = '';
    get('password').value = PASS;
    await get('save').onclick();
    await flush();
    assert.equal(get('user').value, 'ada@example.test');
    assert.equal(get('label').value, 'Ada Work');
    assert.equal(get('password').value, PASS);

    // 3. Save two accounts (ada and bob)
    get('id').value = 'ada';
    get('imapHost').value = '127.0.0.1';
    get('imapPort').value = String(fx.imapPort);
    get('smtpHost').value = '127.0.0.1';
    get('smtpPort').value = String(fx.smtpPort);
    get('imapSecure').checked = false;
    get('smtpSecure').checked = false;
    get('allowInsecure').checked = true;
    await get('save').onclick();
    await flush();
    assert.equal(get('password').value, '');
    assert.equal(get('secretStatus').hidden, false);
    assert.equal(get('secretStatus').textContent.includes('Password saved'), true);

    get('newAccount').onclick();
    get('id').value = 'bob';
    get('label').value = 'Bob Personal';
    get('user').value = 'bob@example.test';
    get('preset').value = 'custom';
    get('auth').value = 'password';
    get('imapHost').value = '127.0.0.1';
    get('imapPort').value = String(fx.imapPort);
    get('smtpHost').value = '127.0.0.1';
    get('smtpPort').value = String(fx.smtpPort);
    get('imapSecure').checked = false;
    get('smtpSecure').checked = false;
    get('allowInsecure').checked = true;
    get('password').value = PASS;
    await get('save').onclick();
    await flush();
    assert.equal(get('accountList').children.length, 2);
    assert.equal(get('accountSelect').children.length, 2);

    // Switch back to ada via account pill
    get('accountList').children[0].onclick();
    assert.equal(get('id').value, 'ada');

    // 4. Browse folders and paginate messages
    await get('folders').onclick();
    await flush();
    assert.equal(get('folderList').children.length, 2);

    get('limit').value = '1';
    await get('search').onclick();
    await flush();
    assert.equal(get('messageList').children.length, 1);
    assert.equal(get('nextPage').disabled, false);
    assert.equal(get('prevPage').disabled, true);

    // Next page -> UID 10 (msg1 with attachment and >4000 char body)
    await get('nextPage').onclick();
    await flush();
    assert.equal(get('prevPage').disabled, false);
    assert.equal(get('messageList').children.length, 1);

    // 5. Click message row to read message, verify preview notice & attachment save
    await get('messageList').children[0].onclick();
    await flush();
    assert.equal(get('messageView').hidden, false);
    assert.equal(get('readSubject').textContent, 'Quarterly Plan');
    assert.equal(get('readBody').textContent.includes('Line 1 with   internal   spaces'), true);
    assert.equal(get('readCompleteness').hidden, false);
    assert.equal(get('readCompleteness').textContent.includes('Complete message bytes saved at:'), true);
    assert.equal(get('attachmentList').hidden, false);
    assert.equal(get('attachmentList').children.length, 1);

    // Save attachment via button inside attachmentList
    const saveAttBtn = get('attachmentList').children[0].children[1];
    await saveAttBtn.onclick();
    await flush();
    assert.equal(get('attachmentStatus').hidden, false);
    assert.equal(get('attachmentStatus').textContent.includes('notes.txt'), true);

    // 6. Bind reply target from reader and verify reply banner
    get('replyFromRead').onclick();
    assert.equal(get('replyTargetBar').hidden, false);
    assert.equal(get('uid').value, '10');
    assert.equal(get('uidValidity').value, '7');
    assert.equal(get('to').value.includes('bea@example.test'), true);
    assert.equal(get('subject').value, 'Re: Quarterly Plan');

    // 7. Cross-account switch clears mailbox/UID/UIDVALIDITY/cursor/requestId state
    get('accountSelect').value = 'bob';
    get('accountSelect').onchange();
    assert.equal(get('id').value, 'bob');
    assert.equal(get('uid').value, '');
    assert.equal(get('uidValidity').value, '');
    assert.equal(get('cursor').value, '');
    assert.equal(get('messageView').hidden, true);
    assert.equal(get('replyTargetBar').hidden, true);

    // Switch back to ada and re-bind reply target for UID 10
    get('accountSelect').value = 'ada';
    get('accountSelect').onchange();
    await get('search').onclick();
    await flush();
    await get('nextPage').onclick();
    await flush();
    await get('messageList').children[0].onclick();
    await flush();
    get('replyFromRead').onclick();
    assert.equal(get('uid').value, '10');
    assert.equal(get('uidValidity').value, '7');

    // 8. Body whitespace trim note visibility
    get('text').value = '  Hello with outer spaces  ';
    get('text').oninput();
    assert.equal(get('bodyTrimNote').hidden, false);
    get('text').value = 'Hello without outer spaces';
    get('text').oninput();
    assert.equal(get('bodyTrimNote').hidden, true);

    // 9. Pre-DATA rejected outcome unhides Send again & reuses exact same requestId
    rejectNextSendPreData = true;
    await get('reply').onclick();
    await flush();
    assert.equal(get('sendAgain').hidden, false);
    const replyCalls = () => requests.filter((r) => r.action === 'reply');
    assert.equal(replyCalls().length, 1);
    const firstReplyReqId = replyCalls()[0].args.requestId;
    assert.equal(replyCalls()[0].args.confirmResend, false);
    assert.equal(replyCalls()[0].args.uid, '10');
    assert.equal(replyCalls()[0].args.uidValidity, '7');

    // Retry via Send again -> reuses firstReplyReqId with confirmResend: true while holding response to verify in-flight mutual exclusion
    let releaseInFlight;
    const inFlightReady = new Promise((resolve) => {
      holdSendResponse = (deliver) => {
        releaseInFlight = deliver;
        resolve();
      };
    });
    const retryPromise = get('sendAgain').onclick();
    assert.equal(get('send').disabled, true);
    assert.equal(get('reply').disabled, true);
    assert.equal(get('sendAgain').disabled, true);
    // Attempt concurrent click while in flight -> must be ignored
    void get('send').onclick();
    assert.equal(replyCalls().length, 2);
    await inFlightReady;
    releaseInFlight();
    await retryPromise;
    await flush();

    assert.equal(replyCalls()[1].args.requestId, firstReplyReqId);
    assert.equal(replyCalls()[1].args.confirmResend, true);
    assert.equal(get('sendAgain').hidden, true);
    assert.equal(get('send').disabled, false);
    assert.equal(get('reply').disabled, false);
    assert.equal(fx.state.smtpData, 1);

    // 10. Delete bob account and verify remaining account ada stays active
    get('accountSelect').value = 'bob';
    get('accountSelect').onchange();
    await get('remove').onclick();
    await flush();
    assert.equal(get('accountList').children.length, 1);
    assert.equal(get('id').value, 'ada');
  } finally {
    await service.deactivate();
    await fx.close();
    await rm(dir, { recursive: true, force: true });
  }
});

