const failedStates = new Set(['failed', 'unknown', 'stopped', 'partial']);

export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new VoiceError('invalid_input', `${name} is required.`);
  return value;
}

function providerId(value) {
  const id = required(value, 'provider').trim();
  if (id.includes('/') && !id.startsWith('kiki-media/')) throw new VoiceError('media_dependency', 'Voice uses the unified kiki-media plugin. Choose one of its speech providers.');
  return id.startsWith('kiki-media/') ? id : `kiki-media/${id}`;
}

function mediaApi(context) {
  if (typeof context.media?.generate !== 'function' || typeof context.media?.media !== 'function') {
    throw new VoiceError('media_dependency', 'This host does not expose Kiki Media. Update Kiki, then install and enable kiki-media for this session.');
  }
  return context.media;
}

async function providers(context) {
  context.signal.throwIfAborted();
  const page = await mediaApi(context).media({ action: 'capabilities', kind: 'tts' });
  const items = (page.providers ?? []).filter((item) => item.provider.startsWith('kiki-media/') && item.definition.kinds.includes('tts'));
  if (items.length === 0) throw new VoiceError('media_dependency', 'Install and enable Kiki Media and a speech source for this session. Configure the source in Media settings.');
  return items;
}

async function chooseProvider(input, context) {
  const available = await providers(context);
  const configured = input.provider ?? (context.settings.defaultProvider || undefined);
  if (configured !== undefined) {
    const selected = providerId(configured);
    if (!available.some((item) => item.provider === selected)) throw new VoiceError('provider_unavailable', `Speech provider ${selected} is not enabled for this session. Use voice providers to choose one.`);
    return selected;
  }
  if (available.length !== 1) throw new VoiceError('provider_required', `Choose a speech provider with speak.provider or the Voice setting: ${available.map((item) => item.provider).join(', ')}`);
  return available[0].provider;
}

export function jobResult(job) {
  return { output: JSON.stringify({ type: 'media_generation', job }), isError: failedStates.has(job.state) };
}

export async function speakText(input, context) {
  required(input.request_id, 'request_id');
  if (input.request_id.length > 200) throw new VoiceError('invalid_input', 'request_id must be at most 200 characters.');
  required(input.text, 'text');
  const selectedVoice = input.voice ?? (context.settings.defaultVoice || undefined);
  required(selectedVoice, 'voice');
  const provider = await chooseProvider(input, context);
  context.signal.throwIfAborted();
  context.progress({ kind: 'status', text: 'Generating speech with Kiki Media' });
  return jobResult(await mediaApi(context).generate({
    request_id: input.request_id,
    provider,
    model: input.model ?? (context.settings.defaultModel || undefined),
    execution: input.execution ?? 'auto',
    request: {
      kind: 'tts',
      text: input.text,
      voice: selectedVoice,
      language: input.language ?? (context.settings.defaultLanguage || undefined),
      format: input.format,
      sample_rate_hz: input.sample_rate_hz,
      options: input.options,
    },
  }));
}

export async function manageVoice(input, context) {
  context.signal.throwIfAborted();
  const api = mediaApi(context);
  if (input.action === 'providers') return { output: JSON.stringify({ providers: await providers(context) }) };
  if (input.action === 'voices') {
    const provider = await chooseProvider(input, context);
    return { output: JSON.stringify(await api.media({ action: 'voices', provider, model: input.model, language: input.language, cursor: input.cursor })) };
  }
  if (!['get', 'resume', 'cancel'].includes(input.action)) throw new VoiceError('invalid_input', 'Choose providers, voices, get, resume or cancel.');
  required(input.job_id, 'job_id');
  const job = await api.media({ action: 'get', job_id: input.job_id });
  providerId(job.provider);
  if (input.action === 'get') return jobResult(job);
  if (input.action === 'resume' && !job.can_resume) throw new VoiceError('not_resumable', `Job ${input.job_id} has no resumable handle. Keep its request_id; do not submit replacement speech for an unknown result.`);
  context.signal.throwIfAborted();
  return jobResult(await api.media({ action: input.action, job_id: input.job_id }));
}

export async function execute(handler, input, context) {
  try {
    context.signal.throwIfAborted();
    return await handler(input ?? {}, context);
  } catch (error) {
    const cancelled = context.signal.aborted || error?.name === 'AbortError';
    return {
      isError: true,
      output: JSON.stringify({
        error: {
          code: cancelled ? 'cancelled' : error?.code ?? 'media_error',
          message: cancelled ? 'The local wait stopped. Inspect an existing job before sending or generating again.' : error instanceof Error ? error.message : String(error),
        },
      }),
    };
  }
}
