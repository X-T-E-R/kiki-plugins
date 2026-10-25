import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { messageLimits } from './message-limits.mjs';
import { register } from '../entry.mjs';
import { toolDefinitions, officialAdapterDefinition, onebotAdapterDefinition } from '../lib/definitions.mjs';
import { createOfficialClient, OfficialGateway } from '../lib/official.mjs';
import { createOneBotClient } from '../lib/onebot.mjs';
import { createOfficialAdapter, createOneBotAdapter, chunkText } from '../lib/adapters.mjs';
import { normalizeOfficialEvent, normalizeOneBotEvent } from '../lib/normalize.mjs';
import { officialIdentity, onebotIdentity, parseIdentity } from '../lib/identity.mjs';
import { fetchMediaBytes, parseCqMessage } from '../lib/attachments.mjs';
import { publicAddress, downloadPublicMedia } from '../lib/media-download.mjs';
import { createReplyContext } from '../lib/reply-context.mjs';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';

const OFFICIAL_SETTINGS = { official__appId: 'fixture-app', official__appSecret: 'fixture-secret', official__apiBaseUrl: 'https://api.fixture.test', official__tokenBaseUrl: 'https://token.fixture.test' };
const OFFICIAL_CONFIG = { appId: 'fixture-app', appSecret: 'fixture-secret', apiBaseUrl: 'https://api.fixture.test', tokenBaseUrl: 'https://token.fixture.test' };
const TOKEN = { method: 'POST', url: 'https://token.fixture.test/app/getAppAccessToken', response: { access_token: 'fixture-token', expires_in: 7200 } };
const privateOfficial = officialIdentity({ userOpenid: 'u1' });
const groupOfficial = officialIdentity({ userOpenid: 'u1', groupOpenid: 'g1' });
const privateOnebot = onebotIdentity({ userId: '200' });
const groupOnebot = onebotIdentity({ userId: '200', groupId: '100' });
const bytes = Uint8Array.from([1, 2, 3]);
const text = (identity, extras = {}) => ({ identity, text: 'hello', code: 'reply', ...extras });
const media = (identity, kind, mediaType) => ({ identity, kind, name: `a.${kind}`, mediaType, bytes });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => Promise.withResolvers();
const tick = () => delay(0);

function fixtureFetch(t, routes) {
  const calls = [], unexpected = [];
  t.after(() => assert.deepEqual(unexpected, [], 'fixture rejected unexpected HTTP requests'));
  return { calls, fetchImpl: async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const route = routes.find((item) => item.method === (init.method ?? 'GET') && item.url === call.url);
    if (!route) { unexpected.push(`${init.method ?? 'GET'} ${url}`); throw new Error(`Unexpected fixture request: ${url}`); }
    const value = typeof route.response === 'function' ? await route.response(call) : route.response;
    return value instanceof Response || value?.text ? value : json(value);
  } };
}
function official(t, routes, config = {}, deps = {}) {
  const fixture = fixtureFetch(t, [TOKEN, ...routes]);
  return { ...fixture, client: createOfficialClient({ ...OFFICIAL_CONFIG, ...config }, { ...fixture, ...deps }) };
}
function gatewayFixture() {
  const ready = deferred();
  let options, stopped = false;
  return { get options() { return options; }, get stopped() { return stopped; }, ready: ready.promise,
    gatewayFactory(value) { options = value; ready.resolve(); return { start() {
      return new Promise((resolve) => value.abortSignal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    } }; } };
}
async function startOfficial(t, fixture, deps = {}) {
  const gateway = gatewayFixture();
  const adapter = createOfficialAdapter({ fetchImpl: fixture.fetchImpl, gatewayFactory: gateway.gatewayFactory, ...deps });
  const events = [];
  let started = false;
  const start = adapter.start({ messageLimits, signal: new AbortController().signal, instanceId: 'fixture-instance', settings: OFFICIAL_SETTINGS, emit: async (event) => {
    assert.equal(started, true, 'emit must follow start resolution'); events.push(event);
  } });
  await gateway.ready;
  gateway.options.onReady({ user: { id: 'ignored-openid' } });
  assert.deepEqual(await start, { accountId: 'qq-official:fixture-app', listenerAccountId: 'fixture-app' });
  started = true;
  t.after(() => adapter.stop());
  return { adapter, gateway, events };
}
async function wsFixture(t, handler) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets = [];
  server.on('connection', (socket, request) => { sockets.push(socket); handler(socket, request); });
  await once(server, 'listening');
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); });
  return { server, sockets, url: `ws://127.0.0.1:${server.address().port}/` };
}
function incomingOnebot(id, sender = 200, extra = {}) {
  return { self_id: 999, post_type: 'message', message_type: 'group', message_id: id, group_id: 100, user_id: sender, message: [{ type: 'text', data: { text: `message-${id}` } }], ...extra };
}

