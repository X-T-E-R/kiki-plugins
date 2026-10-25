export const speak = {
  schemaVersion: 1,
  name: 'speak',
  description: 'Turn text into a playable speech artifact through Kiki Media. Reuse request_id for the same request; pending jobs continue through voice get/resume, never a new generation. Discover providers and voices first. Send the returned original file_id with SendMessage attachment kind voice for a voice message, or audio for ordinary audio.',
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
    },
    required: ['request_id', 'text'],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
};

export const voice = {
  schemaVersion: 1,
  name: 'voice',
  description: 'Discover Kiki Media speech providers or voices, or get/resume/cancel an existing speech job. get is read-only; resume only continues an accepted handle/download and never submits new speech. cancel preserves the provider-reported cancellation and billing status.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['providers', 'voices', 'get', 'resume', 'cancel'] },
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
