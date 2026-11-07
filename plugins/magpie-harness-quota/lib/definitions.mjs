export const DEFAULT_MIN_REFRESH_INTERVAL_MS = 300_000;

export const ANTIGRAVITY_ENGINE_IDS = ['agy-cli', 'antigravity-acp'];
export const GROK_ENGINE_IDS = ['grok-acp'];
export const CODEX_ENGINE_IDS = ['codex-app-server', 'codex-acp'];
export const CLAUDE_ENGINE_IDS = ['claude-acp'];
export const GEMINI_ENGINE_IDS = ['gemini-acp'];
export const CURSOR_ENGINE_IDS = ['cursor-acp'];
export const QODER_ENGINE_IDS = ['qoder-acp'];
export const WORKBUDDY_ENGINE_IDS = ['codebuddy-acp'];

export const antigravityQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'antigravity',
  label: 'Magpie · Antigravity',
  engineIds: ANTIGRAVITY_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const grokQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'grok',
  label: 'Magpie · Grok Build',
  engineIds: GROK_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const codexQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'codex',
  label: 'Magpie · Codex',
  engineIds: CODEX_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const claudeQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'claude',
  label: 'Magpie · Claude Code',
  engineIds: CLAUDE_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const geminiQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'gemini',
  label: 'Magpie · Gemini CLI',
  engineIds: GEMINI_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const cursorQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'cursor',
  label: 'Magpie · Cursor',
  engineIds: CURSOR_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const qoderQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'qoder',
  label: 'Magpie · Qoder',
  engineIds: QODER_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const qoderCnQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'qoder-cn',
  label: 'Magpie · Qoder CN',
  engineIds: QODER_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const workbuddyQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'workbuddy',
  label: 'Magpie · WorkBuddy',
  engineIds: WORKBUDDY_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const workbuddyAiQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'workbuddy-ai',
  label: 'Magpie · WorkBuddy AI',
  engineIds: WORKBUDDY_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

/**
 * Maps each declared Kiki harness quota source id to the exact Magpie CLI
 * `magpie accounts <agent> --json` selector (`internal/cli/accounts_cli.go:35-58,240-254`).
 * Only real 1:1 external harness correspondences are registered; no catch-all engine bindings.
 */
export const MAGPIE_CLI_AGENT_BY_SOURCE_ID = Object.freeze({
  antigravity: 'antigravity',
  grok: 'grok',
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
  cursor: 'cursor',
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  workbuddy: 'workbuddy',
  'workbuddy-ai': 'workbuddy-ai',
});

/**
 * Sources where Magpie's unpooled `span.name` fallback (`retrieveUserQuotaSummary` unavailable)
 * represents exact per-model IDs rather than generic window names like "Credits" or "Limit".
 */
export const UNPOOLED_MODEL_ID_FALLBACK_SOURCES = new Set(['antigravity', 'gemini']);

export const antigravityAccountSourceDefinition = {
  schemaVersion: 1,
  id: 'antigravity',
  label: 'Magpie · Antigravity',
  engineIds: ['agy-cli'],
};

export const harnessAccountSourceDefinitions = [
  antigravityAccountSourceDefinition,
];

export const harnessQuotaSourceDefinitions = [
  antigravityQuotaSourceDefinition,
  grokQuotaSourceDefinition,
  codexQuotaSourceDefinition,
  claudeQuotaSourceDefinition,
  geminiQuotaSourceDefinition,
  cursorQuotaSourceDefinition,
  qoderQuotaSourceDefinition,
  qoderCnQuotaSourceDefinition,
  workbuddyQuotaSourceDefinition,
  workbuddyAiQuotaSourceDefinition,
];

export const MAGPIE_MANAGE_ACTIONS = [
  'capabilities',
  'accounts_list',
  'accounts_switch',
  'accounts_alias',
  'accounts_switch_only',
  'accounts_discovery',
  'accounts_refresh',
  'accounts_checkin',
  'grok_native_status',
  'grok_native_locator',
  'quota_summary',
  'quota_history',
  'quota_refresh',
  'usage_summary',
  'sessions_summary',
  'models_list',
  'model_manage',
  'sync_catalog',
  'groups_list',
  'group_manage',
  'service_status',
  'daemon_manage',
  'autostart_manage',
  'proxy_status',
  'settings_list',
  'settings_get',
  'settings_set',
  'settings_reset',
  'providers_list',
  'provider_pool',
  'plugins_list',
  'plugin_manage',
  'log_locator',
];

