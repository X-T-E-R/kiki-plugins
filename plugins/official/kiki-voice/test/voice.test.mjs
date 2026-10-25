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

test('real Host runner executes Voice through its Media RPC and preserves the artifact result', { skip: !process.env.KIKI_HOST_RUNNER, timeout: 10000 }, async (t) => {
  const root = path.dirname(import.meta.dirname);
  const child = spawn(process.execPath, [path.resolve(process.env.KIKI_HOST_RUNNER), path.join(root, 'entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const incoming = createInterface({ input: child.stdout });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  t.after(() => { child.kill(); incoming.close(); });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Host runner timed out: ${stderr}`)), 8000);
    const fail = (error) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', (code) => { if (code !== null && code !== 0) fail(new Error(`Host runner exited ${code}: ${stderr}`)); });
    incoming.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.method === 'register-error') return fail(new Error(message.params.message));
        if (message.method === 'ready') send({ id: 1, method: 'execute', params: { name: 'speak', args: input, settings: {} } });
        if (message.method === 'media-call') {
          const { callId, action, input: request } = message.params;
          if (action === 'media' && request.action === 'capabilities') send({ method: 'media-result', params: { callId, result: { providers: definitions } } });
          else if (action === 'generate') send({ method: 'media-result', params: { callId, result: job() } });
          else fail(new Error(`Unexpected RPC ${action}: ${JSON.stringify(request)}`));
        }
        if (message.id === 1) { clearTimeout(timeout); resolve(message); }
      } catch (error) { fail(error); }
    });
    send({ id: 0, method: 'handshake', params: { version: 1 } });
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(messages.filter((message) => message.method === 'register').map((message) => message.params.tool), tools);
  assert.equal(messages.filter((message) => message.method === 'media-call' && message.params.action === 'generate').length, 1);
  assert.deepEqual(JSON.parse(result.result.output), { type: 'media_generation', job: job() });
});
