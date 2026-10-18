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
    assert.equal(get('sendAgain').hidden, false);
    assert.equal(fx.state.smtpData, 1);
    const sendCalls = () => requests.filter((request) => request.action === 'send');
    assert.equal(sendCalls().length, 1);
    assert.equal(sendCalls()[0].args.requestId, 'panel-request-1');
    assert.equal(sendCalls()[0].args.confirmResend, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fx.state.smtpData, 1);
    assert.equal(sendCalls().length, 1);

    await get('sendAgain').onclick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sendCalls().length, 2);
    assert.equal(sendCalls()[1].args.requestId, 'panel-request-1');
    assert.equal(sendCalls()[1].args.confirmResend, true);
    assert.equal(fx.state.smtpData, 2);
    assert.equal(requests.every((request) => request.method === 'plugin.call'), true);
  } finally {
    await service.deactivate();
    await fx.close();
    await rm(dir, { recursive: true, force: true });
  }
});
