import fs from 'node:fs/promises';
import path from 'node:path';

import {
  redactProxyEndpoint,
  resolveMagpieConfigDir,
} from './antigravity-direct-quota.mjs';
import {
  hashIdentity,
  inspectGrokManagedAccounts,
  maskAccountIdentifier,
  resolveGrokNativeLocator,
} from './grok-native-locator.mjs';
import {
  defaultExecCommand,
  normalizeMagpieAgentId,
  resolveMagpieExecutable,
} from './magpie.mjs';

const DEFAULT_MANAGE_TIMEOUT_MS = 25_000;
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const AUTH_SCHEME_SECRET_RE = /\b(Authorization\s*:\s*(?:Bearer|Basic|Digest|Token)\s+)([^\s"',;]+)|\b((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{6,})/gi;
const KV_SECRET_RE = /(?<![A-Za-z0-9_])(["']?)(access_token|refresh_token|id_token|client_secret|api_key|apikey|private_key|password|passwd|x-api-key|proxy-authorization|secret)\1(\s*[=:]\s*)(["']?)([^\s"',;}&]+)/gi;
const SECRET_OPTION_KEY_RE = /(secret|token|password|passwd|apikey|api_key|private|credential|cookie|authorization)/i;
const KNOWN_TOKEN_PREFIX_RE = /\b(sk-[A-Za-z0-9_-]{6,}|ya29\.[A-Za-z0-9._-]+|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xai-[A-Za-z0-9_-]{6,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)\b/g;
const EMAIL_IN_TEXT_RE = /([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const WEB_LINK_QUERY_KEY_RE = /(\/\?k=)[^\s&"')]+/gi;

/**
 * Exact public settings registry derived from Magpie's `internal/settingsapi/settingsapi.go` (`Keys`)
 * and `internal/cli/settings_cli.go:77-99` (`settingRow`).
 *
 * Security invariants enforced uniformly across `settings_list`, `settings_get`, `settings_set`, and `settings_reset`:
 * 1) Only keys in this verified public registry are projected or accepted (unknown, internal, or secret-bearing
 *    fields such as `githubToken`, `lanKey`, `proxyCustom`, `redactWords`, `redactAllow` are never exposed).
 * 2) `proxy` is projected strictly through `redactProxyEndpoint` (stripping any userinfo) and `settings_set`
 *    accepts ONLY `""`, `"direct"`, or a credential-free `http(s)://` / `socks5(h)://` / `host:port` endpoint
 *    so proxy credentials never enter process `argv`.
 * 3) `otel` is read-only metadata (`{ enabled, endpoint, metrics, sessions, bodies, bodiesWhole, headerKeys }`,
 *    never returning `headers` values) and cannot be written via CLI `argv` because `OTel.Headers` can carry auth headers.
 */
export const MAGPIE_PUBLIC_SETTINGS_REGISTRY = Object.freeze({
  theme: { kind: 'string' },
  colorblind: { kind: 'bool' },
  reduceMotion: { kind: 'bool' },
  noBird: { kind: 'bool' },
  lang: { kind: 'string' },
  uiFont: { kind: 'json' },
  codeFont: { kind: 'json' },
  tray: { kind: 'string' },
  dock: { kind: 'bool' },
  dockWindow: { kind: 'bool' },
  dockNever: { kind: 'bool' },
  lightweight: { kind: 'bool' },
  keepAwake: { kind: 'bool' },
  keepAwakeDisplay: { kind: 'bool' },
  noWSLAgents: { kind: 'bool' },
  sessionTerminal: { kind: 'string' },
  signInLinkOnly: { kind: 'bool' },
  quitNoAsk: { kind: 'bool' },
  trayUsages: { kind: 'string_list' },
  trayUsage: { kind: 'string' },
  trayUsageEvery: { kind: 'number' },
  trayNoLogos: { kind: 'bool' },
  trayNoBird: { kind: 'bool' },
  trayNoNumber: { kind: 'bool' },
  trayPace: { kind: 'bool' },
  trayNoCost: { kind: 'bool' },
  trayWindows: { kind: 'json' },
  currency: { kind: 'string' },
  chineseUnits: { kind: 'bool' },
  usageAlert: { kind: 'number' },
  balanceAlert: { kind: 'number' },
  resetReminder: { kind: 'number' },
  turnDoneAlert: { kind: 'number' },
  maskAlert: { kind: 'bool' },
  proxy: { kind: 'credential_free_proxy' },
  redact: { kind: 'bool' },
  redactPersonal: { kind: 'bool' },
  redactKinds: { kind: 'bool_map' },
  redactWordsAnyCase: { kind: 'bool' },
  redactWordsWhole: { kind: 'bool' },
  redactShape: { kind: 'bool' },
  noStats: { kind: 'bool' },
  noUsageStats: { kind: 'bool' },
  otel: { kind: 'otel_readonly', writable: false },
  codexWarmup: { kind: 'string' },
  claudeWarmup: { kind: 'string' },
  codexWarmAt: { kind: 'string' },
  claudeWarmAt: { kind: 'string' },
  codexWarmAts: { kind: 'string_list' },
  claudeWarmAts: { kind: 'string_list' },
  workbuddyCheckin: { kind: 'bool' },
  traeCheckin: { kind: 'bool' },
  minimaxCheckin: { kind: 'bool' },
  qoderCheckin: { kind: 'bool' },
  replyModel: { kind: 'string' },
  noLoopGuard: { kind: 'bool' },
  claudeLeanPrompt: { kind: 'bool' },
  claudePrintMode: { kind: 'bool' },
  refusalRetries: { kind: 'number' },
  retryAfterCap: { kind: 'number' },
  vision: { kind: 'string' },
  visionEffort: { kind: 'string' },
  imageGen: { kind: 'string' },
  imageTimeout: { kind: 'number' },
  classifyTimeout: { kind: 'number' },
  searcher: { kind: 'string' },
  searcherThen: { kind: 'string_list' },
  searcherEffort: { kind: 'string' },
  searchFirst: { kind: 'string' },
  noUpdatePill: { kind: 'bool' },
  noAutoUpdate: { kind: 'bool' },
  updateEvery: { kind: 'number' },
  noAutoDownload: { kind: 'bool' },
  autoRestart: { kind: 'bool' },
  updateChannel: { kind: 'string' },
});

export const MAGPIE_MANAGE_CATALOG = Object.freeze([
  {
    action: 'capabilities',
    category: 'discovery',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List all supported structured Magpie management actions, subcommands, and side-effect boundaries.',
  },
  {
    action: 'accounts_list',
    category: 'accounts',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List subscription/plugin accounts and allowance windows via `magpie accounts [agent] --json` (identities redacted).',
  },
  {
    action: 'accounts_switch',
    category: 'accounts',
    mutates: true,
    sideEffectScope: 'magpie_account_selection',
    summary: 'Run `magpie accounts switch <agent> <account|next>`. Distinguishes Magpie gateway priority (`plugin:*`, `antigravity`, `gemini`, `copilot`) from native CLI sign-in (`codex`, `claude`).',
  },
  {
    action: 'accounts_alias',
    category: 'accounts',
    mutates: 'conditional',
    sideEffectScope: 'magpie_metadata',
    summary: 'Read, set, or clear a Magpie display alias on an account (`magpie accounts alias <agent> <account> [alias|--clear]`).',
  },
  {
    action: 'accounts_switch_only',
    category: 'accounts',
    mutates: 'conditional',
    sideEffectScope: 'magpie_routing_mode',
    summary: 'Inspect or toggle `magpie accounts switch-only <codex|claude> [on|off]`.',
  },
  {
    action: 'accounts_discovery',
    category: 'accounts',
    mutates: 'conditional',
    sideEffectScope: 'magpie_discovery_setting',
    summary: 'Inspect or toggle `magpie accounts discovery [on|off]`.',
  },
  {
    action: 'accounts_refresh',
    category: 'accounts',
    mutates: true,
    sideEffectScope: 'saved_account_tokens',
    summary: 'Renew saved ChatGPT and Claude sign-ins via `magpie accounts refresh --json`.',
  },
  {
    action: 'accounts_checkin',
    category: 'accounts',
    mutates: true,
    sideEffectScope: 'vendor_daily_checkin',
    summary: 'Run daily check-in for supported subscriptions/plugins via `magpie accounts checkin --json`.',
  },
  {
    action: 'grok_native_status',
    category: 'grok_native',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Compare Magpie Grok gateway selection against native `~/.grok` (`auth.json`, `sessions`, `auth.json.bak` recovery ref) without reading/returning tokens.',
  },
  {
    action: 'grok_native_locator',
    category: 'grok_native',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Return verified single-rotating-token native Grok binding locator (`cli_native_default_home` when in `~/.grok`, or `GROK_AUTH_PATH` / `config_directory` when in a Magpie plugin private home).',
  },
  {
    action: 'quota_summary',
    category: 'quota',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Read subscription/plan/key allowance cards via `magpie quota [<provider>] --json` (redacted).',
  },
  {
    action: 'quota_history',
    category: 'quota',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Read historical window allowance series (up to 45 days) via `magpie quota history [<target>] [--days N] --json`.',
  },
  {
    action: 'quota_refresh',
    category: 'quota',
    mutates: true,
    sideEffectScope: 'magpie_quota_cache',
    summary: 'Force-refresh one provider or account card via `magpie quota refresh <provider> [<account>] --json` (30s Magpie floor).',
  },
  {
    action: 'usage_summary',
    category: 'usage',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Read token/cost summary over `today | 7d | 30d | all` or `--days` / `--last` via `magpie usage`.',
  },
  {
    action: 'sessions_summary',
    category: 'usage',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Read session spend summary via `magpie sessions [--days N|today|all] [--model M] [--folder F] --json`.',
  },
  {
    action: 'models_list',
    category: 'models_and_groups',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List available Magpie models (`magpie models [<agent>]`) grouped by provider/routing section.',
  },
  {
    action: 'model_manage',
    category: 'models_and_groups',
    mutates: 'conditional',
    sideEffectScope: 'magpie_model_settings',
    subcommands: [
      'name', 'names', 'efforts', 'api', 'apis', 'context', 'output',
      'spec', 'specs', 'wire', 'wires', 'id', 'ids', 'alias', 'aliases',
      'disable', 'enable', 'disabled', 'suffix', 'compact',
    ],
    summary: 'Inspect or configure Magpie model settings (`magpie model <subcommand> ...`: display names, reasoning efforts, protocol API, context/output limits, specs, upstream wire names, custom IDs, usage aliases, disable/enable globs, suffix, and compaction).',
  },
  {
    action: 'sync_catalog',
    category: 'models_and_groups',
    mutates: true,
    sideEffectScope: 'magpie_model_catalog',
    summary: 'Refresh Magpie’s model catalog and vendor model lists via `magpie sync`.',
  },
  {
    action: 'groups_list',
    category: 'models_and_groups',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List Magpie routing groups and auto-discovered multi-provider groups via `magpie groups`.',
  },
  {
    action: 'group_manage',
    category: 'models_and_groups',
    mutates: 'conditional',
    sideEffectScope: 'magpie_routing_groups',
    subcommands: ['show', 'add', 'set', 'pick', 'copy', 'rm', 'restore', 'auto', 'template'],
    summary: 'Inspect, create, update, pin (`pick`), duplicate, remove, restore, or toggle auto-discovery on Magpie routing groups (`magpie group ...`).',
  },
  {
    action: 'service_status',
    category: 'service_and_proxy',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Inspect Magpie binary version, gateway healthcheck (`magpie healthcheck`), autostart/daemon state, log file locator, and redacted proxy summary without starting any service.',
  },
  {
    action: 'daemon_manage',
    category: 'service_and_proxy',
    mutates: 'conditional',
    sideEffectScope: 'magpie_daemon_service',
    subcommands: ['status', 'install', 'uninstall', 'start', 'stop', 'restart', 'web'],
    summary: 'Inspect or explicitly manage Magpie’s background gateway service (`magpie daemon status|install|uninstall|start|stop|restart|web`) when requested by the user.',
  },
  {
    action: 'autostart_manage',
    category: 'service_and_proxy',
    mutates: 'conditional',
    sideEffectScope: 'magpie_login_autostart',
    subcommands: ['status', 'on', 'off'],
    summary: 'Inspect or explicitly toggle Magpie login tray autostart (`magpie autostart [on|off]`).',
  },
  {
    action: 'proxy_status',
    category: 'service_and_proxy',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Read global proxy setting and per-provider / per-account proxy bindings (credentials stripped).',
  },
  {
    action: 'settings_list',
    category: 'settings',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List verified public Magpie settings (`settingsapi.Keys`) via `magpie settings list --json` with credential-free projection.',
  },
  {
    action: 'settings_get',
    category: 'settings',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Read a single verified public Magpie setting via `magpie settings get <key> --json`.',
  },
  {
    action: 'settings_set',
    category: 'settings',
    mutates: true,
    sideEffectScope: 'magpie_settings',
    summary: 'Update a verified writable public Magpie setting via `magpie settings set <key> <value>` (`proxy` accepts credential-free URLs/`direct`/empty only; never passes credentials in argv).',
  },
  {
    action: 'settings_reset',
    category: 'settings',
    mutates: true,
    sideEffectScope: 'magpie_settings',
    summary: 'Reset a verified writable public Magpie setting to its default via `magpie settings reset <key>`.',
  },
  {
    action: 'providers_list',
    category: 'providers_and_plugins',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List configured Magpie providers (redacted, never returning API keys) plus `magpie providers` status.',
  },
  {
    action: 'provider_pool',
    category: 'providers_and_plugins',
    mutates: 'conditional',
    sideEffectScope: 'magpie_provider_pool',
    summary: 'Inspect or configure a subscription account pool (`magpie provider pool <id> [--cap N|off] [--stop on|off] [--careful on|off]`).',
  },
  {
    action: 'plugins_list',
    category: 'providers_and_plugins',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'List installed Magpie community/provider plugins via `magpie plugin list --json` with account keys/tokens and emails stripped.',
  },
  {
    action: 'plugin_manage',
    category: 'providers_and_plugins',
    mutates: 'conditional',
    sideEffectScope: 'magpie_plugins',
    subcommands: ['add', 'rm', 'update', 'on', 'off', 'options', 'use', 'move', 'builtin', 'preset', 'registry', 'dump'],
    summary: 'Install, remove, update, enable/disable, configure non-secret options, migrate subscriptions, or inspect/toggle built-in Magpie plugins (`magpie plugin ...`).',
  },
  {
    action: 'log_locator',
    category: 'diagnostics',
    mutates: false,
    sideEffectScope: 'none',
    summary: 'Locate Magpie app/rotated/service log file paths and structured file metadata (`exists`, `sizeBytes`, `modifiedAt`) without returning raw log contents.',
  },
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function manageError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_ESCAPE_RE, '') : '';
}

export function sanitizeDiagnosticText(raw) {
  if (typeof raw !== 'string') return '';
  return stripAnsi(raw)
    .replace(URL_USERINFO_RE, '$1')
    .replace(WEB_LINK_QUERY_KEY_RE, '$1[redacted]')
    .replace(AUTH_SCHEME_SECRET_RE, (_m, p1, _s1, p2) => `${p1 ?? p2}[redacted-token]`)
    .replace(KV_SECRET_RE, (_match, openQuote, key, separator, valueQuote) => `${openQuote}${key}${openQuote}${separator}${valueQuote}[redacted-secret]`)
    .replace(KNOWN_TOKEN_PREFIX_RE, '[redacted-token]')
    .replace(EMAIL_IN_TEXT_RE, '$1***@$2')
    .trim();
}

function cleanToken(value, label, { required = false, maxLength = 256, allowSpaces = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw manageError('MAGPIE_INVALID_INPUT', `Missing required parameter "${label}".`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": expected a single-line string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw manageError('MAGPIE_INVALID_INPUT', `Missing required parameter "${label}".`);
    return undefined;
  }
  if (!allowSpaces && /\s/.test(trimmed)) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": whitespace is not allowed.`);
  }
  if (trimmed.startsWith('-')) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": option-like leading "-" is not permitted.`);
  }
  return trimmed;
}

function cleanTokenList(list, label, { maxItems = 64, maxLength = 256, allowSpaces = false } = {}) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list) || list.length === 0 || list.length > maxItems) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": expected a non-empty array of up to ${maxItems} strings.`);
  }
  return list.map((item, idx) => cleanToken(item, `${label}[${idx}]`, { required: true, maxLength, allowSpaces }));
}

