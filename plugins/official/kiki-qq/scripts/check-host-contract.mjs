import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition, toolDefinitions } from '../lib/definitions.mjs';
import { officialIdentity, onebotIdentity } from '../lib/identity.mjs';

const [sdkImPath, hostRunnerPath] = process.argv.slice(2);
if (!sdkImPath || !hostRunnerPath) throw new Error('Usage: node check-host-contract.mjs <public SDK im module> <Host runner>');
const sdk = await import(pathToFileURL(resolve(sdkImPath)).href);
for (const definition of [officialAdapterDefinition, onebotAdapterDefinition]) sdk.pluginImAdapterDefinitionSchema.parse(definition);
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
assert.equal(manifest['x-kiki'].entry, './entry.mjs');
assert.deepEqual(manifest['x-kiki'].imAdapters, [officialAdapterDefinition, onebotAdapterDefinition]);
assert.deepEqual(manifest['x-kiki'].tools, toolDefinitions);
const unexpected = [], messages = [], pending = new Map(), waiters = [];
let nextId = 1, stderr = '', runner;
const definitions = [];
const server = createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
  let data;
  if (req.method === 'POST' && req.url === '/app/getAppAccessToken') {
    assert.equal(body.clientSecret, 'fixture-secret'); data = { access_token: 'fixture-token', expires_in: 7200 };
  } else if (req.method === 'GET' && req.url === '/gateway') data = { url: `${base.replace('http:', 'ws:')}/official` };
  else if (req.method === 'POST' && req.url === '/v2/users/u1/messages') {
    assert.equal(req.headers.authorization, 'QQBot fixture-token');
    assert.equal(body.msg_id, 'official-source');
    assert.equal(body.message_reference?.message_id, 'quote-id');
    data = { id: 'official-delivery' };
  } else { unexpected.push(`${req.method} ${req.url}`); res.writeHead(404); res.end('{}'); return; }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
});
const sockets = new Set();
const ws = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!['/official', '/onebot'].includes(req.url)) { unexpected.push(`UPGRADE ${req.url}`); socket.destroy(); return; }
  ws.handleUpgrade(req, socket, head, (client) => ws.emit('connection', client, req));
});
ws.on('connection', (socket, req) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  if (req.url === '/official') socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
  socket.on('message', (bytes) => {
    const frame = JSON.parse(String(bytes));
    if (req.url === '/official') {
      if (frame.op !== 2) { unexpected.push(`official op ${frame.op}`); return; }
      assert.equal(frame.d.token, 'QQBot fixture-token');
      socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture', user: { id: 'bot' } } }));
      socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'official-source', content: 'hello', author: { user_openid: 'u1' } } }));
    } else {
      if (!['get_login_info', 'send_group_msg'].includes(frame.action)) { unexpected.push(`OneBot ${frame.action}`); return; }
      const data = frame.action === 'get_login_info' ? { user_id: 999 } : { message_id: 123 };
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
      if (frame.action === 'get_login_info') socket.send(JSON.stringify({ post_type: 'message', self_id: 999, message_type: 'group', message_id: 12, group_id: 100, user_id: 200, message: [{ type: 'text', data: { text: 'hello' } }] }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function send(value) { runner.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); }
function request(method, params) {
  const id = nextId++;
  const deferred = Promise.withResolvers(); pending.set(id, deferred); send({ id, method, params });
  return deferred.promise;
}
function waitFor(predicate) {
  const found = messages.find(predicate);
  if (found) return Promise.resolve(found);
  const deferred = Promise.withResolvers(); waiters.push({ predicate, ...deferred }); return deferred.promise;
}
function im(adapterId, action, input, settings) { return request('im-adapter-request', { adapterId, action, input, settings, instanceId: `fixture-${adapterId}` }); }
let watchdog;
try {
  runner = spawn(process.execPath, [resolve(hostRunnerPath), fileURLToPath(new URL('../entry.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  watchdog = setTimeout(() => { runner.kill(); for (const call of pending.values()) call.reject(new Error(`Host fixture timed out: ${stderr}`)); for (const call of waiters) call.reject(new Error(`Host fixture timed out: ${stderr}`)); }, 10000);
  runner.stderr.on('data', (bytes) => { stderr += bytes; });
  runner.once('exit', (code) => {
    for (const call of pending.values()) call.reject(new Error(`Host runner exited ${code}: ${stderr}`));
    for (const call of waiters) call.reject(new Error(`Host runner exited ${code}: ${stderr}`));
  });
  createInterface({ input: runner.stdout }).on('line', (line) => {
    const message = JSON.parse(line); messages.push(message);
    if (message.method === 'register-im-adapter') definitions.push(message.params.definition);
    if (message.method === 'im-adapter-event') send({ method: 'im-adapter-event-result', params: { callId: message.params.callId } });
    if (message.id !== undefined) {
      const call = pending.get(message.id); pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
    }
    for (const call of [...waiters]) if (call.predicate(message)) { waiters.splice(waiters.indexOf(call), 1); call.resolve(message); }
  });
  await request('handshake', { version: 1 }); await waitFor((message) => message.method === 'ready');
  assert.deepEqual(definitions, [officialAdapterDefinition, onebotAdapterDefinition]);
  assert.deepEqual(messages.filter((message) => message.method === 'register').map((message) => message.params.tool), toolDefinitions);
  assert.deepEqual(await im('qq-official', 'start', undefined, { official__appId: 'fixture-app', official__appSecret: 'fixture-secret', official__apiBaseUrl: base, official__tokenBaseUrl: base }), { accountId: 'qq-official:fixture-app', listenerAccountId: 'fixture-app' });
  const officialEvent = (await waitFor((message) => message.method === 'im-adapter-event' && message.params.adapterId === 'qq-official')).params.event;
  assert.equal(officialEvent.sourceMessageId, 'official-source');
  assert.deepEqual(await im('qq-official', 'sendText', { identity: officialIdentity({ userOpenid: 'u1' }), text: 'reply', code: 'reply', replyToMessageId: 'quote-id' }), { status: 'delivered', messageIds: ['official-delivery'] });
  await im('qq-official', 'stop');
  assert.deepEqual(await im('qq-onebot', 'start', undefined, { onebot__wsUrl: `${base.replace('http:', 'ws:')}/onebot`, onebot__selfId: '999' }), { accountId: 'qq-onebot:999', listenerAccountId: '999' });
  const onebotEvent = (await waitFor((message) => message.method === 'im-adapter-event' && message.params.adapterId === 'qq-onebot')).params.event;
  assert.equal(onebotEvent.identity.chatId, 'onebot:group:100');
  assert.deepEqual(await im('qq-onebot', 'sendText', { identity: onebotIdentity({ userId: '200', groupId: '100' }), text: 'reply', code: 'reply' }), { status: 'delivered', messageIds: ['123'] });
  await im('qq-onebot', 'stop');
  const exited = once(runner, 'exit');
  await request('shutdown', {}); await exited;
  assert.equal(runner.exitCode, 0, stderr);
  assert.deepEqual(unexpected, []);
  assert.equal(messages.some((message) => message.method === 'register-error'), false);
  console.log('Host contract: 2 exact adapter registrations, 2 real start→event→send→stop paths, shutdown exit 0; SDK definitions valid.');
} finally {
  clearTimeout(watchdog);
  if (runner && runner.exitCode === null) { runner.stdin.destroy(); runner.kill(); await once(runner, 'exit'); }
  for (const socket of sockets) socket.terminate();
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
