import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition } from '../lib/definitions.mjs';
import { createOfficialAdapter } from '../lib/adapters.mjs';
import { createImReceiver, loadImContract } from './im-rpc-fixture.mjs';

const [sdkPath, runnerPath, parserPath] = process.argv.slice(2);
if (!sdkPath || !runnerPath) throw new Error('Usage: node check-history-contract.mjs <public SDK im module> <Host runner> [Host imAdapter module]');
const { sdk, parsePluginImEvent } = await loadImContract(sdkPath, parserPath);
const parseRequest = (value) => sdk.pluginImHistoryRequestSchema.parse(value);
const parsePage = (value) => sdk.pluginImHistoryPageSchema.parse(value);
const requestShape = { chatId: 'onebot:group:100', topicId: 'onebot:group:100', limit: 2 };
for (const definition of [officialAdapterDefinition, onebotAdapterDefinition]) sdk.pluginImAdapterDefinitionSchema.parse(definition);
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
assert.deepEqual(manifest['x-kiki'].imAdapters, [officialAdapterDefinition, onebotAdapterDefinition]);
assert.deepEqual(parsePage(await createOfficialAdapter().readHistory(requestShape)), { status: 'unsupported', detail: 'Official QQ group/C2C APIs do not expose history' });
assert.equal(onebotAdapterDefinition.supportsHistory, true); assert.equal(officialAdapterDefinition.supportsHistory, false);
const actions = [], unexpected = [], registrations = [], events = [], pending = new Map(), waiters = [];
let runner, nextId = 1, stderr = '', watchdog, mode = 'normal', pageRows, includeAnchor;
const raw = (id, time, sender = 200, extra = {}) => ({ self_id: 999, message_id: id, message_seq: id === '7' ? '999988' : '43', message_type: 'group',
  group_id: 100, user_id: sender, sender: { user_id: sender, nickname: 'Fixture member' }, time, message: [{ type: 'text', data: { text: 'history\nbody' } }], ...extra });
const normalRows = [raw('6', 5, 200, { message_seq: '-78' }), raw('7', 10, 999, { message: [{ type: 'image', data: { file: 'fixture.png', url: 'https://media.fixture.test/lazy' } }] }), raw('8', 20)];
function historyWindow(rows, { message_seq: anchor, count }, inclusive) {
  const index = anchor === undefined ? rows.length : rows.findIndex((item) => item.message_seq === anchor);
  assert.ok(index >= 0, `Unknown fixture anchor: ${anchor}`);
  const end = anchor === undefined ? rows.length : index + Number(inclusive);
  return rows.slice(Math.max(0, end - count), end);
}
const wire = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wire.on('connection', (socket) => socket.on('message', (bytes) => {
  const frame = JSON.parse(String(bytes)); actions.push(frame);
  if (!['get_login_info', 'get_group_msg_history'].includes(frame.action)) { unexpected.push(frame.action); return; }
  let response;
  if (frame.action === 'get_login_info') response = { status: 'ok', retcode: 0, data: { user_id: 999 } };
  else if (mode === 'unknown') response = { status: 'ok', retcode: 0, data: {} };
  else if (mode === 'unsupported') response = { status: 'failed', retcode: 1404, data: null, message: 'API unsupported' };
  else if (mode === 'empty') response = { status: 'ok', retcode: 0, data: { messages: [] } };
  else if (mode === 'bounded') response = { status: 'ok', retcode: 0, data: { messages: [raw('7', 10, 999, { sender: { user_id: 999, card: 'n'.repeat(5000) },
    message: [{ type: 'reply', data: { id: '1'.repeat(1025) } }, ...Array.from({ length: 1001 }, (_, index) => ({ type: 'at', data: { qq: String(index + 1) } })),
      { type: 'text', data: { text: 'x'.repeat(17000) } }, ...Array.from({ length: 5 }, () => ({ type: 'image', data: { file: 'fixture.png', url: 'https://media.fixture.test/lazy' } }))] })] } };
  else if (mode === 'stalled') response = { status: 'ok', retcode: 0, data: { messages: [raw('3', 3, 200, { message_seq: '300' })] } };
  else response = { status: 'ok', retcode: 0, data: { messages: historyWindow(mode === 'paged' ? pageRows : normalRows, frame.params, mode === 'paged' ? includeAnchor : true) } };
  socket.send(JSON.stringify({ ...response, echo: frame.echo }));
  if (frame.action === 'get_login_info') {
    socket.send(JSON.stringify({ ...raw('12', 1700000000), post_type: 'message' }));
    socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: 999, group_id: 100, user_id: 200, operator_id: 300, message_id: 12, time: 1700000001 }));
  }
}));
await once(wire, 'listening');
const send = (value) => runner.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
function rpc(method, params) {
  const id = nextId++, call = Promise.withResolvers(); pending.set(id, call); send({ id, method, params }); return call.promise;
}
const receiver = createImReceiver({ sdk, parsePluginImEvent, definitions: [officialAdapterDefinition, onebotAdapterDefinition], send,
  async listener(_adapterId, event) { events.push(event); } });