test('entry registers exact definitions and explicit voice capabilities', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const tools = [], adapters = [];
  register({ registerTool: (definition, execute) => tools.push({ definition, execute }), registerImAdapter: (definition, adapter) => adapters.push({ definition, adapter }) });
  assert.deepEqual(manifest['x-kiki'].tools, toolDefinitions);
  assert.deepEqual(manifest['x-kiki'].imAdapters, [officialAdapterDefinition, onebotAdapterDefinition]);
  assert.deepEqual(tools.map((item) => item.definition), toolDefinitions);
  assert.deepEqual(adapters.map((item) => item.definition), [officialAdapterDefinition, onebotAdapterDefinition]);
  for (const { definition, adapter } of adapters) {
    assert.equal(typeof adapter.start, 'function');
    assert.equal(definition.mediaCapabilities.some((item) => item.kind === 'voice'), true);
  }
  assert.equal(onebotAdapterDefinition.mediaCapabilities.some((item) => item.kind === 'file'), false);
});

test('official identity/source/mention/quote remain distinct across multiple media and senders', () => {
  const raw = { id: 'source-1', content: '<@!bot> 你好', group_openid: 'g1', topic_id: 't1', author: { member_openid: 'u1', username: 'Alice' },
    mentions: [{ member_openid: 'bot', is_you: true }], message_reference: { message_id: 'quoted-1' },
    attachments: [{ filename: 'voice.silk', content_type: 'audio/silk', url: 'https://media.fixture.test/a', asr_refer_text: '参考文本' },
      { filename: 'a.mp4', content_type: 'video/mp4', url: '//media.fixture.test/b' }] };
  const events = normalizeOfficialEvent(raw, { eventType: 'GROUP_AT_MESSAGE_CREATE' });
  assert.deepEqual(events.map((event) => event.kind), ['message']);
  assert.deepEqual(events[0].parts.map((part) => part.kind), ['text', 'audio', 'video']);
  assert.equal(events[0].parts[0].text, '你好');
  assert.equal(events[0].sourceMessageId, 'source-1');
  assert.equal(events[0].replyToMessageId, 'quoted-1');
  assert.equal(events[0].identity.chatId, 'official:group:g1');
  assert.equal(events[0].identity.senderId, 'official:user:u1');
  assert.equal(events[0].identity.topicId, 'official:topic:t1');
  assert.deepEqual(events[0].mentionIds, ['bot']);
  assert.equal(events[0].mentioned, true);
  assert.equal(events[0].parts[1].text, '[QQ ASR reference] 参考文本');
  assert.equal(events[0].parts[2].attachment.url, 'https://media.fixture.test/b');
  const other = normalizeOfficialEvent({ ...raw, id: 'source-2', author: { member_openid: 'u2' } }, { eventType: 'GROUP_MESSAGE_CREATE' })[0];
  assert.equal(other.identity.chatId, events[0].identity.chatId);
  assert.notEqual(other.identity.senderId, events[0].identity.senderId);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 1);
  assert.deepEqual(normalizeOfficialEvent({ ...raw, guild_id: 'guild' }, { eventType: 'AT_MESSAGE_CREATE' }), []);
});

test('OneBot CQ/array events keep all media, quote, mentions and private/group identity', () => {
  const event = incomingOnebot(-42, 200, { topic_id: 'thread1', message: '[CQ:reply,id=-41][CQ:at,qq=999]a&#91;b&#93;[CQ:image,file=a.png,url=https://media.fixture.test/a][CQ:record,file=v.silk,url=https://media.fixture.test/b][CQ:video,file=v.mp4,url=https://media.fixture.test/c]' });
  const events = normalizeOneBotEvent(event, { selfId: '999' });
  assert.deepEqual(events.map((item) => item.kind), ['message']);
  assert.deepEqual(events[0].parts.map((part) => part.kind), ['text', 'image', 'audio', 'video']);
  assert.equal(events[0].parts[0].text, 'a[b]');
  assert.equal(events[0].sourceMessageId, '-42');
  assert.equal(events[0].replyToMessageId, '-41');
  assert.equal(events[0].mentioned, true);
  assert.equal(events[0].identity.topicId, 'onebot:topic:thread1');
  const privateEvent = normalizeOneBotEvent(incomingOnebot(2, 201, { message_type: 'private', group_id: undefined }))[0];
  assert.equal(privateEvent.identity.chatId, 'onebot:private:201');
  assert.equal(privateEvent.identity.chatKind, 'private');
  assert.equal(normalizeOneBotEvent(incomingOnebot(3, 202))[0].identity.chatId, 'onebot:group:100');
  assert.deepEqual(parseCqMessage('&#91;CQ:at,qq=999&#93;'), [{ type: 'text', data: { text: '[CQ:at,qq=999]' } }]);
  assert.throws(() => parseIdentity(privateOfficial, 'onebot'), /different QQ platform/);
});

