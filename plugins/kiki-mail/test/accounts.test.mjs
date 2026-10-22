import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { mergeCredential, normalizeAccount } from '../lib/accounts.mjs';
import { connectionAccount, mappedMailboxes } from '../lib/custom.mjs';
import { beginAuthorization, createPkce, exchangeAuthorizationCode, resolveAuth, startLoopbackAuthorization } from '../lib/oauth.mjs';
import { withImap } from '../lib/imap.mjs';
import { startFixture } from './fixture.mjs';

const account = (extra = {}) => ({ id: 'work', user: 'work@example.test', preset: 'gmail', ...extra });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokens = { access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 900, token_type: 'Bearer' };

test('account notes and custom declarations are normalized, bounded and never execute code', async () => {
  const normalized = normalizeAccount(account({ note: '  Research team  ', imapId: { name: 'Lab Mail', version: '3.4' }, folders: { sent: 'Team/Sent', archive: 'Team/Archive' }, headers: { 'X-Project': 'Research' }, hooks: [{ event: 'beforeConnect', action: 'setTimeout', value: 4200 }, { event: 'afterSend', action: 'recordEvent', value: 'audit' }] }));
  assert.equal(normalized.note, 'Research team');
  assert.equal(connectionAccount(normalized).timeoutMs, 4200);
  assert.equal(mappedMailboxes(normalized, [{ path: 'Team/Sent', specialUse: '' }])[0].specialUse, '\\Sent');
  for (const patch of [
    { note: 'a'.repeat(201) }, { imapId: { eval: 'bad' } }, { folders: { inbox: 'elsewhere' } }, { headers: { Authorization: 'secret' } }, { headers: { 'X-Token': 'secret' } }, { headers: { 'X-Team': 'a\r\nBcc: bad' } }, { hooks: [{ event: 'beforeConnect', action: 'exec', value: 'node evil.mjs' }] }, { hooks: [{ event: 'beforeConnect', action: 'setTimeout', value: 100 }] }, { hooks: [{ event: 'afterSend', action: 'recordEvent', value: 'audit', command: 'bad' }] },
  ]) assert.throws(() => normalizeAccount(account(patch)));
  assert.throws(() => normalizeAccount(account({ password: 'not-a-tool-argument' })), { code: 'credential_in_tool' });
  let seen;
  await withImap(normalized, { user: normalized.user, pass: 'secret' }, { createClient: (config) => { seen = config; return { secureConnection: true, async connect() {}, async logout() {} }; } }, async () => {});
  assert.equal(seen.timeoutMs, 4200);
  assert.equal(seen.imapId.name, 'Lab Mail');
});

test('PKCE, code exchange, callback state and refresh rotation follow the provider response', async () => {
  const pkce = createPkce();
  assert.equal(pkce.verifier.length, 43);
  assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('base64url'));
  const config = normalizeAccount(account({ auth: 'oauth2', oauthClientId: 'public-client' }));
  const session = beginAuthorization(config, 'http://127.0.0.1:54321/oauth/callback');
  const url = new URL(session.authorizationUrl);
  assert.equal(url.protocol, 'https:');
  assert.equal(mergeCredential({ accessToken: 'old', accessTokenExpiresAt: 1 }, { accessToken: 'replacement' }).accessTokenExpiresAt, undefined);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('login_hint'), config.user);
  let calls = 0;
  let patch;
  const fetch = async (_url, input) => { calls++; assert.equal(input.body.get('code_verifier'), session.verifier); assert.equal(input.body.get('client_secret'), null); return response(tokens); };
  await assert.rejects(exchangeAuthorizationCode(config, {}, session, { state: 'wrong', code: 'code' }, () => {}, { fetch }), { code: 'oauth_state_invalid' });
  assert.equal(calls, 0);
  await exchangeAuthorizationCode(config, {}, session, { state: session.state, code: 'code' }, (value) => { patch = value; }, { fetch });
  assert.equal(patch.refreshToken, tokens.refresh_token);
  assert.ok(patch.accessTokenExpiresAt > Date.now() + 890000);
  let attempts = 0;
  const refreshed = await resolveAuth(config, { refreshToken: 'old-refresh', accessToken: 'expired', accessTokenExpiresAt: 1 }, (value) => { patch = value; }, { delay: async () => {}, fetch: async (_url, input) => {
    attempts++;
    assert.equal(input.body.get('grant_type'), 'refresh_token');
    assert.equal(input.body.get('refresh_token'), 'old-refresh');
    return attempts === 1 ? response({}, 503) : response(tokens);
  } });
  assert.equal(attempts, 2);
  assert.equal(refreshed.accessToken, tokens.access_token);
  assert.equal(patch.refreshToken, tokens.refresh_token);
  await assert.rejects(resolveAuth(config, { refreshToken: 'revoked' }, () => {}, { fetch: async () => response({ error: 'invalid_grant', error_description: 'secret must not leak' }, 400) }), { code: 'oauth_reauthorize' });
});

