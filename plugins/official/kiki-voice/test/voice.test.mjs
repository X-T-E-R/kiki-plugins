import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import test from 'node:test';
import { register } from '../entry.mjs';
import { tools } from '../lib/definitions.mjs';
import { speakText, manageVoice, execute } from '../lib/voice.mjs';

const provider = 'kiki-media/example-speech';
const definitions = [{ provider, definition: { id: 'example-speech', kinds: ['tts'], label: 'Example speech', schemaVersion: 1, resumeVersion: 1 } }];
const artifact = { id: 'a1', file_id: 'file-audio', name: 'speech.mp3', mime: 'audio/mpeg', kind: 'audio', role: 'original', complete: true, bytes: 12 };
function job(overrides = {}) {
  return { schemaVersion: 1, job_id: 'media-123', request_id: 'greeting-1', owner_session_id: 'example-session', owner_agent_id: 'main', provider,
    state: 'succeeded', phase: 'download', can_resume: false, artifacts: [artifact], created_at: 1, updated_at: 2, ...overrides };
}
function fixture({ items = definitions, generated = job(), current = job(), error, settings = {} } = {}) {
  const calls = [];
  const controller = new AbortController();
  const context = {
    signal: controller.signal, settings, progress: (update) => calls.push({ progress: update }),
    media: {
      async generate(input) { calls.push({ generate: input }); if (error) throw error; return generated; },
      async media(input) {
        calls.push({ media: input });
        if (input.action === 'capabilities') return { providers: items };
        if (input.action === 'voices') return { voices: [{ id: 'example-voice', languages: ['zh'] }] };
        if (input.action === 'get') return current;
        if (input.action === 'resume') return job();
        if (input.action === 'cancel') return job({ state: 'stopped', cancellation: { remote: 'unsupported', billing: 'unknown' } });
        throw new Error('Unexpected media action');
      },
    },
  };
  return { context, controller, calls };
}
const input = { request_id: 'greeting-1', text: '你好', voice: 'example-voice' };

test('manifest and registered tool definitions have one source', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest['x-kiki'].tools, tools);
  const registered = [];
  register({ registerTool: (definition, handler) => registered.push({ definition, handler }) });
  assert.deepEqual(registered.map((item) => item.definition), tools);
  assert.ok(registered.every((item) => typeof item.handler === 'function'));
});

test('delegates TTS once to Kiki Media and preserves the exact playable job', async () => {
  const { context, calls } = fixture();
  const result = await speakText({ ...input, language: 'zh', format: 'mp3', sample_rate_hz: 24000, options: { speed: 1.1 } }, context);
  assert.deepEqual(JSON.parse(result.output), { type: 'media_generation', job: job() });
  assert.equal(result.isError, false);
  const generated = calls.filter((item) => item.generate).map((item) => item.generate);
  assert.equal(generated.length, 1);
  assert.deepEqual(generated[0], { request_id: 'greeting-1', provider, model: undefined, execution: 'auto',
    request: { kind: 'tts', text: '你好', voice: 'example-voice', language: 'zh', format: 'mp3', sample_rate_hz: 24000, options: { speed: 1.1 } } });
});

test('uses configured voice/provider/model without reading Media credentials', async () => {
  const { context, calls } = fixture({ settings: { defaultProvider: 'example-speech', defaultVoice: 'configured', defaultModel: 'example-model', defaultLanguage: 'zh' } });
  await speakText({ request_id: 'same-id', text: 'Hello' }, context);
  const generated = calls.find((item) => item.generate).generate;
  assert.equal(generated.provider, provider);
  assert.equal(generated.model, 'example-model');
  assert.equal(generated.request.voice, 'configured');
  assert.equal(generated.request.language, 'zh');
  assert.deepEqual(Object.keys(context.settings), ['defaultProvider', 'defaultVoice', 'defaultModel', 'defaultLanguage']);
});

test('missing Media or source returns an actionable error before generation', async () => {
  const { context, calls } = fixture({ items: [{ provider: 'other/speech', definition: { kinds: ['tts'] } }] });
  const result = await execute(speakText, input, context);
  assert.equal(JSON.parse(result.output).error.code, 'media_dependency');
  assert.equal(calls.filter((item) => item.generate).length, 0);
  const absent = await execute(speakText, input, { ...context, media: undefined });
  assert.equal(JSON.parse(absent.output).error.code, 'media_dependency');
});

