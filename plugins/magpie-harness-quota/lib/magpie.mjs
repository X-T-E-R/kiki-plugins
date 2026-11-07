import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';

import {
  harnessQuotaSourceDefinitions,
  MAGPIE_CLI_AGENT_BY_SOURCE_ID,
  UNPOOLED_MODEL_ID_FALLBACK_SOURCES,
} from './definitions.mjs';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_QUOTA_UNITS = new Set(['percent', 'money', 'tokens', 'requests', 'credits', 'count']);
const KNOWN_SOURCE_IDS = new Set(harnessQuotaSourceDefinitions.map((item) => item.id));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortError() {
  const error = new Error('The Magpie quota read was cancelled.');
  error.code = 'ABORT_ERR';
  return error;
}

function cleanIdentifier(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1024 || /[\0\r\n\s]/.test(value.trim())) {
    throw new Error(`Invalid ${label}: expected a non-empty single-token identifier.`);
  }
  return value.trim();
}

function cleanSingleLine(value, label, { required = false, maxLength = 4096 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`Missing ${label}.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}: expected a single-line string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`Missing ${label}.`);
    return undefined;
  }
  return trimmed;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  // Ignore Go zero-time sentinels such as 0001-01-01T00:00:00Z.
  if (parsed <= Date.UTC(1970, 0, 1)) return undefined;
  return new Date(parsed).toISOString();
}

function normalizeQuotaUnit(rawUnit, fallback = 'percent') {
  if (typeof rawUnit === 'string') {
    const lower = rawUnit.trim().toLowerCase();
    if (ALLOWED_QUOTA_UNITS.has(lower)) return lower;
    if (/^(usd|cny|eur|gbp|jpy|\$|¥|€|£|dollars?|cents?)$/i.test(lower)) return 'money';
    if (/^(tokens?|tok)$/i.test(lower)) return 'tokens';
    if (/^(requests?|reqs?|calls?|messages?|msgs?)$/i.test(lower)) return 'requests';
    if (/^(credits?|points?|pts|积分|点)$/i.test(lower)) return 'credits';
  }
  return fallback;
}

/**
 * Normalizes Magpie's `row.agent` (`internal/provider/logins.go:988-1008`, `plugins.go:95-103`)
 * so `magpie accounts grok --json` (`agent: "plugin:grok"`) and `magpie accounts --json` (`agent: "grok"`)
 * both match source `"grok"` cleanly without mixing unrelated agents.
 */
export function normalizeMagpieAgentId(rawAgent) {
  if (typeof rawAgent !== 'string') return '';
  let normalized = rawAgent.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.startsWith('plugin:')) {
    normalized = normalized.slice('plugin:'.length);
  }
  if (normalized.endsWith('-plugin') && normalized.length > '-plugin'.length) {
    normalized = normalized.slice(0, -'-plugin'.length);
  }
  return normalized;
}

export function magpieRowMatchesAgent(rowAgent, targetAgent) {
  if (!targetAgent) return true;
  if (typeof rowAgent !== 'string' || !rowAgent.trim()) return true;
  return normalizeMagpieAgentId(rowAgent) === normalizeMagpieAgentId(targetAgent);
}

export function resolveMagpieExecutable(settings) {
  const configured = cleanSingleLine(settings?.magpiePath, 'magpiePath', { maxLength: 16_384 });
  if (!configured) return process.platform === 'win32' ? 'magpie.exe' : 'magpie';
  if (!path.isAbsolute(configured)) {
    throw new Error('magpiePath must be an absolute path on the Kiki server, or omitted to use magpie on PATH.');
  }
  return configured;
}

function isSelectorObject(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key) => key === 'pool' || key === 'name' || key === 'window');
}

function normalizeSelectorRule(rule, labelPrefix) {
  if (typeof rule === 'string') {
    const pool = cleanSingleLine(rule, labelPrefix, { required: true });
    return { pool };
  }
  if (!isRecord(rule)) {
    throw new Error(`${labelPrefix} must be an object with pool and/or name (or window).`);
  }
  const allowedKeys = new Set(['pool', 'name', 'window']);
  for (const key of Object.keys(rule)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported key "${key}" in ${labelPrefix}; allowed keys are pool, name, window.`);
    }
  }
  const pool = cleanSingleLine(rule.pool, `${labelPrefix}.pool`);
  const name = cleanSingleLine(rule.name ?? rule.window, `${labelPrefix}.name`);
  if (!pool && !name) {
    throw new Error(`${labelPrefix} must specify at least pool or name.`);
  }
  return {
    ...(pool ? { pool } : {}),
    ...(name ? { name } : {}),
  };
}

