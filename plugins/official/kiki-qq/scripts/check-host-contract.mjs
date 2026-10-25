import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition, toolDefinitions } from '../lib/definitions.mjs';
import { officialIdentity, onebotIdentity } from '../lib/identity.mjs';
import { createImReceiver, loadImContract } from './im-rpc-fixture.mjs';

const [sdkImPath, hostRunnerPath, parserPath] = process.argv.slice(2);
if (!sdkImPath || !hostRunnerPath) throw new Error('Usage: node check-host-contract.mjs <public SDK im module> <Host runner> [Host imAdapter module]');
const { sdk, parsePluginImEvent } = await loadImContract(sdkImPath, parserPath);
const limits = sdk.PLUGIN_IM_COMPLETE_LIMITS;
const expectedDefinitions = [officialAdapterDefinition, onebotAdapterDefinition];
for (const definition of expectedDefinitions) sdk.pluginImAdapterDefinitionSchema.parse(definition);
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
assert.equal(manifest['x-kiki'].entry, './entry.mjs');
assert.deepEqual(manifest['x-kiki'].imAdapters, expectedDefinitions);
assert.deepEqual(manifest['x-kiki'].tools, toolDefinitions);
const unexpected = [], messages = [], pending = new Map(), waiters = [], events = [], downloads = [], actions = [], closed = new Map();
let nextId = 1, stderr = '', runner, fatal;
const definitions = [], imageBytes = [Buffer.alloc(8 * 1024 * 1024, 17), Buffer.alloc(8 * 1024 * 1024, 34)];
const server = createServer(async (req, res) => {
  try {
    const media = /^\/media\/(official|onebot)\/(first|second)\.png$/u.exec(req.url);
    if (req.method === 'GET' && media) {
      const bytes = imageBytes[media[2] === 'first' ? 0 : 1];
      downloads.push({ platform: media[1], name: `${media[2]}.png`, bytes: bytes.length });
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length }); res.end(bytes); return;
    }
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    let data;
    if (req.method === 'POST' && req.url === '/app/getAppAccessToken') {
      assert.equal(body.clientSecret, 'fixture-secret'); data = { access_token: 'fixture-token', expires_in: 7200 };
    } else if (req.method === 'GET' && req.url === '/gateway') data = { url: `${base.replace('http:', 'ws:')}/official` };
    else if (req.method === 'POST' && req.url === '/v2/groups/g1/messages') {
      assert.equal(req.headers.authorization, 'QQBot fixture-token'); assert.equal(body.msg_id, 'official-source');
      assert.equal(body.message_reference?.message_id, 'quote-id'); data = { id: 'official-delivery' };
    } else { unexpected.push(`${req.method} ${req.url}`); res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
  } catch (error) { fail(error); res.writeHead(500).end('{}'); }
});
const sockets = new Set(), ws = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!['/official', '/onebot'].includes(req.url)) { unexpected.push(`UPGRADE ${req.url}`); socket.destroy(); return; }
  ws.handleUpgrade(req, socket, head, (client) => ws.emit('connection', client, req));
});
ws.on('connection', (socket, req) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); closed.set(req.url, once(socket, 'close'));
  if (req.url === '/official') socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
  socket.on('message', (bytes) => {
    try {
      const frame = JSON.parse(String(bytes)); actions.push({ platform: req.url.slice(1), action: frame.action ?? frame.op });
      if (req.url === '/official') {
        if (frame.op !== 2) { unexpected.push(`official op ${frame.op}`); return; }
        assert.equal(frame.d.token, 'QQBot fixture-token');
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture', user: { id: 'bot' } } }));
        socket.send(JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: { id: 'official-source', content: '<@!bot> hello two photos',
          timestamp: '2023-11-14T22:13:20Z', group_openid: 'g1', author: { member_openid: 'u1', username: 'Fixture sender' },
          mentions: [{ member_openid: 'bot', is_you: true }], message_reference: { message_id: 'quote-id' },
          attachments: ['first', 'second'].map((name) => ({ filename: `${name}.png`, content_type: 'image/png', size: imageBytes[0].length, url: `${base}/media/official/${name}.png` })) } }));
      } else {
        if (!['get_login_info', 'send_group_msg'].includes(frame.action)) { unexpected.push(`OneBot ${frame.action}`); return; }
        if (frame.action === 'send_group_msg') { assert.equal(frame.params.group_id, '100'); assert.equal(frame.params.message[0].data.text, 'reply'); }
        const data = frame.action === 'get_login_info' ? { user_id: 999 } : { message_id: 123 };
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
        if (frame.action === 'get_login_info') socket.send(JSON.stringify({ post_type: 'message', self_id: 999, message_type: 'group', message_id: 12,
          group_id: 100, user_id: 200, time: 1700000000, sender: { user_id: 200, nickname: 'Fixture sender' }, message: [
            { type: 'reply', data: { id: '11' } }, { type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'hello two photos' } },
            ...['first', 'second'].map((name) => ({ type: 'image', data: { file: `${name}.png`, size: imageBytes[0].length, url: `${base}/media/onebot/${name}.png` } }))] }));
      }
    } catch (error) { fail(error); }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function send(value) { runner.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); }
