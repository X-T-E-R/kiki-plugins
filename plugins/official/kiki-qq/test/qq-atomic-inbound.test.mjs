import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { messageLimits } from './message-limits.mjs';
import { createOfficialAdapter, createOneBotAdapter } from '../lib/adapters.mjs';
import { normalizeOfficialEvent, normalizeOneBotEvent } from '../lib/normalize.mjs';
import { GatewayConnection } from '../vendor/qqbot-gateway/gateway-connection.js';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';

const deferred = () => Promise.withResolvers();
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const image = (bytes) => new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'image/png' } });
const firstUrl = 'https://media.fixture.test/first.png', secondUrl = 'https://media.fixture.test/second.png';
function source(platform) {
  if (platform === 'onebot') return { self_id: 999, post_type: 'message', message_type: 'group', message_id: 27, group_id: 100, user_id: 200,
    time: 1700000000, sender: { user_id: 200, nickname: 'Member' }, message: [{ type: 'reply', data: { id: '25' } }, { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text: 'two current photos' } }, { type: 'image', data: { file: 'first.png', url: firstUrl } }, { type: 'image', data: { file: 'second.png', url: secondUrl } }] };
  return { id: '27', group_openid: '100', author: { member_openid: '200', nickname: 'Member' }, timestamp: '2023-11-14T22:13:20Z',
    content: '<@!bot> two current photos', mentions: [{ member_openid: 'bot', is_you: true }], message_reference: { message_id: '25' },
    attachments: [{ filename: 'first.png', content_type: 'image/png', url: firstUrl }, { filename: 'second.png', content_type: 'image/png', url: secondUrl }] };
}
async function channel(t, platform, limits = messageLimits) {
  const wire = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wire, 'listening');
  let socket, readMedia = async (url) => image(url === firstUrl ? [1, 2, 3] : [4, 5, 6]), admit = async () => {};
  const actions = [], mediaCalls = [], unexpected = [], events = [], errors = [], emissions = [], failures = [], resumes = [], snapshots = [], retryDelays = [];
  wire.on('connection', (connected) => {
    socket = connected;
    if (platform === 'official') connected.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    connected.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes)); actions.push(frame);
      if (platform === 'onebot' && frame.action === 'get_login_info') connected.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999 }, echo: frame.echo }));
      else if (platform === 'official' && frame.op === 2) connected.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'atomic-fixture', user: { id: 'bot' } } }));
      else if (platform === 'official' && frame.op === 6) { connected.send(JSON.stringify({ op: 0, t: 'RESUMED', s: frame.d.seq, d: {} })); resumes.shift()?.resolve(frame); }
      else unexpected.push(frame);
    });
  });
  const fetchImpl = async (url, init = {}) => {
    if (platform === 'official' && url === 'https://token.fixture.test/app/getAppAccessToken' && init.method === 'POST') return json({ access_token: 'fixture-token', expires_in: 7200 });
    if (platform === 'official' && url === 'https://api.fixture.test/gateway' && init.method === 'GET') return json({ url: `ws://127.0.0.1:${wire.address().port}` });
    if ([firstUrl, secondUrl].includes(url) && init.method === 'GET') { mediaCalls.push({ url, signal: init.signal }); return readMedia(url, init); }
    unexpected.push(`${init.method} ${url}`); throw new Error(`Unexpected fixture request ${url}`);
  };
  const adapter = platform === 'onebot' ? createOneBotAdapter({ fetchImpl, onError })
    : createOfficialAdapter({ fetchImpl, onError, gatewayFactory: (options) => {
      const connection = new GatewayConnection({ ...options, reconnect: { delays: [1, 15, 30] }, session: { load: () => null, save: (snapshot) => { snapshots.push({ ...snapshot }); } } });
      const delay = connection.reconnect.getNextDelay.bind(connection.reconnect);
      connection.reconnect.getNextDelay = (wait) => { retryDelays.push(wait); return delay(wait); };
      return connection;
    } });
  function onError(error) { errors.push(error); failures.shift()?.resolve(error); }
  const controller = new AbortController();
  const settings = platform === 'onebot' ? { onebot__wsUrl: `ws://127.0.0.1:${wire.address().port}`, onebot__selfId: '999' }
    : { official__appId: 'fixture-app', official__appSecret: 'fixture-secret', official__apiBaseUrl: 'https://api.fixture.test', official__tokenBaseUrl: 'https://token.fixture.test' };
  await adapter.start({ messageLimits: limits, settings, signal: controller.signal, instanceId: 'atomic-fixture', emit: async (event) => { await admit(event); events.push(event); emissions.shift()?.resolve(event); } });
  t.after(async () => { await adapter.stop(); for (const item of wire.clients) item.terminate(); await new Promise((resolve) => wire.close(resolve)); assert.deepEqual(unexpected, []); });
  return { adapter, controller, actions, events, errors, mediaCalls, snapshots, retryDelays,
    media(handler) { readMedia = handler; },
    admission(handler) { admit = handler; },
    nextEvent() { const pending = deferred(); emissions.push(pending); return pending.promise; },
    nextError() { const pending = deferred(); failures.push(pending); return pending.promise; },
    nextResume() { const pending = deferred(); resumes.push(pending); return pending.promise; },
    disconnect() { socket.close(); },
    send(raw = source(platform), seq = 2) { socket.send(JSON.stringify(platform === 'official' ? { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: seq, d: raw } : raw)); },
  };
}