test('does not guess a voice or provider when several sources are available', async () => {
  const { context, calls } = fixture({ items: [...definitions, { provider: 'kiki-media/second', definition: { kinds: ['tts'] } }] });
  const ambiguous = await execute(speakText, input, context);
  assert.equal(JSON.parse(ambiguous.output).error.code, 'provider_required');
  const missingVoice = await execute(speakText, { request_id: 'a', text: 'hello' }, context);
  assert.equal(JSON.parse(missingVoice.output).error.code, 'invalid_input');
  assert.equal(calls.filter((item) => item.generate).length, 0);
});

test('voice catalog is filtered to the dependency and voices preserve pagination', async () => {
  const { context, calls } = fixture({ items: [...definitions, { provider: 'elsewhere/audio', definition: { kinds: ['tts'] } }] });
  assert.deepEqual(JSON.parse((await manageVoice({ action: 'providers' }, context)).output).providers, definitions);
  await manageVoice({ action: 'voices', provider: 'example-speech', language: 'zh', cursor: 'next' }, context);
  assert.deepEqual(calls.at(-1).media, { action: 'voices', provider, model: undefined, language: 'zh', cursor: 'next' });
});

test('pending and unknown outcomes never generate replacements', async () => {
  for (const state of ['pending', 'unknown', 'failed', 'partial']) {
    const original = job({ state, can_resume: false });
    const { context, calls } = fixture({ generated: original, current: original });
    const result = await speakText(input, context);
    assert.equal(result.isError, state !== 'pending');
    const got = await manageVoice({ action: 'get', job_id: original.job_id }, context);
    assert.deepEqual(JSON.parse(got.output).job, original);
    const resumed = await execute(manageVoice, { action: 'resume', job_id: original.job_id }, context);
    assert.equal(JSON.parse(resumed.output).error.code, 'not_resumable');
    assert.deepEqual(JSON.parse(resumed.output).job, original);
    assert.equal(resumed.isError, true);
    assert.equal(calls.filter((item) => item.generate).length, 1);
    assert.equal(calls.filter((item) => item.media?.action === 'resume').length, 0);
  }
});

test('resume and cancel continue the existing job and preserve cancellation meaning', async () => {
  const { context, calls } = fixture({ current: job({ state: 'pending', can_resume: true }) });
  assert.equal(JSON.parse((await manageVoice({ action: 'resume', job_id: 'media-123' }, context)).output).job.state, 'succeeded');
  const cancelled = await manageVoice({ action: 'cancel', job_id: 'media-123' }, context);
  assert.equal(JSON.parse(cancelled.output).job.cancellation.remote, 'unsupported');
  assert.equal(cancelled.isError, true);
  assert.equal(calls.filter((item) => item.generate).length, 0);
});

test('rejects another plugin provider and honors cancellation before calls', async () => {
  const { context, controller, calls } = fixture({ current: job({ provider: 'another/speech' }) });
  const foreign = await execute(manageVoice, { action: 'cancel', job_id: 'media-123' }, context);
  assert.equal(JSON.parse(foreign.output).error.code, 'media_dependency');
  assert.equal(calls.filter((item) => item.media?.action === 'cancel').length, 0);
  calls.length = 0;
  controller.abort();
  const cancelled = await execute(speakText, input, context);
  assert.equal(JSON.parse(cancelled.output).error.code, 'cancelled');
  assert.equal(calls.length, 0);
});

test('provider error is returned once without local retry', async () => {
  const { context, calls } = fixture({ error: new Error('Provider authentication failed') });
  const result = await execute(speakText, input, context);
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.output).error.message, 'Provider authentication failed');
  assert.equal(calls.filter((item) => item.generate).length, 1);
});

