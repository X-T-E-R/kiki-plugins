import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOneBotClient } from '../lib/onebot.mjs';
import { createOfficialClient } from '../lib/official.mjs';
import { createOneBotAdapter, createOfficialAdapter } from '../lib/adapters.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition } from '../lib/definitions.mjs';
import { normalizeOneBotEvent, normalizeOfficialEvent } from '../lib/normalize.mjs';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';

const deferred = () => Promise.withResolvers();
const ok = (data) => ({ status: 'ok', retcode: 0, data });
const group = (id = '-8', extra = {}) => ({ self_id: 999, message_id: id, message_type: 'group', group_id: 100, user_id: 200,
  sender: { user_id: 200, nickname: 'Member', card: 'Card' }, time: 1700000000, message: [{ type: 'text', data: { text: 'first\nsecond' } }], ...extra });
const lookup = { sourceMessageId: '-8', chatId: 'onebot:group:100' };
async function httpFixture(t, handle) {
  const calls = [], unexpected = [];
  let selfId = 999, loginResponse;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const action = req.url.slice(1); calls.push({ action, body });
      if (req.method !== 'POST' || !['get_login_info', 'get_msg', 'get_group_msg_history', 'get_group_list'].includes(action)) {
        unexpected.push(`${req.method} ${req.url}`); res.writeHead(404).end(); return;
      }
      const response = action === 'get_login_info' ? loginResponse ?? ok({ user_id: selfId }) : await handle(action, body, req, res);
      if (response === undefined) return;
      res.writeHead(response.httpStatus ?? 200, { 'content-type': 'application/json' });
      res.end(response.raw ?? JSON.stringify(response));
    } catch (error) { unexpected.push(error.message); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.deepEqual(unexpected, []); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createOneBotClient({ baseUrl, timeoutMs: 1000 });
  return { client, calls, baseUrl, setSelfId(value) { selfId = value; }, setLoginResponse(value) { loginResponse = value; } };
}
async function wsFixture(t, handle) {
  const actions = [], unexpected = [], sockets = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (bytes) => {
      try {
        const frame = JSON.parse(String(bytes)); actions.push(frame);
        if (!['get_login_info', 'get_msg', 'get_group_msg_history'].includes(frame.action)) { unexpected.push(frame.action); return; }
        const response = frame.action === 'get_login_info' ? ok({ user_id: 999 }) : handle(frame, socket);
        if (response) socket.send(JSON.stringify({ ...response, echo: frame.echo }));
      } catch (error) { unexpected.push(error.message); }
    });
  });
  await once(server, 'listening');
  const client = createOneBotClient({ useWebSocket: true, selfId: '999', wsUrl: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 1000,
    baseUrl: 'http://127.0.0.1:1' }, { fetchImpl() { throw new Error('WS history must not create an HTTP read'); } });
  t.after(async () => { await client.stop(); for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); assert.deepEqual(unexpected, []); });
  return { client, actions, sockets, url: `ws://127.0.0.1:${server.address().port}` };
}

test('history HTTP get_msg preserves source identity, time, quote, mentions and ordered lazy attachments', async (t) => {
  const fixture = await httpFixture(t, (_action, body) => ok(group(body.message_id, { message_seq: 7654, topic_id: 'thread', message: [
    { type: 'reply', data: { id: '-7' } }, { type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'first\nsecond' } },
    { type: 'image', data: { file: '/platform/private/image.png', url: `${fixture.baseUrl}/must-not-download`, file_size: 3 } },
    { type: 'record', data: { file: 'voice.amr', url: `${fixture.baseUrl}/must-not-download-voice`, asr_refer_text: 'reference' } },
  ] })));
  const result = await fixture.client.getMessage({ ...lookup, topicId: 'onebot:topic:thread' });
  assert.equal(result.status, 'ok'); assert.equal(result.accountId, '999'); assert.equal(result.transport, 'http');
  assert.equal(result.end, 'unknown'); assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0].identity, { chatId: 'onebot:group:100', senderId: 'onebot:user:200', topicId: 'onebot:topic:thread', chatKind: 'group', senderName: 'Card' });
  const item = result.messages[0];
  assert.equal(item.sourceMessageId, '-8'); assert.equal(item.time, 1700000000); assert.equal(item.messageSeq, '7654');
  assert.equal(item.replyToMessageId, '-7'); assert.equal(item.mentioned, true); assert.deepEqual(item.mentionIds, ['999']);
  assert.deepEqual(item.attachments.map(({ kind }) => kind), ['image', 'audio']);
  assert.equal(item.attachments[0].size, 3);
  assert.equal(item.attachments[1].mediaType, 'audio/amr'); assert.equal(item.attachments.some((value) => 'bytes' in value), false);
  assert.match(item.text, /^first\nsecond/); assert.equal(item.segments.length, 5);
  assert.deepEqual(fixture.calls.map(({ action }) => action), ['get_login_info', 'get_msg']);
  assert.deepEqual(fixture.calls[1].body, { message_id: '-8' });
});

