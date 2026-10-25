import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { messageLimits } from './message-limits.mjs';
import { register } from '../entry.mjs';
import { createOfficialAdapter, createOneBotAdapter } from '../lib/adapters.mjs';
import { receiptFromError } from '../lib/receipts.mjs';
import { createOfficialClient } from '../lib/official.mjs';
import { createOneBotClient } from '../lib/onebot.mjs';
import { officialIdentity, onebotIdentity } from '../lib/identity.mjs';
import { dispatchEvent } from '../vendor/qqbot-gateway/event-dispatcher.js';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';

const MiB = 1024 * 1024;
const CONFIG = { appId: 'fixture', appSecret: 'fixture-secret', apiBaseUrl: 'https://api.fixture.test', tokenBaseUrl: 'https://token.fixture.test' };
const SETTINGS = { official__appId: CONFIG.appId, official__appSecret: CONFIG.appSecret, official__apiBaseUrl: CONFIG.apiBaseUrl, official__tokenBaseUrl: CONFIG.tokenBaseUrl };
const signal = () => new AbortController().signal;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const deferred = () => Promise.withResolvers();
const c2c = officialIdentity({ userOpenid: 'u1' });
const group = officialIdentity({ userOpenid: 'u1', groupOpenid: 'g1' });
const onebot = onebotIdentity({ userId: '200', groupId: '100' });
const text = (identity) => ({ identity, text: 'fixture-only text', code: 'regression' });

function fetchFixture(t, routes = []) {
  const calls = [], unexpected = [];
  const all = [{ method: 'POST', url: 'https://token.fixture.test/app/getAppAccessToken', response: { access_token: 'fixture-token', expires_in: 7200 } }, ...routes];
  t.after(() => assert.deepEqual(unexpected, [], 'unexpected HTTP request'));
  return { calls, fetchImpl: async (url, init) => {
    const call = { url: String(url), init, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const route = all.find((item) => item.url === call.url && item.method === init.method);
    if (!route) { unexpected.push(`${init.method} ${url}`); throw new Error('Fixture denied unexpected request'); }
    const value = typeof route.response === 'function' ? await route.response(call) : route.response;
    return value instanceof Response ? value : json(value);
  } };
}
async function wireFixture(t, handler) {
  const wire = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wire.on('connection', handler);
  await once(wire, 'listening');
  t.after(async () => { for (const socket of wire.clients) socket.terminate(); await new Promise((resolve) => wire.close(resolve)); });
  return { wire, url: `ws://127.0.0.1:${wire.address().port}/` };
}
async function officialAdapter(t, fixture, deps = {}) {
  let gateway;
  const events = [];
  const adapter = createOfficialAdapter({ ...fixture, ...deps, gatewayFactory(options) {
    gateway = options;
    return { start() { options.onReady({}); return new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true })); } };
  } });
  await adapter.start({ messageLimits, signal: signal(), settings: SETTINGS, emit: async (event) => events.push(event) });
  t.after(() => adapter.stop());
  return { adapter, gateway, events };
}

for (const actual of [998, 999]) test(`QQR-001: reconnect login window blocks business sends; verified account ${actual}`, async (t) => {
  const login2 = deferred(), resumed = deferred(), changed = deferred(), actions = [];
  let connections = 0, first, second, echo;
  const wire = await wireFixture(t, (socket) => {
    const connection = ++connections;
    if (connection === 1) first = socket; else second = socket;
    socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes)); actions.push({ connection, action: frame.action });
      if (frame.action === 'get_login_info' && connection === 2) { echo = frame.echo; login2.resolve(); return; }
      assert.ok(['get_login_info', 'send_group_msg'].includes(frame.action));
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: frame.action === 'get_login_info' ? { user_id: 999 } : { message_id: 123 } }));
    });
  });
  const adapter = createOneBotAdapter({ onError: (error) => { assert.equal(error.code, 'ACCOUNT_CHANGED'); changed.resolve(); } });
  t.after(() => adapter.stop());
  assert.deepEqual(await adapter.start({ messageLimits, settings: { onebot__wsUrl: wire.url, onebot__selfId: '999' }, signal: signal(), emit: async () => resumed.resolve() }), { accountId: 'qq-onebot:999', listenerAccountId: '999' });
  first.close(); await login2.promise;
  const blocked = await adapter.sendText(text(onebot));
  assert.equal(blocked.status, 'failed'); assert.match(blocked.detail, /not verified; action was not sent/);
  await delay(0);
  assert.deepEqual(actions.filter((item) => item.connection === 2), [{ connection: 2, action: 'get_login_info' }]);
  second.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: actual } }));
  if (actual === 998) {
    await changed.promise;
    assert.equal((await adapter.sendText(text(onebot))).status, 'failed');
    assert.equal(actions.some((item) => item.action === 'send_group_msg'), false);
  } else {
    second.send(JSON.stringify({ self_id: 999, post_type: 'message', message_type: 'group', message_id: 2, group_id: 100, user_id: 200, message: 'same-account-resumed' }));
    await resumed.promise;
    assert.deepEqual(await adapter.sendText(text(onebot)), { status: 'delivered', messageIds: ['123'] });
    assert.equal(actions.filter((item) => item.action === 'send_group_msg').length, 1, 'blocked content must never be queued or replayed');
  }
  await adapter.stop(); assert.equal(connections, 2);
});