function im(action, input) {
  if (action === 'start') receiver.start('qq-onebot');
  if (action === 'stop') receiver.stop('qq-onebot');
  return rpc('im-adapter-request', { adapterId: 'qq-onebot', instanceId: 'history-fixture', action, input,
    messageLimits: action === 'start' ? sdk.PLUGIN_IM_COMPLETE_LIMITS : undefined,
    settings: { onebot__wsUrl: `ws://127.0.0.1:${wire.address().port}`, onebot__selfId: '999' } });
}
function wake() { for (const call of [...waiters]) if (call.predicate()) { waiters.splice(waiters.indexOf(call), 1); call.resolve(); } }
function fail(error) { for (const item of pending.values()) item.reject(error); for (const item of waiters) item.reject(error); }
function waitFor(predicate) {
  if (predicate()) return Promise.resolve();
  const call = Promise.withResolvers(); waiters.push({ predicate, ...call }); return call.promise;
}
try {
  runner = spawn(process.execPath, [resolve(runnerPath), fileURLToPath(new URL('../entry.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  watchdog = setTimeout(() => { runner.kill(); for (const item of pending.values()) item.reject(new Error(`History RPC timed out: ${stderr}`)); for (const item of waiters) item.reject(new Error(`History event timed out: ${stderr}`)); }, 10000);
  runner.stderr.on('data', (bytes) => { stderr += bytes; });
  runner.once('exit', (code) => { for (const call of pending.values()) call.reject(new Error(`History runner exited ${code}: ${stderr}`)); for (const call of waiters) call.reject(new Error(`History runner exited ${code}: ${stderr}`)); });
  let ready = false;
  createInterface({ input: runner.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'register-im-adapter') registrations.push(message.params.definition);
    if (message.method === 'ready') ready = true;
    if (message.method === 'im-adapter-message-chunk' || message.method === 'im-adapter-event') { void receiver.accept(message).then(wake, fail); return; }
    if (message.id !== undefined) {
      const call = pending.get(message.id); pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
    }
    wake();
  });
  await rpc('handshake', { version: 1 }); await waitFor(() => ready);
  assert.deepEqual(registrations, [officialAdapterDefinition, onebotAdapterDefinition]);
  assert.deepEqual(await im('start'), { accountId: 'qq-onebot:999', listenerAccountId: '999' });
  await waitFor(() => receiver.deliveries.length === 2);
  assert.equal(events.length, 2); assert.equal(events[0].kind, 'message');
  assert.deepEqual(events[0].parts.map(({ kind, text }) => ({ kind, text })), [{ kind: 'text', text: 'history\nbody' }]);
  assert.equal(events[0].sourceMessageId, '12'); assert.equal(events[0].operation, 'create'); assert.equal(events[0].timestamp, 1700000000000);
  assert.equal(receiver.frames.length, 1); assert.equal(receiver.acknowledgements.length, 2);
  assert.equal(receiver.acknowledgements.every(({ result }) => result === true), true);
  assert.equal(events[1].operation, 'retract'); assert.equal(events[1].sourceMessageId, '12'); assert.equal(events[1].identity.senderId, 'onebot:user:200');
  const first = parsePage(await im('readHistory', parseRequest(requestShape)));
  assert.equal(first.status, 'ok'); assert.equal(first.coverage, 'unknown'); assert.equal(first.end, 'unknown'); assert.equal(first.order, 'chronological');
  assert.deepEqual(first.messages.map(({ sourceMessageId }) => sourceMessageId), ['7', '8']);
  assert.equal(first.messages[0].timestamp, 10000); assert.equal(first.messages[0].isSelf, true);
  assert.deepEqual(first.messages[0].media, [{ kind: 'image', name: 'fixture.png', mediaType: 'image/png' }]);
  const older = parsePage(await im('readHistory', parseRequest({ ...requestShape, cursor: first.nextCursor })));
  assert.equal(actions.at(-1).params.message_seq, '999988'); assert.equal(actions.at(-1).params.count, 3);
  assert.deepEqual(older.messages.map(({ sourceMessageId }) => sourceMessageId), ['6']); assert.equal(typeof older.nextCursor, 'string');
  const beforeInvalid = actions.length;
  await assert.rejects(im('readHistory', { ...requestShape, chatId: 'onebot:group:101', cursor: first.nextCursor }), /account\/chat\/topic/);
  assert.equal(actions.length, beforeInvalid);
  const pagination = [];
  for (const inclusive of [true, false]) for (const anchors of [['100', '200', '300'], ['999988', '-78', '42']]) {
    mode = 'paged'; includeAnchor = inclusive;
    pageRows = anchors.map((message_seq, index) => raw(String(index + 1), index + 1, 200, { message_seq }));
    const pages = [], before = actions.length; let cursor;
    for (const expected of ['3', '2', '1']) {
      const callCount = actions.length;
      const page = parsePage(await im('readHistory', parseRequest({ ...requestShape, limit: 1, cursor })));
      assert.equal(actions.length, callCount + 1); assert.equal(actions.at(-1).params.count, cursor ? 2 : 1);
      assert.deepEqual(page.messages.map(({ sourceMessageId }) => sourceMessageId), [expected]);
      assert.equal(page.end, 'unknown'); assert.equal(page.coverage, 'unknown');
      pages.push(page.messages.map(({ sourceMessageId }) => sourceMessageId)); cursor = page.nextCursor;
      assert.equal(typeof cursor, 'string');
    }
    const terminal = parsePage(await im('readHistory', parseRequest({ ...requestShape, limit: 1, cursor })));
    assert.deepEqual(terminal.messages, []); assert.equal(terminal.nextCursor, undefined); assert.equal(terminal.end, 'unknown');
    assert.equal(terminal.coverage, 'unknown');
    const calls = actions.slice(before);
    assert.deepEqual(calls.map(({ params }) => params.message_seq), [undefined, anchors[2], anchors[1], anchors[0]]);
    assert.deepEqual(calls.map(({ params }) => params.count), [1, 2, 2, 2]);
    pagination.push({ inclusive, limit: 1, anchors, pages, counts: calls.map(({ params }) => params.count), terminal });
  }
  mode = 'stalled';
  const stalledCursor = parsePage(await im('readHistory', parseRequest({ ...requestShape, limit: 1 }))).nextCursor;
  const stalledBefore = actions.length;
  const stalled = parsePage(await im('readHistory', parseRequest({ ...requestShape, limit: 1, cursor: stalledCursor })));
  assert.deepEqual(stalled.messages, []); assert.equal(stalled.nextCursor, undefined); assert.equal(stalled.end, 'unknown');
  assert.equal(stalled.coverage, 'unknown'); assert.equal(actions.length, stalledBefore + 1);
  for (const inclusive of [true, false]) {
    mode = 'paged'; includeAnchor = inclusive;
    pageRows = Array.from({ length: 101 }, (_, index) => raw(String(index + 1), index + 1, 200, { message_seq: String((index + 1) * 17) }));
    const pages = [], before = actions.length; let cursor;
    for (const count of [50, 50, 1]) {
      const callCount = actions.length;
      const page = parsePage(await im('readHistory', parseRequest({ ...requestShape, limit: 50, cursor })));
      assert.equal(actions.length, callCount + 1); assert.equal(actions.at(-1).params.count, cursor ? 51 : 50);
      assert.equal(page.messages.length, count); assert.equal(page.end, 'unknown'); assert.equal(page.coverage, 'unknown');
      pages.push(page.messages.map(({ sourceMessageId }) => sourceMessageId)); cursor = page.nextCursor;
    }
    const ids = pages.flat(); assert.equal(new Set(ids).size, 101);
    assert.deepEqual([...ids].sort((a, b) => Number(a) - Number(b)), pageRows.map(({ message_id }) => message_id));
    pagination.push({ inclusive, limit: 50, pageSizes: pages.map((page) => page.length), uniqueIds: new Set(ids).size, counts: actions.slice(before).map(({ params }) => params.count) });
  }
  mode = 'bounded'; const bounded = parsePage(await im('readHistory', parseRequest(requestShape)));
  assert.equal(bounded.coverage, 'partial'); assert.equal(bounded.messages[0].text.length, 16384);
  assert.equal(bounded.messages[0].media.length, 4); assert.equal(bounded.messages[0].mentionIds.length, 1000);
  assert.equal(bounded.messages[0].identity.senderName.length, 4096); assert.equal(bounded.messages[0].replyToMessageId, undefined);
  mode = 'empty'; const empty = parsePage(await im('readHistory', parseRequest(requestShape)));
  assert.equal(empty.end, 'unknown'); assert.equal(empty.coverage, 'unknown'); assert.deepEqual(empty.messages, []);
  mode = 'unsupported'; assert.deepEqual(parsePage(await im('readHistory', parseRequest(requestShape))), { status: 'unsupported', detail: 'API unsupported' });
  mode = 'unknown'; await assert.rejects(im('readHistory', parseRequest(requestShape)), /history unknown/);
  await im('stop'); await assert.rejects(im('readHistory', requestShape), /not connected/);
  const exit = once(runner, 'exit'); await rpc('shutdown', {}); await exit; assert.equal(runner.exitCode, 0, stderr);
  assert.deepEqual(unexpected, []); assert.equal(receiver.pendingAssemblies, 0);
  console.log(JSON.stringify({ node: process.version, validation: parserPath ? 'production-parser-and-public-wire-assertions' : 'public-wire-contract-assertions',
    parser: parserPath ? resolve(parserPath) : undefined, frames: receiver.frames, listenerCalls: receiver.deliveries.length, acknowledgements: receiver.acknowledgements,
    pendingAssemblies: receiver.pendingAssemblies, registrations: registrations.map(({ id, supportsHistory }) => ({ id, supportsHistory })),
    first, bounded: { ...bounded, messages: bounded.messages.map((item) => ({ sourceMessageId: item.sourceMessageId, textLength: item.text.length, mentionCount: item.mentionIds.length, mediaCount: item.media.length })) },
    older, pagination, stalled, empty, events, historyActionCount: actions.filter((item) => item.action === 'get_group_msg_history').length, shutdownExit: runner.exitCode }, null, 2));
} finally {
  clearTimeout(watchdog);
  if (runner && runner.exitCode === null) { runner.stdin.destroy(); runner.kill(); await once(runner, 'exit'); }
  for (const socket of wire.clients) socket.terminate(); await new Promise((resolve) => wire.close(resolve));
}