test('OAuth loopback and pasted callbacks require real exchange; cancellation, timeout and replay do not authorize', async () => {
  const config = normalizeAccount(account({ auth: 'oauth2', oauthClientId: 'public-client' }));
  let stored = 0;
  const flow = await startLoopbackAuthorization(config, {}, () => { stored++; }, { fetch: async () => response(tokens) });
  try {
    assert.equal((await flow.inspect()).phase, 'waiting');
    const url = new URL(flow.authorizationUrl);
    const callback = new URL(flow.redirectUri);
    callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'real-code');
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(stored, 0);
    callback.searchParams.set('state', url.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
    assert.equal((await flow.inspect()).phase, 'authorized');
    assert.equal(stored, 1);
    await assert.rejects(flow.complete({ callbackUrl: callback.href }), { code: 'oauth_expired' });
  } finally { flow.cancel(); }
  const manual = await startLoopbackAuthorization(config, {}, () => { stored++; }, { fetch: async () => response(tokens) });
  try {
    const callback = new URL(manual.redirectUri);
    callback.searchParams.set('state', new URL(manual.authorizationUrl).searchParams.get('state'));
    callback.searchParams.set('code', 'pasted-code');
    await assert.rejects(manual.complete({ callbackUrl: 'javascript:evil' }), { code: 'oauth_callback_invalid' });
    assert.equal((await manual.complete({ callbackUrl: callback.href })).phase, 'authorized');
    assert.equal(stored, 2);
  } finally { manual.cancel(); }
  const expired = await startLoopbackAuthorization(config, {}, () => { stored++; }, { timeoutMs: 15, fetch: async () => response(tokens) });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await expired.inspect()).phase, 'expired');
  expired.cancel(); assert.equal(stored, 2);
});