test('QQR-002: real Gateway keeps scene/103 references and separates quoted/current attachments', async (t) => {
  const raw = [
    { id: 'original-id', content: 'original', message_scene: { ext: ['msg_idx=original-index'] } },
    { id: 'scene-reply', content: 'scene reply', message_scene: { ext: ['ref_msg_idx=original-index', 'msg_idx=scene-index'] } },
    { id: 'new-source', content: 'reply with new media', message_type: 103, msg_elements: [
      { msg_idx: 'original-index', content: 'old quoted content', attachments: [{ filename: 'old.png', content_type: 'image/png', url: 'https://media.fixture.test/quoted' }] },
      { attachments: [{ filename: 'current-second.png', content_type: 'image/png', url: 'https://media.fixture.test/second' }] },
    ], attachments: [{ filename: 'current-first.png', content_type: 'image/png', url: 'https://media.fixture.test/first' }] },
  ].map((item) => ({ ...item, group_openid: 'g1', author: { member_openid: 'new-sender' } }));
  const wire = await wireFixture(t, (socket) => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes)); assert.equal(frame.op, 2);
      socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture', user: { id: 'bot' } } }));
      raw.forEach((d, index) => socket.send(JSON.stringify({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: index + 2, d })));
    });
  });
  const fixture = fetchFixture(t, [
    { method: 'GET', url: 'https://api.fixture.test/gateway', response: { url: wire.url } },
    ...['first', 'second'].map((name) => ({ method: 'GET', url: `https://media.fixture.test/${name}`, response: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) })),
    { method: 'POST', url: 'https://api.fixture.test/v2/groups/g1/messages', response: { id: 'sent-id' } },
  ]);
  const adapter = createOfficialAdapter(fixture), events = [], done = deferred();
  t.after(() => adapter.stop());
  await adapter.start({ messageLimits, signal: signal(), settings: SETTINGS, emit: async (event) => { events.push(event); if (events.length === 3) done.resolve(); } });
  await done.promise;
  assert.deepEqual(events.map((event) => event.kind), ['message', 'message', 'message']);
  assert.equal(events[1].replyToMessageId, 'original-id');
  assert.equal(events[2].replyToMessageId, 'original-id');
  const reference = events[2].parts.filter((part) => part.kind === 'text').map((part) => part.text).join('\n');
  assert.match(reference, /original-index/); assert.match(reference, /Quoted attachment: "old.png"/);
  assert.deepEqual(events[2].parts.filter((part) => part.media).map((part) => part.media.name), ['current-first.png', 'current-second.png']);
  assert.equal(events.slice(2).every((event) => event.sourceMessageId === 'new-source' && event.identity.senderId === 'official:user:new-sender'), true);
  assert.equal((await adapter.sendText({ ...text(group), replyToMessageId: events[2].replyToMessageId })).status, 'delivered');
  assert.equal(fixture.calls.at(-1).body.msg_id, 'new-source');
  assert.equal(fixture.calls.at(-1).body.event_id, undefined);
  assert.deepEqual(fixture.calls.at(-1).body.message_reference, { message_id: 'original-id' });
});