test('official token/text/media use real receipt IDs and source context separate from quote', async (t) => {
  const { client, calls } = official(t, [
    { method: 'POST', url: 'https://api.fixture.test/v2/groups/g1/messages', response: ({ body }) => ({ id: body.msg_type === 7 ? 'media-id' : 'text-id' }) },
    { method: 'POST', url: 'https://api.fixture.test/v2/groups/g1/files', response: { file_info: 'uploaded', file_uuid: 'upload-id' } },
    { method: 'PUT', url: 'https://api.fixture.test/interactions/click-1', response: {} },
  ]);
  client.observe({ identity: groupOfficial, sourceMessageId: 'inbound-source', kind: 'text' });
  assert.deepEqual(await client.sendText(text(groupOfficial, { messageId: 'outbound-id-is-not-context', replyToMessageId: 'quote-id', buttons: [{ id: 'yes', label: 'Yes' }] })), { status: 'delivered', messageIds: ['text-id'] });
  const sent = calls.find((call) => call.url.endsWith('/messages'));
  assert.equal(sent.body.msg_id, 'inbound-source');
  assert.deepEqual(sent.body.message_reference, { message_id: 'quote-id' });
  assert.equal(sent.body.msg_seq, 1);
  assert.equal(sent.body.keyboard.content.rows[0].buttons[0].id, 'yes');
  assert.equal(sent.init.headers.get('authorization'), 'QQBot fixture-token');
  for (const [kind, mime, fileType] of [['image', 'image/png', 1], ['voice', 'audio/silk', 3], ['audio', 'audio/mpeg', 3], ['video', 'video/mp4', 2], ['file', 'text/plain', 4]]) {
    assert.deepEqual(await client.sendMedia(media(groupOfficial, kind, mime)), { status: 'delivered', messageIds: ['media-id'] });
    const upload = calls.filter((call) => call.url.endsWith('/files')).at(-1);
    assert.equal(upload.body.file_type, fileType);
    assert.equal(upload.body.srv_send_msg, false);
    assert.equal(upload.body.file_data, 'AQID');
  }
  assert.equal(calls.filter((call) => call.url.endsWith('getAppAccessToken')).length, 1);
  assert.equal(await client.answerCallback('click-1'), undefined);
  await assert.rejects(client.listGroups(), { code: 'UNSUPPORTED' });
  await assert.rejects(client.listGroupMembers({ groupId: 'g1' }), { code: 'UNSUPPORTED' });
});

test('reply context cache follows per-target limits/TTL and never treats a quote as passive context', () => {
  let now = 0;
  const cache = createReplyContext({ now: () => now });
  cache.observe({ identity: groupOfficial, sourceMessageId: 'source', replyToMessageId: 'quote', kind: 'text' });
  cache.observe({ identity: groupOfficial, sourceMessageId: 'source', kind: 'image' });
  for (let i = 1; i <= 4; i++) assert.deepEqual(cache.reserve(groupOfficial), { msg_id: 'source', msg_seq: i });
  assert.deepEqual(cache.reserve(groupOfficial), { msg_seq: 1 });
  cache.observe({ identity: groupOfficial, callbackQueryId: 'click', kind: 'callback' });
  assert.deepEqual(cache.reserve(groupOfficial), { event_id: 'INTERACTION_CREATE:click', msg_seq: 1 });
  assert.deepEqual(cache.reserve(groupOfficial, { allowEvent: false }), { msg_seq: 1 });
  cache.observe({ identity: privateOfficial, sourceMessageId: 'private-source', kind: 'text' });
  now = 300001;
  assert.deepEqual(cache.reserve(groupOfficial), { msg_seq: 1 });
  assert.deepEqual(cache.reserve(privateOfficial), { msg_id: 'private-source', msg_seq: 1 });
  cache.clear();
  assert.deepEqual(cache.reserve(privateOfficial), { msg_seq: 1 });
});

test('official explicit unsupported never falls back to a different target or silently drops fields', async (t) => {
  const { client, calls } = official(t, []);
  assert.equal((await client.sendText(text(groupOfficial, { mentionIds: ['u2'] }))).status, 'unsupported');
  assert.equal((await client.sendText(text(officialIdentity({ userOpenid: 'u1', groupOpenid: 'g1', topicId: 'topic' })))).status, 'unsupported');
  assert.equal((await client.sendText(text(privateOnebot))).status, 'failed');
  assert.equal(calls.length, 0);
});

