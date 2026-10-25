import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadImContract(sdkPath, parserPath) {
  const sdkUrl = pathToFileURL(resolve(sdkPath)).href;
  const sdk = await import(sdkUrl);
  assert.ok(Object.isFrozen(sdk.PLUGIN_IM_COMPLETE_LIMITS), 'SDK complete-message limits must be frozen');
  if (!parserPath) return { sdk, parsePluginImEvent: undefined };
  const parserUrl = pathToFileURL(resolve(parserPath)).href;
  const hook = registerHooks({ resolve(specifier, context, next) {
    return next(specifier === '@kiki/protocol' && context.parentURL === parserUrl ? sdkUrl : specifier, context);
  } });
  try {
    const { parsePluginImEvent } = await import(parserUrl);
    assert.equal(typeof parsePluginImEvent, 'function');
    return { sdk, parsePluginImEvent };
  } finally { hook.deregister(); }
}

export function createImReceiver({ sdk, parsePluginImEvent, definitions, send, listener }) {
  const limits = sdk.PLUGIN_IM_COMPLETE_LIMITS;
  const active = new Map(), assemblies = new Map(), frames = [], acknowledgements = [], deliveries = [];
  const decode = (media, definition) => {
    if (media === undefined) return undefined;
    assert.equal(typeof media.name, 'string'); assert.equal(typeof media.mediaType, 'string'); assert.equal(typeof media.base64, 'string');
    const bytes = new Uint8Array(Buffer.from(media.base64, 'base64'));
    assert.equal(Buffer.from(bytes).toString('base64'), media.base64); assert.ok(bytes.byteLength <= definition.maxInboundBytes);
    return { name: media.name, mediaType: media.mediaType, bytes };
  };
  function decodeWire(input, definition) {
    assert.ok(JSON.stringify(input).length <= limits.serializedChars);
    if (input.kind !== 'message') return { ...input, media: decode(input.media, definition) };
    assert.ok(input.parts.length > 0 && input.parts.length <= limits.parts);
    assert.equal(input.parts.some((part) => part.tooLarge === true), false);
    const parts = input.parts.map((part) => ({ ...part, media: decode(part.media, definition) }));
    assert.ok(parts.reduce((sum, part) => sum + (part.media?.bytes.byteLength ?? 0), 0) <= limits.mediaBytes);
    assert.ok(parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) <= limits.textChars);
    return { ...input, parts };
  }
  function stop(adapterId) { active.delete(adapterId); assemblies.delete(adapterId); }
  return {
    frames, acknowledgements, deliveries,
    get pendingAssemblies() { return assemblies.size; },
    start(adapterId) { assert.equal(active.has(adapterId), false); active.set(adapterId, {}); },
    stop,
    async accept(message) {
      if (!['im-adapter-message-chunk', 'im-adapter-event'].includes(message.method)) return false;
      const { adapterId, callId, index, characters, data } = message.params;
      const owner = active.get(adapterId), definition = definitions.find(({ id }) => id === adapterId);
      try {
        assert.ok(owner && definition?.inbound, 'IM adapter must have an active listener');
        assert.ok(Number.isSafeInteger(callId));
        let input;
        if (message.method === 'im-adapter-message-chunk') {
          assert.ok(Number.isSafeInteger(index) && index >= 0);
          assert.ok(Number.isSafeInteger(characters) && characters > 0 && characters <= limits.serializedChars);
          assert.equal(typeof data, 'string'); assert.ok(data.length > 0 && data.length <= limits.chunkChars);
          let assembly = assemblies.get(adapterId);
          if (!assembly) {
            assert.equal(index, 0);
            assembly = { owner, callId, characters, received: 0, chunks: [] }; assemblies.set(adapterId, assembly);
          }
          assert.equal(assembly.owner, owner); assert.equal(assembly.callId, callId); assert.equal(assembly.characters, characters);
          assert.equal(assembly.chunks.length, index);
          assert.equal(data.length, Math.min(limits.chunkChars, characters - assembly.received));
          frames.push({ adapterId, callId, index, characters, dataChars: data.length });
          assembly.chunks.push(data); assembly.received += data.length;
          if (assembly.received < characters) return true;
          assert.equal(assembly.received, characters); assemblies.delete(adapterId);
          input = JSON.parse(assembly.chunks.join(''));
          assert.equal(input.kind, 'message');
        } else input = message.params.event;
        const decoded = decodeWire(input, definition);
        const event = parsePluginImEvent ? parsePluginImEvent(input, definition) : decoded;
        assert.equal(active.get(adapterId), owner);
        await listener(adapterId, event);
        deliveries.push({ adapterId, callId, kind: event.kind, sourceMessageId: event.sourceMessageId });
        const receipt = { callId, result: true }; acknowledgements.push(receipt);
        send({ method: 'im-adapter-event-result', params: receipt });
        return true;
      } catch (error) {
        assemblies.delete(adapterId);
        const receipt = { callId, error: String(error) }; acknowledgements.push(receipt);
        send({ method: 'im-adapter-event-result', params: receipt });
        throw error;
      }
    },
  };
}
