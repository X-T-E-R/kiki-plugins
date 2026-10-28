import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { OfficialBinding } from '../lib/official-binding.mjs';
import { BIND_ACTIONS as actions, OFFICIAL_INSTANCE_ID as instanceId } from '../lib/bind-contract.mjs';

const tick = () => delay(0);
const owner = { instanceId, clientId: 'fixture-page-0001' };
const qr = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture-task&source=kiki-qq&_wv=2';
const candidate = { appId: '92847106', appSecret: 'fixture-only-new-secret' };
const old = { official__appId: '82041957', official__appSecret: 'fixture-only-old-secret', onebot__accessToken: 'fixture-onebot', onebot__selfId: '201', official__intents: 100663296 };
function fixture(t, overrides = {}) {
  const callbacks = [], writes = [], lifetime = new AbortController();
  let settings = { ...old };
  const service = new OfficialBinding({ connect(cb, options) { const item = { cb, options, stopped: false }; callbacks.push(item); return () => { item.stopped = true; }; }, ...overrides });
  const activate = () => service.activate({ settings: { ...settings }, signal: lifetime.signal, updateSettings: async patch => { writes.push(patch); Object.assign(settings, patch); activate(); } });
  activate(); t.after(() => service.deactivate());
  const call = (action, args = {}, context = { settings: { ...settings } }) => service.panel(actions[action], { ...owner, ...args }, context);
  return { service, callbacks, writes, lifetime, call, activate, get settings() { return settings; }, set settings(value) { settings = value; } };
}
const succeed = f => f.callbacks.at(-1).cb.onSuccess([candidate]);
function privateWire(value) {
  const wire = JSON.stringify(value);
  for (const hidden of [candidate.appSecret, old.official__appSecret, old.onebot__accessToken, 'fixture-stack', 'user-openid']) assert.equal(wire.includes(hidden), false, wire);
  for (const key of ['appSecret', 'key', 'stack', 'raw', 'userOpenid']) assert.equal(new RegExp(`"${key}"\\s*:`).test(wire), false, wire);
}

test('activation/status do not start SDK; exact manifest and lifecycle exports are present', async t => {
  const f = fixture(t);
  const before = await f.call('status');
  assert.equal(before.phase, 'idle'); assert.equal(before.configured, true); assert.equal(before.appId, old.official__appId);
  assert.equal(f.callbacks.length, 0); assert.equal(f.writes.length, 0); privateWire(before);
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.4.0'); assert.equal(manifest['x-kiki'].activation, 'app'); assert.equal(manifest['x-kiki'].permissions.uiPanel, true);
  assert.deepEqual(manifest['x-kiki'].panels, [{ schemaVersion: 1, id: 'qq-connection', label: 'QQ connection', slot: 'settings', path: './settings.html' }]);
  const entry = await import('../entry.mjs');
  for (const key of ['activate', 'deactivate', 'handlePanelRequest']) assert.equal(typeof entry[key], 'function');
});

test('SDK success retains only an in-memory candidate; explicit save patches exactly credentials and duplicate saves write once', async t => {
  const f = fixture(t), started = await f.call('start');
  assert.match(started.requestId, /^[a-f0-9-]{36}$/); assert.equal(started.phase, 'starting');
  const sdk = f.callbacks[0]; assert.equal(sdk.options.source, 'kiki-qq'); assert.equal(sdk.options.displayQrCodeToConsole, false);
  sdk.cb.onQrDisplayed(qr); await tick();
  const waiting = await f.call('status', { requestId: started.requestId });
  assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.qrUrl, qr); assert.match(waiting.qrDataUrl, /^data:image\/svg\+xml;base64,/); privateWire(waiting);
  succeed(f); sdk.cb.onFailure(new Error('fixture-stack')); sdk.cb.onQrExpired(); sdk.cb.onQrDisplayed(qr);
  const ready = await f.call('status', { requestId: started.requestId });
  assert.equal(ready.phase, 'candidate'); assert.equal(ready.candidateAppId, candidate.appId); assert.equal(ready.appId, old.official__appId); assert.equal(ready.qrUrl, undefined); privateWire(ready);
  assert.deepEqual(f.settings, old); assert.equal(f.writes.length, 0); assert.equal(sdk.stopped, true);
  assert.equal((await f.call('save', { requestId: started.requestId })).phase, 'saved');
  assert.deepEqual(f.writes, [{ official__appId: candidate.appId, official__appSecret: candidate.appSecret }]);
  assert.deepEqual(f.settings, { ...old, official__appId: candidate.appId, official__appSecret: candidate.appSecret });
  assert.equal(f.service.request.candidate, undefined); assert.equal(f.service.request.snapshot, undefined);
  assert.equal((await f.call('save', { requestId: started.requestId })).phase, 'saved'); assert.equal(f.writes.length, 1);
});