test('official HTTP failures, malformed/lost receipts and cancellation preserve exact send count', async (t) => {
  for (const [name, response, status] of [
    ['denied', json({ message: 'permission denied' }, 403), 'failed'],
    ['rejected', json({ code: 123, message: 'bad request' }), 'failed'],
    ['server', json({}, 503), 'unknown'],
    ['malformed', new Response('not-json'), 'unknown'],
    ['missing-id', json({}), 'unknown'],
    ['lost', () => { throw new Error('reset'); }, 'unknown'],
  ]) {
    await t.test(name, async (t) => {
      const { client, calls } = official(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response }]);
      assert.equal((await client.sendText(text(privateOfficial))).status, status);
      assert.equal(calls.filter((call) => call.url.endsWith('/messages')).length, 1);
    });
  }
  const { client, calls } = official(t, []);
  assert.equal((await client.sendText(text(privateOfficial), { signal: AbortSignal.abort() })).status, 'failed');
  assert.equal(calls.length, 0);
});

test('official body timeout and cancellation after upload stop before subsequent send', async (t) => {
  const hanging = official(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: ({ init }) => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) }) }], { timeoutMs: 15 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal((await hanging.client.sendText(text(privateOfficial))).status, 'unknown'); } finally { clearTimeout(keepAlive); }
  const controller = new AbortController();
  const uploaded = official(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/files', response: () => { controller.abort(); return { file_info: 'file' }; } }]);
  assert.equal((await uploaded.client.sendMedia(media(privateOfficial, 'image', 'image/png'), { signal: controller.signal })).status, 'failed');
  assert.equal(uploaded.calls.some((call) => call.url.endsWith('/messages')), false);
});

test('real mature official Gateway identifies, serializes parts, hydrates and releases socket on stop', async (t) => {
  const identified = deferred(), closed = deferred();
  const wire = await wsFixture(t, (socket) => {
    socket.on('close', closed.resolve);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.op !== 2) return;
      identified.resolve(frame);
      socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture-session', user: { id: 'bot-openid' } } }));
      socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'source-1', content: 'first', author: { user_openid: 'u1' }, attachments: [
        { filename: 'a.png', content_type: 'image/png', url: 'https://media.fixture.test/a' }, { filename: 'v.silk', content_type: 'audio/silk', url: 'https://media.fixture.test/b' },
      ] } }));
      socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'source-2', content: 'second', author: { user_openid: 'u1' } } }));
    });
  });
  const fixture = fixtureFetch(t, [TOKEN, { method: 'GET', url: 'https://api.fixture.test/gateway', response: { url: wire.url } },
    ...['a', 'b'].map((id) => ({ method: 'GET', url: `https://media.fixture.test/${id}`, response: () => new Response(bytes, { headers: { 'content-type': id === 'a' ? 'image/png' : 'audio/silk' } }) })),
    { method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: { id: 'reply-id' } },
  ]);
  const adapter = createOfficialAdapter(fixture);
  t.after(() => adapter.stop());
  const events = [], done = deferred();
  let started = false, active = 0;
  await adapter.start({ messageLimits, signal: new AbortController().signal, settings: OFFICIAL_SETTINGS, instanceId: 'gateway', emit: async (event) => {
    assert.equal(started, true); assert.equal(++active, 1);
    await tick(); events.push(event); active--;
    if (events.length === 2) done.resolve();
  } });
  started = true;
  const identify = await identified.promise;
  assert.equal(identify.d.token, 'QQBot fixture-token');
  await done.promise;
  assert.deepEqual(events.map((event) => event.eventId), ['official:source-1', 'official:source-2']);
  assert.deepEqual([...events[0].parts[1].media.bytes], [1, 2, 3]);
  assert.equal(events.every((event) => event.parts.every((part) => !('attachment' in part))), true);
  assert.deepEqual(await adapter.sendText(text(privateOfficial)), { status: 'delivered', messageIds: ['reply-id'] });
  assert.equal(fixture.calls.at(-1).body.msg_id, 'source-2');
  await adapter.stop(); await closed.promise;
  assert.equal((await adapter.sendText(text(privateOfficial))).status, 'failed');
});

test('official adapter chunks once, stops after partial/unknown and validates media before network', async (t) => {
  let sent = 0;
  const fixture = fixtureFetch(t, [TOKEN, { method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: () => ++sent === 1 ? { id: 'accepted-1' } : (() => { throw new Error('response lost'); })() }]);
  const { adapter } = await startOfficial(t, fixture);
  const receipt = await adapter.sendText(text(privateOfficial, { text: 'a'.repeat(10001) }));
  assert.equal(receipt.status, 'partial');
  assert.deepEqual(receipt.messageIds, ['accepted-1']);
  assert.equal(sent, 2);
  assert.match(receipt.detail, /unknown/);
  assert.equal((await adapter.sendMedia(media(privateOfficial, 'image', 'image/svg+xml'))).status, 'unsupported');
  assert.equal((await adapter.sendMedia({ ...media(privateOfficial, 'image', 'image/png'), bytes: new Uint8Array(0) })).status, 'failed');
  assert.equal((await adapter.sendMedia(media(privateOfficial, 'unsupported', 'text/plain'))).status, 'unsupported');
  assert.deepEqual(chunkText('a😀b', 2), ['a', '😀', 'b']);
});

