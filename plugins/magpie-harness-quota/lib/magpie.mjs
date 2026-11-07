import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { ANTIGRAVITY_ENGINE_IDS } from './definitions.mjs';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

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

export function resolveMagpieExecutable(settings) {
  const configured = cleanSingleLine(settings?.magpiePath, 'magpiePath', { maxLength: 16_384 });
  if (!configured) return process.platform === 'win32' ? 'magpie.exe' : 'magpie';
  if (!path.isAbsolute(configured)) {
    throw new Error('magpiePath must be an absolute path on the Kiki server, or omitted to use magpie on PATH.');
  }
  return configured;
}

function normalizeSelectorRule(rule, modelId) {
  if (typeof rule === 'string') {
    const pool = cleanSingleLine(rule, `modelWindows[${modelId}]`, { required: true });
    return { pool };
  }
  if (!isRecord(rule)) {
    throw new Error(`modelWindows[${modelId}] must be an object with pool and/or name (or window).`);
  }
  const allowedKeys = new Set(['pool', 'name', 'window']);
  for (const key of Object.keys(rule)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported key "${key}" in modelWindows[${modelId}]; allowed keys are pool, name, window.`);
    }
  }
  const pool = cleanSingleLine(rule.pool, `modelWindows[${modelId}].pool`);
  const name = cleanSingleLine(rule.name ?? rule.window, `modelWindows[${modelId}].name`);
  if (!pool && !name) {
    throw new Error(`modelWindows[${modelId}] must specify at least pool or name.`);
  }
  return {
    ...(pool ? { pool } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Parses `modelWindows` JSON string (or object) mapping exact native model IDs
 * to exact Magpie `pool` and/or `name` window selectors.
 */
export function parseModelWindows(raw) {
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
    throw new Error('modelWindows must be a JSON object mapping exact native model IDs to { pool?, name? }.');
  }
  const mappings = new Map();
  for (const [rawModelId, rawValue] of Object.entries(parsed)) {
    const modelId = cleanIdentifier(rawModelId, 'modelWindows model ID');
    const selectors = Array.isArray(rawValue)
      ? rawValue.map((entry) => normalizeSelectorRule(entry, modelId))
      : [normalizeSelectorRule(rawValue, modelId)];
    if (selectors.length === 0) {
      throw new Error(`modelWindows[${modelId}] cannot be an empty array.`);
    }
    mappings.set(modelId, selectors);
  }
  return mappings;
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
  if (selector.pool !== undefined && rawPool !== selector.pool) return false;
  if (selector.name !== undefined && rawName !== selector.name && shortWindow !== selector.name) return false;
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
  if (!isRecord(span)) return {};
  if (span.unlimited === true || span.text === true) {
    return {
      unit: typeof span.unit === 'string' && span.unit.trim() ? span.unit.trim() : undefined,
      remaining: undefined,
    };
  }
  if (typeof span.balance === 'number' && Number.isFinite(span.balance)) {
    return {
      unit: typeof span.unit === 'string' && span.unit.trim() ? span.unit.trim() : 'credits',
      remaining: Math.max(0, span.balance),
    };
  }
  if (typeof span.limit === 'number' && Number.isFinite(span.limit) && span.limit > 0
      && typeof span.amount === 'number' && Number.isFinite(span.amount)) {
    const hasPercent = typeof span.remaining === 'number' && Number.isFinite(span.remaining);
    if (!hasPercent) {
      return {
        unit: typeof span.unit === 'string' && span.unit.trim() ? span.unit.trim() : 'credits',
        remaining: Math.max(0, span.limit - span.amount),
      };
    }
  }
  if (typeof span.remaining === 'number' && Number.isFinite(span.remaining)) {
    return {
      unit: typeof span.unit === 'string' && span.unit.trim() ? span.unit.trim() : 'percent',
      remaining: Math.max(0, Math.min(100, span.remaining)),
    };
  }
  if (typeof span.used === 'number' && Number.isFinite(span.used)) {
    return {
      unit: typeof span.unit === 'string' && span.unit.trim() ? span.unit.trim() : 'percent',
      remaining: Math.max(0, Math.min(100, 100 - span.used)),
    };
  }
  return {
    unit: typeof span.unit === 'string' && span.unit.trim() ? span.unit.trim() : undefined,
    remaining: undefined,
  };
}

function accountLabelOf(row) {
  const alias = cleanSingleLine(row.alias, 'alias');
  if (alias) return alias;
  const seat = cleanSingleLine(row.seat, 'seat');
  if (seat) return seat;
  return undefined;
}

/**
 * Projects Magpie `accounts antigravity --json` rows into Kiki HarnessQuotaReading items.
 *
 * Rules:
 * - Binds `accountId` to the exact CLI `user`.
 * - Preserves `remaining`, `resetsAt`, `readAt` (falling back to `asOf`), and retains `undefined` (unknown)
 *   whenever Magpie marks the reading as failed or held from before (`lapsed`, `error`, or `asOf != nil` per
 *   `internal/provider/login_usage.go:43-55`), or when a window is `text` or `unlimited`.
 * - Uses `modelWindows` to map exact native model IDs onto pooled/named windows; omits `modelIds` on a pooled reading
 *   when unmapped so it can be displayed without routing misattribution.
 */
export function mapMagpieAccountRows(rows, { engineId = 'agy-cli', agent = 'antigravity', modelWindows = new Map() } = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('Magpie CLI returned a non-array JSON payload for accounts.');
  }
  const map = modelWindows instanceof Map ? modelWindows : parseModelWindows(modelWindows);
  const readings = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (typeof row.agent === 'string' && agent && row.agent.toLowerCase() !== agent.toLowerCase()) {
      continue;
    }
    if (typeof row.user !== 'string' || row.user.trim().length === 0) {
      continue;
    }
    const accountId = row.user.trim();
    const accountLabel = accountLabelOf(row);
    const asOf = normalizeIsoTimestamp(row.asOf);
    const readAt = normalizeIsoTimestamp(row.readAt) ?? asOf;
    const windows = Array.isArray(row.windows) ? row.windows : [];
    const hasLapsed = typeof row.lapsed === 'string' && row.lapsed.trim().length > 0;
    const hasError = typeof row.error === 'string' && row.error.trim().length > 0;
    const hasAsOfFallback = asOf !== undefined || (row.asOf !== undefined && row.asOf !== null && String(row.asOf).trim() !== '');
    // Per Magpie login_usage.go:43-55, AsOf != nil or Error != "" means the latest read failed
    // and any windows shown are stale fallback values, never usable as current schedulable quota.
    const isUnusableAccountReading = hasLapsed || hasError || hasAsOfFallback;

    if (windows.length === 0) {
      const reading = {
        engineId,
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
        ...(readAt ? { readAt } : {}),
      };
      readings.push(reading);
      continue;
    }

    for (const span of windows) {
      if (!isRecord(span)) continue;
      const pool = cleanSingleLine(span.pool, 'window.pool');
      const windowLabel = normalizeWindowLabel(span.name, pool);
      const resetsAt = normalizeIsoTimestamp(span.resetsAt) ?? normalizeIsoTimestamp(span.runsOutAt);
      const metrics = isUnusableAccountReading ? { unit: undefined, remaining: undefined } : extractWindowMetrics(span);
      const mappedIds = resolveMappedModelIds(span, windowLabel, map);

      let modelIds;
      if (mappedIds.length > 0) {
        modelIds = mappedIds;
      } else if (!pool && typeof span.name === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(span.name.trim())) {
        // When retrieveUserQuotaSummary was unavailable, Magpie leaves per-model windows unpooled with exact IDs.
        modelIds = [span.name.trim()];
      }

      const reading = {
        engineId,
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
        ...(pool ? { pool } : {}),
        ...(modelIds ? { modelIds } : {}),
        ...(metrics.unit ? { unit: metrics.unit } : {}),
        ...(windowLabel ? { window: windowLabel } : {}),
        ...(metrics.remaining !== undefined ? { remaining: metrics.remaining } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        ...(readAt ? { readAt } : {}),
      };
      readings.push(reading);
    }
  }

  return readings;
}

function buildCliEnvironment(osHome, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (typeof osHome === 'string' && osHome.trim().length > 0) {
    const home = osHome.trim();
    env.HOME = home;
    if (process.platform === 'win32') {
      env.USERPROFILE = home;
    }
  }
  return env;
}

function defaultExecCommand(executable, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      env: options.env,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
          reject(abortError());
          return;
        }
        const detail = typeof stderr === 'string' && stderr.trim()
          ? stderr.trim().split(/\r?\n/)[0].slice(0, 240)
          : error.message;
        reject(new Error(`Magpie CLI accounts read failed: ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Single-shot batch reader for Magpie `accounts antigravity --json`.
 * Refresh throttling and single-flight caching are owned by the Kiki Host.
 */
export class MagpieQuotaService {
  constructor({ execCommand = defaultExecCommand } = {}) {
    this.execCommand = execCommand;
    this.adapter = {
      read: (context) => this.read(context),
    };
  }

  async read(context = {}) {
    const signal = context?.signal;
    if (signal?.aborted) throw abortError();

    const settings = isRecord(context?.settings) ? context.settings : {};
    const executable = resolveMagpieExecutable(settings);
    const modelWindows = parseModelWindows(settings.modelWindows);
    const osHome = cleanSingleLine(context?.osHome, 'osHome', { maxLength: 16_384 });
    const env = buildCliEnvironment(osHome);

    const { stdout } = await this.execCommand(
      executable,
      ['accounts', 'antigravity', '--json'],
      { signal, env, timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (signal?.aborted) throw abortError();

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('Magpie CLI returned invalid JSON for `accounts antigravity --json`.');
    }
    return mapMagpieAccountRows(parsed, {
      engineId: ANTIGRAVITY_ENGINE_IDS[0],
      agent: 'antigravity',
      modelWindows,
    });
  }
}