export const magpieManageToolDefinition = {
  schemaVersion: 1,
  name: 'magpie_manage',
  description: 'Structured, credential-safe Magpie management entry point. Inspects or updates Magpie accounts, global gateway account selection (explicitly distinguished from native CLI sign-in), native Grok single-token home/locator state, quota cards & 45-day history, token/session usage, model catalog & per-model settings (`magpie models` / `magpie model`), routing groups (`magpie groups` / `magpie group`), service/daemon/autostart controls (`magpie daemon` / `magpie autostart` / `magpie healthcheck`), redacted proxy bindings, public settings (`magpie settings`, credential-free proxy validation), provider pools, plugins (`magpie plugin`), and structured log file locators (`magpie log --path`). Never executes arbitrary shell commands, never starts proxy/daemon services unless explicitly invoked via `daemon_manage`, never returns raw log contents, and never returns tokens or API keys.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: MAGPIE_MANAGE_ACTIONS,
        description: 'Structured management operation to run. Use "capabilities" to inspect all operations, subcommands, and side-effect scopes.',
      },
      subcommand: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Structured sub-operation for `model_manage` (`name | names | efforts | api | apis | context | output | spec | specs | wire | wires | id | ids | alias | aliases | disable | enable | disabled | suffix | compact`), `group_manage` (`show | add | set | pick | copy | rm | restore | auto | template`), `plugin_manage` (`add | rm | update | on | off | options | use | move | builtin | preset | registry | dump`), `daemon_manage` (`status | install | uninstall | start | stop | restart | web`), or `autostart_manage` (`status | on | off`).',
      },
      agent: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Optional Magpie subscription/plugin/agent ID (for example "grok", "antigravity", "codex", "claude", "gemini", "cursor", "qoder", "workbuddy").',
      },
      provider: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Optional Magpie provider ID for quota/pool/model/plugin actions.',
      },
      account: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Account selector (12-char accountHash from accounts_list/grok_native_status, alias, or exact Magpie account label; "next" supported on accounts_switch for codex/claude).',
      },
      target: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Target identifier for quota_history, model_manage (`<provider/model>` or model ID), group_manage (`<group-id>` or group name), or plugin_manage (`<plugin-name>` or package spec).',
      },
      targets: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        description: 'Optional list of target IDs (for example multiple models in `model_manage` `disable`/`enable`/`api`, or multiple group/provider IDs in `group_manage` `rm`/`auto`).',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Display name or new group/model alias name for `model_manage` or `group_manage`.',
      },
      alias: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Display alias to set in accounts_alias or model_manage alias.',
      },
      clear: {
        type: 'boolean',
        description: 'When true in accounts_alias, clears the account’s custom alias.',
      },
      reset: {
        type: 'boolean',
        description: 'When true in model_manage or plugin_manage (`options` / `registry`), resets the target setting to its default (`--reset` / `off` / `default`).',
      },
      enabled: {
        type: 'boolean',
        description: 'Boolean toggle for accounts_switch_only, accounts_discovery, group_manage (`auto`), plugin_manage (`builtin`), daemon_manage (`web`), or autostart_manage.',
      },
      nativeGrokHome: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description: 'Optional absolute path override for the native Grok home directory (defaults to GROK_HOME or ~/.grok).',
      },
      period: {
        type: 'string',
        enum: ['today', '7d', '30d', 'all'],
        description: 'Calendar period preset for usage_summary or sessions_summary.',
      },
      days: {
        type: 'number',
        minimum: 0.1,
        maximum: 365,
        description: 'Rolling window in days for quota_history (1..45), usage_summary, or sessions_summary.',
      },
      last: {
        type: 'string',
        minLength: 2,
        maxLength: 32,
        description: 'Rolling duration for usage_summary (for example "24h" or "90m").',
      },
      model: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Model identifier (`<provider/model>` or bare model ID) for sessions_summary, model_manage, or group_manage `pick`.',
      },
      models: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        description: 'Ordered member model IDs or patterns for `group_manage` (`add` / `set`).',
      },
      modelsAdd: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        description: 'Member model IDs or patterns to append (`models+=`) in `group_manage` `set`.',
      },
      modelsRemove: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        description: 'Member model IDs or patterns to remove (`models-=`) in `group_manage` `set`.',
      },
      routing: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Routing strategy for `group_manage` (`smart | order | rotate | usage | pace | weight | free | fast | cheap | drain | expiring | manual`).',
      },
      stays: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'Session affinity (`stays`) for `group_manage` (`auto | session | turn | off | strict`).',
      },
      efforts: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
        },
        description: 'Reasoning effort levels (`none | minimal | low | medium | high | xhigh | max`) for `model_manage` (`efforts` / `spec`) or `group_manage` (`set` `levels=`).',
      },
      api: {
        type: 'string',
        enum: ['chat', 'responses', 'anthropic', 'gemini', 'auto'],
        description: 'Protocol API for `model_manage` (`subcommand="api"`).',
      },
      contextTokens: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'Context window size (for example `"200000"`, `"272k"`, `"1m"`, `"smallest"`) for `model_manage` or `group_manage`.',
      },
      outputTokens: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'Max output token limit (for example `"128k"` or `"64000"`) for `model_manage`.',
      },
      vision: {
        type: 'boolean',
        description: 'Optional vision capability toggle (`--vision on|off`) for `model_manage` (`subcommand="spec"`).',
      },
      family: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Optional family tag for `group_manage` (`set`).',
      },
      effortMode: {
        type: 'string',
        enum: ['auto', 'agent'],
        description: 'Optional group effort mode (`effort=auto|agent`) for `group_manage` (`set`).',
      },
      classifier: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Optional classifier model/group ref (`classifier=<provider/model>`) for `group_manage` (`set`).',
      },
      listed: {
        type: 'boolean',
        description: 'Optional `listed=yes|no` toggle for `group_manage` (`set`).',
      },
      weights: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Optional member weights (`<m1>=<n>[,<m2>=<n>]`) for `group_manage` (`set`).',
      },
      fastModels: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        description: 'Optional fast-mode members (`fast=<m1>[,<m2>]`) for `group_manage` (`set`).',
      },
      templateKind: {
        type: 'string',
        enum: ['smart', 'thrifty', 'steady'],
        description: 'Optional template kind for `group_manage` (`subcommand="template"`).',
      },
      options: {
        type: 'object',
        description: 'Non-secret JSON options object for `plugin_manage` (`subcommand="options"`).',
      },
      preset: {
        type: 'string',
        enum: ['essentials', 'all'],
        description: 'Built-in plugin preset for `plugin_manage` (`subcommand="preset"`).',
      },
      registryUrl: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Credential-free `http(s)://` npm registry URL (or `"default"`) for `plugin_manage` (`subcommand="registry"`).',
      },
      web: {
        type: 'boolean',
        description: 'Optional `--web` / `--no-web` flag for `daemon_manage` (`install` / `web`).',
      },
      lan: {
        type: 'boolean',
        description: 'Optional `--lan` flag for `daemon_manage` (`install` / `web`).',
      },
      addr: {
        type: 'string',
        minLength: 3,
        maxLength: 128,
        description: 'Optional `host:port` address for `daemon_manage` (`install` / `web`).',
      },
      folder: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        description: 'Optional workspace folder filter for sessions_summary.',
      },
      key: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Public setting key from Magpie’s `settingsapi.Keys` registry for settings_get, settings_set, or settings_reset.',
      },
      value: {
        type: ['string', 'number', 'boolean', 'array', 'object'],
        description: 'Setting value for settings_set, or value for `model_manage` (`suffix` / `compact`).',
      },
      cap: {
        type: ['number', 'string'],
        description: 'Optional per-account usage cap percentage (1..100 or "off") for provider_pool.',
      },
      stop: {
        type: 'boolean',
        description: 'Optional --stop toggle for provider_pool.',
      },
      careful: {
        type: 'boolean',
        description: 'Optional --careful toggle for provider_pool.',
      },
    },
    required: ['action'],
  },
  accesses: [{ kind: 'all' }],
  concurrencySafe: false,
  disclosure: 'deferred',
};

export const magpieToolDefinitions = [
  magpieManageToolDefinition,
];