test('stop aborts in-flight HTTP, rejects queued side effects, and permits fresh start', async (t) => {
  const sent = deferred();
  let sends = 0;
  const fixture = fixtureFetch(t, [TOKEN, { method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: ({ init }) => {
    sends++; sent.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } }]);
  const { adapter, gateway } = await startOfficial(t, fixture);
  const sending = adapter.sendText(text(privateOfficial, { text: 'a'.repeat(10001) }));
  await sent.promise;
  await adapter.stop();
  assert.equal((await sending).status, 'unknown');
  assert.equal(gateway.stopped, true);
  assert.equal(sends, 1);
  assert.equal((await adapter.sendMedia(media(privateOfficial, 'image', 'image/png'))).status, 'failed');
});

test('official startup cancellation releases owned gateway with no late emit', async (t) => {
  const gateway = gatewayFixture(), events = [];
  const adapter = createOfficialAdapter({ gatewayFactory: gateway.gatewayFactory, fetchImpl: fixtureFetch(t, []).fetchImpl });
  const controller = new AbortController();
  const starting = adapter.start({ messageLimits, settings: OFFICIAL_SETTINGS, instanceId: 'cancel', signal: controller.signal, emit: async (event) => events.push(event) });
  await gateway.ready; controller.abort();
  await assert.rejects(starting);
  gateway.options.onReady({});
  gateway.options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { id: 'late', author: { user_openid: 'u1' }, content: 'late' } });
  await tick();
  assert.equal(gateway.stopped, true);
  assert.deepEqual(events, []);
  await adapter.stop();
});

test('OneBot HTTP supports exact full group reads and portable text/mention/quote/media segments', async (t) => {
  const fixture = fixtureFetch(t, [
    { method: 'POST', url: 'http://onebot.fixture.test/get_login_info', response: { status: 'ok', retcode: 0, data: { user_id: 999 } } },
    { method: 'POST', url: 'http://onebot.fixture.test/get_group_list', response: { status: 'ok', retcode: 0, data: [{ group_id: 100 }, { group_id: 101 }] } },
    { method: 'POST', url: 'http://onebot.fixture.test/get_group_member_list', response: { status: 'ok', retcode: 0, data: [{ user_id: 200 }] } },
    { method: 'POST', url: 'http://onebot.fixture.test/send_group_msg', response: { status: 'ok', retcode: 0, data: { message_id: -9 } } },
    { method: 'POST', url: 'http://onebot.fixture.test/send_private_msg', response: { status: 'ok', retcode: 0, data: { message_id: 10 } } },
  ]);
  const client = createOneBotClient({ baseUrl: 'http://onebot.fixture.test', accessToken: 'fixture-token' }, fixture);
  assert.deepEqual(await client.listGroups(), { items: [{ group_id: 100 }, { group_id: 101 }], nextCursor: null });
  assert.deepEqual(await client.listGroupMembers({ groupId: '100' }), { items: [{ user_id: 200 }], nextCursor: null });
  await assert.rejects(client.listGroupMembers({ groupId: 'official-openid' }), /numeric/);
  assert.equal(fixture.calls[0].init.headers.get('authorization'), 'Bearer fixture-token');
  assert.deepEqual(await client.sendText(text(groupOnebot, { replyToMessageId: '-8', mentionIds: ['onebot:user:201', 'all'] })), { status: 'delivered', messageIds: ['-9'] });
  assert.deepEqual(fixture.calls.at(-1).body, { group_id: '100', message: [{ type: 'reply', data: { id: '-8' } }, { type: 'at', data: { qq: '201' } }, { type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: 'hello' } }] });
  assert.equal((await client.sendText(text(privateOnebot))).status, 'delivered');
  assert.equal(fixture.calls.at(-1).body.user_id, '200');
  for (const [kind, mime, segment] of [['image', 'image/png', 'image'], ['voice', 'audio/silk', 'record'], ['audio', 'audio/mpeg', 'record'], ['video', 'video/mp4', 'video']]) {
    assert.equal((await client.sendMedia(media(groupOnebot, kind, mime))).status, 'delivered');
    assert.deepEqual(fixture.calls.at(-1).body.message, [{ type: segment, data: { file: 'base64://AQID' } }]);
  }
  const count = fixture.calls.length;
  for (const message of [text(groupOnebot, { buttons: [{ id: 'a', label: 'a' }] }), text(privateOnebot, { mentionIds: ['201'] }), text(onebotIdentity({ userId: '200', groupId: '100', topicId: 'topic' }))]) {
    assert.equal((await client.sendText(message)).status, 'unsupported');
  }
  assert.equal((await client.sendMedia(media(groupOnebot, 'file', 'text/plain'))).status, 'unsupported');
  assert.equal(fixture.calls.length, count);
});