test('request ownership rejects wrong instance, page, missing/old id without exposing another request', async t => {
  const f = fixture(t), first = await f.call('start'); succeed(f);
  for (const args of [{ instanceId: 'plugin:kiki-qq/qq-onebot', requestId: first.requestId }, { clientId: 'fixture-page-0002', requestId: first.requestId }, {}, { requestId: 'unknown' }]) {
    const result = await f.call('save', args); assert.equal(result.ok, false); assert.equal(result.requestId, undefined); assert.equal(result.candidateAppId, undefined); privateWire(result);
  }
  assert.equal((await f.call('start', { instanceId: 'another-instance' })).error.code, 'unsupported_instance');
  const second = await f.call('start', { clientId: 'fixture-page-0002' });
  assert.notEqual(second.requestId, first.requestId); assert.equal(f.service.request.candidate, undefined);
  assert.equal((await f.call('save', { requestId: first.requestId })).error.code, 'stale_request');
  assert.equal(f.writes.length, 0);
});

test('status stays read-only and does not adopt callback data or start/save work', async t => {
  const f = fixture(t), start = await f.call('start');
  for (let i = 0; i < 3; i++) assert.equal((await f.call('status', { requestId: start.requestId })).phase, 'starting');
  const request = f.service.request; succeed(f);
  for (let i = 0; i < 3; i++) privateWire(await f.call('status', { requestId: start.requestId, appSecret: 'untrusted', save: true }));
  assert.equal(f.callbacks.length, 1); assert.equal(f.writes.length, 0); assert.equal(request.candidate.appSecret, candidate.appSecret);
  const general = await f.call('status'); assert.equal(general.phase, 'idle'); assert.equal(general.requestId, undefined);
});

test('expiry, cancel, refresh and teardown fence all late callbacks and async rendering', async t => {
  let resolveQr;
  const f = fixture(t, { renderQr: () => new Promise(resolve => { resolveQr = resolve; }) });
  const first = await f.call('start'); f.callbacks[0].cb.onQrDisplayed(qr); await tick();
  f.callbacks[0].cb.onQrExpired(); succeed(f); resolveQr('data:image/svg+xml;base64,late'); await tick();
  assert.equal((await f.call('status', { requestId: first.requestId })).phase, 'expired'); assert.equal(f.service.request.candidate, undefined);
  const second = await f.call('start'); succeed(f); await f.call('cancel', { requestId: second.requestId });
  succeed(f); f.callbacks[1].cb.onQrDisplayed(qr); assert.equal((await f.call('status', { requestId: second.requestId })).phase, 'cancelled'); assert.equal(f.service.request.candidate, undefined);
  const third = await f.call('start');
  f.callbacks[0].cb.onSuccess([candidate]); f.callbacks[1].cb.onSuccess([candidate]);
  assert.equal((await f.call('status', { requestId: third.requestId })).phase, 'starting');
  succeed(f); f.lifetime.abort(); succeed(f); f.callbacks.at(-1).cb.onQrDisplayed(qr);
  assert.equal(f.service.request, undefined); assert.equal((await f.call('save', { requestId: third.requestId })).error.code, 'inactive'); assert.equal(f.writes.length, 0);
});