function parseFlatModelWindowEntries(entries, scopeLabel = 'modelWindows') {
  const mappings = new Map();
  for (const [rawModelId, rawValue] of entries) {
    const modelId = cleanIdentifier(rawModelId, `${scopeLabel} model ID`);
    const itemPrefix = `${scopeLabel}[${modelId}]`;
    const selectors = Array.isArray(rawValue)
      ? rawValue.map((entry) => normalizeSelectorRule(entry, itemPrefix))
      : [normalizeSelectorRule(rawValue, itemPrefix)];
    if (selectors.length === 0) {
      throw new Error(`${itemPrefix} cannot be an empty array.`);
    }
    mappings.set(modelId, selectors);
  }
  return mappings;
}

/**
 * Parses `modelWindows` JSON string (or object) mapping exact native model IDs
 * to exact Magpie `pool` and/or `name` window selectors.
 *
 * Supports both:
 * 1) Flat mapping (backwards-compatible, applies to all sources or a single source):
 *    `{ "gemini-4-argon-high": { "pool": "Gemini 4 Argon" } }`
 * 2) Source-keyed mapping (or mixed with `*` global defaults):
 *    `{ "antigravity": { "gemini-4-argon-high": { "pool": "Gemini 4 Argon" } }, "grok": { ... } }`
 */
export function parseModelWindows(raw, { sourceId } = {}) {
  if (raw === undefined || raw === null) return new Map();
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return new Map();
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid modelWindows JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(parsed)) {
    throw new Error('modelWindows must be a JSON object mapping exact native model IDs (or source IDs) to { pool?, name? }.');
  }

  const topEntries = Object.entries(parsed);
  if (topEntries.length === 0) return new Map();

  const isSourceKeyed = topEntries.every(([key, value]) => (
    (key === '*' || KNOWN_SOURCE_IDS.has(normalizeMagpieAgentId(key)))
    && isRecord(value)
    && !isSelectorObject(value)
  ));

  if (!isSourceKeyed) {
    return parseFlatModelWindowEntries(topEntries, 'modelWindows');
  }

  const normalizedSource = sourceId ? normalizeMagpieAgentId(sourceId) : undefined;
  const merged = new Map();
  const applySection = (sectionKey, sectionObj) => {
    const sectionMap = parseFlatModelWindowEntries(Object.entries(sectionObj), `modelWindows.${sectionKey}`);
    for (const [modelId, selectors] of sectionMap.entries()) {
      merged.set(modelId, selectors);
    }
  };

  if (isRecord(parsed['*'])) {
    applySection('*', parsed['*']);
  }
  if (normalizedSource) {
    for (const [key, sectionObj] of topEntries) {
      if (key !== '*' && normalizeMagpieAgentId(key) === normalizedSource) {
        applySection(key, sectionObj);
      }
    }
  } else {
    for (const [key, sectionObj] of topEntries) {
      if (key !== '*') applySection(key, sectionObj);
    }
  }
  return merged;
}

export function normalizeWindowLabel(rawName, rawPool) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const pool = typeof rawPool === 'string' ? rawPool.trim() : '';
  if (!name) return undefined;
  if (pool) {
    const prefix = `${pool} · `;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length).trim();
    }
  }
  return name;
}

function matchesSelector(selector, span, shortWindow) {
  const rawPool = typeof span.pool === 'string' && span.pool.trim() ? span.pool.trim() : undefined;
  const rawName = typeof span.name === 'string' && span.name.trim() ? span.name.trim() : undefined;
  // Exact pool equality keeps "Gemini" weekly/hourly pools strictly distinct from "Gemini 4 Argon".
  if (selector.pool !== undefined && rawPool !== selector.pool) return false;
  // When only `name` is given without `pool`, match against full rawName (or unpooled shortWindow) so a bare
  // window label like "7 days" on "Gemini · 7 days" never accidentally claims "Gemini 4 Argon · 7 days".
  if (selector.name !== undefined) {
    if (selector.pool !== undefined) {
      if (rawName !== selector.name && shortWindow !== selector.name) return false;
    } else if (rawName !== selector.name) {
      return false;
    }
  }
  return true;
}

function resolveMappedModelIds(span, shortWindow, modelWindows) {
  const matched = [];
  for (const [modelId, selectors] of modelWindows.entries()) {
    if (selectors.some((selector) => matchesSelector(selector, span, shortWindow))) {
      matched.push(modelId);
    }
  }
  return matched;
}