test('real OneBot forward universal WS verifies login before ordered events and uses API echo', async (t) => {
  const actions = [], done = deferred(), disconnected = deferred();
  const wire = await wsFixture(t, (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    socket.on('close', disconnected.resolve);
    socket.send(JSON.stringify(incomingOnebot(1)));
    socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes)); actions.push(frame);
      assert.ok(['get_login_info', 'send_group_msg', 'send_private_msg'].includes(frame.action));
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: frame.action === 'get_login_info' ? { user_id: 999 } : { message_id: 31 } }));
      if (frame.action === 'get_login_info') {
        socket.send(JSON.stringify(incomingOnebot(2, 201)));
        socket.send(JSON.stringify(incomingOnebot(3, 202, { self_id: 998 })));
      }
    });
  });
  const adapter = createOneBotAdapter();
  t.after(() => adapter.stop());
  const events = [];
  let started = false;
  assert.deepEqual(await adapter.start({ messageLimits, instanceId: 'onebot', settings: { onebot__wsUrl: wire.url, onebot__accessToken: 'fixture-token' }, signal: new AbortController().signal,
    emit: async (event) => { assert.equal(started, true); events.push(event); if (events.length === 2) done.resolve(); } }), { accountId: 'qq-onebot:999', listenerAccountId: '999' });
  started = true;
  await done.promise;
  assert.deepEqual(events.map((event) => event.identity.senderId), ['onebot:user:200', 'onebot:user:201']);
  assert.equal(events[0].identity.chatId, events[1].identity.chatId);
  assert.deepEqual(await adapter.sendText(text(groupOnebot)), { status: 'delivered', messageIds: ['31'] });
  await adapter.stop(); await disconnected.promise;
  assert.equal(actions.filter((action) => action.action === 'get_login_info').length, 1);
  assert.equal(actions.filter((action) => action.action === 'send_group_msg').length, 1);
});

test('OneBot mismatched account rejects startup before any inbound event', async (t) => {
  const wire = await wsFixture(t, (socket) => {
    socket.send(JSON.stringify(incomingOnebot(1)));
    socket.on('message', (bytes) => { const frame = JSON.parse(String(bytes)); socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: { user_id: 998 } })); });
  });
  const events = [];
  const client = createOneBotClient({ wsUrl: wire.url, useWebSocket: true, selfId: '999' });
  t.after(() => client.stop());
  await assert.rejects(client.start({ signal: new AbortController().signal, emit: async (event) => events.push(event) }), /account changed/);
  assert.deepEqual(events, []);
});

test('OneBot disconnect/timeout/cancel after send are unknown with one action, no resend', async (t) => {
  for (const mode of ['disconnect', 'timeout', 'cancel']) await t.test(mode, async (t) => {
    let sent = 0;
    const controller = new AbortController();
    const wire = await wsFixture(t, (socket) => socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.action === 'get_login_info') socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: { user_id: 999 } }));
      else { sent++; if (mode === 'disconnect') socket.close(); if (mode === 'cancel') controller.abort(); }
    }));
    const client = createOneBotClient({ wsUrl: wire.url, useWebSocket: true, timeoutMs: 25 });
    t.after(() => client.stop());
    await client.start({ signal: new AbortController().signal, emit: async () => {} });
    assert.equal((await client.sendText(text(privateOnebot), { signal: controller.signal })).status, 'unknown');
    await client.stop();
    assert.equal(sent, 1);
  });
});

test('OneBot status/retcode never synthesizes success from async or missing receipt', async (t) => {
  for (const [response, expected] of [[{ status: 'failed', retcode: 100, wording: 'denied' }, 'failed'], [{ status: 'async', retcode: 1 }, 'unknown'], [{ status: 'ok', data: { message_id: 1 } }, 'unknown'], [{ status: 'ok', retcode: 0, data: {} }, 'unknown']]) {
    const fixture = fixtureFetch(t, [{ method: 'POST', url: 'http://onebot.fixture.test/send_private_msg', response }]);
    const client = createOneBotClient({ baseUrl: 'http://onebot.fixture.test' }, fixture);
    assert.equal((await client.sendText(text(privateOnebot))).status, expected);
    assert.equal(fixture.calls.length, 1);
  }
});