test('manual credential changes in actual panel settings or activate snapshot block overwrite; OneBot-only changes do not', async t => {
  const f = fixture(t), start = await f.call('start'); succeed(f);
  const changed = await f.call('save', { requestId: start.requestId }, { settings: { ...old, official__appSecret: 'manually-changed' } });
  assert.equal(changed.error.code, 'settings_changed'); assert.equal(f.writes.length, 0); assert.equal(f.service.request.candidate.appId, candidate.appId);
  f.settings = { ...old, official__appId: 'manual-id' }; f.activate();
  assert.equal((await f.call('save', { requestId: start.requestId }, { settings: old })).error.code, 'settings_changed'); assert.equal(f.writes.length, 0);
  const next = await f.call('start'); succeed(f); f.settings.onebot__selfId = '202'; f.activate();
  assert.equal((await f.call('save', { requestId: next.requestId })).phase, 'saved'); assert.equal(f.settings.onebot__selfId, '202');
});

test('failed settings write retains candidate for retry, never returns raw error, and concurrent saves share one write', async t => {
  const f = fixture(t); let rejectWrite, resolveWrite;
  f.service.context.updateSettings = () => { f.writes.push('attempt'); return new Promise((resolve, reject) => { rejectWrite = reject; resolveWrite = resolve; }); };
  const start = await f.call('start'); succeed(f);
  const write = f.call('save', { requestId: start.requestId }); const repeat = f.call('save', { requestId: start.requestId });
  assert.equal((await f.call('status', { requestId: start.requestId })).phase, 'saving');
  assert.equal((await f.call('start')).error.code, 'busy'); assert.equal((await f.call('cancel', { requestId: start.requestId })).error.code, 'busy');
  rejectWrite(new Error(`fixture-stack ${candidate.appSecret}`));
  for (const result of await Promise.all([write, repeat])) { assert.equal(result.error.code, 'save_failed'); assert.equal(result.phase, 'candidate'); privateWire(result); }
  assert.deepEqual(f.settings, old); assert.equal(f.writes.length, 1);
  const retry = f.call('save', { requestId: start.requestId }); resolveWrite(); assert.equal((await retry).phase, 'saved'); assert.equal(f.writes.length, 2);
});

test('deactivation while explicit write is pending clears memory and cannot resurrect a task', async t => {
  const f = fixture(t); let finish;
  f.service.context.updateSettings = () => new Promise(resolve => { finish = resolve; });
  const start = await f.call('start'); succeed(f); const saving = f.call('save', { requestId: start.requestId });
  f.service.deactivate(); finish(); await saving; assert.equal(f.service.request, undefined); assert.deepEqual(f.service.settings, {});
});

test('malformed and failed callbacks are safe terminal states; pre-confirmation save writes nothing', async t => {
  const f = fixture(t), start = await f.call('start');
  assert.equal((await f.call('save', { requestId: start.requestId })).error.code, 'not_ready');
  f.callbacks[0].cb.onSuccess([]); assert.equal((await f.call('status', { requestId: start.requestId })).error.code, 'invalid_credentials');
  await f.call('start'); f.callbacks[1].cb.onFailure(new Error('fixture-stack'));
  const failed = await f.call('status', { requestId: f.service.request.id }); assert.equal(failed.error.code, 'bind_failed'); privateWire(failed);
  await f.call('start'); f.callbacks[2].cb.onQrDisplayed('https://example.test/not-official'); assert.equal(f.service.request.error, 'invalid_qr_url');
  assert.equal(f.writes.length, 0);
});