test('history lookup rejects unproven/mismatched chat, account and source IDs instead of relabelling them', async (t) => {
  let response;
  const fixture = await httpFixture(t, () => ok(response));
  const cases = [
    { raw: group('-8', { group_id: undefined }), status: 'unknown' },
    { raw: group('-8', { group_id: 101 }), status: 'unknown' },
    { raw: group('-9'), status: 'unknown' },
    { raw: group({}, {}), status: 'unknown' },
    { raw: group(9007199254740992), status: 'unknown' },
    { raw: group('-8', { self_id: 998 }), status: 'unavailable', reason: 'account_mismatch' },
    { raw: group('-8', { time: undefined }), status: 'unknown' },
    { raw: group('-8', { sender: { user_id: 201 } }), status: 'unknown' },
  ];
  for (const item of cases) {
    response = item.raw; const result = await fixture.client.getMessage(lookup);
    assert.equal(result.status, item.status); if (item.reason) assert.equal(result.reason, item.reason);
    assert.deepEqual(result.messages, []);
  }
  response = group('-8', { message_type: 'private', user_id: 999, sender: { user_id: 999 } });
  assert.equal((await fixture.client.getMessage({ ...lookup, chatId: 'onebot:private:200' })).status, 'unknown');
  response = group('-8', { message_type: 'private', group_id: undefined });
  assert.equal((await fixture.client.getMessage({ ...lookup, chatId: 'onebot:private:200' })).status, 'ok');
  response = group('-8', { message: '[CQ:reply,id=-7][CQ:at,qq=999]quoted &#91;text&#93;', status: 'deleted' });
  const cq = await fixture.client.getMessage(lookup);
  assert.equal(cq.messages[0].text, 'quoted [text]'); assert.equal(cq.messages[0].deleted, true);
});

test('history pages use real opaque message_seq anchors, chronological time order, and unknown end even for short/empty pages', async (t) => {
  let messages = [group('999988', { time: 30, message_seq: '5' }), group('-78', { time: 10, message_seq: '900' }),
    group('3', { time: 10, message_seq: '11' }), group('-78', { time: 10, message_seq: '900' })];
  const fixture = await httpFixture(t, () => ok({ messages }));
  const first = await fixture.client.getGroupHistory({ groupId: '100', count: 10 });
  assert.equal(first.status, 'ok'); assert.equal(first.order, 'oldest_first'); assert.equal(first.end, 'unknown');
  assert.deepEqual(first.messages.map(({ sourceMessageId }) => sourceMessageId), ['-78', '3', '999988']);
  assert.equal('nextCursor' in first, false);
  assert.deepEqual(fixture.calls[1].body, { group_id: '100', count: 10, reverse_order: false, reverseOrder: false, disable_get_url: true, parse_mult_msg: false });
  messages = [group('122', { time: 9, message_seq: 899 })];
  const second = await fixture.client.getGroupHistory({ groupId: 100, messageSeq: first.messages[0].messageSeq, count: 10 });
  assert.equal(second.anchor, '900'); assert.equal(fixture.calls[3].body.message_seq, '900'); assert.equal(second.end, 'unknown');
  messages = [];
  const empty = await fixture.client.getGroupHistory({ groupId: 100, messageSeq: '899' });
  assert.equal(empty.status, 'empty'); assert.equal(empty.end, 'unknown');
  assert.equal(fixture.calls.filter(({ action }) => action === 'get_group_msg_history').length, 3);
});