for (const platform of ['onebot', 'official']) {
  test(`SG001 ${platform}: one mentioned source emits one complete message only after both current images hydrate`, async (t) => {
    const f = await channel(t, platform), secondEntered = deferred(), releaseSecond = deferred();
    f.media(async (url) => { if (url === firstUrl) return image([1, 2, 3]); secondEntered.resolve(); return releaseSecond.promise; });
    const emitted = f.nextEvent(); f.send(); await secondEntered.promise;
    assert.deepEqual(f.events, [], 'no text or first-media emission before the second download completes');
    releaseSecond.resolve(image([4, 5, 6])); const event = await emitted;
    assert.equal(f.events.length, 1); assert.equal(event.kind, 'message'); assert.equal(event.eventId, `${platform === 'official' ? 'official' : 'onebot'}:27`);
    assert.equal(event.sourceMessageId, '27'); assert.equal(event.mentioned, true); assert.equal(event.replyToMessageId, '25');
    assert.equal(event.timestamp, 1700000000000); assert.equal(event.identity.senderId, `${platform === 'official' ? 'official' : 'onebot'}:user:200`);
    assert.deepEqual(event.parts.map(({ kind }) => kind), ['text', 'image', 'image']); assert.equal(event.parts[0].text, 'two current photos');
    assert.deepEqual(event.parts.slice(1).map(({ media }) => [...media.bytes]), [[1, 2, 3], [4, 5, 6]]);
    assert.deepEqual(event.parts.slice(1).map(({ media }) => media.name), ['first.png', 'second.png']);
    assert.equal(event.parts.some((part) => 'attachment' in part || 'eventId' in part || 'mentioned' in part), false);
    assert.deepEqual(f.errors, []);
  });

  test(`SG001 ${platform}: a failed later download emits zero parts and replay preserves the root/source IDs`, async (t) => {
    const f = await channel(t, platform);
    f.media(async (url) => url === firstUrl ? image([1]) : new Response('unavailable', { status: 503 }));
    const failure = f.nextError(), resumed = platform === 'official' ? f.nextResume() : undefined;
    f.send(); assert.equal((await failure).code, 'MEDIA_HTTP_ERROR'); assert.deepEqual(f.events, []);
    if (resumed) assert.equal((await resumed).d.seq, 1);
    f.media(async (url) => image(url === firstUrl ? [1] : [2]));
    const emitted = f.nextEvent(); f.send(); const event = await emitted;
    assert.equal(event.eventId, `${platform === 'official' ? 'official' : 'onebot'}:27`); assert.equal(event.sourceMessageId, '27');
    assert.equal(event.parts.filter(({ media }) => media).length, 2); assert.equal(f.events.length, 1);
    assert.deepEqual(f.mediaCalls.map(({ url }) => url), [firstUrl, secondUrl, firstUrl, secondUrl]);
  });

  test(`SG001 ${platform}: stop cancels an incomplete source and late download completion cannot emit`, async (t) => {
    const f = await channel(t, platform), secondEntered = deferred(), late = deferred();
    f.media(async (url) => { if (url === firstUrl) return image([1]); secondEntered.resolve(); return late.promise; });
    f.send(); await secondEntered.promise; const stopping = f.adapter.stop();
    assert.equal(f.mediaCalls.at(-1).signal.aborted, true); assert.deepEqual(f.events, []);
    late.resolve(image([2])); await stopping; assert.deepEqual(f.events, []);
  });
}

