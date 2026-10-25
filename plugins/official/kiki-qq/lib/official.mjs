import { createHttpClient } from './http.mjs';
import { parseIdentity } from './identity.mjs';
import { normalizeOfficialEvent } from './normalize.mjs';
import { createReplyContext } from './reply-context.mjs';
import { createOfficialReferences } from './official-references.mjs';
import { delivered, failed, receiptFromError, unknown, unsupported } from './receipts.mjs';
import { GatewayConnection } from '../vendor/qqbot-gateway/gateway-connection.js';
import { ChunkedMediaApi } from '../vendor/qqbot-media/media-chunked.js';
import { ApiError } from '../vendor/qqbot-media/types.js';
import { CHUNKED_UPLOAD_MAX_SIZE, LARGE_FILE_THRESHOLD, sanitizeFileName } from '../vendor/qqbot-media/routes.js';


const MESSAGE_PATH = (scope, target) => scope === 'c2c' ? `/v2/users/${encodeURIComponent(target)}/messages` : `/v2/groups/${encodeURIComponent(target)}/messages`;
const FILE_PATH = (scope, target) => scope === 'c2c' ? `/v2/users/${encodeURIComponent(target)}/files` : `/v2/groups/${encodeURIComponent(target)}/files`;
const MEDIA_FILE_TYPE = { image: 1, video: 2, audio: 3, voice: 3, file: 4 };
export const DEFAULT_INTENTS = (1 << 25) | (1 << 26);
function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw Object.assign(new Error(`${name} is required`), { code: 'CONFIGURATION' });
  return value.trim();
}
function messageIdFrom(data) {
  for (const value of [data?.id, data?.message_id]) {
    if (typeof value === 'string' && value.trim() && !/[\s\u0000-\u001f\u007f]/u.test(value)) return value;
  }
}

export function createOfficialClient(config = {}, deps = {}) {
  const appId = required(config.appId, 'official appId');
  const appSecret = required(config.appSecret, 'official appSecret');
  const api = createHttpClient({ fetchImpl: deps.fetchImpl, baseUrl: config.apiBaseUrl ?? 'https://api.sgroup.qq.com', timeoutMs: config.timeoutMs ?? 30000, allowOrigins: deps.allowOrigins });
  const tokenApi = createHttpClient({ fetchImpl: deps.fetchImpl, baseUrl: config.tokenBaseUrl ?? 'https://bots.qq.com', timeoutMs: 10000, allowOrigins: deps.allowOrigins });
  let cachedToken;
  let pendingToken;
  const replies = createReplyContext({ now: deps.now });
  const references = createOfficialReferences();
  async function accessToken(signal) {
    signal?.throwIfAborted();
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.value;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const response = await tokenApi.request('/app/getAppAccessToken', { method: 'POST', body: { appId, clientSecret: appSecret }, signal });
      const value = response.data?.access_token;
      if (typeof value !== 'string' || !value) throw Object.assign(new Error('Official token response has no access_token'), { code: 'AUTH_RESPONSE_INVALID' });
      cachedToken = { value, expiresAt: Date.now() + Number(response.data.expires_in ?? 7200) * 1000 };
      return value;
    })();
    try { return await pendingToken; } finally { pendingToken = undefined; }
  }
  async function request(path, options = {}) {
    let token;
    try { token = await accessToken(options.signal); } catch { throw Object.assign(new Error('Unable to obtain QQ token; no platform action was sent'), { code: 'NOT_SENT' }); }
    return api.request(path, { ...options, headers: { Authorization: `QQBot ${token}`, ...options.headers } });
  }
  // Reuse the SDK protocol with this client's token, HTTP policy and operation lifetime.
  const chunked = new ChunkedMediaApi({ async request(token, method, path, body, options) {
    try {
      const response = await api.request(path, { method, body, signal: options.signal, timeoutMs: 120000, headers: { Authorization: `QQBot ${token}` } });
      return response.data;
    } catch (error) {
      throw Object.assign(new ApiError(error.message, error.status, path, error.bizCode), { code: error.code, status: error.status, retryAfterMs: error.retryAfterMs });
    }
  } }, { getAccessToken: (_appId, _secret, signal) => accessToken(signal) }, { sanitizeFileName, putPart: deps.putPart });
  function bodyFor(message, allowEvent = true) {
    const body = { content: message.text, msg_type: 0, ...replies.reserve(message.identity, { allowEvent }) };
    if (message.replyToMessageId) body.message_reference = { message_id: message.replyToMessageId };
    if (message.buttons?.length) body.keyboard = { content: { rows: [{ buttons: message.buttons.map((button) => ({
      id: String(button.id), render_data: { label: String(button.label), visited_label: String(button.label), style: 0 },
      action: { type: 2, permission: { type: 2 }, data: String(button.id), click_limit: 1 },
    })) }] } };
    return body;
  }
  function sendResult(data, identity) {
    const id = messageIdFrom(data);
    if (!id) return unknown('Official send returned no valid message id; inspect the platform before sending again');
    references.record(identity, data?.ext_info?.ref_idx, id);
    return delivered([id]);
  }
  async function sendText(message, { signal } = {}) {
    if (signal?.aborted) return failed('Cancelled before send', 'cancelled');
    if (message.mentionIds?.length) return unsupported('mentions', 'Arbitrary user mentions are not supported by this official group/C2C adapter');
    try {
      const target = parseIdentity(message.identity, 'official');
      const response = await request(MESSAGE_PATH(target.scope, target.targetId), { method: 'POST', body: bodyFor(message), signal });
      return sendResult(response.data, message.identity);
    } catch (error) { return receiptFromError(error); }
  }
  async function sendMedia(message, { signal } = {}) {
    const fileType = MEDIA_FILE_TYPE[message.kind];
    if (!fileType) return unsupported(message.kind);
    if (signal?.aborted) return failed('Cancelled before upload', 'cancelled');
    if (!(message.bytes instanceof Uint8Array) || !message.bytes.byteLength) return failed('Media bytes are required', 'bad_media');
    if (message.bytes.byteLength > CHUNKED_UPLOAD_MAX_SIZE) return failed('Media exceeds the 100 MiB upload limit', 'too_large');
    try {
      const target = parseIdentity(message.identity, 'official');
      let uploaded;
      try {
        if (message.bytes.byteLength >= LARGE_FILE_THRESHOLD) {
          uploaded = await chunked.uploadChunked({ scope: target.scope, targetId: target.targetId, fileType,
            source: { kind: 'buffer', buffer: Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength) },
            creds: { appId, clientSecret: appSecret }, fileName: message.name, signal });
        } else {
          uploaded = (await request(FILE_PATH(target.scope, target.targetId), { method: 'POST', body: {
            file_type: fileType, file_data: Buffer.from(message.bytes).toString('base64'), srv_send_msg: false,
            file_name: fileType === 4 ? sanitizeFileName(message.name) : undefined,
          }, signal })).data;
        }
      } catch (error) {
        if (Number(error.status) === 429) return receiptFromError(error);
        return failed(`Upload did not complete; no message was sent: ${error.message}`, signal?.aborted ? 'cancelled' : 'upload_failed');
      }
      const fileInfo = uploaded?.file_info;
      if (typeof fileInfo !== 'string' || !fileInfo) return failed('Upload returned no file_info; no message was sent', 'invalid_response');
      if (signal?.aborted) return failed('Cancelled after upload, before message send', 'cancelled');
      const body = { ...bodyFor(message, false), msg_type: 7, media: { file_info: fileInfo } };
      const response = await request(MESSAGE_PATH(target.scope, target.targetId), { method: 'POST', body, signal });
      return sendResult(response.data, message.identity);
    } catch (error) { return receiptFromError(error); }
  }
  const unsupportedListing = async () => { throw Object.assign(new Error('QQ Bot group/C2C API has no group or member-list endpoint. Use OneBot for these queries; official group identities arrive in gateway events.'), { code: 'UNSUPPORTED' }); };
  async function gatewayUrl(signal) {
    const response = await request('/gateway', { signal });
    const url = new URL(required(response.data?.url, 'gateway url'));
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('QQ gateway must be a credential-free ws/wss URL');
    return url.href;
  }
  async function answerCallback(id, { signal, code = 0, data } = {}) {
    await request(`/interactions/${encodeURIComponent(required(id, 'callbackQueryId'))}`, { method: 'PUT', body: { code, data }, signal });
  }
  const unsupportedHistory = async () => ({ status: 'unsupported', reason: 'endpoint_unsupported', messages: [], end: 'unknown', accountId: appId,
    detail: 'Official QQ group/C2C APIs do not expose message lookup or group history' });
  return { appId, accessToken, request, sendText, sendMedia, observe: replies.observe, listGroups: unsupportedListing, listGroupMembers: unsupportedListing,
    getMessage: unsupportedHistory, getGroupHistory: unsupportedHistory,
    normalize: (raw, options) => normalizeOfficialEvent(raw, { ...options, references }),
    gatewayUrl, answerCallback, clearToken() { cachedToken = undefined; }, clear() { cachedToken = undefined; replies.clear(); references.clear(); } };
}