test('history partial pages retain valid messages and report malformed or foreign-source omissions', async (t) => {
  let messages = [group('1'), group('2', { group_id: 101 }), group({}, {}), group('3', { message: undefined })];
  const fixture = await httpFixture(t, () => ok({ messages }));
  const result = await fixture.client.getGroupHistory({ groupId: 100 });
  assert.equal(result.status, 'partial'); assert.equal(result.end, 'unknown');
  assert.deepEqual(result.messages.map(({ sourceMessageId }) => sourceMessageId), ['1']);
  assert.equal(result.receivedCount, 4); assert.equal(result.omittedCount, 3); assert.equal(result.issues.length, 3);
  messages = [group('1'), group('2', { self_id: 998 })];
  const foreignAccount = await fixture.client.getGroupHistory({ groupId: 100 });
  assert.equal(foreignAccount.reason, 'account_mismatch'); assert.deepEqual(foreignAccount.messages, []);
  messages = [group('1', { topic_id: 'a' }), group('2', { topic_id: 'b' })];
  const topic = await fixture.client.getGroupHistory({ groupId: 100, topicId: 'onebot:topic:a' });
  assert.equal(topic.status, 'partial'); assert.deepEqual(topic.messages.map(({ sourceMessageId }) => sourceMessageId), ['1']);
});

test('history account capability failure stays unavailable without probing a history endpoint', async (t) => {
  const fixture = await httpFixture(t, () => { throw new Error('History must not be requested'); });
  fixture.setLoginResponse({ httpStatus: 404, message: 'No login endpoint' });
  const result = await fixture.client.getGroupHistory({ groupId: 100 });
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'identity_unavailable');
  assert.equal(result.end, 'unknown'); assert.deepEqual(fixture.calls.map(({ action }) => action), ['get_login_info']);
});

test('history distinguishes optional unsupported endpoint, successful empty, provider refusal and unknown response', async (t) => {
  let response;
  const fixture = await httpFixture(t, () => response);
  for (const item of [
    { response: { status: 'failed', retcode: 200, message: '不支持的Api get_group_msg_history', data: null }, status: 'unsupported' },
    { response: { httpStatus: 404, message: 'API not found' }, status: 'unsupported' },
    { response: { status: 'failed', retcode: 1200, message: '消息不存在', data: null }, status: 'unavailable' },
    { response: { status: 'failed', retcode: 1401, message: 'permission denied', data: null }, status: 'unavailable' },
    { response: ok({ messages: [] }), status: 'empty' },
    { response: ok({}), status: 'unknown' },
    { response: { raw: '{broken' }, status: 'unknown' },
    { response: { status: 'async', retcode: 1, data: null }, status: 'unknown' },
  ]) {
    response = item.response;
    const result = await fixture.client.getGroupHistory({ groupId: 100 });
    assert.equal(result.status, item.status); assert.equal(result.end, 'unknown'); assert.deepEqual(result.messages, []);
  }
  assert.equal(fixture.calls.filter(({ action }) => action === 'get_group_msg_history').length, 8, 'no read retries or capability probing');
});

test('history HTTP pins the verified account and blocks a changed account before reading', async (t) => {
  const fixture = await httpFixture(t, () => ok({ messages: [] }));
  await fixture.client.getGroupHistory({ groupId: 100 });
  fixture.setSelfId(998);
  const result = await fixture.client.getGroupHistory({ groupId: 100 });
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'account_mismatch');
  assert.equal(fixture.calls.filter(({ action }) => action === 'get_group_msg_history').length, 1);
  const before = fixture.calls.length;
  await assert.rejects(fixture.client.getMessage({ ...lookup, sourceMessageId: {} }));
  await assert.rejects(fixture.client.getGroupHistory({ groupId: 'official:group:100' }));
  await assert.rejects(fixture.client.getGroupHistory({ groupId: 100, count: 1.5 }));
  assert.equal(fixture.calls.length, before);
});

