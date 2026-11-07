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

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed) || parsed <= Date.UTC(1970, 0, 1)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Presents a raw quota reading without fabricating 0 or infinite values.
 * Stale/failed fallback indicators (`lapsed`, `error`, or `asOf` fallback without valid live `remaining`)
 * remain `status: "unknown"` with `remaining: null` while preserving `readAt` / `asOf` timestamps.
 */
function presentQuotaReading(raw, fallbackSource) {
  const modelIds = Array.isArray(raw.modelIds)
    ? raw.modelIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : [];
  const readAt = normalizeIsoTimestamp(raw.readAt) ?? normalizeIsoTimestamp(raw.asOf);
  const asOf = normalizeIsoTimestamp(raw.asOf);
  const resetsAt = normalizeIsoTimestamp(raw.resetsAt ?? raw.resetAt);

  const hasStaleOrErrorFlag = Boolean(
    (typeof raw.lapsed === 'string' && raw.lapsed.trim())
    || (typeof raw.error === 'string' && raw.error.trim())
    || asOf !== null
    || (raw.asOf !== undefined && raw.asOf !== null && String(raw.asOf).trim() !== '')
    || raw.unlimited === true
    || raw.text === true,
  );

  const hasValidNumber = !hasStaleOrErrorFlag && typeof raw.remaining === 'number' && Number.isFinite(raw.remaining);
  const remaining = hasValidNumber ? Math.max(0, raw.remaining) : null;
  const status = hasValidNumber ? (remaining === 0 ? 'exhausted' : 'known') : 'unknown';

  return {
    source: typeof raw.sourceId === 'string' && raw.sourceId.trim()
      ? raw.sourceId.trim()
      : (typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : fallbackSource),
    engineId: typeof raw.engineId === 'string' && raw.engineId.trim() ? raw.engineId.trim() : null,
    accountId: typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId.trim() : null,
    accountLabel: typeof raw.accountLabel === 'string' && raw.accountLabel.trim() ? raw.accountLabel.trim() : null,
    pool: typeof raw.pool === 'string' && raw.pool.trim() ? raw.pool.trim() : null,
    window: typeof raw.window === 'string' && raw.window.trim() ? raw.window.trim() : null,
    modelIds,
    status,
    unit: hasValidNumber && typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : (typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : null),
    remaining,
    resetsAt,
    readAt,
    ...(asOf ? { asOf } : {}),
  };
}

function readingMatchesFilters(item, { targetTokens, engineTokens, accountTokens }) {
  if (engineTokens.length > 0) {
    const engine = item.engineId?.toLowerCase() ?? '';
    if (!engine || !engineTokens.includes(engine)) return false;
  }
  if (accountTokens.length > 0) {
    const acct = item.accountId?.toLowerCase() ?? '';
    const label = item.accountLabel?.toLowerCase() ?? '';
    if (!accountTokens.includes(acct) && !accountTokens.includes(label)) return false;
  }
  if (targetTokens.length > 0) {
    const haystacks = [
      item.source,
      item.engineId,
      item.accountId,
      item.accountLabel,
      item.pool,
      item.window,
      ...item.modelIds,
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
 * Reads quota snapshot from an explicitly injected `readQuotaSnapshot` adapter.
 * Host context quota wiring will be bound solely to the final `@kiki/plugin-sdk` read-only cache export once stabilized.
 * Never fabricates 0 or unlimited when quota is unavailable or unknown.
 */
async function readSharedQuota(context, injectedReadQuota) {
  if (typeof injectedReadQuota !== 'function') {
    return {
      status: 'unavailable',
      sources: [],
      readings: [],
      note: 'Shared host quota cache SDK is not yet bound in this environment; no quota readings available.',
    };
  }

  try {
    const raw = await injectedReadQuota({ signal: context?.signal });
    if (Array.isArray(raw)) {
      const readings = raw.filter(isRecord).map((r) => presentQuotaReading(r, 'shared-quota-cache'));
      return {
        status: 'ok',
        sources: [],
        readings,
      };
    }
    if (isRecord(raw) && Array.isArray(raw.sources)) {
      const sources = [];
      const readings = [];
      for (const src of raw.sources) {
        if (!isRecord(src)) continue;
        const sourceId = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : 'shared-quota-cache';
        const sourceReadAt = normalizeIsoTimestamp(src.readAt);
        const hasReadings = Array.isArray(src.readings);
        sources.push({
          id: sourceId,
          label: typeof src.label === 'string' ? src.label : sourceId,
          engineIds: Array.isArray(src.engineIds) ? src.engineIds : [],
          readAt: sourceReadAt,
          cached: hasReadings,
        });
        if (hasReadings) {
          for (const item of src.readings) {
            if (!isRecord(item)) continue;
            readings.push(presentQuotaReading(
              { ...item, readAt: item.readAt ?? sourceReadAt, sourceId: item.sourceId ?? sourceId },
              sourceId,
            ));
          }
        }
      }
      return {
        status: 'ok',
        sources,
        readings,
      };
    }
    if (isRecord(raw) && Array.isArray(raw.readings)) {
      const sourceId = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'shared-quota-cache';
      const sourceReadAt = normalizeIsoTimestamp(raw.readAt);
      const readings = raw.readings
        .filter(isRecord)
        .map((r) => presentQuotaReading({ ...r, readAt: r.readAt ?? sourceReadAt }, sourceId));
      return {
        status: 'ok',
        sources: [{ id: sourceId, label: sourceId, engineIds: [], readAt: sourceReadAt, cached: true }],
        readings,
      };
    }
    return {
      status: 'ok',
      sources: [],
      readings: [],
    };
  } catch (error) {
    return {
      status: 'error',
      sources: [],
      readings: [],
      note: `Quota read failed (${error instanceof Error ? error.message : String(error)}); quota treated as unknown.`,
    };
  }
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
  readQuotaSnapshot,
  listModels,
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

    const quotaSnapshot = await readSharedQuota(context, readQuotaSnapshot);
    const filteredReadings = quotaSnapshot.readings.filter((item) =>
      readingMatchesFilters(item, { targetTokens, engineTokens, accountTokens }),
    );

    let models;
    if (args?.includeModels === true) {
      const modelLister = listModels ?? (typeof context?.models?.list === 'function' ? () => context.models.list() : undefined);
      if (modelLister) {
        const catalog = await modelLister();
        models = presentConnectedModels(catalog, targetTokens);
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
      quota: {
        status: quotaSnapshot.status,
        sources: quotaSnapshot.sources,
        totalCachedReadings: quotaSnapshot.readings.length,
        matchedReadingCount: filteredReadings.length,
        ...(quotaSnapshot.note ? { note: quotaSnapshot.note } : {}),
        readings: filteredReadings,
      },
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