test('draft test/save, notes in tools, defaults, summary and secret settings retain their contracts', async () => {
  const fx = await startFixture({ users: [{ user: 'work@example.test', password: 'test-password', mailboxes: { INBOX: { uidValidity: 1, messages: [] }, 'Team/Sent': { uidValidity: 2, messages: [] } } }] });
  const directory = await mkdtemp(path.join(tmpdir(), 'mail-accounts-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const properties = manifest['x-kiki'].settings.schema.properties;
  const service = mailServiceForTests();
  const context = { settings, dataDir: directory, async updateSettings(patch) { for (const key of Object.keys(patch)) assert.ok(properties[key], `undeclared setting ${key}`); Object.assign(settings, patch); } };
  await service.activate(context);
  const config = account({ preset: 'custom', note: 'Research inbox', imapHost: '127.0.0.1', imapPort: fx.imapPort, imapSecure: false, smtpHost: '127.0.0.1', smtpPort: fx.smtpPort, smtpSecure: false, allowInsecureAuth: true, folders: { sent: 'Team/Sent' }, headers: { 'X-Project': 'Research' }, hooks: [{ event: 'afterSend', action: 'recordEvent', value: 'sent-audit' }] });
  try {
    const tested = await service.panel('testDraft', { account: config, credential: { password: 'test-password' } }, context);
    assert.equal(tested.ok, true);
    assert.equal(JSON.stringify(tested).includes('test-password'), false);
    assert.equal(JSON.parse(settings.accounts).length, 0);
    assert.equal((await service.panel('save', { account: { ...config, note: 'Changed' }, draftId: tested.draftId }, context)).code, 'draft_expired');
    assert.equal((await service.panel('save', { account: config, draftId: tested.draftId }, context)).ok, true);
    assert.equal(JSON.parse(settings.credentials).work.password, 'test-password');
    const result = JSON.parse((await service.tool('MailAccount', { action: 'show', accountId: 'work' }, context)).output);
    assert.equal(result.account.note, 'Research inbox');
    assert.equal(result.account.lastTest.ok, true);
    assert.equal(result.account.isDefault, true);
    const folders = await service.panel('folders', { accountId: 'work' }, context);
    assert.equal(folders.mailboxes.find((box) => box.path === 'Team/Sent').specialUse, '\\Sent');
    const alias = await service.panel('search', { accountId: 'work', mailbox: 'sent' }, context);
    assert.equal(alias.mailbox, 'Team/Sent');
    await service.panel('save', { account: { ...config, id: 'other', note: 'Another inbox' }, credential: { password: 'test-password' } }, context);
    await service.panel('default', { accountId: 'other' }, context);
    let state = await service.panel('state', {}, context);
    assert.equal(state.summary.accountCount, 2);
    assert.equal(state.summary.defaultAccountId, 'other');
    assert.equal(state.summary.lastTest.ok, true);
    await service.panel('delete', { accountId: 'other' }, context);
    state = await service.panel('state', {}, context);
    assert.equal(state.defaultAccountId, 'work');
    const sent = await service.panel('send', { accountId: 'work', requestId: 'custom-send', to: 'reader@example.test', subject: 'Hello', text: 'Body' }, context);
    assert.equal(sent.outcome, 'accepted');
    assert.ok(fx.state.imapIds.some((line) => line.includes('kiki-mail') && line.includes('0.2.0')));
    assert.match(fx.state.smtpMessages[0].raw.toString(), /X-Project: Research/);
    const events = await readFile(path.join(directory, 'events', 'work.jsonl'), 'utf8');
    assert.match(events, /sent-audit/);
    assert.equal(properties.accounts.hidden, true);
    assert.equal(properties.credentials.secret, true);
    assert.equal(properties.credentials.hidden, true);
    const edited = await service.panel('save', { account: { ...config, note: 'Revised note' } }, context);
    assert.equal(edited.account.lastTest.ok, true);
    service.recordEvent = async () => { throw new Error('event disk unavailable'); };
    const warning = await service.panel('send', { accountId: 'work', requestId: 'hook-error', to: 'reader@example.test', subject: 'Hello again', text: 'Body' }, context);
    assert.equal(warning.outcome, 'accepted');
    assert.equal(warning.receiptStored, true);
    assert.equal(warning.hookWarnings.length, 1);
    assert.equal((await service.panel('send', { accountId: 'work', requestId: 'hook-error', to: 'reader@example.test', subject: 'Hello again', text: 'Body' }, context)).code, 'already_accepted');
    await service.panel('save', { account: config, credential: { password: 'wrong-password' } }, context);
    assert.equal((await service.panel('test', { accountId: 'work' }, context)).ok, false);
    assert.equal((await service.panel('state', {}, context)).summary.lastTest.ok, false);
  } finally { await service.deactivate(); await fx.close(); await rm(directory, { recursive: true, force: true }); }
});


test('concurrent OAuth consumers share refresh and each retains rotated credentials across accounts', async () => {
  const configs = ['a', 'b'].map((id) => normalizeAccount(account({ id, auth: 'oauth2', oauthClientId: 'public-client' })));
  const settings = { accounts: JSON.stringify(configs), credentials: JSON.stringify({ a: { refreshToken: 'old-a' }, b: { refreshToken: 'old-b' } }) };
  const calls = [];
  const service = mailServiceForTests({ oauthFetch: async (_url, input) => { calls.push(input.body.get('refresh_token')); await new Promise(setImmediate); return response(tokens); } });
  const context = { settings, dataDir: '.', async updateSettings(values) { Object.assign(settings, values); } };
  await service.activate(context);
  let draftCredential;
  const snapshot = () => ({ settings: { ...settings } });
  try {
    await Promise.all([
      service.auth(configs[0], { refreshToken: 'old-a' }, snapshot()),
      service.auth(configs[0], { refreshToken: 'old-a' }, snapshot(), (patch) => { draftCredential = patch; }),
      service.auth(configs[1], { refreshToken: 'old-b' }, snapshot()),
    ]);
    assert.deepEqual(calls.sort(), ['old-a', 'old-b']);
    assert.equal(draftCredential.refreshToken, tokens.refresh_token);
    assert.equal(JSON.parse(settings.credentials).a.refreshToken, tokens.refresh_token);
    assert.equal(JSON.parse(settings.credentials).b.refreshToken, tokens.refresh_token);
  } finally { await service.deactivate(); }
});
