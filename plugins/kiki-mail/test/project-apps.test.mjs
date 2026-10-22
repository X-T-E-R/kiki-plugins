import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mailServiceForTests } from '../entry.mjs';
import { startFixture } from './fixture.mjs';

const SECRET = 'project-secret-gmail';
const SECRET_NEXT = 'project-secret-rotated';
const ACCESS = 'inherited-access-token';
const EXPLICIT_SECRET = 'explicit-client-secret';

function rawMessage() {
  return Buffer.from([
    'From: Bea <bea@example.test>',
    'To: One <one@example.test>',
    'Subject: Fixture note',
    'Date: Mon, 18 Oct 2026 01:00:00 +0000',
    'Message-ID: <note-1@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello fixture',
  ].join('\r\n'));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mailbox(id, user, fx, extra = {}) {
  return {
    id,
    user,
    label: id,
    preset: 'gmail',
    auth: 'oauth2',
    imapHost: '127.0.0.1',
    imapPort: fx.imapPort,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: fx.smtpPort,
    smtpSecure: false,
    allowInsecureAuth: true,
    oauthTokenUrl: 'http://127.0.0.1/token',
    ...extra,
  };
}

async function authorize(service, context, account) {
  const started = await service.panel('oauthStart', { account, editingId: account.id }, context);
  assert.equal(started.ok, true, started.message);
  const url = new URL(started.authorizationUrl);
  const callback = new URL(started.redirectUri);
  callback.searchParams.set('code', `code-${account.id}`);
  callback.searchParams.set('state', url.searchParams.get('state'));
  const done = await service.panel('oauthComplete', { flowId: started.flowId, callbackUrl: callback.href }, context);
  assert.equal(done.phase, 'authorized', done.message);
  const tested = await service.panel('testDraft', { account, draftId: started.draftId, editingId: account.id }, context);
  assert.equal(tested.ok, true, tested.message);
  const saved = await service.panel('save', { account, draftId: tested.draftId }, context);
  assert.equal(saved.ok, true, saved.message);
  return { started, url, saved };
}

test('a project OAuth app is inherited by two Gmail mailboxes and never copied into public views', { timeout: 20000 }, async () => {
  const logs = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(originals)) console[level] = (...args) => { logs.push(args.map((item) => String(item)).join(' ')); };
  const fx = await startFixture({
    users: ['one@example.test', 'two@example.test', 'own@example.test'].map((user) => ({
      user,
      accessToken: user.startsWith('own') ? 'explicit-access' : ACCESS,
      mailboxes: { INBOX: { uidValidity: 1, messages: user.startsWith('one') ? [{ uid: 1, flags: [], raw: rawMessage() }] : [] } },
    })),
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'mail-project-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  let projectSecret = SECRET;
  const calls = [];
  const oauthFetch = async (url, input) => {
    const target = String(url);
    if (!target.startsWith('http://127.0.0.1/')) throw new Error(`unexpected oauth url ${target}`);
    const entry = {
      grant: input.body.get('grant_type'),
      client: input.body.get('client_id'),
      secret: input.body.get('client_secret'),
      refresh: input.body.get('refresh_token'),
    };
    calls.push(entry);
    if (!['authorization_code', 'refresh_token'].includes(entry.grant)) throw new Error(`unexpected grant ${entry.grant}`);
    if (entry.grant === 'refresh_token') {
      const expectedSecret = entry.client === 'explicit-client' ? EXPLICIT_SECRET : projectSecret;
      const expectedClient = entry.client === 'explicit-client' || entry.client === 'gmail-client-a' || entry.client === 'gmail-client-b';
      if (!expectedClient || entry.secret !== expectedSecret) return jsonResponse({ error: 'invalid_client' }, 400);
      return jsonResponse({
        access_token: entry.client === 'explicit-client' ? 'explicit-access' : ACCESS,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    return jsonResponse({ access_token: ACCESS, refresh_token: `refresh-${entry.client}`, expires_in: 3600, token_type: 'Bearer' });
  };
  const service = mailServiceForTests({ oauthFetch });
  const context = { settings, dataDir: dir, async updateSettings(patch) { Object.assign(settings, patch); } };
  await service.activate(context);
  try {
    const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
    assert.equal(html.includes(SECRET), false);
    assert.equal(html.includes('openExternal'), false);
    assert.equal(html.includes('window.open'), false);
    const savedApp = await service.panel('appConfig', { provider: 'gmail', clientId: 'gmail-client-a', clientSecret: SECRET }, context);
    assert.equal(savedApp.apps.gmail.configured, true);
    assert.equal(savedApp.apps.gmail.hasSecret, true);
    assert.equal(Object.hasOwn(savedApp.apps.gmail, 'clientSecret'), false);
    assert.equal(JSON.stringify(savedApp).includes(SECRET), false);

    const first = await authorize(service, context, mailbox('one', 'one@example.test', fx));
    assert.equal(first.url.searchParams.get('client_id'), 'gmail-client-a');
    assert.equal(first.saved.account.oauthClientId, '');
    assert.equal(first.saved.account.oauthInherited, true);
    const startedAt = Date.now();
    const second = await authorize(service, context, mailbox('two', 'two@example.test', fx));
    const addMs = Date.now() - startedAt;
    assert.ok(addMs < 30_000, `second mailbox took ${addMs}ms`);
    process.stdout.write(`second-mailbox-ms ${addMs}\n`);
    assert.equal(second.url.searchParams.get('client_id'), 'gmail-client-a');
    assert.equal(second.saved.account.oauthInherited, true);
    const stored = JSON.parse(settings.accounts);
    assert.equal(stored.find((item) => item.id === 'one').oauthClientId, '');
    assert.equal(stored.find((item) => item.id === 'two').oauthClientId, '');
    const creds = JSON.parse(settings.credentials);
    assert.equal(creds.one.clientSecret, undefined);
    assert.equal(creds.two.clientSecret, undefined);
    assert.equal(creds.one.tokenClientId, 'gmail-client-a');
    assert.equal(creds.one.refreshToken, 'refresh-gmail-client-a');

    const read = await service.panel('read', { accountId: 'one', mailbox: 'INBOX', uidValidity: '1', uid: '1' }, context);
    assert.equal(read.ok, true, read.message);
    assert.match(read.text, /Hello fixture/);
    const sent = await service.panel('send', { accountId: 'one', to: 'bea@example.test', subject: 'Hi', text: 'Body', requestId: 'proj-send' }, context);
    assert.equal(sent.outcome, 'accepted');
    assert.equal(fx.state.smtpData, 1);
    const resent = await service.panel('send', { accountId: 'one', to: 'bea@example.test', subject: 'Hi', text: 'Body', requestId: 'proj-send', confirmResend: true }, context);
    assert.equal(resent.code, 'already_accepted');
    assert.equal(fx.state.smtpData, 1);

    const noted = await service.panel('save', { account: { ...mailbox('one', 'one@example.test', fx), note: 'Desk' } }, context);
    assert.equal(noted.ok, true, noted.message);
    assert.equal(JSON.parse(settings.credentials).one.refreshToken, 'refresh-gmail-client-a');
    assert.equal(JSON.parse(settings.accounts).find((item) => item.id === 'one').note, 'Desk');

    await service.panel('save', {
      account: mailbox('own', 'own@example.test', fx, { oauthClientId: 'explicit-client' }),
      credential: { refreshToken: 'explicit-refresh', accessToken: 'old-explicit', accessTokenExpiresAt: 1, clientSecret: EXPLICIT_SECRET, tokenClientId: 'explicit-client' },
    }, context);
    const explicitTest = await service.panel('test', { accountId: 'own' }, context);
    assert.equal(explicitTest.ok, true, explicitTest.message);
    assert.equal(calls.at(-1).client, 'explicit-client');
    assert.equal(calls.at(-1).secret, EXPLICIT_SECRET);

    projectSecret = SECRET_NEXT;
    const rotated = await service.panel('appConfig', { provider: 'gmail', clientId: 'gmail-client-a', clientSecret: SECRET_NEXT }, context);
    assert.equal(rotated.apps.gmail.hasSecret, true);
    assert.equal(JSON.stringify(rotated).includes(SECRET_NEXT), false);
    const live = JSON.parse(settings.credentials);
    live.one.accessTokenExpiresAt = 1;
    settings.credentials = JSON.stringify(live);
    const refreshed = await service.panel('test', { accountId: 'one' }, context);
    assert.equal(refreshed.ok, true, refreshed.message);
    assert.equal(calls.at(-1).client, 'gmail-client-a');
    assert.equal(calls.at(-1).secret, SECRET_NEXT);
    assert.equal(calls.at(-1).refresh, 'refresh-gmail-client-a');

    const pendingAccount = mailbox('pending', 'one@example.test', fx);
    const pending = await service.panel('oauthStart', { account: pendingAccount }, context);
    assert.equal(pending.ok, true, pending.message);
    const callsBeforeLate = calls.length;
    const cleared = await service.panel('appConfig', { provider: 'gmail', clientId: 'gmail-client-a', clearSecret: true }, context);
    assert.equal(cleared.apps.gmail.hasSecret, false);
    assert.equal(cleared.apps.gmail.clientId, 'gmail-client-a');
    assert.equal(JSON.parse(settings.oauthDefaults).gmail.clientSecret, undefined);
    const pendingCallback = new URL(pending.redirectUri);
    pendingCallback.searchParams.set('code', 'late-code');
    pendingCallback.searchParams.set('state', new URL(pending.authorizationUrl).searchParams.get('state'));
    const late = await service.panel('oauthComplete', { flowId: pending.flowId, callbackUrl: pendingCallback.href }, context);
    assert.equal(late.code, 'app_changed');
    assert.equal(calls.length, callsBeforeLate);
    const cancelled = await service.panel('oauthStart', { account: pendingAccount }, context);
    assert.equal((await service.panel('oauthCancel', { flowId: cancelled.flowId }, context)).phase, 'cancelled');
    assert.equal((await service.panel('oauthComplete', { flowId: cancelled.flowId, callbackUrl: pendingCallback.href }, context)).code, 'oauth_expired');

    projectSecret = SECRET_NEXT;
    await service.panel('appConfig', { provider: 'gmail', clientId: 'gmail-client-b', clientSecret: SECRET_NEXT }, context);
    const afterClient = await service.panel('state', {}, context);
    const one = afterClient.accounts.find((item) => item.id === 'one');
    const own = afterClient.accounts.find((item) => item.id === 'own');
    assert.equal(one.oauthStatus, 'reauthorize');
    assert.equal(one.oauthClientId, '');
    assert.equal(one.oauthInherited, true);
    assert.equal(one.lastTest, null);
    assert.equal(own.oauthClientId, 'explicit-client');
    assert.equal(own.oauthInherited, false);
    assert.equal(own.oauthStatus, 'refresh_ready');
    const callsBeforeBlocked = calls.length;
    const blocked = await service.panel('test', { accountId: 'one' }, context);
    assert.equal(blocked.code, 'oauth_reauthorize');
    assert.equal(calls.length, callsBeforeBlocked);
    const ownLive = JSON.parse(settings.credentials);
    ownLive.own.accessTokenExpiresAt = 1;
    settings.credentials = JSON.stringify(ownLive);
    const ownStill = await service.panel('test', { accountId: 'own' }, context);
    assert.equal(ownStill.ok, true, ownStill.message);
    assert.equal(calls.at(-1).client, 'explicit-client');
    assert.equal(calls.at(-1).secret, EXPLICIT_SECRET);
    const relink = await service.panel('oauthStart', { account: mailbox('two', 'two@example.test', fx), editingId: 'two' }, context);
    assert.equal(new URL(relink.authorizationUrl).searchParams.get('client_id'), 'gmail-client-b');
    await service.panel('oauthCancel', { flowId: relink.flowId }, context);

    await service.panel('default', { accountId: 'two' }, context);
    const clearedMailbox = await service.panel('save', {
      account: { ...mailbox('two', 'two@example.test', fx), note: 'Kept' },
      credential: { password: null, clientSecret: null, refreshToken: null, accessToken: null, tokenClientId: null },
    }, context);
    assert.equal(clearedMailbox.ok, true, clearedMailbox.message);
    assert.equal(JSON.parse(settings.credentials).two.refreshToken, undefined);
    assert.equal(JSON.parse(settings.oauthDefaults).gmail.clientSecret, SECRET_NEXT);
    assert.equal(JSON.parse(settings.accounts).find((item) => item.id === 'own').oauthClientId, 'explicit-client');

    const view = await service.panel('state', {}, context);
    const tool = await service.tool('MailAccount', { action: 'list' }, context);
    for (const secret of [SECRET, SECRET_NEXT, EXPLICIT_SECRET, ACCESS]) {
      assert.equal(JSON.stringify(view).includes(secret), false, secret);
      assert.equal(tool.output.includes(secret), false, secret);
      assert.equal(logs.join('\n').includes(secret), false, secret);
    }
    assert.equal(view.defaultAccountId, 'two');
    const clearedView = view.accounts.find((item) => item.id === 'two');
    assert.equal(clearedView.oauthInherited, true);
    assert.equal(clearedView.credentialStored, false);
    assert.equal(clearedView.oauthStatus, 'authorization_required');
  } finally {
    Object.assign(console, originals);
    await service.deactivate();
    await fx.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the panel configures the project once and the next mailbox does not ask for a client ID', async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const service = mailServiceForTests({ oauthFetch: async () => jsonResponse({ access_token: ACCESS, refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' }) });
  const dir = await mkdtemp(path.join(tmpdir(), 'mail-project-panel-'));
  const context = { settings, dataDir: dir, async updateSettings(patch) { Object.assign(settings, patch); } };
  await service.activate(context);
  const elements = new Map();
  const make = (id) => ({
    id, value: '', checked: false, hidden: false, disabled: false, textContent: '', className: '', dataset: {}, children: [], open: false,
    setAttribute() {}, removeAttribute() {}, focus() { this.focused = true; }, append() {}, replaceChildren() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, make(id));
    return elements.get(id);
  };
  let receive;
  const parent = { postMessage(request) {
    queueMicrotask(async () => receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: true, result: await service.panel(request.action, request.args, context) } }));
  } };
  const flush = async () => { for (let n = 0; n < 6; n += 1) await new Promise(setImmediate); };
  try {
    runInNewContext(script, {
      document: { getElementById: get, createElement: () => make(''), querySelectorAll: () => [] },
      window: { addEventListener(_, fn) { receive = fn; } },
      parent,
      URL,
      navigator: { language: 'en', clipboard: { async writeText() {} } },
      crypto: { randomUUID: () => 'panel-project' },
    });
    receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'init' } });
    await flush();
    await get('appGmailSave').onclick();
    await flush();
    assert.equal(get('fieldIssue').hidden, false);
    assert.match(get('fieldIssue').textContent, /client ID/i);
    get('appGmailClientId').value = 'gmail-client-a';
    get('appGmailSecret').value = SECRET;
    await get('appGmailSave').onclick();
    await flush();
    assert.equal(get('appGmailSecret').value, '');
    assert.match(get('appGmailState').textContent, /secret saved/i);
    assert.equal(get('appGmailClientId').value, 'gmail-client-a');
    assert.equal(JSON.stringify(settings).includes('appGmailSecret'), false);
    get('newAccount').onclick();
    get('preset').value = 'gmail';
    get('preset').onchange();
    get('auth').value = 'oauth2';
    get('auth').onchange();
    assert.equal(get('oauthOwnClient').hidden, true);
    assert.equal(get('oauthInheritNote').hidden, false);
    assert.match(get('oauthInheritNote').textContent, /Gmail project/);
    assert.equal(get('oauthClientId').value, '');
    get('user').value = 'two@example.test';
    get('id').value = 'two';
    assert.equal(get('oauthOwnClient').hidden, true);
    await get('appGmailClearSecret').onclick();
    await flush();
    assert.equal(get('appGmailSecret').value, '');
    assert.equal(JSON.parse(settings.oauthDefaults).gmail.clientSecret, undefined);
    assert.equal(JSON.parse(settings.oauthDefaults).gmail.clientId, 'gmail-client-a');
    assert.equal(get('appGmailState').textContent.includes(SECRET), false);
  } finally {
    await service.deactivate();
    await rm(dir, { recursive: true, force: true });
  }
});