const runnerOptions = { skip: !process.env.KIKI_HOST_RUNNER, timeout: 10000 };
async function runHostTool(t, name, args, respond) {
  const root = path.dirname(import.meta.dirname);
  const child = spawn(process.execPath, [path.resolve(process.env.KIKI_HOST_RUNNER), path.join(root, 'entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const incoming = createInterface({ input: child.stdout });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  t.after(async () => {
    incoming.close();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Host runner timed out: ${stderr}`)), 8000);
    const fail = (error) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Host runner exited ${code}: ${stderr}`)));
    incoming.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.method === 'register-error') return fail(new Error(message.params.message));
        if (message.method === 'ready') send({ id: 1, method: 'execute', params: { name, args, settings: {} } });
        if (message.method === 'media-call') {
          const { callId, action, input: request } = message.params;
          send({ method: 'media-result', params: { callId, ...respond(action, request) } });
        }
        if (message.id === 1) { clearTimeout(timeout); resolve(message); }
      } catch (error) { fail(error); }
    });
    send({ id: 0, method: 'handshake', params: { version: 1 } });
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(messages.filter((message) => message.method === 'register').map((message) => message.params.tool), tools);
  return { result: result.result, calls: messages.filter((message) => message.method === 'media-call').map((message) => message.params) };
}

test('Host runner executes Voice through Media RPC and preserves the artifact result', runnerOptions, async (t) => {
  const { result, calls } = await runHostTool(t, 'speak', input, (action, request) => {
    if (action === 'media' && request.action === 'capabilities') return { result: { providers: definitions } };
    if (action === 'generate') return { result: job() };
    assert.fail(`Unexpected RPC ${action}: ${JSON.stringify(request)}`);
  });
  assert.equal(calls.filter((call) => call.action === 'generate').length, 1);
  assert.deepEqual(JSON.parse(result.output), { type: 'media_generation', job: job() });
});

test('Host runner carries original file_id, full caption, targets and exact channel receipts', runnerOptions, async (t) => {
  const receipt = { message_id: 'm1', delivered_to: ['example-session'], channels: [
    { channel_id: 'example-chat', status: 'delivered', message_ids: ['platform-1'] },
    { channel_id: 'other-chat', status: 'unsupported', unsupported: ['voice'] },
  ], delivery: 'delivered' };
  const { result, calls } = await runHostTool(t, 'speak', { ...input, delivery: { request_id: 'd', channels: ['example-chat', 'other-chat'], text: 'A\nB', reply_to: 'platform-previous' } }, (action, request) => {
    if (action === 'media' && request.action === 'capabilities') return { result: { providers: definitions } };
    if (action === 'generate') return { result: job() };
    if (action === 'message-send') return { result: receipt };
    assert.fail(`Unexpected RPC ${action}: ${JSON.stringify(request)}`);
  });
  assert.deepEqual(JSON.parse(result.output), { type: 'media_generation', job: job(), delivery: receipt });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((call) => call.action === 'generate').length, 1);
  assert.deepEqual(calls.filter((call) => call.action === 'message-send').map((call) => call.input), [{
    request_id: 'd', channels: ['example-chat', 'other-chat'], text: 'A\nB', reply_to: 'platform-previous',
    attachments: [{ file_id: 'file-audio', kind: 'voice', title: 'speech.mp3', mime_type: 'audio/mpeg' }],
  }]);
});

test('Host runner sends existing audio once and keeps the job after a lost message response', runnerOptions, async (t) => {
  const { result, calls } = await runHostTool(t, 'voice', { action: 'send', job_id: 'media-123', delivery: { request_id: 'd' } }, (action, request) => {
    if (action === 'media' && request.action === 'get') return { result: job() };
    if (action === 'message-send') return { error: 'Message response lost' };
    assert.fail(`Unexpected RPC ${action}: ${JSON.stringify(request)}`);
  });
  assert.deepEqual(JSON.parse(result.output).job, job());
  assert.equal(JSON.parse(result.output).delivery.status, 'unknown');
  assert.equal(JSON.parse(result.output).delivery.request_id, 'd');
  assert.equal(calls.filter((call) => call.action === 'generate').length, 0);
  assert.equal(calls.filter((call) => call.action === 'message-send').length, 1);
});


