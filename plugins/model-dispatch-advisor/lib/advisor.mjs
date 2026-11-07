import { advisorError, PreferenceStore } from './store.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFilterTokens(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

function normalizeCandidateIds(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed) || parsed <= Date.UTC(1970, 0, 1)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * Presents one `HarnessQuotaReading` from a `PluginHarnessQuotaSnapshot` without fabricating 0 or infinite values.
 * Per `@kiki/plugin-sdk/harness-quota`, omitted `remaining` means unknown (`status: "unknown"`, `remaining: null`),
 * while `0` is a known exhausted value (`status: "exhausted"`, `remaining: 0`).
 */
function presentQuotaReading(raw, snapshotReadAt) {
  const modelIds = Array.isArray(raw.modelIds)
    ? raw.modelIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : [];
  const readAt = normalizeIsoTimestamp(raw.readAt) ?? snapshotReadAt ?? null;
  const resetAt = normalizeIsoTimestamp(raw.resetAt) ?? null;

  const hasValidNumber = typeof raw.remaining === 'number' && Number.isFinite(raw.remaining) && raw.remaining >= 0;
  const remaining = hasValidNumber ? raw.remaining : null;
  const status = hasValidNumber ? (remaining === 0 ? 'exhausted' : 'known') : 'unknown';

  return {
    accountId: typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId.trim() : null,
    accountLabel: typeof raw.accountLabel === 'string' && raw.accountLabel.trim() ? raw.accountLabel.trim() : null,
    modelIds,
    pool: typeof raw.pool === 'string' && raw.pool.trim() ? raw.pool.trim() : null,
    unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : null,
    window: typeof raw.window === 'string' && raw.window.trim() ? raw.window.trim() : null,
    status,
    remaining,
    resetAt,
    readAt,
  };
}

function sourceMatchesEngineFilter(engineIds, engineTokens) {
  if (engineTokens.length === 0) return true;
  const lower = engineIds.map((id) => id.toLowerCase());
  return engineTokens.some((token) => lower.includes(token));
}

function readingMatchesFilters(reading, sourceMeta, { targetTokens, accountTokens }) {
  if (accountTokens.length > 0) {
    const acct = reading.accountId?.toLowerCase() ?? '';
    const label = reading.accountLabel?.toLowerCase() ?? '';
    if (!accountTokens.includes(acct) && !accountTokens.includes(label)) return false;
  }
  if (targetTokens.length > 0) {
    const haystacks = [
      sourceMeta.id,
      sourceMeta.label,
      ...sourceMeta.engineIds,
      reading.accountId,
      reading.accountLabel,
      reading.pool,
      reading.window,
      ...reading.modelIds,
    ]
      .filter((v) => typeof v === 'string' && v.length > 0)
      .map((v) => v.toLowerCase());

    const matched = targetTokens.some((token) => haystacks.some(
      (field) => field === token || field.endsWith(`/${token}`),
    ));
    if (!matched) return false;
  }
  return true;
}

/**
 * Consumes the sole official read-only Host cache contract: `context.harnessQuota.cached()`.
 * Returns `{ sources: [{ id, label, engineIds, minRefreshIntervalMs, readAt?, readings? }] }` with no top-level `readings`.
 * Does NOT poll Magpie or any quota backend, and never probes rejected legacy context properties.
 * When `readings` is omitted on a source (not yet cached, or latest read failed within interval), that source's
 * status is `"unknown"` (`readings: null`), never fabricated as 0 or unlimited.
 */
async function readHostCachedQuota(context, filters) {
  if (typeof context?.harnessQuota?.cached !== 'function') {
    return {
      status: 'unavailable',
      sources: [],
      note: 'Host context.harnessQuota.cached() is not available on this runtime; quota treated as unknown.',
    };
  }

  let response;
  try {
    response = await context.harnessQuota.cached();
  } catch (error) {
    return {
      status: 'error',
      sources: [],
      note: `context.harnessQuota.cached() failed (${error instanceof Error ? error.message : String(error)}); quota treated as unknown.`,
    };
  }

  if (!isRecord(response) || !Array.isArray(response.sources)) {
    return {
      status: 'error',
      sources: [],
      note: 'context.harnessQuota.cached() returned an unexpected payload (expected { sources: [...] }).',
    };
  }

  const sources = [];
  for (const rawSource of response.sources) {
    if (!isRecord(rawSource) || typeof rawSource.id !== 'string' || !rawSource.id.trim()) continue;
    const engineIds = Array.isArray(rawSource.engineIds)
      ? rawSource.engineIds.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim())
      : [];
    if (!sourceMatchesEngineFilter(engineIds, filters.engineTokens)) continue;

    const id = rawSource.id.trim();
    const label = typeof rawSource.label === 'string' && rawSource.label.trim() ? rawSource.label.trim() : id;
    const minRefreshIntervalMs = typeof rawSource.minRefreshIntervalMs === 'number' && Number.isFinite(rawSource.minRefreshIntervalMs)
      ? rawSource.minRefreshIntervalMs
      : 300_000;
    const readAt = normalizeIsoTimestamp(rawSource.readAt) ?? null;

    if (!Array.isArray(rawSource.readings)) {
      // Per contract: omitted `readings` means unknown (cache not yet populated or last read failed within interval).
      sources.push({
        id,
        label,
        engineIds,
        minRefreshIntervalMs,
        status: 'unknown',
        cached: false,
        readAt,
        readings: null,
      });
      continue;
    }

    const sourceMeta = { id, label, engineIds };
    const presentedReadings = rawSource.readings
      .filter(isRecord)
      .map((item) => presentQuotaReading(item, readAt ?? undefined))
      .filter((item) => readingMatchesFilters(item, sourceMeta, filters));

    sources.push({
      id,
      label,
      engineIds,
      minRefreshIntervalMs,
      status: 'cached',
      cached: true,
      readAt,
      totalCachedReadings: rawSource.readings.length,
      readings: presentedReadings,
    });
  }

  return {
    status: 'ok',
    sources,
  };
}