test('history HTTP cancellation and timeout retain unknown/unavailable and never turn into empty history', async (t) => {
  const entered = deferred();
  const fixture = await httpFixture(t, () => { entered.resolve(); return undefined; });
  const cancelled = new AbortController();
  const work = fixture.client.getGroupHistory({ groupId: 100, signal: cancelled.signal });
  await entered.promise; cancelled.abort();
  const result = await work;
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'cancelled'); assert.equal(result.end, 'unknown');
  const timeoutClient = createOneBotClient({ baseUrl: fixture.baseUrl, timeoutMs: 30 });
  assert.equal((await timeoutClient.getGroupHistory({ groupId: 100 })).status, 'unknown');
  const already = new AbortController(); already.abort(); const before = fixture.calls.length;
  assert.equal((await fixture.client.getMessage({ ...lookup, signal: already.signal })).reason, 'cancelled');
  assert.equal(fixture.calls.length, before);
});

test('history WS reuses the sole verified connection, fixed actions, correlation and cancellation', async (t) => {
  const entered = deferred();
  let hold = false;
  const fixture = await wsFixture(t, (frame) => {
    if (hold) { entered.resolve(); return; }
    if (frame.action === 'get_msg') return ok(group(frame.params.message_id));
    return ok({ messages: [group('8', { message_seq: '903' })] });
  });
  const notStarted = await fixture.client.getMessage(lookup);
  assert.equal(notStarted.status, 'unavailable'); assert.equal(notStarted.accountId, undefined); assert.deepEqual(fixture.actions, []);
  await fixture.client.start({ emit() {} });
  const [message, history] = await Promise.all([fixture.client.getMessage(lookup), fixture.client.getGroupHistory({ groupId: 100, messageSeq: '904' })]);
  assert.equal(message.status, 'ok'); assert.equal(history.status, 'ok'); assert.equal(message.transport, 'websocket');
  assert.equal(fixture.sockets.length, 1); assert.deepEqual(fixture.actions.map(({ action }) => action), ['get_login_info', 'get_msg', 'get_group_msg_history']);
  hold = true;
  const cancelled = new AbortController(); const work = fixture.client.getGroupHistory({ groupId: 100, signal: cancelled.signal });
  await entered.promise; cancelled.abort(); assert.equal((await work).reason, 'cancelled');
  const stopped = fixture.client.getMessage(lookup); await fixture.client.stop();
  assert.ok(['unknown', 'unavailable'].includes((await stopped).status));
  assert.equal(fixture.sockets.length, 1);
});

test('history WS uses real retcodes to separate optional endpoint absence from an unavailable message', async (t) => {
  const fixture = await wsFixture(t, (frame) => ({ status: 'failed', retcode: frame.action === 'get_msg' ? 1200 : 1404,
    message: frame.action === 'get_msg' ? '消息不存在或已被撤回' : '不支持的API get_group_msg_history', data: null }));
  await fixture.client.start();
  const history = await fixture.client.getGroupHistory({ groupId: 100 });
  assert.equal(history.status, 'unsupported'); assert.equal(history.providerCode, 1404);
  const message = await fixture.client.getMessage(lookup);
  assert.equal(message.status, 'unavailable'); assert.equal(message.providerCode, 1200);
});

test('official group/C2C history remains explicit unsupported without touching token, reply cache or HTTP', async () => {
  let calls = 0;
  const client = createOfficialClient({ appId: 'fixture-app', appSecret: 'fixture-secret' }, { fetchImpl() { calls++; throw new Error('No history API is available'); } });
  for (const result of [await client.getMessage(lookup), await client.getGroupHistory({ groupId: 100 })]) {
    assert.equal(result.status, 'unsupported'); assert.equal(result.end, 'unknown'); assert.deepEqual(result.messages, []);
  }
  assert.equal(calls, 0);
});

