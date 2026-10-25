import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createHttpClient, HttpProtocolError } from './http.mjs';
import { parseIdentity } from './identity.mjs';
import { normalizeOneBotEvent } from './normalize.mjs';
import { connectOneBot } from './onebot-transport.mjs';
import { delivered, failed, receiptFromError, unknown, unsupported } from './receipts.mjs';

function numeric(value, name, { signed = false } = {}) {
  const text = String(value ?? '');
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(text)) throw Object.assign(new Error(`${name} must be numeric`), { code: 'CONFIGURATION' });
  return text;
}
function result(data) {
  const id = data?.message_id;
  const valid = typeof id === 'string' ? /^-?\d+$/.test(id) : typeof id === 'number' && Number.isSafeInteger(id);
  return valid ? delivered([String(id)]) : unknown('OneBot returned no valid message_id; inspect before sending again');
}
function mediaSegment(message) {
  const type = ['voice', 'audio'].includes(message.kind) ? 'record' : message.kind;
  if (!['image', 'record', 'video'].includes(type)) return undefined;
  return { type, data: { file: `base64://${Buffer.from(message.bytes).toString('base64')}` } };
}
export function createOneBotClient(config = {}, deps = {}) {
  const accessToken = config.accessToken ? String(config.accessToken) : undefined;
  const api = createHttpClient({ fetchImpl: deps.fetchImpl, baseUrl: config.baseUrl ?? 'http://127.0.0.1:5700', timeoutMs: config.timeoutMs ?? 30000,
    defaultHeaders: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, allowOrigins: deps.allowOrigins });
  const connect = deps.connect ?? connectOneBot;
  const pending = new Map();
  let link, controller, loop, eventEmit, verified = false, earlyFrames = [];
  let accountId = config.selfId ? numeric(config.selfId, 'OneBot selfId') : undefined;
  function parseResponse(value) {
    if (value?.status === 'ok' && value.retcode !== undefined && Number(value.retcode) === 0) return value.data;
    const uncertain = value?.status === 'async' || Number(value?.retcode) === 1 || value?.retcode === undefined;
    throw new HttpProtocolError(String(value?.message ?? value?.wording ?? 'OneBot action failed'), { code: uncertain ? 'OUTCOME_UNKNOWN' : 'ONEBOT_ACTION_FAILED' });
  }
  async function call(action, params = {}, { signal } = {}) {
    if (controller) signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (signal?.aborted) throw Object.assign(new Error('Cancelled before OneBot action'), { code: 'NOT_SENT' });
    if (!config.useWebSocket) {
      const response = await api.request(`/${encodeURIComponent(action)}`, { method: 'POST', body: params, signal });
      return parseResponse(response.data);
    }
    const connection = link;
    if (!connection || (action !== 'get_login_info' && !verified)) throw Object.assign(new Error('OneBot connection account is not verified; action was not sent'), { code: 'NOT_SENT' });
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        if (!pending.delete(echo)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(Object.assign(new Error('OneBot wait cancelled after send'), { code: 'OUTCOME_UNKNOWN' }));
      pending.set(echo, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(Object.assign(new Error('OneBot action timed out; do not resend automatically'), { code: 'OUTCOME_UNKNOWN' })), config.timeoutMs ?? 30000);
      try { connection.send({ action, params, echo }); }
      catch (error) { finish(Object.assign(new Error('OneBot send failed'), { code: error.code === 'NOT_SENT' ? 'NOT_SENT' : 'OUTCOME_UNKNOWN' })); }
    });
  }
  function receive(frame) {
    if (frame?.echo !== undefined) {
      const item = pending.get(String(frame.echo));
      if (!item) return;
      try { item.finish(undefined, parseResponse(frame)); } catch (error) { item.finish(error); }
      return;
    }
    if (controller?.signal.aborted) return;
    if (!verified) {
      if (earlyFrames.length >= 128) { link?.close(); disconnected(); deps.onError?.(new Error('OneBot startup event buffer exceeded')); }
      else earlyFrames.push(frame);
      return;
    }
    if (String(frame?.self_id) !== accountId) return;
    try {
      for (const event of normalizeOneBotEvent(frame, { selfId: accountId, maxInboundBytes: config.maxInboundBytes })) {
        Promise.resolve(eventEmit?.(event)).catch((error) => deps.onError?.(error));
      }
    } catch (error) { deps.onError?.(error); }
  }
  function disconnected() {
    link = undefined; verified = false; earlyFrames = [];
    for (const item of pending.values()) item.finish(Object.assign(new Error('OneBot disconnected after send'), { code: 'OUTCOME_UNKNOWN' }));
  }
  async function open(signal) {
    const url = new URL(String(config.wsUrl ?? ''));
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Use a credential-free forward universal ws/wss OneBot URL and the accessToken setting'), { code: 'CONFIGURATION' });
    const connection = await connect({ url: url.href, headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, signal });
    if (signal.aborted) { connection.close(); signal.throwIfAborted(); }
    verified = false; earlyFrames = [];
    link = connection;
    const closed = new Promise((resolve) => {
      connection.onClose(() => { if (link === connection) disconnected(); resolve(); });
    });
    connection.onError?.((error) => deps.onError?.(error));
    connection.onFrame((frame) => { if (link === connection) receive(frame); });
    return { closed };
  }
  async function start({ signal, emit } = {}) {
    signal?.throwIfAborted();
    if (controller) throw new Error('OneBot is already running');
    if (!config.useWebSocket) throw Object.assign(new Error('The bidirectional OneBot adapter requires a forward universal WebSocket URL. HTTP is used by read-only group tools.'), { code: 'CONFIGURATION' });
    controller = new AbortController();
    eventEmit = emit;
    const current = controller;
    const abort = () => current.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const lifetime = current.signal;
    let firstResolve, firstReject;
    const first = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
    const cancelled = () => firstReject(Object.assign(new Error('OneBot startup cancelled'), { code: 'ABORTED' }));
    lifetime.addEventListener('abort', cancelled, { once: true });
    if (lifetime.aborted) cancelled();
    loop = (async () => {
      let initial = true;
      while (!lifetime.aborted) {
        try {
          const { closed } = await open(lifetime);
          if (!link) throw new Error('OneBot closed during startup');
          const self = await call('get_login_info', {}, { signal: lifetime });
          const actual = numeric(self?.user_id, 'OneBot login user_id');
          if (accountId && accountId !== actual) throw Object.assign(new Error('OneBot account changed; check self ID and endpoint'), { code: 'ACCOUNT_CHANGED' });
          accountId = actual; verified = true;
          for (const frame of earlyFrames.splice(0)) receive(frame);
          if (initial) { initial = false; lifetime.removeEventListener('abort', cancelled); firstResolve({ accountId }); }
          await closed;
        } catch (error) {
          link?.close(); disconnected();
          if (initial) { firstReject(error); break; }
          if (!lifetime.aborted) deps.onError?.(error);
          if (error.code === 'ACCOUNT_CHANGED') current.abort();
        }
        if (!lifetime.aborted) await delay(config.reconnectDelayMs ?? 1000, undefined, { signal: lifetime }).catch(() => {});
      }
    })().finally(() => { signal?.removeEventListener('abort', abort); lifetime.removeEventListener('abort', cancelled); });
    try { return await first; } catch (error) { await stop(); throw error; }
  }
  async function stop() {
    controller?.abort(); link?.close(); disconnected();
    await loop;
    controller = undefined; loop = undefined; eventEmit = undefined;
  }
  async function sendText(message, { signal } = {}) {
    if (message.buttons?.length) return unsupported('buttons');
    try {
      const target = parseIdentity(message.identity, 'onebot');
      if (message.mentionIds?.length && target.scope !== 'group') return unsupported('mentions', 'OneBot @ mentions require a group target');
      const segments = [];
      if (message.replyToMessageId) segments.push({ type: 'reply', data: { id: numeric(message.replyToMessageId, 'reply message ID', { signed: true }) } });
      for (const id of message.mentionIds ?? []) {
        const qq = String(id).replace(/^onebot:user:/, '');
        segments.push({ type: 'at', data: { qq: qq === 'all' ? qq : numeric(qq, 'mention ID') } });
      }
      segments.push({ type: 'text', data: { text: message.text } });
      return result(await call(target.scope === 'group' ? 'send_group_msg' : 'send_private_msg', { [target.scope === 'group' ? 'group_id' : 'user_id']: target.targetId, message: segments }, { signal }));
    } catch (error) { return receiptFromError(error); }
  }
  async function sendMedia(message, { signal } = {}) {
    if (!(message.bytes instanceof Uint8Array) || !message.bytes.length) return failed('Media bytes are required', 'bad_media');
    const segment = mediaSegment(message);
    if (!segment) return unsupported(message.kind);
    try {
      const target = parseIdentity(message.identity, 'onebot');
      return result(await call(target.scope === 'group' ? 'send_group_msg' : 'send_private_msg', { [target.scope === 'group' ? 'group_id' : 'user_id']: target.targetId, message: [segment] }, { signal }));
    } catch (error) { return receiptFromError(error); }
  }
  async function readList(action, params, signal) {
    if (!config.useWebSocket) {
      const self = await call('get_login_info', {}, { signal });
      const actual = numeric(self?.user_id, 'OneBot login user_id');
      if (accountId && accountId !== actual) throw new Error('OneBot HTTP account differs from the expected self ID');
      accountId = actual;
    }
    const items = await call(action, params, { signal });
    if (!Array.isArray(items)) throw new HttpProtocolError('OneBot list response is not an array', { code: 'INVALID_RESPONSE' });
    return { items, nextCursor: null };
  }
  async function listGroups({ signal } = {}) { return readList('get_group_list', {}, signal); }
  async function listGroupMembers({ groupId, signal } = {}) { return readList('get_group_member_list', { group_id: numeric(groupId, 'groupId') }, signal); }
  return { start, stop, call, sendText, sendMedia, listGroups, listGroupMembers, get accountId() { return accountId; } };
}