function presentConnectedModels(catalog, targetTokens) {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) return [];
  const connectionsById = new Map();
  if (Array.isArray(catalog.connections)) {
    for (const conn of catalog.connections) {
      if (isRecord(conn) && typeof conn.id === 'string') {
        connectionsById.set(conn.id, conn);
      }
    }
  }
  const items = [];
  for (const model of catalog.models) {
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) continue;
    const id = model.id.trim();
    const remoteId = typeof model.remote_id === 'string' ? model.remote_id : null;
    const displayName = typeof model.display_name === 'string' ? model.display_name : null;
    if (targetTokens.length > 0) {
      const fields = [id, remoteId, displayName, model.provider_id]
        .filter((v) => typeof v === 'string' && v.length > 0)
        .map((v) => v.toLowerCase());
      const matched = targetTokens.some((token) => fields.some((f) => f === token || f.endsWith(`/${token}`)));
      if (!matched) continue;
    }
    const conn = connectionsById.get(model.provider_id);
    items.push({
      id,
      providerId: model.provider_id ?? null,
      remoteId,
      displayName,
      connectionStatus: conn?.status ?? 'unknown',
      service: conn?.service ?? null,
    });
  }
  return items;
}

export function createDispatchAdvisor({
  store,
  kikiHome,
  dataDir,
  now,
} = {}) {
  const resolveStore = (context) => {
    if (store) return store;
    return new PreferenceStore({
      kikiHome: context?.kikiHome ?? kikiHome,
      dataDir: context?.dataDir ?? dataDir,
      now,
    });
  };

  async function recommend(args = {}, context = {}) {
    const activeStore = resolveStore(context);
    const savedState = await activeStore.read();

    const requestedGroup = typeof args?.group === 'string' && args.group.trim()
      ? args.group.trim()
      : null;

    const targetTokens = normalizeFilterTokens(args?.targets);
    const engineTokens = normalizeFilterTokens(args?.engineIds);
    const accountTokens = normalizeFilterTokens(args?.accountIds);

    const quota = await readHostCachedQuota(context, {
      targetTokens,
      engineTokens,
      accountTokens,
    });

    let models;
    if (args?.includeModels === true) {
      if (typeof context?.models?.list === 'function') {
        const candidates = normalizeCandidateIds(args?.modelCandidates);
        const catalog = await context.models.list(candidates !== undefined ? { candidates } : undefined);
        models = presentConnectedModels(catalog, candidates !== undefined ? [] : targetTokens);
      } else {
        models = [];
      }
    }

    const scopedPreference = requestedGroup
      ? (savedState.preferences?.[requestedGroup] ?? null)
      : null;

    const includeAll = args?.includeAllGroups === true || requestedGroup === null;

    return {
      ok: true,
      informationOnly: true,
      scope: {
        group: requestedGroup,
        revision: savedState.revision,
        updatedAt: savedState.updatedAt,
      },
      preference: scopedPreference,
      ...(includeAll ? { preferencesByGroup: savedState.preferences } : {}),
      quota,
      ...(models !== undefined ? { connectedModels: models } : {}),
    };
  }

  async function updatePreference(args = {}, context = {}) {
    const activeStore = resolveStore(context);
    const action = args?.action;

    if (action === 'get') {
      const state = await activeStore.read();
      if (typeof args?.group === 'string' && args.group.trim()) {
        const groupId = args.group.trim();
        return {
          ok: true,
          action: 'get',
          revision: state.revision,
          updatedAt: state.updatedAt,
          group: groupId,
          preference: state.preferences[groupId] ?? null,
        };
      }
      return {
        ok: true,
        action: 'get',
        revision: state.revision,
        updatedAt: state.updatedAt,
        preferences: state.preferences,
      };
    }

    if (action === 'set') {
      const state = await activeStore.setPreference({
        group: args.group,
        prefer: args.prefer,
        avoid: args.avoid,
        note: args.note,
        userAuthorized: args.userAuthorized,
        userQuote: args.userQuote,
        sourceNote: args.sourceNote,
      });
      return {
        ok: true,
        action: 'set',
        revision: state.revision,
        preference: state.preferences[args.group.trim()],
      };
    }

    if (action === 'clear') {
      const { state, clearedGroups } = await activeStore.clearPreference({
        group: args.group,
        clearAll: args.clearAll === true,
      });
      return {
        ok: true,
        action: 'clear',
        revision: state.revision,
        clearedGroups,
        remainingGroups: Object.keys(state.preferences),
      };
    }

    throw advisorError(
      'ADVISOR_UNKNOWN_ACTION',
      `Unsupported action "${String(action)}"; expected set, clear, or get.`,
    );
  }

  return {
    recommend,
    updatePreference,
  };
}