const historyRequest = { chatId: 'onebot:group:100', topicId: 'onebot:group:100', limit: 2 };
function historyWindow(rows, { message_seq: anchor, count }, inclusive) {
  const index = anchor === undefined ? rows.length : rows.findIndex((item) => item.message_seq === anchor);
  assert.ok(index >= 0, `Unknown fixture anchor: ${anchor}`);
  const end = anchor === undefined ? rows.length : index + Number(inclusive);
  return rows.slice(Math.max(0, end - count), end);
}
async function startedHistoryAdapter(t, fixture) {
  const adapter = createOneBotAdapter({ fetchImpl() { throw new Error('Adapter history must use its WS'); } });
  const context = { signal: new AbortController().signal, settings: { onebot__wsUrl: fixture.url } };
  await adapter.start({ ...context, emit() { throw new Error('History must not emit a new live message'); } });
  t.after(() => adapter.stop());
  return { adapter, context };
}

test('Host history adapter projects real source metadata and opaque source-bound platform anchors', async (t) => {
  const rows = [group('7', { message_seq: '-78', time: 5 }), group('8', { message_seq: '999988', time: 10, user_id: 999, sender: { user_id: 999 },
    message: [{ type: 'reply', data: { id: '-7' } }, { type: 'at', data: { qq: '200' } }, { type: 'image', data: { file: 'photo.png', url: 'https://media.fixture.test/no-download' } }] }),
  group('9', { message_seq: '42', time: 20, status: 'deleted' })];
  const fixture = await wsFixture(t, ({ params }) => ok({ messages: historyWindow(rows, params, true) }));
  const { adapter, context } = await startedHistoryAdapter(t, fixture);
  const page = await adapter.readHistory(historyRequest, context);
  assert.equal(onebotAdapterDefinition.supportsHistory, true); assert.equal(officialAdapterDefinition.supportsHistory, false);
  assert.equal(page.status, 'ok'); assert.equal(page.order, 'chronological'); assert.equal(page.coverage, 'unknown'); assert.equal(page.end, 'unknown');
  assert.equal(page.messages[0].sourceMessageId, '8'); assert.equal(page.messages[0].timestamp, 10000); assert.equal(page.messages[0].isSelf, true);
  assert.equal(page.messages[0].replyToMessageId, '-7'); assert.deepEqual(page.messages[0].mentionIds, ['200']);
  assert.deepEqual(page.messages[0].media, [{ kind: 'image', name: 'photo.png', mediaType: 'image/png' }]);
  assert.equal(page.messages[1].operation, 'retract'); assert.equal(page.messages[1].sourceMessageId, '9'); assert.equal(page.messages[1].text, undefined);
  assert.equal(typeof page.nextCursor, 'string'); assert.notEqual(page.nextCursor, '999988');
  const next = await adapter.readHistory({ ...historyRequest, cursor: page.nextCursor }, context);
  assert.deepEqual(next.messages.map(({ sourceMessageId }) => sourceMessageId), ['7']);
  assert.equal(typeof next.nextCursor, 'string');
  assert.equal(fixture.actions.at(-1).params.message_seq, '999988');
  assert.equal(fixture.actions.at(-1).params.count, 3);
  const before = fixture.actions.length;
  await assert.rejects(adapter.readHistory({ ...historyRequest, chatId: 'onebot:group:101', cursor: page.nextCursor }, context), /account\/chat\/topic/);
  await assert.rejects(adapter.readHistory({ ...historyRequest, cursor: 'raw-sequence' }, context), /cursor/);
  await assert.rejects(adapter.readHistory({ ...historyRequest, limit: 51 }, context), /request/);
  assert.equal(fixture.actions.length, before); assert.equal(fixture.sockets.length, 1);
});

test('Host history adapter keeps empty/partial/unsupported truthful and rejects unknown or unavailable reads', async (t) => {
  let response = ok({ messages: [] });
  const fixture = await wsFixture(t, () => response);
  const { adapter, context } = await startedHistoryAdapter(t, fixture);
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.readHistory(historyRequest, context))), { status: 'ok', messages: [], order: 'chronological', coverage: 'unknown', end: 'unknown' });
  response = ok({ messages: [group('1'), group('2', { group_id: 101 })] });
  assert.equal((await adapter.readHistory(historyRequest, context)).coverage, 'partial');
  response = { status: 'failed', retcode: 1404, message: 'API absent' };
  assert.deepEqual(await adapter.readHistory(historyRequest, context), { status: 'unsupported', detail: 'API absent' });
  response = ok({}); await assert.rejects(adapter.readHistory(historyRequest, context), /history unknown/);
  response = { status: 'failed', retcode: 1200, message: '消息不存在' };
  await assert.rejects(adapter.readHistory(historyRequest, context), /history unavailable/);
  assert.equal((await adapter.readHistory({ ...historyRequest, chatId: 'onebot:private:200', topicId: 'onebot:private:200' }, context)).status, 'unsupported');
  assert.equal((await createOfficialAdapter().readHistory(historyRequest, context)).status, 'unsupported');
});

