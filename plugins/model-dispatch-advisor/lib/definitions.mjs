export const PLUGIN_ID = 'model-dispatch-advisor';

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 256, description: 'Stable candidate identifier inside the functional group.' },
    label: { type: 'string', minLength: 1, maxLength: 256 },
    kind: { type: 'string', enum: ['native-model', 'external-harness', 'profile'], description: 'Candidate execution surface.' },
    profile: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional subagent profile name (e.g. implementer, implementer-grokbuild, writer, think).' },
    executorId: { type: 'string', minLength: 1, maxLength: 128, description: 'External harness engine ID when kind is external-harness (e.g. grok-acp, agy-cli, codex-app-server).' },
    modelId: { type: 'string', minLength: 1, maxLength: 256, description: 'Configured Kiki model ID from context.models.list() or native harness model ID.' },
    effort: { type: 'string', minLength: 1, maxLength: 64 },
    family: { type: 'string', minLength: 1, maxLength: 64, description: 'Model family tag such as gpt, grok, gemini, claude, kimi, deepseek.' },
    defaultRank: { type: 'integer', minimum: 0, maximum: 1000, description: 'Baseline priority within the functional group (lower is earlier).' },
    isRoleDefault: { type: 'boolean', description: 'True when this candidate represents the target role default when no explicit authorization overrides it.' },
    available: { type: 'boolean', description: 'Optional caller/configuration readiness fact for external-harness or profile candidates not verifiable from context.models.list().' },
    allowedModels: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', minLength: 1, maxLength: 256 },
      description: 'Optional hard model allowlist from the target profile; an empty array admits no models.',
    },
    deniedModels: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', minLength: 1, maxLength: 256 },
      description: 'Optional hard model denylist from the target profile or caller.',
    },
  },
  required: ['id'],
};

const constraintsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    allowedModels: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', minLength: 1, maxLength: 256 },
    },
    deniedModels: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', minLength: 1, maxLength: 256 },
    },
    allowedProfiles: {
      type: 'array',
      maxItems: 64,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    deniedProfiles: {
      type: 'array',
      maxItems: 64,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
};

export const dispatchAdvisorRecommendTool = {
  schemaVersion: 1,
  name: 'dispatch_advisor_recommend',
  description: 'Read connected models from context.models.list(), shared quota snapshots, and saved user selection preferences to rank same-function dispatch candidates. Returns soft recommendations with quota status, user preference provenance, and concise reasons without mutating profiles, global config, or active dispatches.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      group: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Functional group to evaluate (e.g. "implementation", "frontend", "review", "research", "writing", "thinking", "director", or a custom group). Defaults to "implementation" or the group mapped from role.',
      },
      role: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Optional target agent role/profile (e.g. "implementer", "writer", "think", "director"). Protected roles (writer, think, director) preserve their role default unless an explicit user-authorized preference authorizes that role or explicitTarget is set.',
      },
      roleDefaultModel: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Optional model ID or candidate ID known from the caller profile to be this role’s configured default. When omitted on a protected role without an isRoleDefault candidate, a profile-inherited default entry (profile:<role>) is preserved.',
      },
      explicitTarget: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Model ID, candidate ID, profile, or harness explicitly named by the user for this turn. Explicit user selection outranks soft preferences and quota sorting while respecting hard constraints.',
      },
      candidates: {
        type: 'array',
        maxItems: 64,
        items: candidateSchema,
        description: 'Optional explicit candidate list (such as external harnesses or role-specific profiles). When omitted and no custom group is stored, connected chat models from context.models.list() are evaluated directly.',
      },
      constraints: {
        ...constraintsSchema,
        description: 'Optional hard profile/caller admission constraints (allowedModels, deniedModels, allowedProfiles, deniedProfiles). Explicit empty allowlists admit nothing.',
      },
      includeAllGroups: {
        type: 'boolean',
        description: 'When true, also include a compact summary of saved preferences across all functional groups.',
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
  description: 'Save, inspect, or clear user-stated model/harness selection preferences and custom functional groups in this plugin’s own data store. Recording a preference requires explicit user authorization (userAuthorized=true and userQuote/sourceNote); model-inferred guesses are rejected.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'clear', 'get', 'define_group', 'remove_group'],
        description: 'set saves/replaces a functional group preference; clear removes one group or all preferences; get reads stored state; define_group/remove_group manages custom functional groups and candidates.',
      },
      group: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Functional group ID (e.g. "implementation"). Required for set, define_group, remove_group, and single-group clear.',
      },
      clearAll: {
        type: 'boolean',
        description: 'When action="clear" and clearAll=true, removes all stored preferences (and custom groups if includeCustomGroups=true).',
      },
      includeCustomGroups: {
        type: 'boolean',
        description: 'When action="clear" and clearAll=true, also clear custom group definitions.',
      },
      prefer: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'Candidate IDs, families (e.g. "grok", "gemini"), profiles, or model IDs to prioritize inside this group.',
      },
      avoid: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 256 },
        description: 'Candidate IDs, families (e.g. "gpt"), profiles, or model IDs to deprioritize softly (use less) inside this group.',
      },
      authorizedRoles: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 128 },
        description: 'Explicit roles (such as "writer", "think", "director") the user explicitly authorized changing. Omit for general implementation preferences.',
      },
      userAuthorized: {
        type: 'boolean',
        description: 'Must be true when saving a preference: confirms the preference comes from an explicit user instruction rather than agent self-inference.',
      },
      userQuote: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Concise verbatim user instruction or summary of what the user stated (e.g. "现在 GPT 少用一点").',
      },
      sourceNote: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Provenance anchor such as turn/session note or operator entry.',
      },
      groupLabel: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Display label when action="define_group".',
      },
      protectedRoleDefault: {
        type: 'boolean',
        description: 'When action="define_group", marks whether this group protects its role default unless explicitly authorized.',
      },
      candidates: {
        type: 'array',
        maxItems: 64,
        items: candidateSchema,
        description: 'Custom candidates for action="define_group".',
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
