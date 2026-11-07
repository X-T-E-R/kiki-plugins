export const PLUGIN_ID = 'model-dispatch-advisor';

export const dispatchAdvisorRecommendTool = {
  schemaVersion: 1,
  name: 'dispatch_advisor_recommend',
  description: 'Read cached harness quota snapshots via context.harnessQuota.cached() (remaining quota, source, readAt/resetAt, and unknown states) alongside the user’s latest saved selection preference for a functional scope. Presents facts to the AI without computing a winner, ranking candidates, polling Magpie, or mutating profiles and defaults.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      group: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Functional scope key to look up saved user selection preferences (for example "implementation"). Omit to inspect all saved functional scopes.',
      },
      includeAllGroups: {
        type: 'boolean',
        description: 'When true, include all saved functional scope preferences even when a specific group is requested.',
      },
      targets: {
        type: 'array',
        maxItems: 64,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'Optional exact identifiers (modelId, engineId, pool, window, or accountId) to filter cached quota readings.',
      },
      engineIds: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 128 },
        description: 'Optional exact harness engine IDs (for example "agy-cli" or "grok-acp") to filter cached quota sources and readings.',
      },
      accountIds: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'Optional exact quota account IDs to filter cached quota readings.',
      },
      modelCandidates: {
        type: 'array',
        maxItems: 128,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'Optional exact model IDs or remote IDs passed to context.models.list({ candidates }) when includeModels=true.',
      },
      includeModels: {
        type: 'boolean',
        description: 'When true, also include raw connected model entries from context.models.list({ candidates: modelCandidates }).',
      },
    },
  },
  accesses: [{ kind: 'all' }],
  concurrencySafe: true,
  disclosure: 'deferred',
};

export const dispatchPreferenceUpdateTool = {
  schemaVersion: 1,
  name: 'dispatch_preference_update',
  description: 'Save, read, or clear explicit user-stated selection preferences for a functional scope in this plugin’s own data store. Saving requires userAuthorized=true and userQuote/sourceNote; model-inferred guesses are rejected and profiles/defaults are never modified.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'clear', 'get'],
        description: 'set saves or replaces the preference for one functional group; clear removes one group or all saved preferences; get reads stored preferences.',
      },
      group: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Functional scope key (for example "implementation"). Required for set and single-group clear.',
      },
      clearAll: {
        type: 'boolean',
        description: 'When action="clear" and clearAll=true, clears all saved functional scope preferences.',
      },
      prefer: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'User-stated preferred targets or labels within this functional scope.',
      },
      avoid: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'User-stated targets or labels to use less within this functional scope.',
      },
      note: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Optional concise scope or condition note from the user instruction.',
      },
      userAuthorized: {
        type: 'boolean',
        description: 'Must be true when action="set": confirms the preference comes from an explicit user instruction rather than agent self-inference.',
      },
      userQuote: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Verbatim user instruction or concise summary of what the user stated (for example "现在 GPT 少用一点").',
      },
      sourceNote: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Optional provenance anchor such as session/turn reference.',
      },
    },
    required: ['action'],
  },
  accesses: [{ kind: 'all' }],
  concurrencySafe: false,
  disclosure: 'deferred',
};

export const definitions = [
  dispatchAdvisorRecommendTool,
  dispatchPreferenceUpdateTool,
];