test('Host history adapter enforces message/text/media/mention bounds with partial coverage, retaining real IDs', async (t) => {
  const many = [...Array.from({ length: 1001 }, (_, index) => ({ type: 'at', data: { qq: String(index + 1) } })),
    { type: 'text', data: { text: 'x'.repeat(17000) } }, ...Array.from({ length: 5 }, () => ({ type: 'image', data: { file: 'image.png' } }))];
  const fixture = await wsFixture(t, () => ok({ messages: [group('7', { sender: { user_id: 200, card: 'N'.repeat(5000) }, message: many }), group('1'.repeat(1025))] }));
  const { adapter, context } = await startedHistoryAdapter(t, fixture);
  const page = await adapter.readHistory(historyRequest, context);
  assert.equal(page.coverage, 'partial'); assert.equal(page.messages.length, 1); assert.equal(page.messages[0].sourceMessageId, '7');
  assert.equal(page.messages[0].text.length, 16384); assert.equal(page.messages[0].identity.senderName.length, 4096);
  assert.equal(page.messages[0].mentionIds.length, 1000); assert.equal(page.messages[0].media.length, 4);
});

test('Host history adapter cancellation/stop do not open HTTP or return a fabricated successful empty page', async (t) => {
  const entered = deferred();
  const fixture = await wsFixture(t, () => { entered.resolve(); return undefined; });
  const adapter = createOneBotAdapter({ fetchImpl() { throw new Error('No HTTP fallback'); } });
  const context = { settings: { onebot__wsUrl: fixture.url }, signal: new AbortController().signal };
  await assert.rejects(adapter.readHistory(historyRequest, context), /running channel/);
  await adapter.start({ ...context, emit() {} });
  t.after(() => adapter.stop());
  const cancelled = new AbortController();
  const work = adapter.readHistory(historyRequest, { ...context, signal: cancelled.signal });
  await entered.promise; cancelled.abort(); await assert.rejects(work, /abort/i);
  const stopping = adapter.readHistory(historyRequest, context);
  const rejected = assert.rejects(stopping, /abort/i);
  await adapter.stop(); await rejected;
  await assert.rejects(adapter.readHistory(historyRequest, context), /running channel/);
  assert.equal(fixture.sockets.length, 1);
});

test('Host event metadata uses epoch milliseconds and retract target IDs, not dedup event IDs or recall operators', () => {
  const self = normalizeOneBotEvent({ ...group('8', { user_id: 999, sender: { user_id: 999 } }), post_type: 'message_sent' }, { selfId: '999' })[0];
  assert.equal(self.isSelf, true); assert.equal(self.operation, 'create'); assert.equal(self.timestamp, 1700000000000);
  const recalled = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'group_recall', self_id: 999, group_id: 100, user_id: 200, operator_id: 300, message_id: 8, time: 1700000001 }, { selfId: '999' })[0];
  assert.equal(recalled.operation, 'retract'); assert.equal(recalled.sourceMessageId, '8'); assert.notEqual(recalled.eventId, '8');
  assert.equal(recalled.identity.senderId, 'onebot:user:200'); assert.equal(recalled.timestamp, 1700000001000);
  const original = normalizeOfficialEvent({ id: 'source', timestamp: '2026-10-25T00:00:00Z', author: { user_openid: 'member' }, content: 'text' }, { eventType: 'C2C_MESSAGE_CREATE' })[0];
  assert.equal(original.operation, 'create'); assert.equal(original.timestamp, Date.parse('2026-10-25T00:00:00Z'));
});