test('media hydration rejects an oversized source and preserves missing audio with its ASR reference', async (t) => {
  const fixture = fixtureFetch(t, []), errors = [];
  const { adapter, gateway, events } = await startOfficial(t, fixture, { onError: (error) => errors.push(error) });
  await gateway.options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { id: 'large', author: { user_openid: 'u1' }, attachments: [{ filename: 'large.mp4', content_type: 'video/mp4', url: 'https://media.fixture.test/large', size: 9 * 1024 * 1024 }] } });
  assert.deepEqual(events, []);
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'MEDIA_TOO_LARGE');
  await gateway.options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { id: 'asr', author: { user_openid: 'u1' }, attachments: [{ filename: 'voice.silk', content_type: 'audio/silk', asr_refer_text: '参考' }] } });
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'message');
  assert.equal(events[0].parts[0].kind, 'audio');
  assert.match(events[0].parts[0].text, /no downloadable URL/);
  assert.match(events[0].parts[0].text, /QQ ASR reference.*参考/);
  assert.equal(events[0].parts[0].media, undefined);
  await adapter.stop();
  assert.equal(fixture.calls.length, 0);
});

test('attachment policy denies private/mixed DNS, credentials and redirects; pins approved DNS once', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  const requestImpl = () => { throw new Error('network must be denied before request'); };
  await assert.rejects(downloadPublicMedia('http://127.0.0.1/a', { requestImpl }), { code: 'MEDIA_URL_INVALID' });
  await assert.rejects(downloadPublicMedia('https://user:secret@media.fixture.test/a', { requestImpl }), { code: 'MEDIA_URL_INVALID' });
  await assert.rejects(downloadPublicMedia('https://media.fixture.test/a', { requestImpl, lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'MEDIA_URL_INVALID' });
  let lookups = 0;
  const downloaded = await downloadPublicMedia('https://media.fixture.test/a', { lookupImpl: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; }, requestImpl: (options, callback) => {
    assert.equal(options.hostname, 'media.fixture.test'); assert.equal(options.servername, 'media.fixture.test');
    options.lookup('media.fixture.test', { all: false }, (_, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    options.lookup('media.fixture.test', { all: true }, (_, addresses) => assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]));
    const req = new EventEmitter();
    req.end = () => { const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'image/png' }; callback(res); res.emit('data', Buffer.from(bytes)); res.emit('end'); };
    return req;
  } });
  assert.equal(lookups, 1);
  assert.deepEqual([...downloaded.bytes], [1, 2, 3]);
  await assert.rejects(fetchMediaBytes({ url: 'https://media.fixture.test/a' }, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), { code: 'MEDIA_REDIRECT' });
  await assert.rejects(fetchMediaBytes({ url: 'https://media.fixture.test/a' }, { maxBytes: 2, fetchImpl: async () => new Response(bytes) }), { code: 'MEDIA_TOO_LARGE' });
});


test('stop releases an unacknowledged Host emit, drops queued events and allows only one replacement listener', async (t) => {
  const gateways = [], received = deferred();
  const emit = deferred();
  const adapter = createOfficialAdapter({ fetchImpl: fixtureFetch(t, []).fetchImpl, gatewayFactory: (options) => {
    const gateway = gatewayFixture(); gateways.push(gateway); return gateway.gatewayFactory(options);
  } });
  t.after(() => adapter.stop());
  const context = { messageLimits, signal: new AbortController().signal, settings: OFFICIAL_SETTINGS, instanceId: 'restart', emit: async () => { received.resolve(); return emit.promise; } };
  const starting = adapter.start(context);
  gateways[0].options.onReady({}); await starting;
  await assert.rejects(adapter.start(context), /already running/);
  const raw = { author: { user_openid: 'u1' }, content: 'pending' };
  gateways[0].options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { ...raw, id: 'first' } });
  gateways[0].options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { ...raw, id: 'queued' } });
  await received.promise;
  await adapter.stop();
  assert.equal(gateways[0].stopped, true);
  const events = [];
  const restarting = adapter.start({ messageLimits, ...context, emit: async (event) => events.push(event) });
  gateways[1].options.onReady({}); await restarting;
  gateways[0].options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { ...raw, id: 'retired' } });
  gateways[1].options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { ...raw, id: 'replacement' } });
  await delay(10);
  assert.deepEqual(events.map((event) => event.sourceMessageId), ['replacement']);
  emit.resolve();
  await adapter.stop();
  assert.equal(gateways[1].stopped, true);
});