test('SG001 normalizers keep callback and target-based retraction on the legacy event contract', () => {
  const callback = normalizeOfficialEvent({ id: 'callback', user_openid: '200', data: { button_data: 'choice' } }, { eventType: 'INTERACTION_CREATE' });
  assert.equal(callback.length, 1); assert.equal(callback[0].kind, 'callback'); assert.equal(callback[0].parts, undefined);
  const recalled = normalizeOneBotEvent({ self_id: 999, post_type: 'notice', notice_type: 'group_recall', group_id: 100, user_id: 200, operator_id: 300, message_id: 27, time: 1700000001 }, { selfId: '999' });
  assert.equal(recalled.length, 1); assert.equal(recalled[0].kind, 'text'); assert.equal(recalled[0].operation, 'retract');
  assert.equal(recalled[0].sourceMessageId, '27'); assert.equal(recalled[0].identity.senderId, 'onebot:user:200'); assert.equal(recalled[0].parts, undefined);
});

for (const platform of ['onebot', 'official']) {
  test(`SG001 ${platform}: missing URLs keep kind/name/reason and ASR references in one ordered envelope without bytes`, async (t) => {
    const f = await channel(t, platform), raw = source(platform);
    if (platform === 'onebot') raw.message = [{ type: 'text', data: { text: 'body' } },
      { type: 'record', data: { file: 'first.amr', asr_refer_text: 'platform reference' } },
      { type: 'image', data: { file: 'second.png' } }, { type: 'video', data: { file: 'third.mp4' } }];
    else { raw.content = 'body'; raw.attachments = [{ filename: 'first.amr', content_type: 'voice', file: 'C:\\platform\\first.amr', asr_refer_text: 'platform reference' },
      { filename: 'second.png', content_type: 'image/png' }, { filename: 'third.mp4', content_type: 'video/mp4' }]; }
    const emitted = f.nextEvent(); f.send(raw); const event = await emitted;
    assert.equal(f.events.length, 1); assert.deepEqual(event.parts.map(({ kind }) => kind), ['text', 'audio', 'image', 'video']);
    for (const [index, name] of ['first.amr', 'second.png', 'third.mp4'].entries()) {
      const part = event.parts[index + 1]; assert.equal(part.media, undefined); assert.equal(part.tooLarge, undefined);
      assert.ok(part.text.includes(name)); assert.match(part.text, /no downloadable URL; local platform paths are not read/);
    }
    assert.match(event.parts[1].text, /platform reference/); assert.deepEqual(f.mediaCalls, []);
  });

  test(`SG001 ${platform}: an explicitly oversized later part rejects the whole source without an initial text emit`, async (t) => {
    const f = await channel(t, platform), raw = source(platform);
    if (platform === 'onebot') raw.message.at(-1).data.size = 8 * 1024 * 1024 + 1;
    else raw.attachments.at(-1).size = 8 * 1024 * 1024 + 1;
    const rejected = f.nextError(); f.send(raw); assert.equal((await rejected).code, 'MEDIA_TOO_LARGE'); assert.deepEqual(f.events, []);
  });
}

