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

export function jobResult(job, extra = {}, isError = false) {
  return { output: JSON.stringify({ type: 'media_generation', job, ...extra }), isError: isError || failedStates.has(job.state) };
}

function validateDelivery(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VoiceError('invalid_input', 'delivery must be an object with a request_id.');
  const fields = ['request_id', 'to', 'channel', 'channels', 'reply_to', 'text', 'file_id', 'kind'];
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new VoiceError('invalid_input', 'Use delivery target fields and an original file_id, not paths or message batches.');
  required(input.request_id, 'delivery.request_id');
  if (input.request_id.length > 256) throw new VoiceError('invalid_input', 'delivery.request_id must be at most 256 characters.');
  for (const field of ['to', 'channel', 'reply_to', 'file_id']) {
    if (input[field] !== undefined) required(input[field], `delivery.${field}`);
  }
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > 32) throw new VoiceError('invalid_input', 'delivery.channels must contain 1 to 32 channel ids.');
    for (const channel of input.channels) required(channel, 'delivery.channels item');
  }
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 20000)) throw new VoiceError('invalid_input', 'delivery.text must be a string of at most 20000 characters.');
  if (input.kind !== undefined && !['voice', 'audio'].includes(input.kind)) throw new VoiceError('invalid_input', 'delivery.kind must be voice or audio.');
  if (typeof context.messages?.send !== 'function') throw new VoiceError('messages_dependency', 'Update Kiki to a Host with the public plugin message API.');
}

function failedReceipt(receipt) {
  const messages = receipt.messages ?? [receipt];
  return messages.some((message) => ['undeliverable', 'cancelled', 'not_sent'].includes(message.delivery)
    || message.channels?.some((channel) => ['failed', 'unknown', 'unsupported', 'partial'].includes(channel.status)));
}

async function deliver(job, input, context) {
  if (job.state !== 'succeeded') return jobResult(job, { delivery: {
    status: failedStates.has(job.state) ? 'not_sent' : 'awaiting_generation', request_id: input.request_id,
    detail: failedStates.has(job.state) ? 'Inspect this Media job before sending. No audio was sent.' : 'Inspect this job with voice get/resume, then use voice send with this delivery request_id when it succeeds.',
  } });
  const audio = job.artifacts.filter((item) => item.role === 'original' && item.complete && item.file_id && item.kind === 'audio' && item.mime.startsWith('audio/'));
  const selected = input.file_id ? audio.find((item) => item.file_id === input.file_id) : audio.length === 1 ? audio[0] : undefined;
  if (!selected) return jobResult(job, { delivery: { status: 'not_sent', request_id: input.request_id, detail: 'Choose a complete original audio file_id from this job.' } }, true);
  if (context.signal.aborted) return jobResult(job, { delivery: { status: 'not_sent', request_id: input.request_id, detail: 'Cancelled before sending.' } }, true);
  try {
    const receipt = await context.messages.send({
      request_id: input.request_id, text: input.text, to: input.to, channel: input.channel, channels: input.channels, reply_to: input.reply_to,
      attachments: [{ file_id: selected.file_id, kind: input.kind ?? 'voice', title: selected.name, mime_type: selected.mime }],
    });
    return jobResult(job, { delivery: receipt }, failedReceipt(receipt));
  } catch (error) {
    return jobResult(job, { delivery: { status: 'unknown', request_id: input.request_id, detail: error instanceof Error ? error.message : String(error) } }, true);
  }
}

export async function speakText(input, context) {
  required(input.request_id, 'request_id');
  if (input.request_id.length > 200) throw new VoiceError('invalid_input', 'request_id must be at most 200 characters.');
  required(input.text, 'text');
  const selectedVoice = input.voice ?? (context.settings.defaultVoice || undefined);
  required(selectedVoice, 'voice');
  if (input.delivery !== undefined) validateDelivery(input.delivery, context);
  const provider = await chooseProvider(input, context);
  context.signal.throwIfAborted();
  context.progress({ kind: 'status', text: 'Generating speech with Kiki Media' });
  const job = await mediaApi(context).generate({
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
  });
  return input.delivery ? deliver(job, input.delivery, context) : jobResult(job);
}

export async function manageVoice(input, context) {
  context.signal.throwIfAborted();
  if (input.delivery !== undefined && input.action !== 'send') throw new VoiceError('invalid_input', 'delivery is only used by voice send. get/resume/cancel do not send messages.');
  const api = mediaApi(context);
  if (input.action === 'providers') return { output: JSON.stringify({ providers: await providers(context) }) };
  if (input.action === 'voices') {
    const provider = await chooseProvider(input, context);
    return { output: JSON.stringify(await api.media({
      action: 'voices', provider, cursor: input.cursor,
      model: input.model ?? (context.settings.defaultModel || undefined),
      language: input.language ?? (context.settings.defaultLanguage || undefined),
    })) };
  }
  if (!['get', 'resume', 'cancel', 'send'].includes(input.action)) throw new VoiceError('invalid_input', 'Choose providers, voices, get, resume, cancel or send.');
  if (input.action === 'send') validateDelivery(input.delivery, context);
  required(input.job_id, 'job_id');
  const job = await api.media({ action: 'get', job_id: input.job_id });
  providerId(job.provider);
  if (input.action === 'send') return deliver(job, input.delivery, context);
  if (input.action === 'get') return jobResult(job);
  if (input.action === 'resume' && !job.can_resume) return jobResult(job, { error: {
    code: 'not_resumable', message: `Job ${input.job_id} has no resumable handle. Keep its request_id; do not submit replacement speech for an unknown result.`,
  } }, true);
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
        request_id: input?.request_id,
        job_id: input?.job_id,
        error: {
          code: cancelled ? 'cancelled' : error?.code ?? 'media_error',
          message: cancelled ? 'The local wait stopped. Inspect an existing job before sending or generating again.' : error instanceof Error ? error.message : String(error),
        },
      }),
    };
  }
}