test('QQR-002/006: ref-index association is separate, scoped and cleared; unresolved index remains a preview', async (t) => {
  const fixture = fetchFixture(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: { id: 'real-outbound-id', ext_info: { ref_idx: 'outbound-index' } } }]);
  const client = createOfficialClient(CONFIG, fixture);
  assert.deepEqual(await client.sendText(text(c2c)), { status: 'delivered', messageIds: ['real-outbound-id'] });
  const event = { id: 'next-source', author: { user_openid: 'u1' }, message_scene: { ext: ['ref_msg_idx=outbound-index'] } };
  const normalize = (raw = event, owner = client) => owner.normalize(raw, { eventType: 'C2C_MESSAGE_CREATE' })[0];
  assert.equal(normalize().replyToMessageId, 'real-outbound-id');
  for (const item of [normalize({ ...event, author: { user_openid: 'u2' } }), normalize(event, createOfficialClient(CONFIG, fixture))]) {
    assert.equal(item.replyToMessageId, undefined); assert.match(item.parts.map((part) => part.text ?? '').join('\n'), /ref_index="outbound-index".*message ID unavailable/);
    assert.equal(item.sourceMessageId, 'next-source');
  }
  client.clear(); assert.equal(normalize().replyToMessageId, undefined);
});

function chunkRoutes({ size, scope = 'users/u1', failPrepare, failSend, complete } = {}) {
  const base = `https://api.fixture.test/v2/${scope}`;
  const block = 5 * MiB;
  return [
    { method: 'POST', url: `${base}/upload_prepare`, response: failPrepare ?? (({ body, init }) => {
      assert.equal(init.headers.get('authorization'), 'QQBot fixture-token');
      assert.equal(body.file_size, size); assert.equal('file_data' in body, false);
      assert.match(body.md5, /^[a-f0-9]{32}$/); assert.match(body.sha1, /^[a-f0-9]{40}$/); assert.match(body.md5_10m, /^[a-f0-9]{32}$/);
      return { upload_id: 'upload-1', block_size: block, concurrency: 3, retry_timeout: 1, parts: Array.from({ length: Math.ceil(size / block) }, (_, index) => ({ index: index + 1, presigned_url: `https://cos.fixture.test/part-${index + 1}?signed=fixture` })) };
    }) },
    { method: 'POST', url: `${base}/upload_part_finish`, response: ({ body }) => {
      assert.equal(body.upload_id, 'upload-1'); assert.ok(body.part_index >= 1); assert.ok(body.block_size <= block); assert.match(body.md5, /^[a-f0-9]{32}$/); return {};
    } },
    { method: 'POST', url: `${base}/files`, response: complete ?? (({ body }) => { assert.deepEqual(body, { upload_id: 'upload-1' }); return { file_info: 'chunked-file', file_uuid: 'file-uuid', ttl: 600 }; }) },
    { method: 'POST', url: `${base}/messages`, response: failSend ?? (({ body }) => { assert.deepEqual(body.media, { file_info: 'chunked-file' }); return { id: 'media-message-id' }; }) },
  ];
}