function extractWindowMetrics(span) {
  if (!isRecord(span)) return { unit: 'percent', remaining: undefined };
  if (span.unlimited === true || span.text === true) {
    return {
      unit: normalizeQuotaUnit(span.unit, 'percent'),
      remaining: undefined,
    };
  }
  if (typeof span.balance === 'number' && Number.isFinite(span.balance)) {
    return {
      unit: normalizeQuotaUnit(span.unit, 'credits'),
      remaining: Math.max(0, span.balance),
    };
  }
  if (typeof span.limit === 'number' && Number.isFinite(span.limit) && span.limit > 0
      && typeof span.amount === 'number' && Number.isFinite(span.amount)) {
    const hasPercent = typeof span.remaining === 'number' && Number.isFinite(span.remaining);
    if (!hasPercent) {
      return {
        unit: normalizeQuotaUnit(span.unit, 'credits'),
        remaining: Math.max(0, span.limit - span.amount),
      };
    }
  }
  if (typeof span.remaining === 'number' && Number.isFinite(span.remaining)) {
    return {
      unit: normalizeQuotaUnit(span.unit, 'percent'),
      remaining: Math.max(0, Math.min(100, span.remaining)),
    };
  }
  if (typeof span.used === 'number' && Number.isFinite(span.used)) {
    return {
      unit: normalizeQuotaUnit(span.unit, 'percent'),
      remaining: Math.max(0, Math.min(100, 100 - span.used)),
    };
  }
  return {
    unit: normalizeQuotaUnit(span.unit, 'percent'),
    remaining: undefined,
  };
}

/**
 * Parses an unambiguous account-level wallet string (`row.balance`, e.g. `"2100 credits (monthly 100 ...)"`,
 * `"$12.50"`, `"1.5K credits"`) only when `row.windows` is empty and the reading is fresh.
 * Returns `{ unit, remaining, window: "Balance" }` or `undefined` when ambiguous/unparseable (stays unknown).
 */