function cleanAccountSelector(value, label = 'account', { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw manageError('MAGPIE_INVALID_INPUT', `Missing required parameter "${label}".`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": expected a single-line account identifier.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw manageError('MAGPIE_INVALID_INPUT', `Missing required parameter "${label}".`);
    return undefined;
  }
  if (trimmed.startsWith('-')) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": option-like leading "-" is not permitted.`);
  }
  return trimmed;
}

function cleanPositiveNumber(value, label, { min = 1, max = 365, integer = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": expected a number between ${min} and ${max}.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid "${label}": expected an integer.`);
  }
  return value;
}

/**
 * Validates a credential-free proxy or HTTP(S) URL so credentials NEVER enter CLI `argv`.
 */
export function validateCredentialFreeProxyInput(raw) {
  if (typeof raw !== 'string' || /[\0\r\n]/.test(raw) || raw.length > 1024) {
    throw manageError('MAGPIE_INVALID_INPUT', 'Proxy value must be a single-line string.');
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'direct') {
    return trimmed === '' ? '' : 'direct';
  }
  if (trimmed.startsWith('-')) {
    throw manageError('MAGPIE_INVALID_INPUT', 'Invalid proxy value.');
  }
  if (trimmed.includes('@')) {
    throw manageError(
      'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV',
      'Proxy URLs containing username/password credentials cannot be passed via CLI argv. Use a credential-free local proxy endpoint or configure authenticated proxies directly in Magpie’s Settings UI.',
    );
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw manageError('MAGPIE_INVALID_INPUT', 'Invalid proxy endpoint: expected http(s)://host:port, socks5(h)://host:port, host:port, "direct", or "".');
  }
  const allowedProtocols = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
  if (!allowedProtocols.has(parsed.protocol) || !parsed.hostname) {
    throw manageError('MAGPIE_INVALID_INPUT', `Unsupported proxy protocol "${parsed.protocol}"; expected http, https, socks5, or socks5h.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw manageError(
      'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV',
      'Proxy URL must not contain credentials, query parameters, or fragments.',
    );
  }
  return trimmed;
}

function validateCredentialFreeHttpUrl(raw, label) {
  const trimmed = cleanToken(raw, label, { required: true, maxLength: 512 });
  if (trimmed === 'default') return 'default';
  if (trimmed.includes('@')) {
    throw manageError('MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV', `${label} must not embed credentials in URL.`);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid ${label}: expected an http:// or https:// URL, or "default".`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
    throw manageError('MAGPIE_INVALID_INPUT', `Invalid ${label}: expected a credential-free http:// or https:// URL.`);
  }
  return trimmed;
}

function redactHttpEndpointPreservingPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '' : parsed.pathname.slice(-1));
  } catch {
    return redactProxyEndpoint(raw.trim());
  }
}

function projectSafeOtelValue(value) {
  if (!isRecord(value)) return {};
  const headerKeys = isRecord(value.headers) ? Object.keys(value.headers).sort() : [];
  let safeEndpoint = null;
  if (typeof value.endpoint === 'string' && value.endpoint.trim()) {
    safeEndpoint = redactHttpEndpointPreservingPath(value.endpoint.trim());
  }
  return {
    enabled: Boolean(value.enabled),
    endpoint: safeEndpoint,
    metrics: Boolean(value.metrics),
    sessions: Boolean(value.sessions),
    bodies: Boolean(value.bodies),
    bodiesWhole: Boolean(value.bodiesWhole),
    headerCount: headerKeys.length,
    headerKeys,
  };
}

/**
 * Projects a single setting value through `MAGPIE_PUBLIC_SETTINGS_REGISTRY`.
 * Returns `{ allowed: false }` for any key outside the verified public registry.
 */
export function projectPublicSettingValue(key, value) {
  if (!Object.hasOwn(MAGPIE_PUBLIC_SETTINGS_REGISTRY, key)) {
    return { allowed: false, value: undefined };
  }
  const spec = MAGPIE_PUBLIC_SETTINGS_REGISTRY[key];
  if (spec.kind === 'credential_free_proxy') {
    const safeProxy = typeof value === 'string' && value.trim()
      ? (value.trim().toLowerCase() === 'direct' ? 'direct' : (redactProxyEndpoint(value.trim()) ?? ''))
      : '';
    return { allowed: true, value: safeProxy };
  }
  if (spec.kind === 'otel_readonly') {
    return { allowed: true, value: projectSafeOtelValue(value) };
  }
  if (typeof value === 'string') {
    return { allowed: true, value: sanitizeDiagnosticText(value) };
  }
  if (Array.isArray(value)) {
    return {
      allowed: true,
      value: value.map((item) => (typeof item === 'string' ? sanitizeDiagnosticText(item) : item)),
    };
  }
  return { allowed: true, value };
}