function bodyAndImages(platform, text, count, { downloadable = false } = {}) {
  const raw = source(platform);
  if (platform === 'onebot') raw.message = [{ type: 'text', data: { text } }, ...Array.from({ length: count }, (_, index) => ({ type: 'image', data: { file: `image-${index}.png`, url: downloadable ? firstUrl : undefined } }))];
  else { raw.content = text; raw.attachments = Array.from({ length: count }, (_, index) => ({ filename: `image-${index}.png`, content_type: 'image/png', url: downloadable ? firstUrl : undefined })); }
  return raw;
}
function wireLength(event) {
  return JSON.stringify(event, (key, value) => key === 'media' && value?.bytes instanceof Uint8Array
    ? { name: value.name, mediaType: value.mediaType, base64: Buffer.from(value.bytes).toString('base64') } : value).length;
}
for (const platform of ['onebot', 'official']) {
  test(`SG001 ${platform}: parent cancellation aborts the late download and emits no partial message`, async (t) => {
    const f = await channel(t, platform), secondEntered = deferred(), late = deferred();
    f.media(async (url) => { if (url === firstUrl) return image([1]); secondEntered.resolve(); return late.promise; });
    const failure = platform === 'onebot' ? f.nextError() : undefined;
    f.send(); await secondEntered.promise;
    f.controller.abort(); assert.equal(f.mediaCalls.at(-1).signal.aborted, true);
    late.resolve(image([2])); if (failure) await failure;
    await f.adapter.stop(); assert.deepEqual(f.events, []);
  });

  test(`SG001 ${platform}: 256 ordered parts are accepted; 257 reject the whole envelope`, async (t) => {
    const f = await channel(t, platform), accepted = f.nextEvent();
    f.send(bodyAndImages(platform, 'body', 255)); const event = await accepted;
    assert.equal(event.parts.length, 256); assert.equal(event.parts[0].text, 'body');
    assert.match(event.parts.at(-1).text, /image-254\.png/);
    const rejected = f.nextError(); f.send(bodyAndImages(platform, 'body', 256));
    assert.equal((await rejected).code, 'MESSAGE_TOO_LARGE'); assert.equal(f.events.length, 1); assert.deepEqual(f.mediaCalls, []);
  });

  test(`SG001 ${platform}: the text budget counts UTF-16 across all parts and never truncates`, async (t) => {
    const f = await channel(t, platform), text = '😀'.repeat(messageLimits.textChars / 2);
    const accepted = f.nextEvent(); f.send(bodyAndImages(platform, text, 0));
    assert.equal((await accepted).parts[0].text, text);
    const rejected = f.nextError(), resumed = platform === 'official' ? f.nextResume() : undefined;
    f.send(bodyAndImages(platform, `${text}x`, 0));
    assert.equal((await rejected).code, 'MESSAGE_TOO_LARGE'); assert.equal(f.events.length, 1);
    if (resumed) assert.equal((await resumed).d.seq, 2);
    const missingReason = f.nextError(); f.send(bodyAndImages(platform, text, 1));
    assert.equal((await missingReason).code, 'MESSAGE_TOO_LARGE'); assert.equal(f.events.length, 1);
  });

  test(`SG001 ${platform}: four 8 MiB downloads meet 32 MiB; a fifth byte rejects all parts`, async (t) => {
    const f = await channel(t, platform);
    let downloaded = 0;
    f.media(async () => new Response(new Uint8Array(downloaded++ < 4 ? 8 * 1024 * 1024 : 1), { headers: { 'content-type': 'image/png' } }));
    const accepted = f.nextEvent(); f.send(bodyAndImages(platform, 'body', 4, { downloadable: true }));
    const event = await accepted;
    assert.equal(event.parts.slice(1).reduce((sum, part) => sum + part.media.bytes.byteLength, 0), messageLimits.mediaBytes);
    assert.equal(event.parts.slice(1).every((part) => part.media.bytes.byteLength === 8 * 1024 * 1024), true);
    downloaded = 0;
    const rejected = f.nextError(); f.send(bodyAndImages(platform, 'body', 5, { downloadable: true }));
    assert.equal((await rejected).code, 'MESSAGE_TOO_LARGE'); assert.equal(f.events.length, 1);
    assert.equal(f.mediaCalls.length, 9);
  });

  test(`SG001 ${platform}: downloaded overflow without a declared size rejects the whole source`, async (t) => {
    const f = await channel(t, platform);
    f.media(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    const rejected = f.nextError(); f.send();
    assert.equal((await rejected).code, 'MEDIA_TOO_LARGE'); assert.deepEqual(f.events, []); assert.equal(f.mediaCalls.length, 1);
  });

  test(`SG001 ${platform}: injected serialized budget includes JSON escaping and base64 exactly`, async (t) => {
    const f = await channel(t, platform), raw = bodyAndImages(platform, 'body\\\"\n😀', 1, { downloadable: true });
    f.media(async () => image([1, 2, 3, 4]));
    const first = f.nextEvent(); f.send(raw); const event = await first, length = wireLength(event);
    const exactChannel = await channel(t, platform, Object.freeze({ ...messageLimits, serializedChars: length }));
    exactChannel.media(async () => image([1, 2, 3, 4]));
    const exact = exactChannel.nextEvent(); exactChannel.send(raw); assert.equal(wireLength(await exact), length);
    const overflowChannel = await channel(t, platform, Object.freeze({ ...messageLimits, serializedChars: length - 1 }));
    overflowChannel.media(async () => image([1, 2, 3, 4]));
    const rejected = overflowChannel.nextError(); overflowChannel.send(raw);
    assert.equal((await rejected).code, 'MESSAGE_TOO_LARGE'); assert.deepEqual(overflowChannel.events, []);
  });
}

test('SG001 requires public Host messageLimits before opening a platform connection', async () => {
  let network = 0;
  const adapter = createOneBotAdapter({ fetchImpl() { network++; throw new Error('Unexpected network'); }, connect() { network++; throw new Error('Unexpected connect'); } });
  await assert.rejects(adapter.start({ signal: new AbortController().signal, settings: {}, emit() {} }), { code: 'HOST_CONTRACT' });
  assert.equal(network, 0); await adapter.stop();
});

for (const platform of ['onebot', 'official']) test(`SG001 ${platform}: explicit platform-local URL paths remain ordered unavailable media`, async (t) => {
  const f = await channel(t, platform), raw = bodyAndImages(platform, 'body', 3), paths = ['file:///platform/first.png', 'C:\\platform\\second.png', '/platform/third.png'];
  if (platform === 'onebot') paths.forEach((url, index) => { raw.message[index + 1].data.url = url; });
  else paths.forEach((url, index) => { raw.attachments[index].url = url; });
  const emitted = f.nextEvent(); f.send(raw); const event = await emitted;
  assert.deepEqual(event.parts.map(({ kind }) => kind), ['text', 'image', 'image', 'image']);
  for (const [index, part] of event.parts.slice(1).entries()) {
    assert.equal(part.media, undefined); assert.equal(part.tooLarge, undefined);
    assert.ok(part.text.includes(`image-${index}.png`)); assert.match(part.text, /no downloadable URL; local platform paths are not read/);
  }
  assert.deepEqual(f.mediaCalls, []); assert.deepEqual(f.errors, []);
});

test('PLUGIN-01 official: rejected Host admission resumes before the failed sequence; replay succeeds once', async (t) => {
  const f = await channel(t, 'official');
  f.admission(() => { throw Object.assign(new Error('fixture Host refused the complete message'), { code: 'HOST_REJECTED' }); });
  const failure = f.nextError(), resumed = f.nextResume();
  f.send();
  assert.equal((await failure).code, 'HOST_REJECTED');
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.snapshots.map(({ lastSeq }) => lastSeq), [1]);
  assert.equal((await resumed).d.seq, 1);
  f.admission(async () => {});
  const replay = f.nextEvent(); f.send();
  assert.equal((await replay).sourceMessageId, '27');
  assert.deepEqual(f.events.map(({ sourceMessageId }) => sourceMessageId), ['27']);
  const nextResume = f.nextResume();
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.disconnect();
  assert.equal((await nextResume).d.seq, 2);
  assert.equal(f.snapshots.at(-1).lastSeq, 2);
  assert.equal(f.errors.length, 1);
});