export function parseAccountBalanceString(rawBalance) {
  if (typeof rawBalance !== 'string') return undefined;
  const trimmed = rawBalance.trim();
  if (!trimmed) return undefined;
  // Remove parenthetical breakdown suffix like "(monthly 100 · long-term 2000)" before parsing the headline total.
  const headline = trimmed.replace(/\([^)]*\)/g, ' ').trim();
  if (!headline) return undefined;

  const currencyMatch = /^(?:\$|usd\s*)([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)$/i.exec(headline)
    ?? /^([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)\s*(usd|dollars?)$/i.exec(headline);
  if (currencyMatch) {
    const amount = Number(currencyMatch[1].replaceAll(',', ''));
    if (Number.isFinite(amount) && amount >= 0) {
      return { unit: 'money', remaining: amount, window: 'Balance' };
    }
  }

  const unitMatch = /^([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)([km])?\s*(credits?|points?|pts|tokens?|requests?|积分)?$/i.exec(headline);
  if (unitMatch) {
    const base = Number(unitMatch[1].replaceAll(',', ''));
    if (!Number.isFinite(base) || base < 0) return undefined;
    const suffix = (unitMatch[2] ?? '').toLowerCase();
    const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
    const remaining = base * multiplier;
    const rawUnitWord = unitMatch[3] ?? 'credits';
    return {
      unit: normalizeQuotaUnit(rawUnitWord, 'credits'),
      remaining,
      window: 'Balance',
    };
  }

  return undefined;
}

function accountLabelOf(row, { isDisabled = false } = {}) {
  const baseLabel = cleanSingleLine(row.alias, 'alias') ?? cleanSingleLine(row.seat, 'seat');
  if (!isDisabled) return baseLabel;
  return baseLabel ? `${baseLabel} (disabled)` : 'disabled';
}

function looksLikeExactModelIdentifier(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  // Must look like a real model slug (contains `-`, `.`, `_`, `/`, or `@`, e.g. `gemini-3.8-flash-high` or `grok-4.7@256k`),
  // never a generic English window label like `Credits`, `Limit`, `Monthly`, or `Weekly`.
  return /^[a-z0-9][a-z0-9._/@-]*$/i.test(trimmed) && /[-._/@]/.test(trimmed);
}

/**
 * Projects Magpie `accounts [agent] --json` rows into Kiki `HarnessQuotaReading` items
 * conforming strictly to `@kiki/plugin-sdk/harness-quota` (`harnessQuotaReadingSchema`).
 *
 * Rules:
 * - Accepts both `<agent>` and plugin-served `"plugin:<agent>"` / `"<agent>-plugin"` rows (`accounts grok --json`).
 * - Binds `accountId` to the exact CLI `user`.
 * - Emits `unit` (`percent | money | tokens | requests | credits | count`), `resetAt`, `readAt` (falling back to `asOf`),
 *   and omits `remaining` (unknown) whenever Magpie marks the reading as failed or held from before (`lapsed`, `error`, or
 *   `asOf != nil` per `internal/provider/login_usage.go:43-55`), or when a window is `text` or `unlimited`.
 * - Uses `modelWindows` to map exact native model IDs onto pooled/named windows; omits `modelIds` on a pooled reading
 *   when unmapped (for example ordinary `Gemini` 5h / 7d windows) so it never masquerades as `Gemini 4 Argon`, while
 *   unpooled generic windows (such as Grok `"7 days"` or Codex `"5 hours"` / `"7 days"`) omit both `pool` and `modelIds`
 *   so Host `chooseAutoInstance` routes any model on that account using its allowance.
 */
export function mapMagpieAccountRows(rows, { agent = 'antigravity', modelWindows = new Map() } = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('Magpie CLI returned a non-array JSON payload for accounts.');
  }
  const normalizedAgent = normalizeMagpieAgentId(agent);
  const map = modelWindows instanceof Map
    ? modelWindows
    : parseModelWindows(modelWindows, { sourceId: normalizedAgent });
  const allowUnpooledModelFallback = !normalizedAgent || UNPOOLED_MODEL_ID_FALLBACK_SOURCES.has(normalizedAgent);
  const readings = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (agent && !magpieRowMatchesAgent(row.agent, agent)) {
      continue;
    }
    if (typeof row.user !== 'string' || row.user.trim().length === 0) {
      continue;
    }
    const accountId = cleanIdentifier(row.user, 'account user');
    const isDisabled = row.on === false || row.paused === true;
    const accountLabel = accountLabelOf(row, { isDisabled });
    const asOf = normalizeIsoTimestamp(row.asOf);
    const readAt = normalizeIsoTimestamp(row.readAt) ?? asOf;
    const windows = Array.isArray(row.windows) ? row.windows : [];
    const hasLapsed = typeof row.lapsed === 'string' && row.lapsed.trim().length > 0;
    const hasError = typeof row.error === 'string' && row.error.trim().length > 0;
    const hasAsOfFallback = asOf !== undefined || (row.asOf !== undefined && row.asOf !== null && String(row.asOf).trim() !== '');
    // Disabled/paused accounts (`on: false` / `paused: true`) and failed/stale fallback rows (`lapsed`, `error`, or
    // `asOf != nil` per `internal/provider/login_usage.go:43-55`) omit `remaining` (unknown) so they never participate
    // in `auto` instance selection with positive quota while still surfacing their disabled/unknown state in displays.
    const isUnusableAccountReading = isDisabled || hasLapsed || hasError || hasAsOfFallback;

    if (windows.length === 0) {
      const parsedWallet = !isUnusableAccountReading ? parseAccountBalanceString(row.balance) : undefined;
      readings.push({
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
        unit: parsedWallet?.unit ?? 'percent',
        ...(parsedWallet?.window ? { window: parsedWallet.window } : {}),
        ...(parsedWallet?.remaining !== undefined ? { remaining: parsedWallet.remaining } : {}),
        ...(readAt ? { readAt } : {}),
      });
      continue;
    }

    for (const span of windows) {
      if (!isRecord(span)) continue;
      const pool = cleanSingleLine(span.pool, 'window.pool');
      const windowLabel = normalizeWindowLabel(span.name, pool);
      const resetAt = normalizeIsoTimestamp(span.resetsAt ?? span.resetAt) ?? normalizeIsoTimestamp(span.runsOutAt);
      const rawMetrics = extractWindowMetrics(span);
      const metrics = isUnusableAccountReading
        ? { unit: rawMetrics.unit, remaining: undefined }
        : rawMetrics;
      const mappedIds = resolveMappedModelIds(span, windowLabel, map);

      let modelIds;
      if (mappedIds.length > 0) {
        modelIds = mappedIds;
      } else if (!pool && allowUnpooledModelFallback && looksLikeExactModelIdentifier(span.name)) {
        // When retrieveUserQuotaSummary was unavailable on Google Code Assist, Magpie leaves per-model windows unpooled with exact IDs.
        modelIds = [span.name.trim()];
      }

      readings.push({
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
        ...(modelIds ? { modelIds } : {}),
        ...(pool ? { pool } : {}),
        unit: metrics.unit,
        ...(windowLabel ? { window: windowLabel } : {}),
        ...(metrics.remaining !== undefined ? { remaining: metrics.remaining } : {}),
        ...(resetAt ? { resetAt } : {}),
        ...(readAt ? { readAt } : {}),
      });
    }
  }

  return readings;
}