/** Only the last HTTPS boundary is replaced: the bundled official component owns creation, polling and AES-GCM decryption. */
export function stubConnectorHttps(t, respond) {
  const calls = [], pending = [];
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => {
      const call = { hostname: options.hostname, path: options.path, method: options.method, body: JSON.parse(body) };
      calls.push(call);
      assert.equal(call.hostname, 'q.qq.com'); assert.equal(call.method, 'POST');
      assert.ok(['/lite/create_bind_task', '/lite/poll_bind_result'].includes(call.path), 'fixture denies all unexpected requests');
      const deliver = value => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
        callback(res); res.emit('data', JSON.stringify(value)); res.emit('end');
      });
      const result = respond(call, calls, deliver); if (result !== undefined) deliver(result); else pending.push(call);
    };
    return req;
  });
  return { calls, pending };
}
function encrypted(secret, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const bytes = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, bytes, cipher.getAuthTag()]).toString('base64');
}
async function until(check) { for (let i = 0; i < 50 && !check(); i++) await tick(); assert.ok(check(), 'bounded callback completion'); }

test('official 1.2.0 real start → task → official QR → poll → decrypt → candidate → exact save', async t => {
  const boundary = stubConnectorHttps(t, (call, calls) => call.path.endsWith('create_bind_task') ? { retcode: 0, data: { task_id: 'fixture-task' } } : { retcode: 0, data: { status: 2, bot_appid: candidate.appId, bot_encrypt_secret: encrypted(candidate.appSecret, calls[0].body.key), user_openid: 'user-openid' } });
  const f = fixture(t, { connect: undefined }); const start = await f.call('start');
  await until(() => f.service.request.phase === 'candidate');
  const status = await f.call('status', { requestId: start.requestId }); assert.equal(status.candidateAppId, candidate.appId); privateWire(status);
  assert.equal(boundary.calls.length, 2); assert.deepEqual(Object.keys(boundary.calls[0].body), ['key']); assert.equal(Buffer.from(boundary.calls[0].body.key, 'base64').length, 32);
  assert.deepEqual(boundary.calls[1].body, { task_id: 'fixture-task' }); assert.equal(f.writes.length, 0);
  assert.equal((await f.call('save', { requestId: start.requestId })).phase, 'saved');
  assert.deepEqual(f.writes[0], { official__appId: candidate.appId, official__appSecret: candidate.appSecret });
});

test('official status 3 stops SDK auto-refresh; late create and late decrypted success are fenced', async t => {
  let mode = 'expire', held;
  const boundary = stubConnectorHttps(t, (call, calls, deliver) => {
    if (mode === 'create-late' && call.path.endsWith('create_bind_task')) { held = deliver; return; }
    if (call.path.endsWith('create_bind_task')) return { retcode: 0, data: { task_id: 'fixture-task' } };
    if (mode === 'success-late') { held = () => deliver({ retcode: 0, data: { status: 2, bot_appid: candidate.appId, bot_encrypt_secret: encrypted(candidate.appSecret, calls.at(-2).body.key) } }); return; }
    return { retcode: 0, data: { status: 3 } };
  });
  const f = fixture(t, { connect: undefined }); await f.call('start'); await until(() => f.service.request.phase === 'expired'); await tick();
  assert.equal(boundary.calls.length, 2); assert.equal(f.service.request.controller.signal.aborted, true);
  mode = 'create-late'; const create = await f.call('start'); await until(() => Boolean(held)); await f.call('cancel', { requestId: create.requestId });
  held({ retcode: 0, data: { task_id: 'late-create' } }); await tick(); await tick(); assert.equal(boundary.calls.length, 3); assert.equal(f.service.request.phase, 'cancelled');
  held = undefined; mode = 'success-late'; const success = await f.call('start'); await until(() => Boolean(held)); await f.call('cancel', { requestId: success.requestId }); held(); await tick(); await tick();
  assert.equal(f.service.request.phase, 'cancelled'); assert.equal(f.service.request.candidate, undefined); assert.equal(f.writes.length, 0);
});