test('PLUGIN-01 official: an unacknowledged admission may be a duplicate after resume, never a partial message', async (t) => {
  const f = await channel(t, 'official');
  const acceptedAtHost = [];
  f.admission((event) => { acceptedAtHost.push(event.sourceMessageId); if (acceptedAtHost.length === 1) throw new Error('ack lost after Host accepted'); });
  const failed = f.nextError(), resumed = f.nextResume();
  f.send(); assert.match((await failed).message, /ack lost/);
  assert.equal((await resumed).d.seq, 1);
  const replay = f.nextEvent(); f.send();
  assert.equal((await replay).sourceMessageId, '27');
  assert.deepEqual(acceptedAtHost, ['27', '27']);
  assert.equal(f.events.length, 1);
});

test('PLUGIN-01 OneBot: Host rejection is reported once and manual source replay can succeed', async (t) => {
  const f = await channel(t, 'onebot');
  f.admission(() => { throw Object.assign(new Error('Host rejected OneBot message'), { code: 'HOST_REJECTED' }); });
  const failed = f.nextError(); f.send();
  assert.equal((await failed).code, 'HOST_REJECTED'); assert.deepEqual(f.events, []);
  f.admission(async () => {});
  const replay = f.nextEvent(); f.send();
  assert.equal((await replay).sourceMessageId, '27');
  assert.equal(f.errors.length, 1);
});