export function defaultExecCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
          reject(abortError());
          return;
        }
        const stderrLines = typeof stderr === 'string' && stderr.trim()
          ? stderr.trim().split(/\r?\n/).filter(Boolean)
          : [];
        const meaningfulLine = stderrLines.at(-1) ?? '';
        const detail = meaningfulLine ? meaningfulLine.slice(0, 240) : error.message;
        const wrapped = new Error(`Magpie CLI command failed: ${detail}`);
        wrapped.exitCode = typeof error.code === 'number' ? error.code : 1;
        wrapped.stdout = typeof stdout === 'string' ? stdout : '';
        wrapped.stderr = typeof stderr === 'string' ? stderr : '';
        reject(wrapped);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function resolveOverrideAdapter(overrideEntry) {
  if (typeof overrideEntry === 'function') return { read: overrideEntry };
  if (isRecord(overrideEntry) && typeof overrideEntry.read === 'function') return overrideEntry;
  if (isRecord(overrideEntry) && isRecord(overrideEntry.adapter) && typeof overrideEntry.adapter.read === 'function') {
    return overrideEntry.adapter;
  }
  return undefined;
}

/**
 * Multi-source batch reader for Magpie `accounts <agent> --json`, with per-source accuracy override support
 * (`entry.mjs` wires `lib/antigravity-direct-quota.mjs`'s `MagpieAntigravityDirectQuotaService` onto `antigravity`
 * by default while Grok, Codex, Claude, Gemini, Cursor, Qoder, WorkBuddy, etc. read directly from Magpie CLI).
 *
 * Conforms strictly to `HarnessQuotaAdapter.read({ signal, settings, kikiHome }) -> { readings }`.
 * Refresh throttling (`>= 300000` ms) and single-flight caching are owned by the Kiki Host.
 */
export class MagpieQuotaService {
  constructor({
    execCommand = defaultExecCommand,
    sourceOverrides = {},
  } = {}) {
    this.execCommand = execCommand;
    this.sourceOverrides = new Map();
    if (isRecord(sourceOverrides)) {
      for (const [sourceId, entry] of Object.entries(sourceOverrides)) {
        this.setSourceOverride(sourceId, entry);
      }
    }
    this.adaptersBySource = new Map();
    this.adapter = this.adapterFor('antigravity');
  }

  setSourceOverride(sourceId, overrideEntry) {
    const key = cleanIdentifier(sourceId, 'quota source id');
    if (overrideEntry === null || overrideEntry === undefined) {
      this.sourceOverrides.delete(key);
      return;
    }
    const resolved = resolveOverrideAdapter(overrideEntry);
    if (!resolved) {
      throw new Error(`Invalid override for quota source "${key}": expected an adapter with read(context).`);
    }
    this.sourceOverrides.set(key, resolved);
  }

  adapterFor(sourceId = 'antigravity') {
    const key = cleanIdentifier(sourceId, 'quota source id');
    let adapter = this.adaptersBySource.get(key);
    if (!adapter) {
      adapter = {
        read: (context) => this.readSource(key, context),
      };
      this.adaptersBySource.set(key, adapter);
    }
    return adapter;
  }

  async read(context = {}) {
    return this.readSource('antigravity', context);
  }

  async readSource(sourceId, context = {}) {
    const signal = context?.signal;
    if (signal?.aborted) throw abortError();
    const settings = isRecord(context?.settings) ? context.settings : {};

    const override = this.sourceOverrides.get(sourceId);
    if (override) {
      const overrideResult = await override.read(context);
      if (signal?.aborted) throw abortError();
      return Array.isArray(overrideResult) ? { readings: overrideResult } : overrideResult;
    }

    const cliAgent = MAGPIE_CLI_AGENT_BY_SOURCE_ID[sourceId] ?? sourceId;
    const executable = resolveMagpieExecutable(settings);
    const modelWindows = parseModelWindows(settings.modelWindows, { sourceId });
    const kikiHome = cleanSingleLine(context?.kikiHome, 'kikiHome', { maxLength: 16_384 });

    const { stdout } = await this.execCommand(
      executable,
      ['accounts', cliAgent, '--json'],
      { signal, env: { ...process.env }, ...(kikiHome ? { cwd: kikiHome } : {}), timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (signal?.aborted) throw abortError();

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Magpie CLI returned invalid JSON for \`accounts ${cliAgent} --json\`.`);
    }
    const readings = mapMagpieAccountRows(parsed, {
      agent: cliAgent,
      modelWindows,
    });
    return { readings };
  }
}