test('generate-and-send preserves original file_id and the full real delivery receipt', async () => {
  const { context, calls } = fixture();
  const receipt = { message_id: 'message-1', delivered_to: ['session-2'], channels: [{ channel_id: 'qq-group', status: 'delivered', message_ids: ['platform-1'] }], delivery: 'delivered' };
  context.messages = { send: async (input) => { calls.push({ send: input }); return receipt; } };
  const result = await speakText({ ...input, delivery: { request_id: 'greeting-delivery-1', text: 'A\nB', channel: 'qq-group' } }, context);
  assert.deepEqual(JSON.parse(result.output), { type: 'media_generation', job: job(), delivery: receipt });
  assert.equal(result.isError, false);
  assert.equal(calls.filter((item) => item.generate).length, 1);
  assert.deepEqual(calls.find((item) => item.send).send, {
    request_id: 'greeting-delivery-1', text: 'A\nB', to: undefined, channel: 'qq-group', channels: undefined, reply_to: undefined,
    attachments: [{ file_id: 'file-audio', kind: 'voice', title: 'speech.mp3', mime_type: 'audio/mpeg' }],
  });
});

test('pending/unknown/failed generation and incomplete files never reach message send', async () => {
  for (const state of ['pending', 'unknown', 'failed', 'partial', 'stopped']) {
    const original = job({ state }); const { context, calls } = fixture({ generated: original });
    context.messages = { send: async () => { throw new Error('Unexpected send'); } };
    const result = await speakText({ ...input, delivery: { request_id: 'delivery-1' } }, context);
    const data = JSON.parse(result.output);
    assert.deepEqual(data.job, original);
    assert.equal(data.delivery.status, state === 'pending' ? 'awaiting_generation' : 'not_sent');
    assert.equal(calls.filter((item) => item.generate).length, 1);
  }
  for (const artifacts of [[{ ...artifact, complete: false }], [{ ...artifact, role: 'preview' }], [{ ...artifact, file_id: undefined }], [artifact, { ...artifact, file_id: 'second' }]]) {
    const { context } = fixture({ current: job({ artifacts }) });
    context.messages = { send: async () => { throw new Error('Unexpected send'); } };
    const result = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'delivery-1' } }, context);
    assert.equal(JSON.parse(result.output).delivery.status, 'not_sent');
  }
});

test('send an existing completed job without regeneration; failed and unknown sends retain the job and request_id', async () => {
  for (const status of ['unknown', 'failed', 'partial', 'unsupported', 'delivered']) {
    const { context, calls } = fixture();
    const receipt = { message_id: 'm1', delivered_to: [], channels: [{ channel_id: 'qq', status }] };
    context.messages = { send: async (input) => { calls.push({ send: input }); return receipt; } };
    const result = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'stable-send-1', kind: 'audio' } }, context);
    assert.deepEqual(JSON.parse(result.output).delivery, receipt);
    assert.deepEqual(JSON.parse(result.output).job, job());
    assert.equal(result.isError, status !== 'delivered');
    assert.equal(calls.filter((item) => item.generate).length, 0);
    assert.equal(calls.filter((item) => item.send).length, 1);
  }
  const { context, calls } = fixture();
  context.messages = { send: async (input) => { calls.push({ send: input }); throw new Error('response lost'); } };
  const result = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'stable-send-1' } }, context);
  assert.equal(JSON.parse(result.output).delivery.status, 'unknown');
  assert.equal(JSON.parse(result.output).delivery.request_id, 'stable-send-1');
  assert.deepEqual(JSON.parse(result.output).job, job());
  assert.equal(calls.filter((item) => item.send).length, 1);
});

test('missing public message API or delivery id fails before generation; cancellation retains a generated job', async () => {
  const { context, calls, controller } = fixture();
  let result = await execute(speakText, { ...input, delivery: { request_id: 'delivery-1' } }, context);
  assert.equal(JSON.parse(result.output).error.code, 'messages_dependency');
  assert.equal(calls.filter((item) => item.generate).length, 0);
  context.messages = { send: async () => { throw new Error('Unexpected send'); } };
  result = await execute(speakText, { ...input, delivery: {} }, context);
  assert.equal(JSON.parse(result.output).error.code, 'invalid_input');
  context.media.generate = async () => { controller.abort(); return job(); };
  result = await speakText({ ...input, delivery: { request_id: 'delivery-1' } }, context);
  assert.equal(JSON.parse(result.output).delivery.status, 'not_sent');
  assert.deepEqual(JSON.parse(result.output).job, job());
});