test('QQR-003: adapter routes 5 MiB threshold and declared 30/100 MiB maxima through full chunk protocol', async (t) => {
  for (const [kind, size, scope] of [['file', 5 * MiB - 1, 'users/u1'], ['file', 5 * MiB, 'users/u1'], ['video', 20 * MiB + 1, 'users/u1'], ['video', 30 * MiB, 'groups/g1'], ['file', 100 * MiB, 'users/u1']]) {
    await t.test(`${kind} ${size} bytes ${scope}`, async (t) => {
      const data = Buffer.alloc(size, 7), parts = [];
      const chunk = size >= 5 * MiB;
      const base = `https://api.fixture.test/v2/${scope}`;
      const fixture = fetchFixture(t, chunk ? chunkRoutes({ size, scope }) : [
        { method: 'POST', url: `${base}/files`, response: ({ body }) => { assert.equal(body.srv_send_msg, false); assert.equal(Buffer.byteLength(body.file_data, 'base64'), size); return { file_info: 'small-file' }; } },
        { method: 'POST', url: `${base}/messages`, response: { id: 'media-message-id' } },
      ]);
      const { adapter } = await officialAdapter(t, fixture, { putPart: async (url, bytes, signal) => {
        signal.throwIfAborted();
        const part = Number(new URL(url).pathname.match(/^\/part-(\d+)$/)?.[1]); assert.ok(part);
        const offset = (part - 1) * 5 * MiB;
        assert.equal(bytes.length, Math.min(5 * MiB, size - offset));
        assert.equal(Buffer.compare(bytes, data.subarray(offset, offset + bytes.length)), 0);
        parts.push({ part, length: bytes.length, md5: createHash('md5').update(bytes).digest('hex') });
      } });
      assert.deepEqual(await adapter.sendMedia({ identity: scope.startsWith('groups') ? group : c2c, kind, name: `fixture.${kind === 'video' ? 'mp4' : 'bin'}`, mediaType: kind === 'video' ? 'video/mp4' : 'application/octet-stream', bytes: data }), { status: 'delivered', messageIds: ['media-message-id'] });
      assert.equal(fixture.calls.filter((call) => call.url.endsWith('/messages')).length, 1);
      assert.equal(fixture.calls.filter((call) => call.url.endsWith('/files')).length, 1);
      assert.equal(parts.length, chunk ? Math.ceil(size / (5 * MiB)) : 0);
      if (chunk) {
        const prepare = fixture.calls.find((call) => call.url.endsWith('/upload_prepare')).body;
        assert.equal(prepare.md5, createHash('md5').update(data).digest('hex'));
        assert.equal(prepare.sha1, createHash('sha1').update(data).digest('hex'));
        assert.equal(prepare.md5_10m, createHash('md5').update(size > 10002432 ? data.subarray(0, 10002432) : data).digest('hex'));
        for (const call of fixture.calls.filter((call) => call.url.endsWith('/upload_part_finish'))) {
          const part = parts.find((part) => part.part === call.body.part_index);
          assert.equal(call.body.block_size, part.length); assert.equal(call.body.md5, part.md5);
        }
      }
      await adapter.stop();
    });
  }
});

test('QQR-003: chunk upload failure/cancel never sends a message; lost message receipt stays unknown', async (t) => {
  const size = 5 * MiB, data = Buffer.alloc(size);
  for (const mode of ['prepare-denied', 'daily-limit', 'part-failed', 'cancel-parts', 'cancel-completed', 'send-lost']) await t.test(mode, async (t) => {
    const controller = new AbortController(), started = deferred(); let putCalls = 0, aborted = false;
    const routes = chunkRoutes({ size,
      failPrepare: mode === 'prepare-denied' ? json({ message: 'denied' }, 403) : mode === 'daily-limit' ? json({ code: 40093002, message: 'daily limit' }) : undefined,
      failSend: mode === 'send-lost' ? () => { throw new Error('message receipt lost'); } : undefined,
      complete: mode === 'cancel-completed' ? () => { controller.abort(); return { file_info: 'uploaded' }; } : undefined,
    });
    const fixture = fetchFixture(t, routes);
    const { adapter } = await officialAdapter(t, fixture, { putPart: async (_url, _bytes, signal) => {
      putCalls++; started.resolve();
      if (mode === 'part-failed') throw new Error('COS upload failed');
      if (mode === 'cancel-parts') return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    } });
    const sending = adapter.sendMedia({ identity: c2c, kind: 'file', name: 'fixture.bin', mediaType: 'application/octet-stream', bytes: data }, { signal: controller.signal });
    if (mode === 'cancel-parts') { await started.promise; await adapter.stop(); assert.equal(aborted, true); }
    const receipt = await sending;
    assert.equal(receipt.status, mode === 'send-lost' ? 'unknown' : 'failed');
    assert.equal(fixture.calls.filter((call) => call.url.endsWith('/messages')).length, mode === 'send-lost' ? 1 : 0);
    if (mode === 'part-failed') assert.equal(putCalls, 3, 'only upload-part retries are permitted');
    if (mode === 'prepare-denied' || mode === 'daily-limit') {
      assert.equal(putCalls, 0); assert.equal(fixture.calls.some((call) => call.url.endsWith('/files')), false, 'no single-upload fallback for oversized data');
    }
    await adapter.stop();
  });
});