test('stop aborts attachment hydration before emit and cancels the owned download', async (t) => {
  const downloading = deferred();
  let cancelled = false;
  const fixture = fixtureFetch(t, [{ method: 'GET', url: 'https://media.fixture.test/pending', response: ({ init }) => {
    downloading.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { cancelled = true; reject(init.signal.reason); }, { once: true }));
  } }]);
  const { adapter, gateway, events } = await startOfficial(t, fixture);
  gateway.options.onMessage({ rawEventType: 'C2C_MESSAGE_CREATE', raw: { id: 'download', author: { user_openid: 'u1' }, attachments: [{ filename: 'a.png', content_type: 'image/png', url: 'https://media.fixture.test/pending' }] } });
  await downloading.promise; await adapter.stop();
  assert.equal(cancelled, true);
  assert.deepEqual(events, []);
});

test('OneBot startup cancellation closes a real connected socket waiting for login', async (t) => {
  const login = deferred(), closed = deferred();
  const wire = await wsFixture(t, (socket) => {
    socket.on('close', closed.resolve);
    socket.on('message', (bytes) => { const frame = JSON.parse(String(bytes)); assert.equal(frame.action, 'get_login_info'); login.resolve(); });
  });
  const client = createOneBotClient({ wsUrl: wire.url, useWebSocket: true });
  const controller = new AbortController();
  const starting = client.start({ signal: controller.signal, emit: async () => assert.fail('startup must not emit') });
  await login.promise; controller.abort();
  await assert.rejects(starting, /cancelled/); await closed.promise;
  assert.equal((await client.sendText(text(privateOnebot))).status, 'failed');
  await client.stop();
});

test('OneBot reconnect re-verifies the same account and contains malformed/foreign events', async (t) => {
  let connections = 0;
  const emitted = deferred(), errors = [];
  const wire = await wsFixture(t, (socket) => {
    connections++;
    const connection = connections;
    socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes)); assert.equal(frame.action, 'get_login_info');
      socket.send(JSON.stringify(incomingOnebot(connection, 200 + connection)));
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: { user_id: 999 } }));
      if (connection === 1) setTimeout(() => socket.close(), 5);
      else {
        socket.send(JSON.stringify(incomingOnebot(10, 'invalid:sender')));
        socket.send(JSON.stringify(incomingOnebot(11, 202, { self_id: 998 })));
        socket.send(JSON.stringify(incomingOnebot(12, 203)));
      }
    });
  });
  const events = [];
  const client = createOneBotClient({ wsUrl: wire.url, useWebSocket: true, reconnectDelayMs: 1 }, { onError: (error) => errors.push(error) });
  t.after(() => client.stop());
  await client.start({ signal: new AbortController().signal, emit: async (event) => { events.push(event); if (event.sourceMessageId === '12') emitted.resolve(); } });
  await emitted.promise; await client.stop();
  assert.equal(connections, 2);
  assert.deepEqual(events.map((event) => event.sourceMessageId), ['1', '2', '12']);
  assert.equal(errors.length, 1);
});


test('OneBot HTTP group tools reject account mismatch and malformed list responses', async (t) => {
  const fixture = fixtureFetch(t, [{ method: 'POST', url: 'http://onebot.fixture.test/get_login_info', response: { status: 'ok', retcode: 0, data: { user_id: 998 } } }]);
  const client = createOneBotClient({ baseUrl: 'http://onebot.fixture.test', selfId: '999' }, fixture);
  await assert.rejects(client.listGroups(), /account differs/);
  assert.equal(fixture.calls.length, 1);
  const malformed = fixtureFetch(t, [
    { method: 'POST', url: 'http://onebot.fixture.test/get_login_info', response: { status: 'ok', retcode: 0, data: { user_id: 999 } } },
    { method: 'POST', url: 'http://onebot.fixture.test/get_group_list', response: { status: 'ok', retcode: 0, data: { groups: [] } } },
  ]);
  await assert.rejects(createOneBotClient({ baseUrl: 'http://onebot.fixture.test' }, malformed).listGroups(), /not an array/);
});


test('official upload loss is a known unsent message; loss after the media send is unknown', async (t) => {
  const uploadLost = official(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/files', response: () => { throw new Error('upload response lost'); } }]);
  assert.equal((await uploadLost.client.sendMedia(media(privateOfficial, 'image', 'image/png'))).status, 'failed');
  assert.equal(uploadLost.calls.some((call) => call.url.endsWith('/messages')), false);
  const sendLost = official(t, [
    { method: 'POST', url: 'https://api.fixture.test/v2/users/u1/files', response: { file_info: 'uploaded' } },
    { method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: () => { throw new Error('send response lost'); } },
  ]);
  assert.equal((await sendLost.client.sendMedia(media(privateOfficial, 'image', 'image/png'))).status, 'unknown');
  assert.equal(sendLost.calls.filter((call) => call.url.endsWith('/files')).length, 1);
  assert.equal(sendLost.calls.filter((call) => call.url.endsWith('/messages')).length, 1);
});