function fail(error) { fatal ??= error; for (const call of pending.values()) call.reject(error); for (const call of waiters) call.reject(error); }
function request(method, params) {
  if (fatal) return Promise.reject(fatal);
  const id = nextId++, call = Promise.withResolvers(); pending.set(id, call); send({ id, method, params }); return call.promise;
}
function wake() { for (const call of [...waiters]) if (call.predicate()) { waiters.splice(waiters.indexOf(call), 1); call.resolve(); } }
function waitFor(predicate) {
  if (fatal) return Promise.reject(fatal); if (predicate()) return Promise.resolve();
  const call = Promise.withResolvers(); waiters.push({ predicate, ...call }); return call.promise;
}
const receiver = createImReceiver({ sdk, parsePluginImEvent, definitions: expectedDefinitions, send, async listener(adapterId, event) {
  events.push({ adapterId, event });
} });
function im(adapterId, action, input, settings) {
  if (action === 'start') receiver.start(adapterId);
  if (action === 'stop') receiver.stop(adapterId);
  return request('im-adapter-request', { adapterId, action, input, settings, instanceId: `fixture-${adapterId}`, messageLimits: action === 'start' ? limits : undefined });
}
function assertComplete(adapterId, sourceMessageId, identity, mentionIds, replyToMessageId) {
  const rows = events.filter((item) => item.adapterId === adapterId); assert.equal(rows.length, 1);
  const event = rows[0].event;
  assert.equal(event.kind, 'message'); assert.equal(event.eventId, `${adapterId === 'qq-official' ? 'official' : 'onebot'}:${sourceMessageId}`);
  assert.equal(event.sourceMessageId, sourceMessageId); assert.deepEqual(event.identity, identity);
  assert.equal(event.mentioned, true); assert.deepEqual(event.mentionIds, mentionIds); assert.equal(event.replyToMessageId, replyToMessageId);
  assert.equal(event.timestamp, 1700000000000); assert.equal(event.operation, 'create');
  assert.deepEqual(event.parts.map(({ kind }) => kind), ['text', 'image', 'image']); assert.equal(event.parts[0].text, 'hello two photos');
  for (const [index, part] of event.parts.slice(1).entries()) {
    assert.equal(part.media.bytes.byteLength, 8 * 1024 * 1024); assert.equal(part.media.mediaType, 'image/png');
    assert.equal(part.media.name, `${index ? 'second' : 'first'}.png`); assert.deepEqual(Buffer.from(part.media.bytes), imageBytes[index]);
    assert.equal('sourceMessageId' in part || 'mentioned' in part || 'identity' in part || 'eventId' in part, false);
  }
  const frames = receiver.frames.filter((frame) => frame.adapterId === adapterId);
  assert.equal(frames.length, 6); assert.deepEqual(frames.map(({ index }) => index), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set(frames.map(({ callId }) => callId)).size, 1);
  assert.equal(frames.reduce((sum, { dataChars }) => sum + dataChars, 0), frames[0].characters);
  assert.equal(frames.slice(0, -1).every(({ dataChars }) => dataChars === limits.chunkChars), true);
  assert.equal(receiver.deliveries.filter((item) => item.adapterId === adapterId).length, 1);
  const acknowledgements = receiver.acknowledgements.filter(({ callId }) => callId === frames[0].callId);
  assert.deepEqual(acknowledgements, [{ callId: frames[0].callId, result: true }]);
  return { adapterId, eventId: event.eventId, sourceMessageId, identity: event.identity, mentioned: event.mentioned, mentionIds: event.mentionIds,
    replyToMessageId: event.replyToMessageId, timestamp: event.timestamp, decodedBytes: event.parts.map((part) => part.media?.bytes.byteLength ?? 0),
    frames, listenerCalls: rows.length, acknowledgements };
}
let watchdog;
try {
  runner = spawn(process.execPath, [resolve(hostRunnerPath), fileURLToPath(new URL('./host-contract-entry.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  watchdog = setTimeout(() => { fail(new Error(`Host fixture timed out: ${stderr}`)); runner.kill(); }, 20000);
  runner.stderr.on('data', (bytes) => { stderr += bytes; });
  runner.once('exit', (code) => { if (pending.size || waiters.length) fail(new Error(`Host runner exited ${code}: ${stderr}`)); });
  createInterface({ input: runner.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'im-adapter-message-chunk' || message.method === 'im-adapter-event') { void receiver.accept(message).then(wake, fail); return; }
      messages.push(message);
      if (message.method === 'register-im-adapter') definitions.push(message.params.definition);
      if (message.id !== undefined) {
        const call = pending.get(message.id); pending.delete(message.id);
        if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
      }
      wake();
    } catch (error) { fail(error); }
  });
  await request('handshake', { version: 1 }); await waitFor(() => messages.some((message) => message.method === 'ready'));
  assert.deepEqual(definitions, expectedDefinitions);
  assert.deepEqual(messages.filter((message) => message.method === 'register').map((message) => message.params.tool), toolDefinitions);
  assert.deepEqual(await im('qq-official', 'start', undefined, { official__appId: 'fixture-app', official__appSecret: 'fixture-secret', official__apiBaseUrl: base, official__tokenBaseUrl: base }), { accountId: 'qq-official:fixture-app', listenerAccountId: 'fixture-app' });
  await waitFor(() => receiver.deliveries.some((item) => item.adapterId === 'qq-official'));
  const official = assertComplete('qq-official', 'official-source', officialIdentity({ userOpenid: 'u1', groupOpenid: 'g1', senderName: 'Fixture sender' }), ['bot'], 'quote-id');
  const officialReceipt = await im('qq-official', 'sendText', { identity: officialIdentity({ userOpenid: 'u1', groupOpenid: 'g1' }), text: 'reply', code: 'reply', replyToMessageId: 'quote-id' });
  assert.deepEqual(officialReceipt, { status: 'delivered', messageIds: ['official-delivery'] });
  await im('qq-official', 'stop'); await closed.get('/official');
  assert.deepEqual(await im('qq-onebot', 'start', undefined, { onebot__wsUrl: `${base.replace('http:', 'ws:')}/onebot`, onebot__selfId: '999' }), { accountId: 'qq-onebot:999', listenerAccountId: '999' });
  await waitFor(() => receiver.deliveries.some((item) => item.adapterId === 'qq-onebot'));
  const onebot = assertComplete('qq-onebot', '12', onebotIdentity({ userId: '200', groupId: '100', senderName: 'Fixture sender' }), ['999'], '11');
  const onebotReceipt = await im('qq-onebot', 'sendText', { identity: onebotIdentity({ userId: '200', groupId: '100' }), text: 'reply', code: 'reply' });
  assert.deepEqual(onebotReceipt, { status: 'delivered', messageIds: ['123'] });
  await im('qq-onebot', 'stop'); await closed.get('/onebot');
  assert.equal(receiver.pendingAssemblies, 0); assert.equal(sockets.size, 0);
  const exited = once(runner, 'exit'); await request('shutdown', {}); await exited;
  assert.equal(runner.exitCode, 0, stderr); assert.deepEqual(unexpected, []);
  assert.equal(messages.some((message) => message.method === 'register-error'), false); assert.equal(stderr, '');
  assert.deepEqual(downloads.map(({ bytes }) => bytes), Array(4).fill(8 * 1024 * 1024));
  console.log(JSON.stringify({ node: process.version, runner: resolve(hostRunnerPath), parser: parserPath ? resolve(parserPath) : undefined,
    validation: parserPath ? 'production-parser-and-public-wire-assertions' : 'public-wire-contract-assertions', limits,
    registrations: definitions.map(({ id }) => id), official, onebot, downloads, actions,
    receipts: [officialReceipt, onebotReceipt], pendingAssemblies: receiver.pendingAssemblies, remainingSockets: sockets.size, shutdownExit: runner.exitCode }, null, 2));
} finally {
  clearTimeout(watchdog);
  if (runner && runner.exitCode === null) { runner.stdin.destroy(); runner.kill(); await once(runner, 'exit'); }
  for (const socket of sockets) socket.terminate();
  server.closeAllConnections(); await new Promise((resolve) => ws.close(resolve)); await new Promise((resolve) => server.close(resolve));
}