test('QQR-004/005: native voice/AMR retains audio bytes/ASR; missing URLs retain attachment order and reason', async (t) => {
  const fixture = fetchFixture(t, [{ method: 'GET', url: 'https://media.fixture.test/voice', response: () => new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'application/octet-stream' } }) }]);
  const { gateway, events } = await officialAdapter(t, fixture);
  const send = async (raw) => gateway.onMessage(dispatchEvent('C2C_MESSAGE_CREATE', { author: { user_openid: 'u1' }, ...raw }, '').msg);
  await send({ id: 'native-voice', attachments: [{ filename: 'voice.amr', content_type: 'voice', url: 'https://media.fixture.test/voice', asr_refer_text: '平台参考文本' }] });
  await send({ id: 'pure-missing', attachments: [{ filename: 'a.png', content_type: 'image/png', size: 3 }] });
  await send({ id: 'body-multiple', content: 'body', attachments: [
    { filename: 'first.amr', content_type: 'voice', file: 'C:\\platform\\first.amr' },
    { filename: 'second.png', content_type: 'image/png' }, { filename: 'third.mp4', content_type: 'video/mp4' },
  ] });
  assert.deepEqual(events.map((event) => event.kind), ['message', 'message', 'message']);
  const voice = events[0].parts[0];
  assert.equal(voice.kind, 'audio'); assert.equal(voice.media.mediaType, 'audio/amr'); assert.deepEqual([...voice.media.bytes], [9, 8, 7]);
  assert.match(voice.text, /QQ ASR reference.*平台参考文本/);
  const missing = [events[1].parts[0], ...events[2].parts.slice(1)];
  for (const part of missing) { assert.equal(part.media, undefined); assert.equal(part.tooLarge, undefined); assert.match(part.text, /no downloadable URL; local platform paths are not read/); }
  assert.deepEqual(events[2].parts.map((part) => part.kind), ['text', 'audio', 'image', 'video']);
  for (const [index, name] of ['first.amr', 'second.png', 'third.mp4'].entries()) assert.ok(events[2].parts[index + 1].text.includes(name));
  assert.deepEqual(events.map((event) => event.eventId), ['official:native-voice', 'official:pure-missing', 'official:body-multiple']);
  assert.equal(fixture.calls.length, 1, 'no attempt to read local paths or missing URLs');
});

test('QQR-006: only valid protocol IDs produce delivered, with exactly one send per result', async (t) => {
  for (const response of [{ ext_info: { ref_idx: 'not-a-message-id' } }, { id: {} }, { id: [] }, { id: '  ' }, { id: 7 }, { id: false }, { id: 'real-id' }]) {
    const fixture = fetchFixture(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response }]);
    const receipt = await createOfficialClient(CONFIG, fixture).sendText(text(c2c));
    assert.equal(receipt.status, response.id === 'real-id' ? 'delivered' : 'unknown');
    assert.equal(fixture.calls.filter((call) => call.url.endsWith('/messages')).length, 1);
  }
  for (const id of [{}, [], true, '', 'arbitrary-string', 1.5, Number.MAX_SAFE_INTEGER + 1, '-12', -12, 0]) {
    const fixture = fetchFixture(t, [{ method: 'POST', url: 'https://onebot.fixture.test/send_group_msg', response: { status: 'ok', retcode: 0, data: { message_id: id } } }]);
    const receipt = await createOneBotClient({ baseUrl: 'https://onebot.fixture.test' }, fixture).sendText(text(onebot));
    const valid = id === '-12' || id === -12 || id === 0;
    assert.equal(receipt.status, valid ? 'delivered' : 'unknown');
    if (valid) assert.deepEqual(receipt.messageIds, [String(id)]);
    assert.equal(fixture.calls.length, 1);
  }
});

