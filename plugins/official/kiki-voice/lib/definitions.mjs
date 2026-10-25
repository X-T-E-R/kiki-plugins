export const delivery = {
  type: 'object',
  properties: {
    request_id: { type: 'string', minLength: 1, maxLength: 256, description: 'Stable message-send id, separate from the generation request_id. Reuse only for the same target and payload.' },
    to: { type: 'string', minLength: 1, description: 'Host message recipient, using the same routing as SendMessage.' },
    channel: { type: 'string', minLength: 1, description: 'One output channel id. Omit channel/channels to use the current thread bound outputs.' },
    channels: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1 }, description: 'Explicit output channel ids.' },
    reply_to: { type: 'string', minLength: 1 },
    text: { type: 'string', maxLength: 20000, description: 'One complete caption. Line breaks do not split it into messages.' },
    file_id: { type: 'string', minLength: 1, description: 'Optional selection when the job has several complete original audio artifacts.' },
    kind: { type: 'string', enum: ['voice', 'audio'], default: 'voice' },
  },
  required: ['request_id'], additionalProperties: false,
};

export const speak = {
  schemaVersion: 1,
  name: 'speak',
  description: 'Generate playable speech through Kiki Media. Reuse request_id for the same generation. Optional delivery sends the complete original audio file_id through Host messages and returns its real receipt; reuse delivery.request_id for the same message. Pending jobs need voice get/resume then send, without a new generation. Unknown outcomes are never automatically retried. Select a discovered voice and provider. Omitting delivery only generates speech.',
  parameters: {
    type: 'object',
    properties: {
      request_id: { type: 'string', minLength: 1, maxLength: 200 },
      text: { type: 'string', minLength: 1 },
      provider: { type: 'string', minLength: 1, description: 'Kiki Media provider id, for example kiki-media/minimax-speech, or its short id. Omit to use the Voice setting or the sole enabled Media speech provider.' },
      voice: { type: 'string', minLength: 1, description: 'An actual voice id from voice voices, or omit to use the Voice setting.' },
      model: { type: 'string', minLength: 1 },
      language: { type: 'string', minLength: 1 },
      format: { type: 'string', minLength: 1 },
      sample_rate_hz: { type: 'integer', minimum: 1 },
      options: { type: 'object', description: 'Provider-specific speech options.' },
      execution: { type: 'string', enum: ['auto', 'background'], default: 'auto' },
      delivery: { ...delivery, description: 'Optional explicit generate-and-send action. Sends a complete original file_id once through Host messages; pending jobs need voice send after completion.' },
    },
    required: ['request_id', 'text'],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
};

export const voice = {
  schemaVersion: 1,
  name: 'voice',
  description: 'Discover speech providers/voices or get, resume, cancel or explicitly send an existing Kiki Media speech job. send requires delivery with a stable message request_id and uses only complete original audio file_ids. resume continues the accepted handle/download; cancel preserves provider cancellation and billing state. Unknown delivery is not automatically retried.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['providers', 'voices', 'get', 'resume', 'cancel', 'send'] },
      delivery: { ...delivery, description: 'Required for send. Uses the existing job original file_id; no new generation is submitted.' },
      provider: { type: 'string', minLength: 1 },
      model: { type: 'string', minLength: 1 },
      language: { type: 'string', minLength: 1 },
      cursor: { type: 'string' },
      job_id: { type: 'string', minLength: 1 },
    },
    required: ['action'],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
};

export const tools = [speak, voice];