function projectPublicSettingRow(row) {
  if (!isRecord(row) || typeof row.key !== 'string') return null;
  const projectedVal = projectPublicSettingValue(row.key, row.value);
  if (!projectedVal.allowed) return null;
  const projectedDef = projectPublicSettingValue(row.key, row.default);
  const spec = MAGPIE_PUBLIC_SETTINGS_REGISTRY[row.key];
  return {
    key: row.key,
    type: typeof row.type === 'string' ? row.type : spec.kind,
    writable: spec.writable !== false,
    value: projectedVal.value,
    default: projectedDef.value,
    ...(Array.isArray(row.choices) && row.choices.length > 0 ? { choices: row.choices } : {}),
  };
}

function ensurePublicSettingKey(key, { requireWritable = false } = {}) {
  if (!Object.hasOwn(MAGPIE_PUBLIC_SETTINGS_REGISTRY, key)) {
    throw manageError(
      'MAGPIE_FORBIDDEN_KEY',
      `Setting key "${key}" is outside Magpie’s verified public settings registry. Call action="settings_list" to inspect supported keys.`,
    );
  }
  const spec = MAGPIE_PUBLIC_SETTINGS_REGISTRY[key];
  if (requireWritable && spec.writable === false) {
    throw manageError(
      'MAGPIE_FORBIDDEN_KEY',
      `Setting key "${key}" is read-only in magpie_manage because its payload can carry authentication headers.`,
    );
  }
  return spec;
}

function redactAccountRow(row) {
  if (!isRecord(row)) return row;
  const rawUser = typeof row.user === 'string' ? row.user : null;
  return {
    agent: typeof row.agent === 'string' ? row.agent : null,
    normalizedAgent: typeof row.agent === 'string' ? normalizeMagpieAgentId(row.agent) : null,
    accountHash: rawUser ? hashIdentity(rawUser.split(' · ')[0].replace(/\s+\([^)]+\)$/, '').trim()) : null,
    labelHash: rawUser ? hashIdentity(rawUser) : null,
    maskedAccount: rawUser ? maskAccountIdentifier(rawUser) : null,
    alias: typeof row.alias === 'string' && row.alias.trim() ? row.alias.trim() : null,
    plan: typeof row.plan === 'string' && row.plan.trim() ? row.plan.trim() : null,
    active: row.active === true,
    enabled: row.on !== false && row.paused !== true,
    on: row.on !== false,
    ...(row.paused === true ? { paused: true } : {}),
    ...(typeof row.balance === 'string' && row.balance.trim() ? { balance: row.balance.trim() } : {}),
    ...(typeof row.readAt === 'string' && row.readAt.trim() ? { readAt: row.readAt.trim() } : {}),
    ...(typeof row.asOf === 'string' && row.asOf.trim() ? { asOf: row.asOf.trim() } : {}),
    ...(typeof row.lapsed === 'string' && row.lapsed.trim() ? { lapsed: sanitizeDiagnosticText(row.lapsed) } : {}),
    ...(typeof row.error === 'string' && row.error.trim() ? { error: sanitizeDiagnosticText(row.error) } : {}),
    windows: Array.isArray(row.windows) ? row.windows : [],
  };
}

function redactQuotaCard(card) {
  if (!isRecord(card)) return card;
  const rawUser = typeof card.user === 'string' ? card.user : null;
  const copy = { ...card };
  delete copy.key;
  delete copy.token;
  delete copy.secret;
  if (rawUser) {
    copy.accountHash = hashIdentity(rawUser.split(' · ')[0].replace(/\s+\([^)]+\)$/, '').trim());
    copy.maskedAccount = maskAccountIdentifier(rawUser);
    delete copy.user;
  }
  if (typeof copy.error === 'string') {
    copy.error = sanitizeDiagnosticText(copy.error);
  }
  return copy;
}

function redactHistoryEntry(entry) {
  if (!isRecord(entry)) return entry;
  const copy = { ...entry };
  if (typeof copy.user === 'string' && copy.user.trim()) {
    copy.accountHash = hashIdentity(copy.user.split(' · ')[0].replace(/\s+\([^)]+\)$/, '').trim());
    copy.maskedAccount = maskAccountIdentifier(copy.user);
    delete copy.user;
  }
  return copy;
}

function redactPluginsPayload(raw) {
  if (Array.isArray(raw)) {
    return {
      plugins: [],
      loaded: [],
      providers: [],
      middleware: {},
    };
  }
  if (!isRecord(raw)) return { plugins: [], loaded: [], providers: [], middleware: {} };
  const plugins = (Array.isArray(raw.plugins) ? raw.plugins : []).filter(isRecord).map((p) => ({
    spec: typeof p.spec === 'string' ? p.spec : null,
    off: p.off === true,
    optionKeys: isRecord(p.options) ? Object.keys(p.options).sort() : [],
  }));
  const loaded = (Array.isArray(raw.loaded) ? raw.loaded : []).filter(isRecord).map((l) => ({
    spec: typeof l.spec === 'string' ? l.spec : null,
    provides: Array.isArray(l.provides) ? l.provides : [],
    ...(typeof l.error === 'string' && l.error.trim() ? { error: sanitizeDiagnosticText(l.error) } : {}),
  }));
  const providers = (Array.isArray(raw.providers) ? raw.providers : []).filter(isRecord).map((prov) => {
    const rawAccountId = typeof prov.accountId === 'string' && prov.accountId.trim() ? prov.accountId.trim() : null;
    const rawAccounts = Array.isArray(prov.accounts) ? prov.accounts.filter(isRecord) : [];
    return {
      id: typeof prov.id === 'string' ? prov.id : null,
      spec: typeof prov.spec === 'string' ? prov.spec : null,
      name: typeof prov.name === 'string' ? prov.name : null,
      npm: typeof prov.npm === 'string' ? prov.npm : null,
      api: typeof prov.api === 'string' ? prov.api : null,
      signedIn: Boolean(prov.signedIn),
      authType: typeof prov.authType === 'string' ? prov.authType : null,
      accountHash: rawAccountId ? hashIdentity(rawAccountId) : null,
      maskedAccount: rawAccountId ? maskAccountIdentifier(rawAccountId) : null,
      accountCount: rawAccounts.length,
      accounts: rawAccounts.map((acct) => {
        const acctId = typeof acct.accountId === 'string' && acct.accountId.trim() ? acct.accountId.trim() : null;
        return {
          type: typeof acct.type === 'string' ? acct.type : null,
          accountHash: acctId ? hashIdentity(acctId) : null,
          maskedAccount: acctId ? maskAccountIdentifier(acctId) : null,
          modelCount: Array.isArray(acct.models) ? acct.models.length : 0,
        };
      }),
      modelCount: Array.isArray(prov.models) ? prov.models.length : 0,
      options: Array.isArray(prov.options) ? prov.options : [],
    };
  });
  const middleware = {};
  if (isRecord(raw.middleware)) {
    for (const [k, v] of Object.entries(raw.middleware)) {
      if (!isRecord(v)) continue;
      middleware[k] = {
        ...(typeof v.error === 'string' && v.error.trim() ? { error: sanitizeDiagnosticText(v.error) } : {}),
        ...(Array.isArray(v.points) ? { points: v.points } : {}),
      };
    }
  }
  return { plugins, loaded, providers, middleware };
}

/**
 * Drops credential-like keys and URL userinfo at a plugin options/config boundary.
 * Public booleans, numbers, and non-secret strings remain.
 */
export function projectNonSecretOptions(value, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => projectNonSecretOptions(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const projected = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_OPTION_KEY_RE.test(key)) continue;
      const next = projectNonSecretOptions(child, depth + 1);
      if (next !== undefined) projected[key] = next;
    }
    return projected;
  }
  if (typeof value === 'string') {
    if (value.includes('://') && value.includes('@')) return undefined;
    return sanitizeDiagnosticText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function emptyPluginDump() {
  return {
    file: null,
    there: false,
    preset: null,
    api: null,
    plugins: [],
  };
}

/**
 * Projects `magpie plugin dump --json` (`builtin_cli.go` dumpPlugins) down to the
 * public file/preset/api shell and each plugin's id, enablement, source, state, and
 * non-secret config. Unknown keys, including raw token maps, are not copied.
 */
export function projectPluginDump(parsed) {
  if (!isRecord(parsed)) return emptyPluginDump();
  const plugins = (Array.isArray(parsed.plugins) ? parsed.plugins : []).filter(isRecord).map((plug) => {
    const config = isRecord(plug.config) ? projectNonSecretOptions(plug.config) : {};
    const sourcesIn = isRecord(plug.configSources) ? plug.configSources : {};
    const configSources = {};
    if (isRecord(config)) {
      for (const key of Object.keys(config)) {
        if (typeof sourcesIn[key] === 'string') configSources[key] = sourcesIn[key];
      }
    }
    return {
      id: typeof plug.id === 'string' ? plug.id : null,
      enabled: plug.enabled === true,
      source: typeof plug.source === 'string' ? plug.source : null,
      chosen: plug.chosen === true,
      ...(Number.isInteger(plug.inUse) && plug.inUse > 0 ? { inUse: plug.inUse } : {}),
      ...(typeof plug.state === 'string' ? { state: plug.state } : {}),
      ...(typeof plug.why === 'string' && plug.why.trim() ? { why: sanitizeDiagnosticText(plug.why) } : {}),
      ...(isRecord(config) && Object.keys(config).length > 0 ? { config } : {}),
      ...(Object.keys(configSources).length > 0 ? { configSources } : {}),
    };
  });
  return {
    file: typeof parsed.file === 'string' ? parsed.file : null,
    there: parsed.there === true,
    preset: typeof parsed.preset === 'string' ? parsed.preset : null,
    api: typeof parsed.api === 'string' ? parsed.api : null,
    plugins,
  };
}

function projectPluginOptionsStdout(stdout) {
  const text = stripAnsi(typeof stdout === 'string' ? stdout : '').trim();
  if (!text) return { output: '' };
  const jsonStart = text.search(/^[\t ]*(?:\{|\[)/m);
  if (jsonStart >= 0) {
    const prelude = sanitizeDiagnosticText(text.slice(0, jsonStart));
    try {
      const options = projectNonSecretOptions(JSON.parse(text.slice(jsonStart)));
      return {
        output: [prelude, JSON.stringify(options)].filter(Boolean).join('\n'),
        options,
      };
    } catch {
      return {
        output: prelude,
        options: null,
        parseError: 'plugin options JSON could not be parsed',
      };
    }
  }
  return { output: sanitizeDiagnosticText(text) };
}

function projectPluginDumpStdout(stdout) {
  const text = stripAnsi(typeof stdout === 'string' ? stdout : '').trim();
  if (!text) return { dump: emptyPluginDump() };
  try {
    return { dump: projectPluginDump(JSON.parse(text)) };
  } catch {
    return {
      dump: null,
      parseError: 'plugin dump JSON could not be parsed',
    };
  }
}

function validateNonSecretOptionsObject(obj) {
  if (!isRecord(obj)) {
    throw manageError('MAGPIE_INVALID_INPUT', 'Parameter "options" must be a JSON object.');
  }
  const checkValue = (value, label, depth = 0) => {
    if (typeof value === 'string' && value.includes('://') && value.includes('@')) {
      throw manageError(
        'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV',
        `Option "${label}" contains URL userinfo credentials and cannot be passed via CLI argv.`,
      );
    }
    if (!Array.isArray(value) && !isRecord(value)) return;
    if (depth > 4) {
      throw manageError('MAGPIE_INVALID_INPUT', 'Plugin options object exceeds maximum nesting depth.');
    }
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_OPTION_KEY_RE.test(key)) {
        throw manageError(
          'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV',
          `Option key "${key}" looks like a credential and cannot be passed via CLI argv.`,
        );
      }
      checkValue(child, Array.isArray(value) ? `${label}[${key}]` : key, depth + 1);
    }
  };
  checkValue(obj, 'options');
  return obj;
}

/**
 * Classifies the real side-effect scope of `magpie accounts switch <agent> <target>`
 * per `internal/cli/accounts_cli.go:215-238` and `internal/provider/side_logins.go:237-255`.
 */
export function classifyMagpieSwitchScope(agentId) {
  const normalized = normalizeMagpieAgentId(agentId);
  if (normalized === 'codex' || normalized === 'claude') {
    return {
      scope: 'native_cli_and_magpie',
      nativeHarnessActivated: true,
      magpieGatewayUpdated: true,
      note: `Magpie switched ${normalized}'s native sign-in on disk; already-running ${normalized} processes keep their previous session token until restarted.`,
    };
  }
  return {
    scope: 'magpie_gateway_only',
    nativeHarnessActivated: false,
    magpieGatewayUpdated: true,
    note: `Magpie updated its own gateway priority (logins.json first=true) for "${normalized}" via switchSideLogin; the external harness CLI's native sign-in was NOT modified.`,
  };
}

async function readJsonFileOrDefault(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function inspectFileLocator(filePath, role) {
  if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath.trim())) return null;
  const resolved = path.resolve(filePath.trim());
  try {
    const st = await fs.stat(resolved);
    if (!st.isFile()) return { role, path: resolved, exists: false, sizeBytes: null, modifiedAt: null };
    return {
      role,
      path: resolved,
      exists: true,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { role, path: resolved, exists: false, sizeBytes: null, modifiedAt: null };
    }
    return { role, path: resolved, exists: false, sizeBytes: null, modifiedAt: null };
  }
}