export class OfficialGateway {
  constructor({ client, gatewayFactory = (options) => new GatewayConnection(options), intents = DEFAULT_INTENTS, maxInboundBytes = 8 * 1024 * 1024 } = {}) {
    Object.assign(this, { client, gatewayFactory, intents, maxInboundBytes });
  }
  async start({ signal, emit, onError = () => {} }) {
    if (this.controller) throw new Error('Official gateway is already running');
    signal?.throwIfAborted();
    this.controller = new AbortController();
    const controller = this.controller;
    const abort = () => controller.abort(signal?.reason);
    this.detach = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const lifetime = controller.signal;
    try {
      return await new Promise((resolve, reject) => {
        let ready = false;
        const aborted = () => reject(Object.assign(new Error('Official gateway stopped before READY'), { code: 'ABORTED' }));
        const fail = (error) => { lifetime.removeEventListener('abort', aborted); if (ready) onError(error); else reject(error); };
        lifetime.addEventListener('abort', aborted, { once: true });
        const onReady = () => { if (lifetime.aborted) return; ready = true; lifetime.removeEventListener('abort', aborted); resolve({ accountId: this.client.appId }); };
        const events = (raw, eventType, message) => {
          if (lifetime.aborted) return;
          // Enqueue every part synchronously: the SDK invokes callbacks concurrently.
          return Promise.all(this.client.normalize(raw, { eventType, message, maxInboundBytes: this.maxInboundBytes }).map(emit));
        };
        const connection = this.gatewayFactory({
          account: { accountId: this.client.appId, appId: this.client.appId, clientSecret: '' },
          abortSignal: lifetime, intents: this.intents,
          getAccessToken: () => this.client.accessToken(lifetime), clearTokenCache: () => this.client.clearToken(),
          getGatewayUrl: () => this.client.gatewayUrl(lifetime), onReady, onResumed: onReady,
          onMessage: (message) => events(message.raw, message.rawEventType, message),
          onInteraction: (event) => events(event, 'INTERACTION_CREATE'),
          onRawEvent: () => {}, onError,
        });
        this.run = connection.start().then(() => { if (!ready) aborted(); }, fail);
        if (lifetime.aborted) aborted();
      });
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    this.controller?.abort();
    this.detach?.();
    await this.run;
    this.controller = undefined;
    this.run = undefined;
  }
}