test('QQR-007: public entry tools share WS identity and retain its account guard after stop', async (t) => {
  const actions = [], requests = [], unexpected = [];
  let httpAccount = 998;
  const http = createServer(async (req, res) => {
    for await (const _part of req) {}
    requests.push(req.url);
    if (req.method !== 'POST' || !['/get_login_info', '/get_group_list'].includes(req.url)) { unexpected.push(`${req.method} ${req.url}`); res.writeHead(404); res.end('{}'); return; }
    const data = req.url === '/get_login_info' ? { user_id: httpAccount } : [{ group_id: 100 }];
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const wire = await wireFixture(t, (socket) => socket.on('message', (bytes) => {
    const frame = JSON.parse(String(bytes)); actions.push(frame.action);
    const data = frame.action === 'get_login_info' ? { user_id: 999 } : frame.action === 'get_group_list' ? [{ group_id: 100 }] : frame.action === 'get_group_member_list' ? [{ user_id: 200 }] : assert.fail(`Unexpected WS action ${frame.action}`);
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data }));
  }));
  const adapters = new Map(), tools = new Map();
  register({ registerImAdapter(definition, adapter) { adapters.set(definition.id, adapter); }, registerTool(definition, execute) { tools.set(definition.name, execute); } });
  const adapter = adapters.get('qq-onebot'); t.after(() => adapter.stop());
  const settings = { onebot__wsUrl: wire.url, onebot__baseUrl: `http://127.0.0.1:${http.address().port}` };
  await adapter.start({ messageLimits, settings, signal: signal(), emit: async () => {} });
  const context = { settings, signal: signal(), progress() {} };
  for (const [name, args, items] of [['qq_list_groups', {}, [{ group_id: 100 }]], ['qq_list_group_members', { groupId: '100' }, [{ user_id: 200 }]]]) {
    const result = await tools.get(name)(args, context);
    assert.deepEqual(JSON.parse(result.output), { items, nextCursor: null, accountId: 'qq-onebot:999', transport: 'websocket' });
  }
  assert.deepEqual(actions, ['get_login_info', 'get_group_list', 'get_group_member_list']);
  assert.deepEqual(requests, []);
  await adapter.stop();
  const wrongAccount = await tools.get('qq_list_groups')({}, context);
  assert.equal(wrongAccount.isError, true); assert.match(wrongAccount.output, /account differs/);
  assert.deepEqual(requests, ['/get_login_info'], 'HTTP account mismatch must stop before list read');
  httpAccount = 999;
  const sameAccount = await tools.get('qq_list_groups')({}, context);
  assert.deepEqual(JSON.parse(sameAccount.output), { items: [{ group_id: 100 }], nextCursor: null, accountId: 'qq-onebot:999', transport: 'http' });
  assert.deepEqual(requests, ['/get_login_info', '/get_login_info', '/get_group_list']);
  assert.deepEqual(unexpected, []);
});

test('QQR-007: standalone HTTP tool pins discovered account, validates every read and reports its identity', async (t) => {
  let account = 999;
  const fixture = fetchFixture(t, [
    { method: 'POST', url: 'https://onebot.fixture.test/get_login_info', response: () => ({ status: 'ok', retcode: 0, data: { user_id: account } }) },
    { method: 'POST', url: 'https://onebot.fixture.test/get_group_list', response: { status: 'ok', retcode: 0, data: [{ group_id: 100 }] } },
    { method: 'POST', url: 'https://onebot.fixture.test/get_group_member_list', response: { status: 'ok', retcode: 0, data: [{ user_id: 200 }] } },
  ]);
  const adapter = createOneBotAdapter(fixture), context = { settings: { onebot__baseUrl: 'https://onebot.fixture.test' }, signal: signal() };
  assert.deepEqual(await adapter.readGroups({}, context), { items: [{ group_id: 100 }], nextCursor: null, accountId: 'qq-onebot:999', transport: 'http' });
  assert.deepEqual((await adapter.readGroups({ groupId: '100' }, context)).items, [{ user_id: 200 }]);
  account = 998; await assert.rejects(adapter.readGroups({}, context), /account differs/);
  assert.deepEqual(fixture.calls.map((call) => new URL(call.url).pathname), ['/get_login_info', '/get_group_list', '/get_login_info', '/get_group_member_list', '/get_login_info']);
});

test('stable Host rate-limit contract: explicit 429 is failed with retryAfterMs and no plugin send retry', async (t) => {
  const fixture = fetchFixture(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: () => json({ message: 'rate limit' }, 429, { 'retry-after': '1.25' }) }]);
  const client = createOfficialClient(CONFIG, fixture);
  const receipt = await client.sendText(text(c2c));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.errorKind, 'rate_limited'); assert.equal(receipt.retryAfterMs, 1250);
  assert.equal(fixture.calls.filter((call) => call.url.endsWith('/messages')).length, 1);
});