async function inspectStructuredLogLocator(service, context) {
  const [pathRes, summaryRes] = await Promise.all([
    service.runCli(['log', '--path'], context, { allowNonZero: true }),
    service.runCli(['log'], context, { allowNonZero: true }),
  ]);

  const primaryPath = pathRes.exitCode === 0 && pathRes.stdout.trim()
    ? pathRes.stdout.trim().split(/\r?\n/)[0].trim()
    : null;

  const discoveredPaths = new Set();
  if (primaryPath && path.isAbsolute(primaryPath)) {
    discoveredPaths.add(path.resolve(primaryPath));
  }

  if (summaryRes.exitCode === 0 && summaryRes.stdout.trim()) {
    for (const rawLine of stripAnsi(summaryRes.stdout).split(/\r?\n/)) {
      if (!rawLine || /^\s/.test(rawLine)) continue;
      const trimmed = rawLine.trim();
      if (path.isAbsolute(trimmed)) {
        discoveredPaths.add(path.resolve(trimmed));
      }
    }
  }

  const files = [];
  for (const p of discoveredPaths) {
    const role = primaryPath && path.resolve(primaryPath) === p
      ? 'app_log'
      : (path.basename(p).includes('old') || p.endsWith('.1') || p.endsWith('.old.log') ? 'rotated_app_log' : 'service_or_background_log');
    const info = await inspectFileLocator(p, role);
    if (info) files.push(info);
  }

  // Also check rotated sibling (`app.old.log`) if primaryPath exists
  if (primaryPath && path.isAbsolute(primaryPath)) {
    const rotatedCandidate = path.join(path.dirname(path.resolve(primaryPath)), 'app.old.log');
    if (!discoveredPaths.has(rotatedCandidate)) {
      const rotatedInfo = await inspectFileLocator(rotatedCandidate, 'rotated_app_log');
      if (rotatedInfo?.exists) files.push(rotatedInfo);
    }
  }

  return {
    appLogPath: primaryPath && path.isAbsolute(primaryPath) ? path.resolve(primaryPath) : null,
    files,
  };
}

async function inspectRedactedProxySummary({ magpieConfigDir, magpiePath, env, homedir }) {
  const configDir = await resolveMagpieConfigDir({ configDir: magpieConfigDir, magpiePath, env, homedir });
  const [settingsRaw, providersRaw] = await Promise.all([
    readJsonFileOrDefault(path.join(configDir, 'settings.json'), {}),
    readJsonFileOrDefault(path.join(configDir, 'providers.json'), {}),
  ]);

  const globalProxy = isRecord(settingsRaw) && typeof settingsRaw.proxy === 'string' && settingsRaw.proxy.trim()
    ? (settingsRaw.proxy.trim().toLowerCase() === 'direct' ? 'direct' : redactProxyEndpoint(settingsRaw.proxy))
    : null;

  const providers = [];
  const list = isRecord(providersRaw) && Array.isArray(providersRaw.providers) ? providersRaw.providers : [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const providerProxy = typeof item.proxy === 'string' && item.proxy.trim()
      ? redactProxyEndpoint(item.proxy)
      : null;
    const accountProxies = [];
    if (isRecord(item.accountProxies)) {
      for (const [acctKey, rawProxy] of Object.entries(item.accountProxies)) {
        if (typeof rawProxy !== 'string' || !rawProxy.trim()) continue;
        accountProxies.push({
          accountHash: hashIdentity(acctKey),
          maskedAccount: maskAccountIdentifier(acctKey),
          proxy: redactProxyEndpoint(rawProxy),
        });
      }
    }
    if (providerProxy || accountProxies.length > 0 || item.off === true) {
      providers.push({
        id: item.id,
        off: item.off === true,
        proxy: providerProxy,
        accountProxyCount: accountProxies.length,
        accountProxies,
      });
    }
  }

  return {
    magpieConfigDir: configDir,
    globalProxy,
    providers,
  };
}

function parseModelsCatalogOutput(stdout) {
  const sections = [];
  let currentSection = null;
  let gatewayEndpoint = null;
  const notes = [];

  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed)) {
      gatewayEndpoint = redactHttpEndpointPreservingPath(trimmed);
      continue;
    }
    if (/^[^\s/]+\/[^\s]+/.test(trimmed)) {
      const match = trimmed.match(/^([^\s]+)(?:\s{2,}(.+))?$/);
      const id = match ? match[1] : trimmed;
      const rest = match?.[2]?.trim() ?? '';
      let label = null;
      let efforts = null;
      if (rest) {
        const parts = rest.split(/\s{2,}/);
        if (parts.length >= 2) {
          label = parts[0];
          efforts = parts.slice(1).join(' ');
        } else if (/^(none|minimal|low|medium|high|xhigh|max|ultra)(\/|$)/i.test(parts[0])) {
          efforts = parts[0];
        } else {
          label = parts[0];
        }
      }
      if (!currentSection) {
        currentSection = { section: 'Models', models: [] };
        sections.push(currentSection);
      }
      currentSection.models.push({ id, label, efforts });
      continue;
    }
    if (trimmed.includes(': ') || trimmed.startsWith('magpie ')) {
      notes.push(sanitizeDiagnosticText(trimmed));
      continue;
    }
    currentSection = { section: sanitizeDiagnosticText(trimmed), models: [] };
    sections.push(currentSection);
  }

  const totalModels = sections.reduce((sum, s) => sum + s.models.length, 0);
  return { totalModels, gatewayEndpoint, sections, notes };
}

export class MagpieManagementService {
  constructor({
    execCommand = defaultExecCommand,
    env = process.env,
    homedir,
  } = {}) {
    this.execCommand = execCommand;
    this.env = env;
    this.homedir = homedir;
  }