test('invalid delivery is rejected before a speech purchase or message call', async () => {
  for (const delivery of [null, false, [], {}, { request_id: ' ' }, { request_id: 'x'.repeat(257) },
    { request_id: 'd', to: 1 }, { request_id: 'd', channel: '' }, { request_id: 'd', channels: [] },
    { request_id: 'd', channels: [''] }, { request_id: 'd', reply_to: '' }, { request_id: 'd', file_id: '' },
    { request_id: 'd', text: 'x'.repeat(20001) }, { request_id: 'd', kind: 'file' }, { request_id: 'd', path: '/unapproved/audio.mp3' }]) {
    const { context, calls } = fixture();
    context.messages = { send: async () => { throw new Error('Unexpected send'); } };
    const result = await execute(speakText, { ...input, delivery }, context);
    assert.equal(JSON.parse(result.output).error?.code, 'invalid_input', JSON.stringify(delivery));
    assert.equal(calls.filter((item) => item.generate).length, 0);
  }
});

test('management actions never silently discard a requested delivery', async () => {
  for (const action of ['providers', 'voices', 'get', 'resume', 'cancel']) {
    const { context, calls } = fixture({ current: job({ can_resume: true }) });
    const result = await execute(manageVoice, { action, job_id: 'media-123', delivery: { request_id: 'd' } }, context);
    assert.equal(JSON.parse(result.output).error?.code, 'invalid_input', action);
    assert.equal(calls.length, 0);
  }
});

test('batch receipts preserve per-message cancelled/not_sent/partial/unknown outcomes', async () => {
  for (const delivery of ['cancelled', 'not_sent', 'undeliverable', 'pending', 'delivered']) {
    const receipt = { messages: [{ index: 0, message_id: 'm1', delivered_to: [], delivery }] };
    const { context } = fixture();
    context.messages = { send: async () => receipt };
    const result = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'd' } }, context);
    assert.deepEqual(JSON.parse(result.output).delivery, receipt);
    assert.equal(result.isError, !['pending', 'delivered'].includes(delivery), delivery);
  }
  const receipt = { messages: [
    { index: 0, message_id: 'm1', delivered_to: ['example-session'], delivery: 'delivered' },
    { index: 1, message_id: 'm2', delivered_to: [], channels: [{ channel_id: 'example-chat', status: 'partial', detail: 'Audio unsupported' }] },
    { index: 2, message_id: 'm3', delivered_to: [], channels: [{ channel_id: 'another-chat', status: 'unknown' }] },
  ] };
  const { context } = fixture();
  context.messages = { send: async () => receipt };
  const result = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'd' } }, context);
  assert.deepEqual(JSON.parse(result.output).delivery, receipt);
  assert.equal(result.isError, true);
});

test('running/pending generation returns the unsent delivery identity and recovery step', async () => {
  for (const state of ['running', 'pending']) {
    const { context, calls } = fixture({ generated: job({ state, task_id: 'task-speech', can_resume: true }) });
    context.messages = { send: async () => { throw new Error('Unexpected send'); } };
    const result = await speakText({ ...input, delivery: { request_id: 'd' } }, context);
    const data = JSON.parse(result.output);
    assert.equal(data.job.state, state);
    assert.equal(data.job.task_id, 'task-speech');
    assert.equal(data.delivery.status, 'awaiting_generation');
    assert.equal(data.delivery.request_id, 'd');
    assert.match(data.delivery.detail, /voice send/u);
    assert.equal(calls.filter((item) => item.generate).length, 1);
  }
});

test('send selects only an original audio file from its Media job and never substitutes a path', async () => {
  const second = { ...artifact, id: 'a2', file_id: 'file-second', name: 'second.ogg', mime: 'audio/ogg' };
  const { context, calls } = fixture({ current: job({ artifacts: [artifact, second] }) });
  context.messages = { send: async (input) => { calls.push({ send: input }); return { message_id: 'm1', delivered_to: ['example-session'], delivery: 'delivered' }; } };
  const result = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'd', file_id: 'file-second', kind: 'audio', to: 'example-session' } }, context);
  assert.equal(result.isError, false);
  assert.deepEqual(calls.find((item) => item.send).send.attachments, [{ file_id: 'file-second', kind: 'audio', title: 'second.ogg', mime_type: 'audio/ogg' }]);
  assert.equal(calls.find((item) => item.send).send.to, 'example-session');
  assert.equal(calls.filter((item) => item.generate).length, 0);
  const missing = await manageVoice({ action: 'send', job_id: 'media-123', delivery: { request_id: 'other', file_id: 'file-foreign' } }, context);
  assert.equal(JSON.parse(missing.output).delivery.status, 'not_sent');
  assert.equal(calls.filter((item) => item.send).length, 1);
});