test('QQR-008: manifest settings use the public strict shape; tool JSON schema patterns remain intact', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const properties = manifest['x-kiki'].settings.schema.properties;
  const allowed = new Set(['type', 'title', 'description', 'secret', 'default', 'hidden', 'group', 'groupTitle', 'localizations', 'enum', 'multiline', 'advanced']);
  for (const [name, property] of Object.entries(properties)) {
    assert.ok(['string', 'boolean', 'number'].includes(property.type), name);
    for (const field of Object.keys(property)) assert.ok(allowed.has(field), `${name}.${field}`);
  }
  assert.equal(properties.official__intents.type, 'number');
  assert.equal(properties.official__intents.default, 100663296);
  assert.equal(properties.onebot__selfId.type, 'string');
  assert.equal(manifest['x-kiki'].settings.schema.required?.includes('onebot__selfId') ?? false, false);
  assert.equal(manifest['x-kiki'].tools.find((tool) => tool.name === 'qq_list_group_members').parameters.properties.groupId.pattern, '^[0-9]+$');
});

test('QQR-008: actual adapter startup validates intents before any gateway or network action', async (t) => {
  const fixture = fetchFixture(t);
  const values = [];
  const adapter = createOfficialAdapter({ ...fixture, gatewayFactory(options) {
    values.push(options.intents);
    return { start() { options.onReady({}); return new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true })); } };
  } });
  t.after(() => adapter.stop());
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    await assert.rejects(adapter.start({ messageLimits, settings: { ...SETTINGS, official__intents: value }, signal: signal(), emit: async () => {} }), { code: 'CONFIGURATION', message: 'official__intents must be a non-negative integer' });
  }
  assert.deepEqual(values, []); assert.equal(fixture.calls.length, 0);
  for (const value of [undefined, 0, 1, 100663296]) {
    await adapter.start({ messageLimits, settings: { ...SETTINGS, official__intents: value }, signal: signal(), emit: async () => {} });
    await adapter.stop();
  }
  assert.deepEqual(values, [100663296, 0, 1, 100663296]);
  assert.throws(() => createOneBotClient({ selfId: 'not-numeric' }), /selfId must be numeric/);
  assert.equal(createOneBotClient({}).accountId, undefined);
});

test('QQR-009: numeric and date Retry-After retain the true wait without an early retry field', async (t) => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const cases = [
    ['1.25', 1250, 1250], ['60', 60000, 60000], ['120', undefined, 120000],
    [new Date(now + 60000).toUTCString(), 60000, 60000],
    [new Date(now + 120000).toUTCString(), undefined, 120000],
    [new Date(now - 1000).toUTCString(), 0, 0],
    ['0', 0, 0], ['60.0001', undefined, 60001],
    ['-1', undefined], ['NaN', undefined], ['Infinity', undefined], ['1e3', undefined], ['garbage', undefined], ['', undefined],
  ];
  for (const [header, expected, actual] of cases) {
    const fixture = fetchFixture(t, [{ method: 'POST', url: 'https://api.fixture.test/v2/users/u1/messages', response: () => json({ message: 'fixture rate limit' }, 429, { 'retry-after': header }) }]);
    const receipt = await createOfficialClient(CONFIG, fixture).sendText(text(c2c));
    assert.equal(receipt.status, 'failed', header); assert.equal(receipt.errorKind, 'rate_limited', header);
    assert.equal(receipt.retryAfterMs, expected, header);
    assert.equal(Object.hasOwn(receipt, 'retryAfterMs'), expected !== undefined, header);
    assert.ok(receipt.detail.includes(`Retry-After=${JSON.stringify(header)}`), header);
    if (actual !== undefined) assert.ok(receipt.detail.includes(`retryAfterMs=${actual}`), header);
    if (actual > 60000) assert.match(receipt.detail, /automatic retry disabled/);
    assert.equal(fixture.calls.filter((call) => call.url.endsWith('/messages')).length, 1);
  }
});

test('QQR-009: malformed delay values cannot escape the bounded receipt contract', () => {
  for (const delay of [-1, 1.5, NaN, Infinity, '120000', Number.MAX_SAFE_INTEGER + 1]) {
    const receipt = receiptFromError({ status: 429, retryAfterMs: delay, message: 'fixture rate limit' });
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.errorKind, 'rate_limited');
    assert.equal(Object.hasOwn(receipt, 'retryAfterMs'), false);
    assert.ok(receipt.detail.includes(`retryAfterMs=${String(delay)}`));
    assert.match(receipt.detail, /automatic retry disabled/);
  }
});