  async runCli(args, context = {}, { allowNonZero = false, timeoutMs = DEFAULT_MANAGE_TIMEOUT_MS } = {}) {
    const settings = isRecord(context?.settings) ? context.settings : {};
    const executable = resolveMagpieExecutable(settings);
    const kikiHome = typeof context?.kikiHome === 'string' && context.kikiHome.trim()
      ? context.kikiHome.trim()
      : undefined;

    try {
      const { stdout, stderr } = await this.execCommand(executable, args, {
        signal: context?.signal,
        env: { ...this.env },
        ...(kikiHome ? { cwd: kikiHome } : {}),
        timeoutMs,
      });
      return {
        exitCode: 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      };
    } catch (error) {
      if (error?.code === 'ABORT_ERR' || context?.signal?.aborted) throw error;
      if (allowNonZero) {
        return {
          exitCode: typeof error?.exitCode === 'number' ? error.exitCode : 1,
          stdout: typeof error?.stdout === 'string' ? error.stdout : '',
          stderr: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        };
      }
      throw manageError(
        'MAGPIE_CLI_ERROR',
        sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async resolveAccountArgument(agent, selector, context) {
    const cleaned = cleanAccountSelector(selector, 'account', { required: true });
    if (cleaned.toLowerCase() === 'next') return 'next';
    if (/^[a-f0-9]{8,64}$/i.test(cleaned)) {
      const { stdout } = await this.runCli(['accounts', agent, '--json'], context);
      let rows;
      try {
        rows = JSON.parse(stdout);
      } catch {
        rows = [];
      }
      if (Array.isArray(rows)) {
        const lower = cleaned.toLowerCase();
        const matches = rows.filter((r) => {
          if (!isRecord(r) || typeof r.user !== 'string') return false;
          const headHash = hashIdentity(r.user.split(' · ')[0].replace(/\s+\([^)]+\)$/, '').trim()) ?? '';
          const fullHash = hashIdentity(r.user) ?? '';
          return headHash.startsWith(lower) || fullHash.startsWith(lower);
        });
        if (matches.length === 1) {
          return matches[0].user;
        }
        if (matches.length > 1) {
          throw manageError('MAGPIE_AMBIGUOUS_ACCOUNT', `Account hash prefix "${cleaned}" matched ${matches.length} accounts in "${agent}".`);
        }
      }
    }
    return cleaned;
  }

  async executeModelManage(rawArgs, context) {
    const sub = cleanToken(rawArgs.subcommand, 'subcommand', { required: true, maxLength: 32 }).toLowerCase();
    const target = cleanToken(rawArgs.target ?? rawArgs.model, 'target', { maxLength: 256, allowSpaces: true });
    const reset = rawArgs.reset === true;

    const readOnlyListSubs = new Set(['names', 'prices', 'specs', 'wires', 'ids', 'aliases', 'disabled']);
    if (readOnlyListSubs.has(sub)) {
      const { stdout } = await this.runCli(['model', sub], context);
      return {
        ok: true,
        action: 'model_manage',
        subcommand: sub,
        mutated: false,
        sideEffectScope: 'none',
        output: sanitizeDiagnosticText(stdout),
      };
    }

    switch (sub) {
      case 'name': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'model_manage subcommand="name" requires "target" (<provider/model>).');
        const newName = cleanToken(rawArgs.name ?? (typeof rawArgs.value === 'string' ? rawArgs.value : undefined), 'name', { maxLength: 256, allowSpaces: true });
        const cliArgs = ['model', 'name', target];
        let mutated = false;
        if (reset) {
          cliArgs.push('--reset');
          mutated = true;
        } else if (newName !== undefined) {
          cliArgs.push(newName);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_model_settings' : 'none',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'efforts': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'model_manage subcommand="efforts" requires "target" (<provider/model>).');
        const cliArgs = ['model', 'efforts', target];
        let mutated = false;
        if (reset) {
          cliArgs.push('--reset');
          mutated = true;
        } else if (rawArgs.enabled === false || rawArgs.value === 'off') {
          cliArgs.push('off');
          mutated = true;
        } else if (rawArgs.efforts !== undefined) {
          const levels = cleanTokenList(rawArgs.efforts, 'efforts', { maxItems: 16, maxLength: 32 });
          cliArgs.push(levels.join(','));
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_model_settings' : 'none',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'api': {
        const modelTargets = rawArgs.targets !== undefined
          ? cleanTokenList(rawArgs.targets, 'targets', { maxItems: 32, maxLength: 256 })
          : (target ? [target] : null);
        if (!modelTargets || modelTargets.length === 0) {
          throw manageError('MAGPIE_INVALID_INPUT', 'model_manage subcommand="api" requires "target" or "targets".');
        }
        const apiChoice = cleanToken(rawArgs.api ?? (typeof rawArgs.value === 'string' ? rawArgs.value : undefined), 'api', { maxLength: 32 });
        const cliArgs = ['model', 'api', ...modelTargets];
        let mutated = false;
        if (reset) {
          cliArgs.push('--reset');
          mutated = true;
        } else if (apiChoice !== undefined) {
          if (!['chat', 'responses', 'anthropic', 'gemini', 'auto'].includes(apiChoice)) {
            throw manageError('MAGPIE_INVALID_INPUT', 'api must be one of chat, responses, anthropic, gemini, or auto.');
          }
          cliArgs.push(apiChoice);
          mutated = true;
        } else if (modelTargets.length > 1) {
          throw manageError('MAGPIE_INVALID_INPUT', 'Multiple targets in model_manage subcommand="api" require "api" or reset=true.');
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_model_settings' : 'none',
          targets: modelTargets,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'apis': {
        const provider = cleanToken(rawArgs.provider ?? target, 'provider', { maxLength: 64 });
        const cliArgs = provider ? ['model', 'apis', provider] : ['model', 'apis'];
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated: false,
          sideEffectScope: 'none',
          provider: provider ?? null,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'context':
      case 'output': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', `model_manage subcommand="${sub}" requires "target" (<provider/model>).`);
        const rawLimit = sub === 'context'
          ? (rawArgs.contextTokens ?? (typeof rawArgs.value === 'string' || typeof rawArgs.value === 'number' ? String(rawArgs.value) : undefined))
          : (rawArgs.outputTokens ?? (typeof rawArgs.value === 'string' || typeof rawArgs.value === 'number' ? String(rawArgs.value) : undefined));
        const limit = cleanToken(rawLimit, sub === 'context' ? 'contextTokens' : 'outputTokens', { maxLength: 32 });
        const cliArgs = ['model', sub, target];
        let mutated = false;
        if (reset) {
          cliArgs.push('--reset');
          mutated = true;
        } else if (limit !== undefined) {
          cliArgs.push(limit);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_model_settings' : 'none',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'spec': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'model_manage subcommand="spec" requires "target" (<provider/model>).');
        const cliArgs = ['model', 'spec', target];
        let mutated = false;
        if (reset) {
          cliArgs.push('--reset');
          mutated = true;
        } else {
          const ctxTok = cleanToken(rawArgs.contextTokens, 'contextTokens', { maxLength: 32 });
          const outTok = cleanToken(rawArgs.outputTokens, 'outputTokens', { maxLength: 32 });
          if (ctxTok) {
            cliArgs.push('--context', ctxTok);
            mutated = true;
          }
          if (outTok) {
            cliArgs.push('--output', outTok);
            mutated = true;
          }
          if (typeof rawArgs.vision === 'boolean') {
            cliArgs.push('--vision', rawArgs.vision ? 'on' : 'off');
            mutated = true;
          }
          if (rawArgs.efforts !== undefined) {
            const levels = cleanTokenList(rawArgs.efforts, 'efforts', { maxItems: 16, maxLength: 32 });
            cliArgs.push('--reasoning', levels.join(','));
            mutated = true;
          }
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_model_settings' : 'none',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'wire':
      case 'id':
      case 'alias': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', `model_manage subcommand="${sub}" requires "target".`);
        const nextVal = cleanToken(
          rawArgs.alias ?? rawArgs.name ?? (typeof rawArgs.value === 'string' ? rawArgs.value : undefined),
          'name',
          { maxLength: 256, allowSpaces: sub === 'wire' },
        );
        const cliArgs = ['model', sub, target];
        let mutated = false;
        if (reset) {
          cliArgs.push('--reset');
          mutated = true;
        } else if (nextVal !== undefined) {
          cliArgs.push(nextVal);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_model_settings' : 'none',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'disable':
      case 'enable': {
        const list = rawArgs.targets !== undefined
          ? cleanTokenList(rawArgs.targets, 'targets', { maxItems: 32, maxLength: 256 })
          : (target ? [target] : null);
        if (!list || list.length === 0) {
          throw manageError('MAGPIE_INVALID_INPUT', `model_manage subcommand="${sub}" requires "target" or "targets".`);
        }
        const { stdout } = await this.runCli(['model', sub, ...list], context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_model_settings',
          targets: list,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'suffix': {
        const val = typeof rawArgs.value === 'boolean'
          ? (rawArgs.value ? 'on' : 'off')
          : cleanToken(rawArgs.value, 'value', { maxLength: 16 });
        if (val !== undefined && !['on', 'own', 'off'].includes(val)) {
          throw manageError('MAGPIE_INVALID_INPUT', 'suffix value must be "on", "own", or "off".');
        }
        const cliArgs = val !== undefined ? ['model', 'suffix', val] : ['model', 'suffix'];
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated: val !== undefined,
          sideEffectScope: val !== undefined ? 'magpie_model_settings' : 'none',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'compact': {
        const agent = cleanToken(rawArgs.agent, 'agent', { maxLength: 32 });
        const val = typeof rawArgs.value === 'boolean'
          ? (rawArgs.value ? 'on' : 'off')
          : cleanToken(rawArgs.value !== undefined ? String(rawArgs.value) : undefined, 'value', { maxLength: 32 });
        const cliArgs = ['model', 'compact'];
        if (agent) cliArgs.push(agent);
        if (val !== undefined) cliArgs.push(val);
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'model_manage',
          subcommand: sub,
          mutated: val !== undefined,
          sideEffectScope: val !== undefined ? 'magpie_model_settings' : 'none',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      default:
        throw manageError('MAGPIE_INVALID_INPUT', `Unsupported model_manage subcommand "${sub}".`);
    }
  }

  buildGroupPairs(rawArgs) {
    const pairs = [];
    const name = cleanToken(rawArgs.name, 'name', { maxLength: 256, allowSpaces: true });
    if (name !== undefined && rawArgs.subcommand === 'set') {
      pairs.push(`name=${name}`);
    }
    if (rawArgs.models !== undefined) {
      const models = cleanTokenList(rawArgs.models, 'models', { maxItems: 64, maxLength: 256, allowSpaces: true });
      pairs.push(`models=${models.join(',')}`);
    }
    if (rawArgs.modelsAdd !== undefined) {
      const add = cleanTokenList(rawArgs.modelsAdd, 'modelsAdd', { maxItems: 64, maxLength: 256, allowSpaces: true });
      pairs.push(`models+=${add.join(',')}`);
    }
    if (rawArgs.modelsRemove !== undefined) {
      const rmList = cleanTokenList(rawArgs.modelsRemove, 'modelsRemove', { maxItems: 64, maxLength: 256, allowSpaces: true });
      pairs.push(`models-=${rmList.join(',')}`);
    }
    const routing = cleanToken(rawArgs.routing, 'routing', { maxLength: 64 });
    if (routing !== undefined) pairs.push(`routing=${routing}`);
    const stays = cleanToken(rawArgs.stays, 'stays', { maxLength: 32 });
    if (stays !== undefined) pairs.push(`stays=${stays}`);
    const ctxTok = cleanToken(rawArgs.contextTokens, 'contextTokens', { maxLength: 32 });
    if (ctxTok !== undefined) pairs.push(`context=${ctxTok}`);
    if (rawArgs.efforts !== undefined) {
      const levels = cleanTokenList(rawArgs.efforts, 'efforts', { maxItems: 16, maxLength: 32 });
      pairs.push(`levels=${levels.join(',')}`);
    }
    const family = cleanToken(rawArgs.family, 'family', { maxLength: 64 });
    if (family !== undefined) pairs.push(`family=${family}`);
    const effortMode = cleanToken(rawArgs.effortMode, 'effortMode', { maxLength: 16 });
    if (effortMode !== undefined) pairs.push(`effort=${effortMode}`);
    const classifier = cleanToken(rawArgs.classifier, 'classifier', { maxLength: 256 });
    if (classifier !== undefined) pairs.push(`classifier=${classifier}`);
    if (typeof rawArgs.listed === 'boolean') {
      pairs.push(`listed=${rawArgs.listed ? 'yes' : 'no'}`);
    }
    const weights = cleanToken(rawArgs.weights, 'weights', { maxLength: 512, allowSpaces: true });
    if (weights !== undefined) pairs.push(`weight=${weights}`);
    if (rawArgs.fastModels !== undefined) {
      const fast = cleanTokenList(rawArgs.fastModels, 'fastModels', { maxItems: 32, maxLength: 256 });
      pairs.push(`fast=${fast.join(',')}`);
    }
    return pairs;
  }

  async executeGroupManage(rawArgs, context) {
    const sub = cleanToken(rawArgs.subcommand ?? 'show', 'subcommand', { required: true, maxLength: 32 }).toLowerCase();
    const target = cleanToken(rawArgs.target, 'target', { maxLength: 256, allowSpaces: true });

    switch (sub) {
      case 'show': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="show" requires "target" (<group-id>).');
        const { stdout } = await this.runCli(['group', 'show', target], context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: false,
          sideEffectScope: 'none',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'add': {
        const groupName = cleanToken(rawArgs.name ?? target, 'name', { required: true, maxLength: 256, allowSpaces: true });
        const pairs = this.buildGroupPairs({ ...rawArgs, subcommand: 'add' });
        if (!pairs.some((p) => p.startsWith('models='))) {
          throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="add" requires "models" (array of provider/model IDs or patterns).');
        }
        const { stdout } = await this.runCli(['group', 'add', groupName, ...pairs], context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_routing_groups',
          name: groupName,
          applied: pairs,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'set': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="set" requires "target" (<group-id>).');
        const pairs = this.buildGroupPairs({ ...rawArgs, subcommand: 'set' });
        if (pairs.length === 0) {
          throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="set" requires at least one field to update (e.g. models, modelsAdd, modelsRemove, routing, stays, name).');
        }
        const { stdout } = await this.runCli(['group', 'set', target, ...pairs], context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_routing_groups',
          target,
          applied: pairs,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'pick': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="pick" requires "target" (<group-id>).');
        const model = cleanToken(rawArgs.model, 'model', { required: true, maxLength: 256, allowSpaces: true });
        const { stdout } = await this.runCli(['group', 'pick', target, model], context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_routing_groups',
          target,
          model,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'copy': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="copy" requires "target" (<group-id>).');
        const copyName = cleanToken(rawArgs.name, 'name', { maxLength: 256, allowSpaces: true });
        const cliArgs = copyName ? ['group', 'copy', target, copyName] : ['group', 'copy', target];
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_routing_groups',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'rm': {
        const ids = rawArgs.targets !== undefined
          ? cleanTokenList(rawArgs.targets, 'targets', { maxItems: 32, maxLength: 256, allowSpaces: true })
          : (target ? [target] : null);
        if (!ids || ids.length === 0) {
          throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="rm" requires "target" or "targets".');
        }
        const { stdout } = await this.runCli(['group', 'rm', ...ids], context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_routing_groups',
          targets: ids,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'restore': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'group_manage subcommand="restore" requires "target" (<group-id>).');
        const { stdout } = await this.runCli(['group', 'restore', target], context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_routing_groups',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'auto': {
        const cliArgs = ['group', 'auto'];
        let mutated = false;
        if (rawArgs.targets !== undefined || rawArgs.reset === true) {
          cliArgs.push('skip');
          if (rawArgs.reset === true) {
            cliArgs.push('none');
          } else {
            const skipIds = cleanTokenList(rawArgs.targets, 'targets', { maxItems: 32, maxLength: 64 });
            cliArgs.push(...skipIds);
          }
          mutated = true;
        } else if (typeof rawArgs.enabled === 'boolean') {
          cliArgs.push(rawArgs.enabled ? 'on' : 'off');
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_routing_groups' : 'none',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'template': {
        const kind = cleanToken(rawArgs.templateKind, 'templateKind', { maxLength: 32 });
        const tplName = cleanToken(rawArgs.name, 'name', { maxLength: 256, allowSpaces: true });
        const cliArgs = ['group', 'template'];
        let mutated = false;
        if (kind) {
          if (!['smart', 'thrifty', 'steady'].includes(kind)) {
            throw manageError('MAGPIE_INVALID_INPUT', 'templateKind must be "smart", "thrifty", or "steady".');
          }
          cliArgs.push(kind);
          if (tplName) cliArgs.push(tplName);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'group_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_routing_groups' : 'none',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      default:
        throw manageError('MAGPIE_INVALID_INPUT', `Unsupported group_manage subcommand "${sub}".`);
    }
  }

  async executePluginManage(rawArgs, context) {
    const sub = cleanToken(rawArgs.subcommand, 'subcommand', { required: true, maxLength: 32 }).toLowerCase();
    const target = cleanToken(rawArgs.target, 'target', { maxLength: 256 });

    switch (sub) {
      case 'add':
      case 'rm':
      case 'on':
      case 'off':
      case 'move': {
        if (!target) {
          throw manageError('MAGPIE_INVALID_INPUT', `plugin_manage subcommand="${sub}" requires "target".`);
        }
        if (sub === 'add' && target.includes('://') && target.includes('@')) {
          throw manageError('MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV', 'Plugin package spec must not embed URL credentials.');
        }
        const timeoutMs = (sub === 'add' || sub === 'move') ? 120_000 : DEFAULT_MANAGE_TIMEOUT_MS;
        const { stdout } = await this.runCli(['plugin', sub, target], context, { timeoutMs });
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_plugins',
          target,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'update': {
        const { stdout } = await this.runCli(['plugin', 'update'], context, { timeoutMs: 120_000 });
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_plugins',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'use': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'plugin_manage subcommand="use" requires "target" (<plugin-name>).');
        const provider = cleanToken(rawArgs.provider ?? rawArgs.agent, 'provider', { required: true, maxLength: 64 });
        const { stdout } = await this.runCli(['plugin', 'use', target, provider], context);
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_plugins',
          target,
          provider,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'options': {
        if (!target) throw manageError('MAGPIE_INVALID_INPUT', 'plugin_manage subcommand="options" requires "target" (<plugin-name>).');
        const cliArgs = ['plugin', 'options', target];
        let mutated = false;
        if (rawArgs.reset === true || rawArgs.value === 'off') {
          cliArgs.push('off');
          mutated = true;
        } else if (rawArgs.options !== undefined) {
          const checked = validateNonSecretOptionsObject(rawArgs.options);
          cliArgs.push(JSON.stringify(checked));
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        const projected = projectPluginOptionsStdout(stdout);
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_plugins' : 'none',
          target,
          output: projected.output,
          ...(Object.hasOwn(projected, 'options') ? { options: projected.options } : {}),
          ...(projected.parseError ? { parseError: projected.parseError } : {}),
        };
      }

      case 'builtin': {
        const cliArgs = ['plugin', 'builtin'];
        let mutated = false;
        if (typeof rawArgs.enabled === 'boolean') {
          if (!target) {
            throw manageError('MAGPIE_INVALID_INPUT', 'Toggling a built-in plugin requires "target" (<builtin-id>, e.g. "routing", "groups", "sessions").');
          }
          cliArgs.push(rawArgs.enabled ? 'on' : 'off', target);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_plugins' : 'none',
          ...(target ? { target } : {}),
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'preset': {
        const preset = cleanToken(rawArgs.preset, 'preset', { required: true, maxLength: 32 });
        if (preset !== 'essentials' && preset !== 'all') {
          throw manageError('MAGPIE_INVALID_INPUT', 'preset must be "essentials" or "all".');
        }
        const { stdout } = await this.runCli(['plugin', 'preset', preset], context);
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated: true,
          sideEffectScope: 'magpie_plugins',
          preset,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'registry': {
        const cliArgs = ['plugin', 'registry'];
        let mutated = false;
        if (rawArgs.reset === true) {
          cliArgs.push('default');
          mutated = true;
        } else if (rawArgs.registryUrl !== undefined) {
          const safeUrl = validateCredentialFreeHttpUrl(rawArgs.registryUrl, 'registryUrl');
          cliArgs.push(safeUrl);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated,
          sideEffectScope: mutated ? 'magpie_plugins' : 'none',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'dump': {
        const { stdout } = await this.runCli(['plugin', 'dump', '--json'], context);
        const projected = projectPluginDumpStdout(stdout);
        return {
          ok: true,
          action: 'plugin_manage',
          subcommand: sub,
          mutated: false,
          sideEffectScope: 'none',
          dump: projected.dump,
          ...(projected.parseError ? { parseError: projected.parseError } : {}),
        };
      }

      default:
        throw manageError('MAGPIE_INVALID_INPUT', `Unsupported plugin_manage subcommand "${sub}".`);
    }
  }

  async executeDaemonManage(rawArgs, context) {
    const sub = cleanToken(rawArgs.subcommand ?? 'status', 'subcommand', { required: true, maxLength: 32 }).toLowerCase();
    const allowed = new Set(['status', 'install', 'uninstall', 'start', 'stop', 'restart', 'web']);
    if (!allowed.has(sub)) {
      throw manageError('MAGPIE_INVALID_INPUT', `Unsupported daemon_manage subcommand "${sub}". Expected status, install, uninstall, start, stop, restart, or web.`);
    }

    const cliArgs = ['daemon', sub];
    let mutated = sub !== 'status';

    if (sub === 'install') {
      if (rawArgs.web === true) cliArgs.push('--web');
      else if (rawArgs.web === false) cliArgs.push('--no-web');
      if (rawArgs.lan === true) cliArgs.push('--lan');
      const addr = cleanToken(rawArgs.addr, 'addr', { maxLength: 128 });
      if (addr) cliArgs.push('--addr', addr);
    } else if (sub === 'web') {
      const toggle = typeof rawArgs.enabled === 'boolean' ? rawArgs.enabled : rawArgs.web;
      if (typeof toggle === 'boolean') {
        cliArgs.push(toggle ? 'on' : 'off');
        if (toggle && rawArgs.lan === true) cliArgs.push('--lan');
        const addr = cleanToken(rawArgs.addr, 'addr', { maxLength: 128 });
        if (toggle && addr) cliArgs.push('--addr', addr);
        mutated = true;
      } else {
        mutated = false;
      }
    }

    const res = await this.runCli(cliArgs, context, { allowNonZero: sub === 'status' });
    return {
      ok: res.exitCode === 0 || sub === 'status',
      action: 'daemon_manage',
      subcommand: sub,
      supported: res.exitCode === 0,
      mutated: res.exitCode === 0 ? mutated : false,
      sideEffectScope: res.exitCode === 0 && mutated ? 'magpie_daemon_service' : 'none',
      output: sanitizeDiagnosticText(res.exitCode === 0 ? res.stdout : (res.stderr || res.stdout)),
    };
  }

  async executeAutostartManage(rawArgs, context) {
    const sub = rawArgs.subcommand !== undefined
      ? cleanToken(rawArgs.subcommand, 'subcommand', { maxLength: 16 }).toLowerCase()
      : (typeof rawArgs.enabled === 'boolean' ? (rawArgs.enabled ? 'on' : 'off') : 'status');

    if (!['status', 'on', 'off'].includes(sub)) {
      throw manageError('MAGPIE_INVALID_INPUT', 'autostart_manage expects subcommand="status" | "on" | "off" (or boolean enabled).');
    }
    const cliArgs = sub === 'status' ? ['autostart'] : ['autostart', sub];
    const mutated = sub !== 'status';
    const { stdout } = await this.runCli(cliArgs, context);
    const cleaned = sanitizeDiagnosticText(stdout);
    return {
      ok: true,
      action: 'autostart_manage',
      subcommand: sub,
      mutated,
      sideEffectScope: mutated ? 'magpie_login_autostart' : 'none',
      enabled: /opens at login|starts the gateway at boot/i.test(cleaned),
      output: cleaned,
    };
  }

  async execute(rawArgs = {}, context = {}) {
    if (!isRecord(rawArgs)) {
      throw manageError('MAGPIE_INVALID_INPUT', 'Tool arguments must be a JSON object.');
    }
    const action = cleanToken(rawArgs.action, 'action', { required: true, maxLength: 64 });
    const settings = isRecord(context?.settings) ? context.settings : {};
    const magpiePath = typeof settings.magpiePath === 'string' && settings.magpiePath.trim()
      ? settings.magpiePath.trim()
      : undefined;
    const magpieConfigDir = typeof settings.magpieConfigDir === 'string' && settings.magpieConfigDir.trim()
      ? settings.magpieConfigDir.trim()
      : undefined;

    switch (action) {
      case 'capabilities': {
        return {
          ok: true,
          action,
          mutated: false,
          operations: MAGPIE_MANAGE_CATALOG,
        };
      }

      case 'accounts_list': {
        const agent = cleanToken(rawArgs.agent, 'agent', { maxLength: 64 });
        const cliArgs = agent ? ['accounts', agent, '--json'] : ['accounts', '--json'];
        const { stdout } = await this.runCli(cliArgs, context);
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for accounts list.');
        }
        const rows = Array.isArray(parsed) ? parsed.map((row) => redactAccountRow(row)) : [];
        return {
          ok: true,
          action,
          mutated: false,
          agent: agent ?? null,
          count: rows.length,
          accounts: rows,
        };
      }

      case 'accounts_switch': {
        const agent = cleanToken(rawArgs.agent, 'agent', { required: true, maxLength: 64 });
        const resolvedAccount = await this.resolveAccountArgument(agent, rawArgs.account, context);
        const { stdout } = await this.runCli(['accounts', 'switch', agent, resolvedAccount], context);
        const scopeInfo = classifyMagpieSwitchScope(agent);
        const readback = await this.runCli(['accounts', agent, '--json'], context, { allowNonZero: true });
        let accounts = null;
        if (readback.exitCode === 0 && readback.stdout.trim()) {
          try {
            const rows = JSON.parse(readback.stdout);
            if (Array.isArray(rows)) accounts = rows.map((row) => redactAccountRow(row));
          } catch {
            accounts = null;
          }
        }
        return {
          ok: true,
          action,
          mutated: true,
          agent,
          targetAccountHash: resolvedAccount === 'next' ? null : hashIdentity(resolvedAccount.split(' · ')[0].replace(/\s+\([^)]+\)$/, '').trim()),
          maskedTarget: resolvedAccount === 'next' ? 'next' : maskAccountIdentifier(resolvedAccount),
          ...scopeInfo,
          message: sanitizeDiagnosticText(stdout),
          ...(accounts ? { accounts } : {}),
        };
      }

      case 'accounts_alias': {
        const agent = cleanToken(rawArgs.agent, 'agent', { required: true, maxLength: 64 });
        const resolvedAccount = await this.resolveAccountArgument(agent, rawArgs.account, context);
        const clear = rawArgs.clear === true;
        const alias = cleanToken(rawArgs.alias, 'alias', { maxLength: 128, allowSpaces: true });
        const cliArgs = ['accounts', 'alias', agent, resolvedAccount];
        let mutated = false;
        if (clear) {
          cliArgs.push('--clear');
          mutated = true;
        } else if (alias !== undefined) {
          cliArgs.push(alias);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action,
          mutated,
          sideEffectScope: mutated ? 'magpie_metadata' : 'none',
          agent,
          accountHash: hashIdentity(resolvedAccount.split(' · ')[0].replace(/\s+\([^)]+\)$/, '').trim()),
          maskedAccount: maskAccountIdentifier(resolvedAccount),
          alias: clear ? null : (alias ?? sanitizeDiagnosticText(stdout)),
          message: sanitizeDiagnosticText(stdout),
        };
      }

      case 'accounts_switch_only': {
        const agent = cleanToken(rawArgs.agent, 'agent', { required: true, maxLength: 32 }).toLowerCase();
        if (agent !== 'codex' && agent !== 'claude') {
          throw manageError('MAGPIE_INVALID_INPUT', 'accounts_switch_only only supports agent="codex" or agent="claude".');
        }
        const enabled = typeof rawArgs.enabled === 'boolean' ? rawArgs.enabled : undefined;
        const cliArgs = ['accounts', 'switch-only', agent];
        if (enabled !== undefined) cliArgs.push(enabled ? 'on' : 'off');
        const { stdout } = await this.runCli(cliArgs, context);
        const cleaned = sanitizeDiagnosticText(stdout);
        return {
          ok: true,
          action,
          mutated: enabled !== undefined,
          sideEffectScope: enabled !== undefined ? 'magpie_routing_mode' : 'none',
          agent,
          switchOnly: cleaned.startsWith('on ') || cleaned === 'on' ? true : (cleaned.startsWith('off ') || cleaned === 'off' ? false : enabled ?? null),
          message: cleaned,
        };
      }

      case 'accounts_discovery': {
        const enabled = typeof rawArgs.enabled === 'boolean' ? rawArgs.enabled : undefined;
        const cliArgs = ['accounts', 'discovery'];
        if (enabled !== undefined) cliArgs.push(enabled ? 'on' : 'off');
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action,
          mutated: enabled !== undefined,
          sideEffectScope: enabled !== undefined ? 'magpie_discovery_setting' : 'none',
          message: sanitizeDiagnosticText(stdout),
        };
      }

      case 'accounts_refresh': {
        const { stdout } = await this.runCli(['accounts', 'refresh', '--json'], context, { timeoutMs: 120_000 });
        let parsed = [];
        try {
          parsed = stdout.trim() ? JSON.parse(stdout) : [];
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for accounts refresh.');
        }
        const results = (Array.isArray(parsed) ? parsed : []).map((r) => ({
          agent: r?.agent ?? r?.Agent ?? null,
          accountHash: hashIdentity(r?.user ?? r?.User ?? ''),
          maskedAccount: maskAccountIdentifier(r?.user ?? r?.User ?? ''),
          renewed: Boolean(r?.renewed ?? r?.Renewed),
          error: sanitizeDiagnosticText(r?.err ?? r?.Err ?? '') || null,
        }));
        return {
          ok: true,
          action,
          mutated: true,
          sideEffectScope: 'saved_account_tokens',
          results,
        };
      }

      case 'accounts_checkin': {
        const { stdout } = await this.runCli(['accounts', 'checkin', '--json'], context, { timeoutMs: 120_000 });
        let parsed = [];
        try {
          parsed = stdout.trim() ? JSON.parse(stdout) : [];
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for accounts checkin.');
        }
        const results = (Array.isArray(parsed) ? parsed : []).map((r) => ({
          by: r?.by ?? r?.By ?? null,
          vendor: r?.vendor ?? r?.Vendor ?? null,
          accountHash: hashIdentity(r?.user ?? r?.User ?? ''),
          maskedAccount: maskAccountIdentifier(r?.user ?? r?.User ?? ''),
          outcome: r?.outcome ?? r?.Outcome ?? null,
          credit: typeof (r?.credit ?? r?.Credit) === 'number' ? (r.credit ?? r.Credit) : null,
          streak: typeof (r?.streak ?? r?.Streak) === 'number' ? (r.streak ?? r.Streak) : null,
          message: sanitizeDiagnosticText(r?.msg ?? r?.Msg ?? '') || null,
        }));
        return {
          ok: true,
          action,
          mutated: true,
          sideEffectScope: 'vendor_daily_checkin',
          results,
        };
      }

      case 'grok_native_status': {
        const nativeGrokHome = cleanToken(rawArgs.nativeGrokHome, 'nativeGrokHome', { maxLength: 4096, allowSpaces: true });
        const status = await inspectGrokManagedAccounts({
          magpieConfigDir,
          magpiePath,
          nativeGrokHome,
          env: this.env,
          homedir: this.homedir,
        });
        const { _internalAccounts, ...publicStatus } = status;
        return {
          ok: true,
          action,
          mutated: false,
          ...publicStatus,
        };
      }

      case 'grok_native_locator': {
        const nativeGrokHome = cleanToken(rawArgs.nativeGrokHome, 'nativeGrokHome', { maxLength: 4096, allowSpaces: true });
        const account = cleanAccountSelector(rawArgs.account, 'account');
        const resolved = await resolveGrokNativeLocator({
          account,
          magpieConfigDir,
          magpiePath,
          nativeGrokHome,
          env: this.env,
          homedir: this.homedir,
        });
        return {
          ok: true,
          action,
          mutated: false,
          ...resolved,
        };
      }

      case 'quota_summary': {
        const provider = cleanToken(rawArgs.provider ?? rawArgs.agent, 'provider', { maxLength: 64 });
        const cliArgs = ['quota'];
        if (provider) cliArgs.push(provider);
        cliArgs.push('--json');
        const { stdout } = await this.runCli(cliArgs, context, { timeoutMs: 45_000 });
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for quota summary.');
        }
        const cards = (Array.isArray(parsed) ? parsed : []).map(redactQuotaCard);
        return {
          ok: true,
          action,
          mutated: false,
          provider: provider ?? null,
          count: cards.length,
          cards,
        };
      }

      case 'quota_history': {
        const target = cleanAccountSelector(rawArgs.target ?? rawArgs.provider ?? rawArgs.agent, 'target');
        const days = cleanPositiveNumber(rawArgs.days, 'days', { min: 1, max: 45 });
        const cliArgs = ['quota', 'history'];
        if (target) cliArgs.push(target);
        if (days !== undefined) cliArgs.push('--days', String(days));
        cliArgs.push('--json');
        const { stdout } = await this.runCli(cliArgs, context);
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for quota history.');
        }
        const entries = (Array.isArray(parsed) ? parsed : []).map(redactHistoryEntry);
        return {
          ok: true,
          action,
          mutated: false,
          target: target ? maskAccountIdentifier(target) : null,
          days: days ?? null,
          count: entries.length,
          history: entries,
        };
      }

      case 'quota_refresh': {
        const provider = cleanToken(rawArgs.provider ?? rawArgs.agent, 'provider', { required: true, maxLength: 64 });
        const account = rawArgs.account !== undefined
          ? await this.resolveAccountArgument(provider, rawArgs.account, context)
          : undefined;
        const cliArgs = ['quota', 'refresh', provider];
        if (account) cliArgs.push(account);
        cliArgs.push('--json');
        const { stdout } = await this.runCli(cliArgs, context, { timeoutMs: 60_000 });
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for quota refresh.');
        }
        const cards = (Array.isArray(parsed) ? parsed : [parsed]).map(redactQuotaCard);
        return {
          ok: true,
          action,
          mutated: true,
          sideEffectScope: 'magpie_quota_cache',
          provider,
          cards,
        };
      }

      case 'usage_summary': {
        const period = cleanToken(rawArgs.period, 'period', { maxLength: 16 });
        const days = cleanPositiveNumber(rawArgs.days, 'days', { min: 0.1, max: 365 });
        const last = cleanToken(rawArgs.last, 'last', { maxLength: 32 });
        if (period && !['today', '7d', '30d', 'all'].includes(period)) {
          throw manageError('MAGPIE_INVALID_INPUT', 'period must be one of "today", "7d", "30d", or "all".');
        }
        if (days !== undefined && last !== undefined) {
          throw manageError('MAGPIE_INVALID_INPUT', 'Specify either "days" or "last", not both.');
        }
        const cliArgs = ['usage'];
        if (days !== undefined) cliArgs.push('--days', String(days));
        else if (last !== undefined) cliArgs.push('--last', last);
        else if (period) cliArgs.push(period);
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action,
          mutated: false,
          period: period ?? (days !== undefined ? `${days}d` : last ?? '30d'),
          report: sanitizeDiagnosticText(stdout),
        };
      }

      case 'sessions_summary': {
        const period = cleanToken(rawArgs.period, 'period', { maxLength: 16 });
        const days = cleanPositiveNumber(rawArgs.days, 'days', { min: 1, max: 365, integer: true });
        const model = cleanToken(rawArgs.model, 'model', { maxLength: 128 });
        const folder = cleanToken(rawArgs.folder, 'folder', { maxLength: 1024, allowSpaces: true });
        const cliArgs = ['sessions'];
        if (days !== undefined) {
          cliArgs.push('--days', String(days));
        } else if (period === 'today' || period === 'all') {
          cliArgs.push(period);
        }
        if (model) cliArgs.push('--model', model);
        if (folder) cliArgs.push('--folder', folder);
        cliArgs.push('--json');
        const { stdout } = await this.runCli(cliArgs, context);
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for sessions summary.');
        }
        return {
          ok: true,
          action,
          mutated: false,
          sessions: parsed,
        };
      }

      case 'models_list': {
        const agent = cleanToken(rawArgs.agent, 'agent', { maxLength: 64 });
        const cliArgs = agent ? ['models', agent] : ['models'];
        const { stdout } = await this.runCli(cliArgs, context);
        const parsed = parseModelsCatalogOutput(stdout);
        return {
          ok: true,
          action,
          mutated: false,
          agent: agent ?? null,
          ...parsed,
        };
      }

      case 'model_manage':
        return this.executeModelManage(rawArgs, context);

      case 'sync_catalog': {
        const { stdout } = await this.runCli(['sync'], context, { timeoutMs: 45_000 });
        return {
          ok: true,
          action,
          mutated: true,
          sideEffectScope: 'magpie_model_catalog',
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'groups_list': {
        const { stdout } = await this.runCli(['groups'], context);
        const lines = sanitizeDiagnosticText(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return {
          ok: true,
          action,
          mutated: false,
          count: lines.length,
          groups: lines,
        };
      }

      case 'group_manage':
        return this.executeGroupManage(rawArgs, context);

      case 'service_status': {
        const [versionRes, healthRes, autostartRes, daemonRes, logLocator, proxySummary] = await Promise.all([
          this.runCli(['version'], context, { allowNonZero: true }),
          this.runCli(['healthcheck'], context, { allowNonZero: true, timeoutMs: 5_000 }),
          this.runCli(['autostart'], context, { allowNonZero: true }),
          this.runCli(['daemon', 'status'], context, { allowNonZero: true }),
          inspectStructuredLogLocator(this, context),
          inspectRedactedProxySummary({ magpieConfigDir, magpiePath, env: this.env, homedir: this.homedir }),
        ]);
        return {
          ok: true,
          action,
          mutated: false,
          version: versionRes.exitCode === 0 ? sanitizeDiagnosticText(versionRes.stdout) : null,
          gatewayAnswering: healthRes.exitCode === 0,
          autostart: autostartRes.exitCode === 0 ? sanitizeDiagnosticText(autostartRes.stdout) : sanitizeDiagnosticText(autostartRes.stderr),
          daemon: {
            supported: daemonRes.exitCode === 0,
            detail: sanitizeDiagnosticText(daemonRes.exitCode === 0 ? daemonRes.stdout : daemonRes.stderr),
          },
          logs: logLocator,
          proxy: proxySummary,
        };
      }

      case 'daemon_manage':
        return this.executeDaemonManage(rawArgs, context);

      case 'autostart_manage':
        return this.executeAutostartManage(rawArgs, context);

      case 'proxy_status': {
        const proxySummary = await inspectRedactedProxySummary({
          magpieConfigDir,
          magpiePath,
          env: this.env,
          homedir: this.homedir,
        });
        return {
          ok: true,
          action,
          mutated: false,
          ...proxySummary,
        };
      }

      case 'settings_list': {
        const { stdout } = await this.runCli(['settings', 'list', '--json'], context);
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for settings list.');
        }
        const items = (Array.isArray(parsed) ? parsed : [])
          .map(projectPublicSettingRow)
          .filter((item) => item !== null);
        return {
          ok: true,
          action,
          mutated: false,
          count: items.length,
          settings: items,
        };
      }

      case 'settings_get': {
        const key = cleanToken(rawArgs.key, 'key', { required: true, maxLength: 128 });
        ensurePublicSettingKey(key, { requireWritable: false });
        const { stdout } = await this.runCli(['settings', 'get', key, '--json'], context);
        let rawValue;
        try {
          rawValue = JSON.parse(stdout);
        } catch {
          rawValue = stdout.trim();
        }
        const projected = projectPublicSettingValue(key, rawValue);
        return {
          ok: true,
          action,
          mutated: false,
          key,
          value: projected.value,
        };
      }

      case 'settings_set': {
        const key = cleanToken(rawArgs.key, 'key', { required: true, maxLength: 128 });
        const spec = ensurePublicSettingKey(key, { requireWritable: true });
        if (rawArgs.value === undefined || rawArgs.value === null) {
          throw manageError('MAGPIE_INVALID_INPUT', 'Missing required parameter "value" for settings_set.');
        }
        let serializedValue;
        if (spec.kind === 'credential_free_proxy') {
          if (typeof rawArgs.value !== 'string') {
            throw manageError('MAGPIE_INVALID_INPUT', 'Setting "proxy" requires a string ("", "direct", or credential-free URL).');
          }
          serializedValue = validateCredentialFreeProxyInput(rawArgs.value);
        } else if (typeof rawArgs.value === 'boolean') {
          serializedValue = rawArgs.value ? 'on' : 'off';
        } else if (typeof rawArgs.value === 'number' && Number.isFinite(rawArgs.value)) {
          serializedValue = String(rawArgs.value);
        } else if (typeof rawArgs.value === 'string') {
          if (/[\0\r\n]/.test(rawArgs.value) || rawArgs.value.length > 2048) {
            throw manageError('MAGPIE_INVALID_INPUT', 'Invalid string "value" for settings_set.');
          }
          if (rawArgs.value.includes('://') && rawArgs.value.includes('@')) {
            throw manageError('MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV', 'URL credentials cannot be passed via settings_set CLI argv.');
          }
          serializedValue = rawArgs.value;
        } else {
          if (isRecord(rawArgs.value)) validateNonSecretOptionsObject(rawArgs.value);
          serializedValue = JSON.stringify(rawArgs.value);
        }
        const { stdout } = await this.runCli(['settings', 'set', key, serializedValue], context);
        const projected = projectPublicSettingValue(key, spec.kind === 'credential_free_proxy' ? serializedValue : rawArgs.value);
        return {
          ok: true,
          action,
          mutated: true,
          sideEffectScope: 'magpie_settings',
          key,
          appliedValue: projected.value,
          message: sanitizeDiagnosticText(stdout),
        };
      }

      case 'settings_reset': {
        const key = cleanToken(rawArgs.key, 'key', { required: true, maxLength: 128 });
        ensurePublicSettingKey(key, { requireWritable: true });
        const { stdout } = await this.runCli(['settings', 'reset', key], context);
        return {
          ok: true,
          action,
          mutated: true,
          sideEffectScope: 'magpie_settings',
          key,
          message: sanitizeDiagnosticText(stdout),
        };
      }

      case 'providers_list': {
        const [cliRes, proxySummary] = await Promise.all([
          this.runCli(['providers'], context),
          inspectRedactedProxySummary({ magpieConfigDir, magpiePath, env: this.env, homedir: this.homedir }),
        ]);
        const lines = sanitizeDiagnosticText(cliRes.stdout)
          .split(/\r?\n/)
          .filter(Boolean);
        return {
          ok: true,
          action,
          mutated: false,
          providers: lines,
          proxyOverrides: proxySummary.providers,
        };
      }

      case 'provider_pool': {
        const provider = cleanToken(rawArgs.provider ?? rawArgs.agent, 'provider', { required: true, maxLength: 64 });
        const cliArgs = ['provider', 'pool', provider];
        let mutated = false;
        if (rawArgs.cap !== undefined && rawArgs.cap !== null) {
          if (rawArgs.cap === 'off') {
            cliArgs.push('--cap=off');
          } else {
            const capNum = cleanPositiveNumber(rawArgs.cap, 'cap', { min: 1, max: 100, integer: true });
            cliArgs.push(`--cap=${capNum}`);
          }
          mutated = true;
        }
        if (typeof rawArgs.stop === 'boolean') {
          cliArgs.push(`--stop=${rawArgs.stop ? 'on' : 'off'}`);
          mutated = true;
        }
        if (typeof rawArgs.careful === 'boolean') {
          cliArgs.push(`--careful=${rawArgs.careful ? 'on' : 'off'}`);
          mutated = true;
        }
        const { stdout } = await this.runCli(cliArgs, context);
        return {
          ok: true,
          action,
          mutated,
          sideEffectScope: mutated ? 'magpie_provider_pool' : 'none',
          provider,
          output: sanitizeDiagnosticText(stdout),
        };
      }

      case 'plugins_list': {
        const { stdout } = await this.runCli(['plugin', 'list', '--json'], context);
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw manageError('MAGPIE_PARSE_ERROR', 'Magpie CLI returned invalid JSON for plugin list.');
        }
        return {
          ok: true,
          action,
          mutated: false,
          ...redactPluginsPayload(parsed),
        };
      }

      case 'plugin_manage':
        return this.executePluginManage(rawArgs, context);

      case 'log_locator': {
        const locator = await inspectStructuredLogLocator(this, context);
        return {
          ok: true,
          action,
          mutated: false,
          ...locator,
        };
      }

      default:
        throw manageError(
          'MAGPIE_UNKNOWN_ACTION',
          `Unsupported action "${action}". Call with action="capabilities" to inspect supported operations.`,
        );
    }
  }
}
