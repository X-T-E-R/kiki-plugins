import { fetchMediaBytes } from './attachments.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition } from './definitions.mjs';
import { createOfficialClient, OfficialGateway, DEFAULT_INTENTS } from './official.mjs';
import { createOneBotClient } from './onebot.mjs';
import { readOneBotHistory } from './host-history.mjs';
import { failed, partial, receiptFromError, unknown, unsupported } from './receipts.mjs';

function setting(settings, key, fallback) {
  const value = settings?.[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}
function officialIntents(settings) {
  const value = setting(settings, 'official__intents', DEFAULT_INTENTS);
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('official__intents must be a non-negative integer'), { code: 'CONFIGURATION' });
  return value;
}
export function settingsFor(platform, settings = {}) {
  if (platform === 'official') return {
    appId: setting(settings, 'official__appId'), appSecret: setting(settings, 'official__appSecret'),
    apiBaseUrl: setting(settings, 'official__apiBaseUrl', 'https://api.sgroup.qq.com'),
    tokenBaseUrl: setting(settings, 'official__tokenBaseUrl', 'https://bots.qq.com'),
    intents: officialIntents(settings),
  };
  return { baseUrl: setting(settings, 'onebot__baseUrl', 'http://127.0.0.1:5700'), wsUrl: setting(settings, 'onebot__wsUrl'),
    accessToken: setting(settings, 'onebot__accessToken'), selfId: setting(settings, 'onebot__selfId'), useWebSocket: true };
}
export function chunkText(text, limit = 5000) {
  const chunks = [];
  let current = '';
  for (const character of String(text ?? '')) {
    if (current && current.length + character.length > limit) { chunks.push(current); current = ''; }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}
async function hydrate(event, options) {
  const { attachment, ...publicEvent } = event;
  if (!attachment) return publicEvent;
  if (event.tooLarge) return { ...publicEvent, preview: 'QQ attachment exceeds the inbound size limit.' };
  try {
    const media = await fetchMediaBytes(attachment, options);
    return { ...publicEvent, media: { name: media.name, mediaType: media.mediaType, bytes: media.bytes } };
  } catch (error) {
    const detail = error.code === 'MEDIA_TOO_LARGE' ? 'QQ attachment exceeds the inbound size limit.'
      : error.code === 'MEDIA_URL_MISSING' ? 'QQ attachment has no downloadable URL; local platform paths are not read.'
        : 'QQ attachment could not be downloaded.';
    return { ...publicEvent, tooLarge: error.code === 'MEDIA_TOO_LARGE' || undefined,
      preview: [detail, event.preview].filter(Boolean).join('\n') };
  }
}
function emitUntilStopped(emit, event, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => resolve();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => signal.aborted ? undefined : emit(event)).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function adapter(platform, definition, buildClient, deps) {
  let run, readClient, readConfig, verifiedAccount;
  function sending(work, context) {
    const state = run;
    if (!state?.started || state.signal.aborted) return Promise.resolve(failed('Adapter is not running', 'not_sent'));
    const signal = context?.signal ? AbortSignal.any([state.signal, context.signal]) : state.signal;
    const result = Promise.resolve().then(() => work(state.client, { ...context, signal })).catch(receiptFromError);
    state.sends.add(result);
    void result.finally(() => state.sends.delete(result));
    return result;
  }
  return {
    async start(context) {
      if (run) throw new Error(`${platform} adapter is already running`);
      context.signal.throwIfAborted();
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let release;
      const ready = new Promise((resolve) => { release = resolve; });
      const state = { controller, signal, release, queue: ready, sends: new Set(), started: false };
      run = state;
      try {
        const config = settingsFor(platform, context.settings);
        const client = buildClient(config);
        state.client = client;
        const transport = platform === 'official' ? new OfficialGateway({ client, gatewayFactory: deps.gatewayFactory, intents: config.intents, maxInboundBytes: definition.maxInboundBytes }) : client;
        state.transport = transport;
        const result = await transport.start({ signal, onError: deps.onError, emit(event) {
          state.queue = state.queue.then(async () => {
            if (signal.aborted) return;
            const hydrated = await hydrate(event, { fetchImpl: deps.fetchImpl, signal, maxBytes: definition.maxInboundBytes });
            if (signal.aborted) return;
            client.observe?.(hydrated);
            await emitUntilStopped(context.emit, hydrated, signal);
          }).catch((error) => deps.onError?.(error));
          return state.queue;
        } });
        signal.throwIfAborted();
        if (platform === 'onebot') verifiedAccount = { config: JSON.stringify(config), id: String(result.accountId) };
        state.started = true;
        state.timer = setTimeout(release, 0);
        return { accountId: `${definition.id}:${result.accountId}`, listenerAccountId: String(result.accountId) };
      } catch (error) {
        controller.abort(); release();
        await state.transport?.stop();
        if (run === state) run = undefined;
        throw error;
      }
    },
    async stop() {
      const state = run;
      if (!state) return;
      state.stopping ??= (async () => {
        state.controller.abort(); clearTimeout(state.timer); state.release();
        await state.transport?.stop();
        await Promise.allSettled([state.queue, ...state.sends]);
        state.client?.clear?.();
        if (run === state) run = undefined;
      })();
      await state.stopping;
    },
    sendText(message, context) {
      return sending(async (client, lifetime) => {
        const chunks = chunkText(message.text, definition.textLimit);
        if (!chunks.length) return failed('Text is required', 'bad_format');
        const ids = [];
        for (const [index, text] of chunks.entries()) {
          let receipt;
          try { receipt = await client.sendText({ ...message, text, mentionIds: index === 0 ? message.mentionIds : undefined, buttons: index === 0 ? message.buttons : undefined }, lifetime); }
          catch (error) { receipt = receiptFromError(error); }
          if (receipt.status === 'delivered') ids.push(...(receipt.messageIds ?? []));
          else if (receipt.status === 'unknown') return ids.length ? partial(ids, `Chunk ${index + 1} outcome is unknown; inspect before resending`) : unknown(receipt.detail);
          else return ids.length ? partial(ids, receipt.detail, receipt.unsupported) : receipt;
        }
        return { status: 'delivered', messageIds: ids };
      }, context);
    },
    sendMedia(message, context) {
      return sending(async (client, lifetime) => {
        const capability = definition.mediaCapabilities.find((item) => item.kind === message.kind);
        if (!capability) return unsupported(message.kind);
        if (!(message.bytes instanceof Uint8Array) || !message.bytes.length) return failed('Media bytes are required', 'bad_media');
        if (capability.maxBytes && message.bytes.length > capability.maxBytes) return failed('Media exceeds platform size limit', 'too_large');
        if (capability.mimeTypes && !capability.mimeTypes.includes(message.mediaType)) return unsupported(message.kind, `Unsupported ${message.mediaType}; supported formats: ${capability.mimeTypes.join(', ')}`);
        return client.sendMedia(message, lifetime);
      }, context);
    },
    async readGroups({ groupId } = {}, context) {
      if (platform !== 'onebot') throw new Error('Group-list APIs are only available on OneBot');
      const state = run;
      if (state && (!state.started || state.signal.aborted)) throw new Error('OneBot account is starting or stopping; group data was not read');
      let client = state?.client;
      if (!client) {
        const configured = settingsFor('onebot', context.settings);
        const expected = verifiedAccount?.config === JSON.stringify(configured) ? verifiedAccount.id : configured.selfId;
        const config = { ...configured, useWebSocket: false, selfId: expected };
        const key = JSON.stringify(config);
        if (readConfig !== key) { readConfig = key; readClient = createOneBotClient(config, deps); }
        client = readClient;
      }
      const signal = state ? AbortSignal.any([state.signal, context.signal]) : context.signal;
      const work = groupId === undefined ? client.listGroups({ signal }) : client.listGroupMembers({ groupId, signal });
      state?.sends.add(work);
      try {
        const result = await work;
        return { ...result, accountId: `qq-onebot:${client.accountId}`, transport: state ? 'websocket' : 'http' };
      } finally { state?.sends.delete(work); }
    },
    async readHistory(request, context) {
      if (platform !== 'onebot') return { status: 'unsupported', detail: 'Official QQ group/C2C APIs do not expose history' };
      const state = run;
      if (!state?.started || state.signal.aborted) throw new Error('OneBot history requires the verified running channel');
      const signal = context?.signal ? AbortSignal.any([state.signal, context.signal]) : state.signal;
      const work = readOneBotHistory(state.client, request, signal);
      state.sends.add(work);
      try { return await work; } finally { state.sends.delete(work); }
    },
    async editText() { return unsupported('edit'); },
    async answerCallback(id, context) {
      const state = run;
      if (!state?.started || state.signal.aborted || !state.client.answerCallback) throw new Error('Callbacks are unavailable on this adapter');
      const signal = context?.signal ? AbortSignal.any([state.signal, context.signal]) : state.signal;
      const work = state.client.answerCallback(id, { ...context, signal });
      state.sends.add(work);
      try { await work; } finally { state.sends.delete(work); }
    },
  };
}
export function createOfficialAdapter(deps = {}) {
  return adapter('official', officialAdapterDefinition, (config) => createOfficialClient(config, deps), deps);
}
export function createOneBotAdapter(deps = {}) {
  return adapter('onebot', onebotAdapterDefinition, (config) => createOneBotClient({ ...config, maxInboundBytes: onebotAdapterDefinition.maxInboundBytes }, deps), deps);
}
export function createConfiguredClient(platform, settings, deps = {}) {
  return platform === 'official' ? createOfficialClient(settingsFor(platform, settings), deps) : createOneBotClient({ ...settingsFor(platform, settings), useWebSocket: false }, deps);
}