test('PLUGIN-01 official: a later dispatch cannot advance the cursor while an earlier Host admission is pending', async (t) => {
  const f = await channel(t, 'official'), entered = deferred(), release = deferred();
  f.admission(async (event) => { if (event.sourceMessageId === '27') { entered.resolve(); await release.promise; } });
  const first = f.nextEvent(), second = f.nextEvent();
  f.send(); await entered.promise;
  f.send({ ...source('official'), id: '28' }, 3);
  assert.deepEqual(f.snapshots.map(({ lastSeq }) => lastSeq), [1]);
  assert.deepEqual(f.events, []);
  release.resolve();
  assert.equal((await first).sourceMessageId, '27');
  assert.equal((await second).sourceMessageId, '28');
  const resumed = f.nextResume(); await new Promise((resolve) => setTimeout(resolve, 5)); f.disconnect();
  assert.equal((await resumed).d.seq, 3);
});

test('PLUGIN-01 official: repeated rejection of the same source keeps its cursor and backs off', async (t) => {
  const f = await channel(t, 'official');
  f.media(async (url) => url === firstUrl ? image([1]) : new Response('unavailable', { status: 503 }));
  for (const wait of [1, 15, 30]) {
    const failed = f.nextError(), resumed = f.nextResume();
    f.send(); assert.equal((await failed).code, 'MEDIA_HTTP_ERROR');
    assert.equal((await resumed).d.seq, 1);
    assert.equal(f.retryDelays.at(-1), wait);
    assert.deepEqual(f.snapshots.map(({ lastSeq }) => lastSeq), Array(f.snapshots.length).fill(1));
  }
  assert.deepEqual(f.events, []);
  f.media(async (url) => image(url === firstUrl ? [1] : [2]));
  const replay = f.nextEvent(); f.send(); assert.equal((await replay).sourceMessageId, '27');
});
