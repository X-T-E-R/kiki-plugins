import { advisorError, normalizeCandidateDefinition, PreferenceStore } from './store.mjs';

export const PROTECTED_ROLES = new Set(['writer', 'think', 'director']);

const ROLE_TO_GROUP = {
  implementer: 'implementation',
  'implementer-argon': 'implementation',
  'implementer-grokbuild': 'implementation',
  'agy-main': 'implementation',
  frontend: 'frontend',
  reviewer: 'review',
  researcher: 'research',
  writer: 'writing',
  think: 'thinking',
  director: 'director',
  worker: 'worker',
  explore: 'explore',
};

export const BUILTIN_GROUPS = {
  implementation: {
    id: 'implementation',
    label: 'Engineering Implementation',
    protectedRoleDefault: false,
    candidates: [
      {
        id: 'implementer:axon/gpt-6.1-sol',
        label: 'Implementer · GPT-6.1 Sol',
        kind: 'native-model',
        profile: 'implementer',
        modelId: 'axon/gpt-6.1-sol',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'implementer-grokbuild:grok-4.7',
        label: 'Grok Build · Grok 4.7',
        kind: 'external-harness',
        profile: 'implementer-grokbuild',
        executorId: 'grok-acp',
        modelId: 'grok-4.7',
        effort: 'xhigh',
        family: 'grok',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'implementer-argon:axon-message/gemini-4-argon',
        label: 'Implementer Argon · Gemini 4 Argon',
        kind: 'native-model',
        profile: 'implementer-argon',
        modelId: 'axon-message/gemini-4-argon',
        effort: 'high',
        family: 'gemini',
        defaultRank: 25,
        isRoleDefault: false,
      },
      {
        id: 'implementer:grok-4.7',
        label: 'Implementer · Grok 4.7 (Native)',
        kind: 'native-model',
        profile: 'implementer',
        modelId: 'grok-4.7',
        effort: 'xhigh',
        family: 'grok',
        defaultRank: 30,
        isRoleDefault: false,
      },
      {
        id: 'agy-main:gemini-4-argon-high',
        label: 'AGY CLI · Gemini 4 Argon (High)',
        kind: 'external-harness',
        profile: 'agy-main',
        executorId: 'agy-cli',
        modelId: 'gemini-4-argon-high',
        effort: 'high',
        family: 'gemini',
        defaultRank: 35,
        isRoleDefault: false,
      },
      {
        id: 'implementer:axon/gpt-6-astra',
        label: 'Implementer · GPT-6 Astra',
        kind: 'native-model',
        profile: 'implementer',
        modelId: 'axon/gpt-6-astra',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 40,
        isRoleDefault: false,
      },
    ],
  },
  writing: {
    id: 'writing',
    label: 'Writing & Editorial',
    protectedRoleDefault: true,
    defaultRole: 'writer',
    candidates: [
      {
        id: 'writer:axon-message/gemini-4-argon',
        label: 'Writer · Gemini 4 Argon (Default)',
        kind: 'native-model',
        profile: 'writer',
        modelId: 'axon-message/gemini-4-argon',
        effort: 'high',
        family: 'gemini',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'writer:axon-message/gemini-3.8-flash',
        label: 'Writer · Gemini 3.8 Flash',
        kind: 'native-model',
        profile: 'writer',
        modelId: 'axon-message/gemini-3.8-flash',
        effort: 'high',
        family: 'gemini',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'writer:deepseek-v4-flash',
        label: 'Writer · DeepSeek V4 Flash',
        kind: 'native-model',
        profile: 'writer',
        modelId: 'deepseek-v4-flash',
        effort: 'high',
        family: 'deepseek',
        defaultRank: 30,
        isRoleDefault: false,
      },
    ],
  },
  thinking: {
    id: 'thinking',
    label: 'Deep Reasoning (Think)',
    protectedRoleDefault: true,
    defaultRole: 'think',
    candidates: [
      {
        id: 'think:axon/gpt-6-astra',
        label: 'Think · GPT-6 Astra (Default)',
        kind: 'native-model',
        profile: 'think',
        modelId: 'axon/gpt-6-astra',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'think:axon-message/gemini-4-argon',
        label: 'Think · Gemini 4 Argon',
        kind: 'native-model',
        profile: 'think',
        modelId: 'axon-message/gemini-4-argon',
        effort: 'high',
        family: 'gemini',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'think:axon/gpt-6.1-sol',
        label: 'Think · GPT-6.1 Sol',
        kind: 'native-model',
        profile: 'think',
        modelId: 'axon/gpt-6.1-sol',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 30,
        isRoleDefault: false,
      },
      {
        id: 'think:grok-4.7',
        label: 'Think · Grok 4.7',
        kind: 'native-model',
        profile: 'think',
        modelId: 'grok-4.7',
        effort: 'xhigh',
        family: 'grok',
        defaultRank: 40,
        isRoleDefault: false,
      },
    ],
  },
  director: {
    id: 'director',
    label: 'Creative & AV Director',
    protectedRoleDefault: true,
    defaultRole: 'director',
    candidates: [
      {
        id: 'director:axon-message/gemini-4-argon',
        label: 'Director · Gemini 4 Argon (Default)',
        kind: 'native-model',
        profile: 'director',
        modelId: 'axon-message/gemini-4-argon',
        effort: 'high',
        family: 'gemini',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'director:anthropic/claude-opus-5-5',
        label: 'Director · Claude Opus 5.5',
        kind: 'native-model',
        profile: 'director',
        modelId: 'anthropic/claude-opus-5-5',
        effort: 'xhigh',
        family: 'claude',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'director:kimi-code/k3-256k',
        label: 'Director · K3 256K',
        kind: 'native-model',
        profile: 'director',
        modelId: 'kimi-code/k3-256k',
        effort: 'max',
        family: 'kimi',
        defaultRank: 30,
        isRoleDefault: false,
      },
    ],
  },
  frontend: {
    id: 'frontend',
    label: 'Frontend & UI Slice',
    protectedRoleDefault: false,
    candidates: [
      {
        id: 'frontend:axon-message/gemini-4-argon',
        label: 'Frontend · Gemini 4 Argon (Default)',
        kind: 'native-model',
        profile: 'frontend',
        modelId: 'axon-message/gemini-4-argon',
        effort: 'high',
        family: 'gemini',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'frontend:axon-message/gemini-3.8-flash',
        label: 'Frontend · Gemini 3.8 Flash',
        kind: 'native-model',
        profile: 'frontend',
        modelId: 'axon-message/gemini-3.8-flash',
        effort: 'high',
        family: 'gemini',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'frontend:deepseek-v4-flash',
        label: 'Frontend · DeepSeek V4 Flash',
        kind: 'native-model',
        profile: 'frontend',
        modelId: 'deepseek-v4-flash',
        effort: 'high',
        family: 'deepseek',
        defaultRank: 30,
        isRoleDefault: false,
      },
    ],
  },
  review: {
    id: 'review',
    label: 'Independent Review',
    protectedRoleDefault: false,
    candidates: [
      {
        id: 'reviewer:axon/gpt-6.1-sol',
        label: 'Reviewer · GPT-6.1 Sol (Default)',
        kind: 'native-model',
        profile: 'reviewer',
        modelId: 'axon/gpt-6.1-sol',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'reviewer:grok-4.7',
        label: 'Reviewer · Grok 4.7',
        kind: 'native-model',
        profile: 'reviewer',
        modelId: 'grok-4.7',
        effort: 'xhigh',
        family: 'grok',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'reviewer:kimi-code/k3-256k',
        label: 'Reviewer · K3 256K',
        kind: 'native-model',
        profile: 'reviewer',
        modelId: 'kimi-code/k3-256k',
        effort: 'max',
        family: 'kimi',
        defaultRank: 30,
        isRoleDefault: false,
      },
    ],
  },
  research: {
    id: 'research',
    label: 'Research & Synthesis',
    protectedRoleDefault: false,
    candidates: [
      {
        id: 'researcher:axon/gpt-6.1-sol',
        label: 'Researcher · GPT-6.1 Sol (Default)',
        kind: 'native-model',
        profile: 'researcher',
        modelId: 'axon/gpt-6.1-sol',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 10,
        isRoleDefault: true,
      },
      {
        id: 'researcher:axon-message/gemini-4-argon',
        label: 'Researcher · Gemini 4 Argon',
        kind: 'native-model',
        profile: 'researcher',
        modelId: 'axon-message/gemini-4-argon',
        effort: 'high',
        family: 'gemini',
        defaultRank: 20,
        isRoleDefault: false,
      },
      {
        id: 'researcher:axon/gpt-6-astra',
        label: 'Researcher · GPT-6 Astra',
        kind: 'native-model',
        profile: 'researcher',
        modelId: 'axon/gpt-6-astra',
        effort: 'xhigh',
        family: 'gpt',
        defaultRank: 30,
        isRoleDefault: false,
      },
    ],
  },
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function inferModelFamily(candidate) {
  if (typeof candidate?.family === 'string' && candidate.family.trim()) {
    return candidate.family.trim().toLowerCase();
  }
  const probe = `${candidate?.modelId ?? ''} ${candidate?.id ?? ''} ${candidate?.executorId ?? ''}`.toLowerCase();
  if (/\b(gpt|sol|astra|luna|o1|o3|o4|codex|openai)\b/.test(probe)) return 'gpt';
  if (/\bgrok\b/.test(probe)) return 'grok';
  if (/\b(gemini|argon|antigravity|agy)\b/.test(probe)) return 'gemini';
  if (/\b(claude|opus|sonnet|haiku|anthropic)\b/.test(probe)) return 'claude';
  if (/\b(kimi|k2|k3|moonshot)\b/.test(probe)) return 'kimi';
  if (/\bdeepseek\b/.test(probe)) return 'deepseek';
  return 'other';
}

function parseJsonSetting(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw advisorError('ADVISOR_INVALID_SETTINGS', `Invalid ${label} setting JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveEffectiveGroup(rawGroup, rawRole) {
  const role = typeof rawRole === 'string' && rawRole.trim() ? rawRole.trim().toLowerCase() : undefined;
  const explicitGroup = typeof rawGroup === 'string' && rawGroup.trim() ? rawGroup.trim() : undefined;
  if (explicitGroup) return { groupId: explicitGroup, role };
  if (role && ROLE_TO_GROUP[role]) return { groupId: ROLE_TO_GROUP[role], role };
  return { groupId: 'implementation', role };
}

function mergeCandidates(baseList, overrideList) {
  const byId = new Map();
  const order = [];
  for (const [idx, item] of baseList.entries()) {
    const normalized = normalizeCandidateDefinition(item, idx);
    byId.set(normalized.id, normalized);
    order.push(normalized.id);
  }
  if (Array.isArray(overrideList)) {
    for (const [idx, item] of overrideList.entries()) {
      const normalized = normalizeCandidateDefinition(item, baseList.length + idx);
      if (!byId.has(normalized.id)) order.push(normalized.id);
      byId.set(normalized.id, { ...byId.get(normalized.id), ...normalized });
    }
  }
  return order.map((id) => {
    const c = byId.get(id);
    return { ...c, family: inferModelFamily(c) };
  });
}

function buildCatalogIndex(catalog) {
  const modelsById = new Map();
  const modelsByRemoteId = new Map();
  const connectionsById = new Map();
  if (isRecord(catalog)) {
    if (Array.isArray(catalog.connections)) {
      for (const conn of catalog.connections) {
        if (isRecord(conn) && typeof conn.id === 'string') {
          connectionsById.set(conn.id, conn);
        }
      }
    }
    if (Array.isArray(catalog.models)) {
      for (const model of catalog.models) {
        if (!isRecord(model) || typeof model.id !== 'string') continue;
        modelsById.set(model.id, model);
        if (typeof model.remote_id === 'string' && !modelsByRemoteId.has(model.remote_id)) {
          modelsByRemoteId.set(model.remote_id, model);
        }
      }
    }
  }
  return { modelsById, modelsByRemoteId, connectionsById };
}

function evaluateCatalogAvailability(candidate, catalogIndex, hasCatalog) {
  if (candidate.kind === 'external-harness') {
    return {
      source: 'external-harness',
      catalogStatus: 'external_unverified_by_model_catalog',
      available: true,
      detail: `External harness (${candidate.executorId ?? candidate.profile ?? 'external'}); availability governed by executor runtime.`,
    };
  }
  if (candidate.kind === 'profile' && !candidate.modelId) {
    return {
      source: 'profile-declaration',
      catalogStatus: 'profile_declared',
      available: true,
      detail: `Profile candidate (${candidate.profile ?? candidate.id}).`,
    };
  }
  if (!hasCatalog) {
    return {
      source: 'candidate-input',
      catalogStatus: 'catalog_unavailable',
      available: true,
      detail: 'Host model catalog was not supplied; availability unknown.',
    };
  }
  const exact = candidate.modelId ? catalogIndex.modelsById.get(candidate.modelId) : undefined;
  if (exact) {
    const conn = catalogIndex.connectionsById.get(exact.provider_id);
    const connected = !conn || conn.status === 'connected';
    return {
      source: 'kiki-model-catalog',
      catalogStatus: connected ? 'connected' : (conn?.status ?? 'unconfigured'),
      available: connected,
      providerId: exact.provider_id,
      remoteId: exact.remote_id,
      detail: connected
        ? `Listed in Kiki model catalog (${exact.id}).`
        : `Listed in Kiki model catalog (${exact.id}) but connection "${exact.provider_id}" is ${conn?.status}.`,
    };
  }
  return {
    source: 'candidate-input',
    catalogStatus: 'not_in_catalog',
    available: false,
    detail: `Model "${candidate.modelId ?? candidate.id}" is not connected in Kiki models.list().`,
  };
}

function evaluateHardConstraints(candidate, constraints) {
  const blockedReasons = [];
  const allowedModels = [
    ...(Array.isArray(candidate.allowedModels) ? candidate.allowedModels : []),
  ];
  const callAllowedModels = Array.isArray(constraints?.allowedModels) ? constraints.allowedModels : undefined;
  const deniedModels = new Set([
    ...(Array.isArray(candidate.deniedModels) ? candidate.deniedModels : []),
    ...(Array.isArray(constraints?.deniedModels) ? constraints.deniedModels : []),
  ]);
  const allowedProfiles = Array.isArray(constraints?.allowedProfiles) ? constraints.allowedProfiles : undefined;
  const deniedProfiles = new Set(Array.isArray(constraints?.deniedProfiles) ? constraints.deniedProfiles : []);

  if (candidate.modelId) {
    if (allowedModels.length > 0 && !allowedModels.includes(candidate.modelId)) {
      blockedReasons.push(`Model "${candidate.modelId}" is outside candidate allowedModels.`);
    }
    if (callAllowedModels && callAllowedModels.length > 0 && !callAllowedModels.includes(candidate.modelId)) {
      blockedReasons.push(`Model "${candidate.modelId}" is outside hard allowedModels constraint.`);
    }
    if (deniedModels.has(candidate.modelId)) {
      blockedReasons.push(`Model "${candidate.modelId}" is excluded by hard deniedModels constraint.`);
    }
  }
  if (candidate.profile) {
    if (allowedProfiles && allowedProfiles.length > 0 && !allowedProfiles.includes(candidate.profile)) {
      blockedReasons.push(`Profile "${candidate.profile}" is outside hard allowedProfiles constraint.`);
    }
    if (deniedProfiles.has(candidate.profile)) {
      blockedReasons.push(`Profile "${candidate.profile}" is excluded by hard deniedProfiles constraint.`);
    }
  }
  return {
    admitted: blockedReasons.length === 0,
    blockedReasons,
  };
}

/**
 * Reads quota snapshot from Kiki Host's shared cached quota API when available,
 * or from an injected `readQuotaSnapshot` adapter in tests.
 * Never fabricates 0 or unlimited when quota is unavailable or unknown.
 */
async function readSharedQuota(context, injectedReadQuota) {
  const reader = injectedReadQuota
    ?? (typeof context?.quotas?.list === 'function' ? (opts) => context.quotas.list(opts) : undefined)
    ?? (typeof context?.quotas?.read === 'function' ? (opts) => context.quotas.read(opts) : undefined)
    ?? (typeof context?.harnessQuotas?.list === 'function' ? (opts) => context.harnessQuotas.list(opts) : undefined)
    ?? (typeof context?.harnessQuotas?.read === 'function' ? (opts) => context.harnessQuotas.read(opts) : undefined);

  if (!reader) {
    return {
      status: 'unavailable',
      source: 'none',
      readings: [],
      note: 'Host quota cache reader is not attached in this environment; quota treated as unknown.',
    };
  }

  try {
    const raw = await reader({ signal: context?.signal });
    const readings = Array.isArray(raw)
      ? raw
      : (isRecord(raw) && Array.isArray(raw.readings) ? raw.readings : (isRecord(raw) && Array.isArray(raw.items) ? raw.items : []));
    const source = isRecord(raw) && typeof raw.source === 'string' ? raw.source : 'host-shared-quota-cache';
    return {
      status: 'ok',
      source,
      readings,
    };
  } catch (error) {
    return {
      status: 'error',
      source: 'host-shared-quota-cache',
      readings: [],
      note: `Quota read failed (${error instanceof Error ? error.message : String(error)}); quota treated as unknown.`,
    };
  }
}

function matchQuotaForCandidate(candidate, readings) {
  if (!Array.isArray(readings) || readings.length === 0) {
    return { status: 'unknown', source: null, matchedReadings: [] };
  }
  const relevant = readings.filter((r) => {
    if (!isRecord(r)) return false;
    const engineMatch = candidate.executorId && typeof r.engineId === 'string' && r.engineId === candidate.executorId;
    const modelIds = Array.isArray(r.modelIds) ? r.modelIds : [];
    const exactModelMatch = Boolean(
      candidate.modelId && modelIds.some((id) => id === candidate.modelId)
    );
    if (candidate.kind === 'external-harness') {
      if (!engineMatch) return false;
      // Account-wide unpooled limit (no pool, no modelIds) or exact modelIds match.
      if (exactModelMatch) return true;
      if (!r.pool && modelIds.length === 0) return true;
      return false;
    }
    return exactModelMatch;
  });

  if (relevant.length === 0) {
    return { status: 'unknown', source: null, matchedReadings: [] };
  }

  // Group by accountId (or standalone reading) to find best usable account capacity for this candidate.
  // Within a single account, tightest window (min remaining of same unit) governs that account;
  // across multiple accounts on an external harness, best available account governs `auto` capacity.
  const byAccount = new Map();
  for (const item of relevant) {
    const key = typeof item.accountId === 'string' && item.accountId ? item.accountId : '__default__';
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(item);
  }

  const accountSummaries = [];
  for (const [accountId, items] of byAccount.entries()) {
    const knownNumeric = items.filter((i) => typeof i.remaining === 'number' && Number.isFinite(i.remaining));
    if (knownNumeric.length === 0) {
      accountSummaries.push({
        accountId: accountId === '__default__' ? undefined : accountId,
        accountLabel: items[0]?.accountLabel,
        status: 'unknown',
        unit: items[0]?.unit,
        remaining: undefined,
        resetsAt: items[0]?.resetsAt,
        readAt: items[0]?.readAt,
        sourceId: items[0]?.sourceId ?? items[0]?.source,
      });
      continue;
    }
    const primaryUnit = knownNumeric[0].unit ?? 'percent';
    const sameUnit = knownNumeric.filter((i) => (i.unit ?? 'percent') === primaryUnit);
    // Tightest window on this single account (e.g. 0% weekly blocks 80% 5h on the same account).
    let tightest = sameUnit[0];
    for (const w of sameUnit.slice(1)) {
      if (w.remaining < tightest.remaining) tightest = w;
    }
    accountSummaries.push({
      accountId: accountId === '__default__' ? undefined : accountId,
      accountLabel: tightest.accountLabel,
      status: tightest.remaining <= 0 ? 'exhausted' : 'known',
      unit: primaryUnit,
      remaining: tightest.remaining,
      window: tightest.window,
      pool: tightest.pool,
      resetsAt: tightest.resetsAt,
      readAt: tightest.readAt,
      sourceId: tightest.sourceId ?? tightest.source,
    });
  }

  const knownAccounts = accountSummaries.filter((a) => a.status === 'known' || a.status === 'exhausted');
  if (knownAccounts.length === 0) {
    return {
      status: 'unknown',
      source: accountSummaries[0]?.sourceId ?? 'quota-source',
      accounts: accountSummaries,
    };
  }

  const units = new Set(knownAccounts.map((a) => a.unit));
  if (units.size > 1) {
    return {
      status: 'incomparable_units',
      source: knownAccounts[0]?.sourceId ?? 'quota-source',
      accounts: accountSummaries,
    };
  }

  // Pick the account with the highest remaining quota for auto scheduling.
  let best = knownAccounts[0];
  for (const acc of knownAccounts.slice(1)) {
    if (acc.remaining > best.remaining) best = acc;
  }

  return {
    status: best.remaining <= 0 ? 'exhausted' : 'known',
    unit: best.unit,
    remaining: best.remaining,
    bestAccountId: best.accountId,
    bestAccountLabel: best.accountLabel,
    window: best.window,
    pool: best.pool,
    resetsAt: best.resetsAt,
    readAt: best.readAt,
    source: best.sourceId ?? 'quota-source',
    accounts: accountSummaries,
  };
}

function matchesToken(candidate, rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.trim()) return false;
  const token = rawToken.trim().toLowerCase();
  const fields = [
    candidate.id,
    candidate.modelId,
    candidate.profile,
    candidate.executorId,
    candidate.family,
    candidate.label,
  ]
    .filter((v) => typeof v === 'string')
    .map((v) => v.toLowerCase());

  if (fields.some((f) => f === token)) return true;
  // Support matching bare model tail after provider slash (e.g., "gpt-6.1-sol" matches "axon/gpt-6.1-sol").
  if (candidate.modelId && candidate.modelId.toLowerCase().endsWith(`/${token}`)) return true;
  // Support common aliases like "grok-build" / "grok build" -> grok-acp / implementer-grokbuild, "argon" -> gemini-4-argon
  if ((token === 'grok build' || token === 'grok-build') && (candidate.executorId === 'grok-acp' || candidate.profile === 'implementer-grokbuild')) {
    return true;
  }
  if (token === 'argon' && fields.some((f) => f.includes('argon'))) return true;
  if (token === 'non-gpt' && candidate.family !== 'gpt') return true;
  return false;
}

function preferenceEffectForCandidate(candidate, activePreference) {
  if (!activePreference) return { tier: 0, matchedToken: null };
  for (const [idx, token] of activePreference.prefer.entries()) {
    if (matchesToken(candidate, token)) {
      return { tier: 1, preferIndex: idx, matchedToken: token };
    }
  }
  for (const [idx, token] of activePreference.avoid.entries()) {
    if (matchesToken(candidate, token)) {
      return { tier: -1, avoidIndex: idx, matchedToken: token };
    }
  }
  return { tier: 0, matchedToken: null };
}

function isPreferenceApplicableToRole({ groupDef, role, preference }) {
  if (!preference) return { applicable: false, protectedPreserved: false };
  const normalizedRole = typeof role === 'string' && role.trim() ? role.trim().toLowerCase() : undefined;
  const isProtected = groupDef?.protectedRoleDefault === true || (normalizedRole ? PROTECTED_ROLES.has(normalizedRole) : false);
  if (!isProtected) {
    return { applicable: true, protectedPreserved: false };
  }
  const authorizedRoles = (preference.authorizedRoles ?? []).map((r) => r.toLowerCase());
  const roleName = normalizedRole ?? groupDef?.defaultRole?.toLowerCase();
  if (roleName && authorizedRoles.includes(roleName)) {
    return { applicable: true, protectedPreserved: false };
  }
  return {
    applicable: false,
    protectedPreserved: true,
    reason: `Role "${roleName ?? groupDef.id}" keeps its default model unless explicitly authorized in authorizedRoles or explicitTarget.`,
  };
}

function compareComparableQuota(aQuota, bQuota) {
  // Never assume unknown or incomparable quota is 0 or unlimited!
  // Only compare when BOTH candidates have known numeric remaining in the EXACT SAME unit,
  // OR deprioritize a known genuinely exhausted (remaining === 0) candidate behind a non-exhausted one.
  const aExhausted = aQuota.status === 'exhausted';
  const bExhausted = bQuota.status === 'exhausted';
  if (aExhausted !== bExhausted) {
    return aExhausted ? 1 : -1;
  }
  if (
    aQuota.status === 'known'
    && bQuota.status === 'known'
    && aQuota.unit
    && aQuota.unit === bQuota.unit
    && typeof aQuota.remaining === 'number'
    && typeof bQuota.remaining === 'number'
    && aQuota.remaining !== bQuota.remaining
  ) {
    return bQuota.remaining - aQuota.remaining;
  }
  return 0;
}

function buildReasonParts(entry, { protectedPreserved }) {
  const parts = [];
  if (!entry.constraints.admitted) {
    parts.push(`blocked by hard profile constraint (${entry.constraints.blockedReasons.join(' ')})`);
    return parts.join('; ');
  }
  if (!entry.availability.available) {
    parts.push(`unavailable in Kiki model catalog (${entry.availability.catalogStatus})`);
  } else if (entry.availability.source === 'external-harness') {
    parts.push(`external harness (${entry.candidate.executorId ?? entry.candidate.profile})`);
  }
  if (entry.explicitMatch) {
    parts.push('explicitly named for this turn (overrides soft preferences)');
  } else if (protectedPreserved && entry.candidate.isRoleDefault) {
    parts.push('protected role default preserved');
  } else if (entry.preferenceEffect.tier > 0) {
    parts.push(`preferred by user rule ("${entry.preferenceEffect.matchedToken}")`);
  } else if (entry.preferenceEffect.tier < 0) {
    parts.push(`deprioritized by user rule ("${entry.preferenceEffect.matchedToken}")`);
  }
  if (entry.quota.status === 'known') {
    const acct = entry.quota.bestAccountLabel ?? entry.quota.bestAccountId;
    parts.push(`remaining ${entry.quota.remaining} ${entry.quota.unit}${acct ? ` (${acct})` : ''}`);
  } else if (entry.quota.status === 'exhausted') {
    parts.push(`quota exhausted (0 ${entry.quota.unit})`);
  } else {
    parts.push('quota unknown');
  }
  return parts.join('; ');
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

    const settingsGroups = parseJsonSetting(context?.settings?.customGroups, 'customGroups');
    const { groupId, role } = resolveEffectiveGroup(args?.group, args?.role);

    const builtinGroup = BUILTIN_GROUPS[groupId];
    const settingGroup = isRecord(settingsGroups?.[groupId]) ? settingsGroups[groupId] : undefined;
    const storedCustomGroup = savedState.customGroups?.[groupId];

    const groupDef = storedCustomGroup ?? settingGroup ?? builtinGroup ?? {
      id: groupId,
      label: groupId,
      protectedRoleDefault: role ? PROTECTED_ROLES.has(role) : false,
      candidates: [],
    };

    const baseCandidates = Array.isArray(groupDef.candidates) ? groupDef.candidates : [];
    const mergedCandidates = mergeCandidates(baseCandidates, args?.candidates);

    const modelLister = listModels ?? (typeof context?.models?.list === 'function' ? () => context.models.list() : undefined);
    let catalog;
    let hasCatalog = false;
    if (modelLister) {
      catalog = await modelLister();
      hasCatalog = isRecord(catalog) && Array.isArray(catalog.models);
    }
    const catalogIndex = buildCatalogIndex(catalog);

    const quotaSnapshot = await readSharedQuota(context, readQuotaSnapshot);

    const rawPreference = savedState.preferences?.[groupId] ?? null;
    const roleApplication = isPreferenceApplicableToRole({
      groupDef,
      role,
      preference: rawPreference,
    });
    const effectivePreference = roleApplication.applicable ? rawPreference : null;

    const explicitTarget = typeof args?.explicitTarget === 'string' && args.explicitTarget.trim()
      ? args.explicitTarget.trim()
      : null;

    const evaluated = mergedCandidates.map((candidate) => {
      const constraints = evaluateHardConstraints(candidate, args?.constraints);
      const availability = evaluateCatalogAvailability(candidate, catalogIndex, hasCatalog);
      const quota = matchQuotaForCandidate(candidate, quotaSnapshot.readings);
      const explicitMatch = explicitTarget ? matchesToken(candidate, explicitTarget) : false;
      const preferenceEffect = preferenceEffectForCandidate(candidate, effectivePreference);

      const entry = {
        candidate,
        constraints,
        availability,
        quota,
        explicitMatch,
        preferenceEffect,
      };
      return {
        ...entry,
        reason: buildReasonParts(entry, { protectedPreserved: roleApplication.protectedPreserved }),
      };
    });

    evaluated.sort((a, b) => {
      // 1. Hard profile admission always wins (never violate hard constraints, even for explicitTarget).
      if (a.constraints.admitted !== b.constraints.admitted) {
        return a.constraints.admitted ? -1 : 1;
      }
      // 2. Availability in catalog (external harnesses remain eligible rather than dropped).
      if (a.availability.available !== b.availability.available) {
        return a.availability.available ? -1 : 1;
      }
      // 3. Explicit user selection for this turn beats soft preferences and role defaults.
      if (a.explicitMatch !== b.explicitMatch) {
        return a.explicitMatch ? -1 : 1;
      }
      // 4. Protected role default when no explicit role authorization was granted.
      if (roleApplication.protectedPreserved && a.candidate.isRoleDefault !== b.candidate.isRoleDefault) {
        return a.candidate.isRoleDefault ? -1 : 1;
      }
      // 5. Soft user preference within the functional group (+1 preferred > 0 neutral > -1 avoided).
      if (a.preferenceEffect.tier !== b.preferenceEffect.tier) {
        return b.preferenceEffect.tier - a.preferenceEffect.tier;
      }
      if (a.preferenceEffect.tier === 1 && a.preferenceEffect.preferIndex !== b.preferenceEffect.preferIndex) {
        return a.preferenceEffect.preferIndex - b.preferenceEffect.preferIndex;
      }
      // 6. Quota comparison: genuinely exhausted deprioritized; comparable same-unit higher remaining wins;
      //    unknown quota is neither 0 nor infinite (falls through to baseline rank).
      const quotaCmp = compareComparableQuota(a.quota, b.quota);
      if (quotaCmp !== 0) return quotaCmp;

      // 7. Baseline group rank.
      return a.candidate.defaultRank - b.candidate.defaultRank;
    });

    const rankedCandidates = evaluated.map((entry, idx) => ({
      rank: idx + 1,
      id: entry.candidate.id,
      label: entry.candidate.label,
      kind: entry.candidate.kind,
      profile: entry.candidate.profile ?? null,
      executorId: entry.candidate.executorId ?? null,
      modelId: entry.candidate.modelId ?? null,
      effort: entry.candidate.effort ?? null,
      family: entry.candidate.family,
      eligible: entry.constraints.admitted && entry.availability.available,
      admittedByProfileConstraints: entry.constraints.admitted,
      blockedReasons: entry.constraints.blockedReasons,
      catalog: {
        source: entry.availability.source,
        status: entry.availability.catalogStatus,
        available: entry.availability.available,
      },
      quota: {
        status: entry.quota.status,
        unit: entry.quota.unit ?? null,
        remaining: entry.quota.remaining ?? null,
        window: entry.quota.window ?? null,
        pool: entry.quota.pool ?? null,
        resetsAt: entry.quota.resetsAt ?? null,
        readAt: entry.quota.readAt ?? null,
        bestAccountId: entry.quota.bestAccountId ?? null,
        bestAccountLabel: entry.quota.bestAccountLabel ?? null,
        source: entry.quota.source ?? null,
      },
      explicitMatch: entry.explicitMatch,
      preferenceEffect: entry.preferenceEffect.tier > 0
        ? 'preferred'
        : (entry.preferenceEffect.tier < 0 ? 'avoided' : 'neutral'),
      reason: entry.reason,
    }));

    const recommended = rankedCandidates.find((item) => item.eligible && item.quota.status !== 'exhausted')
      ?? rankedCandidates.find((item) => item.eligible)
      ?? null;

    return {
      ok: true,
      advisoryOnly: true,
      group: {
        id: groupId,
        label: groupDef.label ?? groupId,
        role: role ?? null,
        protectedRoleDefault: Boolean(groupDef.protectedRoleDefault || (role && PROTECTED_ROLES.has(role))),
        protectedDefaultPreserved: roleApplication.protectedPreserved,
        ...(roleApplication.reason ? { protectionNote: roleApplication.reason } : {}),
      },
      explicitTarget,
      preference: rawPreference
        ? {
            applied: roleApplication.applicable,
            group: rawPreference.group,
            prefer: rawPreference.prefer,
            avoid: rawPreference.avoid,
            authorizedRoles: rawPreference.authorizedRoles,
            source: rawPreference.source,
          }
        : null,
      quotaSummary: {
        status: quotaSnapshot.status,
        source: quotaSnapshot.source,
        readingCount: quotaSnapshot.readings.length,
        ...(quotaSnapshot.note ? { note: quotaSnapshot.note } : {}),
      },
      recommended: recommended
        ? {
            id: recommended.id,
            label: recommended.label,
            kind: recommended.kind,
            profile: recommended.profile,
            executorId: recommended.executorId,
            modelId: recommended.modelId,
            effort: recommended.effort,
            reason: recommended.reason,
          }
        : null,
      candidates: rankedCandidates,
      ...(args?.includeAllGroups ? { allSavedPreferences: savedState.preferences } : {}),
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
          group: groupId,
          preference: state.preferences[groupId] ?? null,
          customGroup: state.customGroups[groupId] ?? null,
        };
      }
      return {
        ok: true,
        action: 'get',
        revision: state.revision,
        updatedAt: state.updatedAt,
        preferences: state.preferences,
        customGroups: state.customGroups,
      };
    }

    if (action === 'set') {
      const state = await activeStore.setPreference({
        group: args.group,
        prefer: args.prefer,
        avoid: args.avoid,
        authorizedRoles: args.authorizedRoles,
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
        includeCustomGroups: args.includeCustomGroups === true,
      });
      return {
        ok: true,
        action: 'clear',
        revision: state.revision,
        clearedGroups,
        remainingGroups: Object.keys(state.preferences),
      };
    }

    if (action === 'define_group') {
      const state = await activeStore.defineCustomGroup({
        group: args.group,
        groupLabel: args.groupLabel,
        protectedRoleDefault: args.protectedRoleDefault === true,
        candidates: args.candidates,
      });
      return {
        ok: true,
        action: 'define_group',
        revision: state.revision,
        customGroup: state.customGroups[args.group.trim()],
      };
    }

    if (action === 'remove_group') {
      const { state, removed } = await activeStore.removeCustomGroup({
        group: args.group,
      });
      return {
        ok: true,
        action: 'remove_group',
        revision: state.revision,
        removed,
      };
    }

    throw advisorError(
      'ADVISOR_UNKNOWN_ACTION',
      `Unsupported action "${String(action)}"; expected set, clear, get, define_group, or remove_group.`,
    );
  }

  return {
    recommend,
    updatePreference,
  };
}