test('generation errors keep the request identity for inspection rather than inventing a retry id', async () => {
  const { context, calls } = fixture({ error: new Error('Media RPC response lost') });
  const result = await execute(speakText, input, context);
  assert.equal(JSON.parse(result.output).request_id, input.request_id);
  assert.equal(calls.filter((item) => item.generate).length, 1);
});


test('same ids reach fixture Host deduplication unchanged and changed payloads are rejected', async () => {
  const { context } = fixture();
  const generations = new Map();
  const deliveries = new Map();
  let purchases = 0;
  let externalSends = 0;
  context.media.generate = async (request) => {
    const previous = generations.get(request.request_id);
    if (previous && previous.payload !== JSON.stringify(request)) throw new Error('request_id already belongs to a different media request');
    if (previous) return previous.job;
    purchases++;
    generations.set(request.request_id, { payload: JSON.stringify(request), job: job() });
    return job();
  };
  context.messages = { send: async (request) => {
    const previous = deliveries.get(request.request_id);
    if (previous && previous.payload !== JSON.stringify(request)) throw new Error('request_id already belongs to a different message');
    if (previous) return { ...previous.receipt, deduplicated: true };
    externalSends++;
    const receipt = { message_id: 'message-1', delivered_to: [], channels: [{ channel_id: 'example-chat', status: 'unknown' }] };
    deliveries.set(request.request_id, { payload: JSON.stringify(request), receipt });
    return receipt;
  } };
  const request = { ...input, delivery: { request_id: 'stable-delivery', channel: 'example-chat', text: 'A\nB' } };
  const first = await execute(speakText, request, context);
  assert.equal(JSON.parse(first.output).delivery.channels[0].status, 'unknown');
  assert.equal(purchases, 1);
  assert.equal(externalSends, 1);
  const repeated = await execute(speakText, request, context);
  assert.equal(JSON.parse(repeated.output).delivery.deduplicated, true);
  const fromJob = await execute(manageVoice, { action: 'send', job_id: 'media-123', delivery: request.delivery }, context);
  assert.equal(JSON.parse(fromJob.output).delivery.deduplicated, true);
  const changedSpeech = await execute(speakText, { ...request, text: 'Different speech' }, context);
  assert.match(JSON.parse(changedSpeech.output).error.message, /different media request/u);
  const changedMessage = await execute(manageVoice, { action: 'send', job_id: 'media-123', delivery: { ...request.delivery, text: 'Different caption' } }, context);
  assert.equal(JSON.parse(changedMessage.output).delivery.status, 'unknown');
  assert.match(JSON.parse(changedMessage.output).delivery.detail, /different message/u);
  assert.equal(purchases, 1);
  assert.equal(externalSends, 1);
});

test('local cancellation during a send keeps the completed job and reports uncertain delivery once', async () => {
  const { context, calls, controller } = fixture();
  context.messages = { send: async (request) => {
    calls.push({ send: request });
    controller.abort();
    throw new DOMException('Local wait stopped', 'AbortError');
  } };
  const result = await execute(speakText, { ...input, delivery: { request_id: 'd' } }, context);
  assert.deepEqual(JSON.parse(result.output).job, job());
  assert.equal(JSON.parse(result.output).delivery.status, 'unknown');
  assert.equal(JSON.parse(result.output).delivery.request_id, 'd');
  assert.equal(calls.filter((item) => item.generate).length, 1);
  assert.equal(calls.filter((item) => item.send).length, 1);
});


test('voice discovery uses the same configured model/language as speech, with explicit overrides', async () => {
  const { context, calls } = fixture({ settings: { defaultProvider: 'example-speech', defaultModel: 'speech-model', defaultLanguage: 'zh' } });
  await manageVoice({ action: 'voices' }, context);
  assert.deepEqual(calls.at(-1).media, { action: 'voices', provider, model: 'speech-model', language: 'zh', cursor: undefined });
  await manageVoice({ action: 'voices', model: 'other-model', language: 'en', cursor: 'page-2' }, context);
  assert.deepEqual(calls.at(-1).media, { action: 'voices', provider, model: 'other-model', language: 'en', cursor: 'page-2' });
});