test('QQH-001 Host history adapter reads three limit-1 pages with inclusive/exclusive and nonlinear anchors', async (t) => {
  for (const inclusive of [true, false]) for (const anchors of [['100', '200', '300'], ['999988', '-78', '42']]) {
    const rows = anchors.map((message_seq, index) => group(String(index + 1), { message_seq, time: index + 1 }));
    const fixture = await wsFixture(t, ({ params }) => ok({ messages: historyWindow(rows, params, inclusive) }));
    const { adapter, context } = await startedHistoryAdapter(t, fixture);
    let cursor;
    for (const expected of ['3', '2', '1']) {
      const before = fixture.actions.length;
      const page = await adapter.readHistory({ ...historyRequest, limit: 1, cursor }, context);
      assert.deepEqual(page.messages.map(({ sourceMessageId }) => sourceMessageId), [expected]);
      assert.equal(page.coverage, 'unknown'); assert.equal(page.end, 'unknown');
      assert.equal(fixture.actions.length, before + 1, 'one platform read per requested page');
      assert.equal(fixture.actions.at(-1).params.count, cursor ? 2 : 1);
      cursor = page.nextCursor; assert.equal(typeof cursor, 'string');
    }
    const last = await adapter.readHistory({ ...historyRequest, limit: 1, cursor }, context);
    assert.deepEqual(last.messages, []); assert.equal(last.nextCursor, undefined); assert.equal(last.end, 'unknown');
    const reads = fixture.actions.filter(({ action }) => action === 'get_group_msg_history');
    assert.deepEqual(reads.map(({ params }) => params.message_seq), [undefined, anchors[2], anchors[1], anchors[0]]);
    assert.equal(fixture.sockets.length, 1);
    await adapter.stop();
  }
});

test('QQH-001 Host history adapter keeps 50-message output and one bounded read on inclusive/exclusive pages', async (t) => {
  const rows = Array.from({ length: 101 }, (_, index) => group(String(index + 1), { message_seq: String((index + 1) * 17), time: index + 1 }));
  for (const inclusive of [true, false]) {
    const fixture = await wsFixture(t, ({ params }) => ok({ messages: historyWindow(rows, params, inclusive) }));
    const { adapter, context } = await startedHistoryAdapter(t, fixture);
    const pages = []; let cursor;
    for (const count of [50, 50, 1]) {
      const before = fixture.actions.length;
      const page = await adapter.readHistory({ ...historyRequest, limit: 50, cursor }, context);
      assert.equal(page.messages.length, count); assert.equal(page.coverage, 'unknown'); assert.equal(page.end, 'unknown');
      assert.equal(fixture.actions.length, before + 1); assert.equal(fixture.actions.at(-1).params.count, cursor ? 51 : 50);
      pages.push(page); cursor = page.nextCursor;
    }
    const ids = pages.flatMap(({ messages }) => messages.map(({ sourceMessageId }) => sourceMessageId));
    assert.equal(new Set(ids).size, 101); assert.deepEqual([...ids].sort((a, b) => Number(a) - Number(b)), rows.map(({ message_id }) => message_id));
    assert.equal(fixture.sockets.length, 1);
    await adapter.stop();
  }
});

test('QQH-001 Host history adapter suppresses a repeated endpoint by real source or anchor and stops unknown', async (t) => {
  for (const repeated of [group('3', { message_seq: '300', time: 3 }), group('3', { message_seq: '-78', time: 3 }), group('99', { message_seq: '300', time: 3 })]) {
    let reads = 0;
    const fixture = await wsFixture(t, () => ok({ messages: [reads++ ? repeated : group('3', { message_seq: '300', time: 3 })] }));
    const { adapter, context } = await startedHistoryAdapter(t, fixture);
    const first = await adapter.readHistory({ ...historyRequest, limit: 1 }, context);
    const page = await adapter.readHistory({ ...historyRequest, limit: 1, cursor: first.nextCursor }, context);
    assert.deepEqual(page.messages, []); assert.equal(page.nextCursor, undefined);
    assert.equal(page.coverage, 'unknown'); assert.equal(page.end, 'unknown'); assert.equal(reads, 2);
    assert.equal(fixture.actions.at(-1).params.count, 2); assert.equal(fixture.sockets.length, 1);
    await adapter.stop();
  }
});
