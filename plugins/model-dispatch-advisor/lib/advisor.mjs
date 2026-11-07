import { advisorError, normalizeCandidateDefinition, PreferenceStore } from './store.mjs';

export const PROTECTED_ROLES = new Set(['writer', 'think', 'director']);

const ROLE_TO_GROUP = {
  implementer: 'implementation',
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
  },
  writing: {
    id: 'writing',
    label: 'Writing & Editorial',
    protectedRoleDefault: true,
    defaultRole: 'writer',
  },
  thinking: {
    id: 'thinking',
    label: 'Deep Reasoning (Think)',
    protectedRoleDefault: true,
    defaultRole: 'think',
  },
  director: {
    id: 'director',
    label: 'Creative & AV Director',
    protectedRoleDefault: true,
    defaultRole: 'director',
  },
  frontend: {
    id: 'frontend',
    label: 'Frontend & UI Slice',
    protectedRoleDefault: false,
  },
  review: {
    id: 'review',
    label: 'Independent Review',
    protectedRoleDefault: false,
  },
  research: {
    id: 'research',
    label: 'Research & Synthesis',
    protectedRoleDefault: false,
  },
  worker: {
    id: 'worker',
    label: 'Bounded Worker Execution',
    protectedRoleDefault: false,
  },
  explore: {
    id: 'explore',
    label: 'Bounded Evidence Exploration',
    protectedRoleDefault: false,
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
  if (role && role.startsWith('implementer')) return { groupId: 'implementation', role };
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

function deriveCatalogCandidates(catalog, catalogIndex) {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) return [];
  const derived = [];
  for (const model of catalog.models) {
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) continue;
    const conn = catalogIndex.connectionsById.get(model.provider_id);
    if (conn && conn.service && conn.service !== 'chat') continue;
    const id = model.id.trim();
    const label = typeof model.display_name === 'string' && model.display_name.trim()
      ? model.display_name.trim()
      : id;
    derived.push({
      id,
      label,
      kind: 'native-model',
      modelId: id,
      defaultRank: 10 + derived.length * 10,
      isRoleDefault: false,
      family: inferModelFamily({ id, modelId: id, label }),
    });
  }
  return derived;
}

function evaluateCatalogAvailability(candidate, catalogIndex, hasCatalog) {
  if (candidate.kind === 'external-harness') {
    if (candidate.available === true) {
      return {
        source: 'external-harness',
        catalogStatus: 'caller_verified',
        available: true,
        detail: `External harness (${candidate.executorId ?? candidate.profile ?? 'external'}) marked ready by caller/configuration.`,
      };
    }
    if (candidate.available === false) {
      return {
        source: 'external-harness',
        catalogStatus: 'caller_unavailable',
        available: false,
        detail: `External harness (${candidate.executorId ?? candidate.profile ?? 'external'}) marked unavailable by caller/configuration.`,
      };
    }
    return {
      source: 'external-harness',
      catalogStatus: 'external_unverified_by_model_catalog',
      available: false,
      detail: `External harness (${candidate.executorId ?? candidate.profile ?? 'external'}) cannot be verified from context.models.list(); supply available: true when profile/executor readiness is confirmed.`,
    };
  }
  if (candidate.kind === 'profile' && !candidate.modelId) {
    if (candidate.available === false) {
      return {
        source: 'profile-declaration',
        catalogStatus: 'caller_unavailable',
        available: false,
        detail: `Profile candidate (${candidate.profile ?? candidate.id}) marked unavailable by caller.`,
      };
    }
    if (candidate.isRoleDefault || candidate.available === true) {
      return {
        source: 'profile-inheritance',
        catalogStatus: candidate.isRoleDefault ? 'profile_inherited_default' : 'caller_verified',
        available: true,
        detail: candidate.isRoleDefault
          ? `Inherited default for profile "${candidate.profile ?? candidate.id}" (omit model_alias/effort to preserve profile default).`
          : `Profile candidate (${candidate.profile ?? candidate.id}) marked available by caller.`,
      };
    }
    return {
      source: 'profile-declaration',
      catalogStatus: 'profile_unverified_by_model_catalog',
      available: false,
      detail: `Profile "${candidate.profile ?? candidate.id}" cannot be verified from context.models.list(); supply available: true or modelId when confirmed.`,
    };
  }
  if (!hasCatalog) {
    const ready = candidate.available !== false;
    return {
      source: 'candidate-input',
      catalogStatus: 'catalog_unavailable',
      available: ready,
      detail: 'Host model catalog was not supplied; availability taken from candidate input.',
    };
  }
  const exact = candidate.modelId ? catalogIndex.modelsById.get(candidate.modelId) : undefined;
  if (exact) {
    const conn = catalogIndex.connectionsById.get(exact.provider_id);
    const connected = (!conn || conn.status === 'connected') && candidate.available !== false;
    return {
      source: 'kiki-model-catalog',
      catalogStatus: !conn || conn.status === 'connected'
        ? (candidate.available === false ? 'caller_unavailable' : 'connected')
        : (conn?.status ?? 'unconfigured'),
      available: connected,
      providerId: exact.provider_id,
      remoteId: exact.remote_id,
      detail: connected
        ? `Connected in Kiki model catalog (${exact.id}).`
        : `Listed in Kiki model catalog (${exact.id}) but connection "${exact.provider_id}" is ${conn?.status ?? 'unavailable'}.`,
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
  const hasCandidateAllowedModels = Array.isArray(candidate.allowedModels);
  const candidateAllowedModels = hasCandidateAllowedModels ? candidate.allowedModels : undefined;
  const hasCallAllowedModels = Array.isArray(constraints?.allowedModels);
  const callAllowedModels = hasCallAllowedModels ? constraints.allowedModels : undefined;
  const deniedModels = new Set([
    ...(Array.isArray(candidate.deniedModels) ? candidate.deniedModels : []),
    ...(Array.isArray(constraints?.deniedModels) ? constraints.deniedModels : []),
  ]);
  const hasAllowedProfiles = Array.isArray(constraints?.allowedProfiles);
  const allowedProfiles = hasAllowedProfiles ? constraints.allowedProfiles : undefined;
  const deniedProfiles = new Set(Array.isArray(constraints?.deniedProfiles) ? constraints.deniedProfiles : []);

  if (hasCandidateAllowedModels) {
    if (!candidate.modelId || !candidateAllowedModels.includes(candidate.modelId)) {
      blockedReasons.push(
        candidateAllowedModels.length === 0
          ? 'Candidate allowedModels is explicitly empty (admits no models).'
          : `Model "${candidate.modelId ?? '(none)'}" is outside candidate allowedModels.`,
      );
    }
  }
  if (hasCallAllowedModels) {
    if (!candidate.modelId || !callAllowedModels.includes(candidate.modelId)) {
      blockedReasons.push(
        callAllowedModels.length === 0
          ? 'Hard allowedModels constraint is explicitly empty (admits no models).'
          : `Model "${candidate.modelId ?? '(none)'}" is outside hard allowedModels constraint.`,
      );
    }
  }
  if (candidate.modelId && deniedModels.has(candidate.modelId)) {
    blockedReasons.push(`Model "${candidate.modelId}" is excluded by hard deniedModels constraint.`);
  }

  if (hasAllowedProfiles) {
    if (!candidate.profile || !allowedProfiles.includes(candidate.profile)) {
      blockedReasons.push(
        allowedProfiles.length === 0
          ? 'Hard allowedProfiles constraint is explicitly empty (admits no profiles).'
          : `Profile "${candidate.profile ?? '(none)'}" is outside hard allowedProfiles constraint.`,
      );
    }
  }
  if (candidate.profile && deniedProfiles.has(candidate.profile)) {
    blockedReasons.push(`Profile "${candidate.profile}" is excluded by hard deniedProfiles constraint.`);
  }

  return {
    admitted: blockedReasons.length === 0,
    blockedReasons,
  };
}

/**
 * Reads quota snapshot from an explicitly injected `readQuotaSnapshot` adapter.
 * Host context quota wiring will be bound solely to the final `@kiki/plugin-sdk` export once stabilized.
 * Never fabricates 0 or unlimited when quota is unavailable or unknown.
 */
async function readSharedQuota(context, injectedReadQuota) {
  if (typeof injectedReadQuota !== 'function') {
    return {
      status: 'unavailable',
      source: 'none',
      readings: [],
      note: 'Shared host quota cache SDK is not yet bound in this environment; quota treated as unknown.',
    };
  }

  try {
    const raw = await injectedReadQuota({ signal: context?.signal });
    const readings = Array.isArray(raw)
      ? raw
      : (isRecord(raw) && Array.isArray(raw.readings) ? raw.readings : []);
    const source = isRecord(raw) && typeof raw.source === 'string' ? raw.source : 'shared-quota-cache';
    return {
      status: 'ok',
      source,
      readings,
    };
  } catch (error) {
    return {
      status: 'error',
      source: 'shared-quota-cache',
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
      candidate.modelId && modelIds.some((id) => id === candidate.modelId),
    );
    if (candidate.kind === 'external-harness') {
      if (!engineMatch) return false;
      if (exactModelMatch) return true;
      if (!r.pool && modelIds.length === 0) return true;
      return false;
    }
    return exactModelMatch;
  });

  if (relevant.length === 0) {
    return { status: 'unknown', source: null, matchedReadings: [] };
  }

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
        resetsAt: items[0]?.resetsAt ?? items[0]?.resetAt,
        readAt: items[0]?.readAt,
        sourceId: items[0]?.sourceId ?? items[0]?.source,
      });
      continue;
    }
    const primaryUnit = knownNumeric[0].unit ?? 'percent';
    const sameUnit = knownNumeric.filter((i) => (i.unit ?? 'percent') === primaryUnit);
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
      resetsAt: tightest.resetsAt ?? tightest.resetAt,
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
  if (candidate.modelId && candidate.modelId.toLowerCase().endsWith(`/${token}`)) return true;
  if ((token === 'grok build' || token === 'grok-build') && (candidate.executorId === 'grok-acp' || candidate.profile === 'implementer-grokbuild')) {
    return true;
  }
  if (token === 'argon' && fields.some((f) => f.includes('argon'))) return true;
  if (token === 'ds' && (candidate.family === 'deepseek' || fields.some((f) => f.includes('deepseek')))) return true;
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

/**
 * Evaluates role default protection independently of whether any preference is currently stored.
 * Protected roles (`writer`, `think`, `director`, or custom `protectedRoleDefault: true` groups)
 * preserve their role default unless the user explicitly authorized that role in `authorizedRoles`.
 */
function evaluateRoleProtection({ groupDef, role, preference }) {
  const normalizedRole = typeof role === 'string' && role.trim() ? role.trim().toLowerCase() : undefined;
  const roleName = normalizedRole ?? groupDef?.defaultRole?.toLowerCase();
  const isProtected = groupDef?.protectedRoleDefault === true || (roleName ? PROTECTED_ROLES.has(roleName) : false);

  if (!isProtected) {
    return {
      isProtected: false,
      protectedPreserved: false,
      preferenceApplicable: Boolean(preference),
    };
  }

  const authorizedRoles = (preference?.authorizedRoles ?? []).map((r) => r.toLowerCase());
  if (preference && roleName && authorizedRoles.includes(roleName)) {
    return {
      isProtected: true,
      protectedPreserved: false,
      preferenceApplicable: true,
    };
  }

  return {
    isProtected: true,
    protectedPreserved: true,
    preferenceApplicable: false,
    reason: `Role "${roleName ?? groupDef.id}" preserves its profile default unless explicitly authorized in authorizedRoles or overridden via explicitTarget.`,
  };
}

function attachRoleDefaults(candidates, { roleName, isProtected, roleDefaultModel }) {
  const targetToken = typeof roleDefaultModel === 'string' && roleDefaultModel.trim()
    ? roleDefaultModel.trim()
    : null;

  let list = candidates.map((c) => ({ ...c }));

  if (targetToken) {
    let matched = false;
    list = list.map((c) => {
      if (matchesToken(c, targetToken)) {
        matched = true;
        return { ...c, isRoleDefault: true };
      }
      return c;
    });
    if (!matched) {
      const normalized = normalizeCandidateDefinition({
        id: targetToken,
        label: roleName ? `${roleName} · ${targetToken} (Role Default)` : `${targetToken} (Role Default)`,
        kind: 'native-model',
        ...(roleName ? { profile: roleName } : {}),
        modelId: targetToken,
        defaultRank: 0,
        isRoleDefault: true,
      }, 0);
      list.unshift({ ...normalized, family: inferModelFamily(normalized) });
    }
  }

  const hasRoleDefault = list.some((c) => c.isRoleDefault);
  if (isProtected && !hasRoleDefault) {
    const targetProfile = roleName ?? 'role-default';
    list.unshift({
      id: `profile:${targetProfile}`,
      label: `${targetProfile} (inherit profile default)`,
      kind: 'profile',
      profile: targetProfile,
      defaultRank: 0,
      isRoleDefault: true,
      available: true,
      family: 'other',
    });
  }
  return list;
}

function compareComparableQuota(aQuota, bQuota) {
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
    parts.push(`blocked by hard constraint (${entry.constraints.blockedReasons.join(' ')})`);
    return parts.join('; ');
  }
  if (!entry.availability.available) {
    parts.push(`unavailable (${entry.availability.catalogStatus})`);
  } else if (entry.availability.source === 'external-harness') {
    parts.push(`external harness (${entry.candidate.executorId ?? entry.candidate.profile})`);
  } else if (entry.availability.source === 'profile-inheritance') {
    parts.push(`inherits profile "${entry.candidate.profile ?? entry.candidate.id}" default`);
  }
  if (entry.explicitMatch) {
    parts.push('explicitly named for this turn (overrides soft preferences and quota sorting)');
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
    };

    const modelLister = listModels ?? (typeof context?.models?.list === 'function' ? () => context.models.list() : undefined);
    let catalog;
    let hasCatalog = false;
    if (modelLister) {
      catalog = await modelLister();
      hasCatalog = isRecord(catalog) && Array.isArray(catalog.models);
    }
    const catalogIndex = buildCatalogIndex(catalog);

    const configuredCandidates = Array.isArray(groupDef.candidates) ? groupDef.candidates : [];
    const hasCallerCandidates = Array.isArray(args?.candidates) && args.candidates.length > 0;
    const baseCandidates = configuredCandidates.length > 0
      ? configuredCandidates
      : (hasCallerCandidates ? [] : deriveCatalogCandidates(catalog, catalogIndex));

    const merged = mergeCandidates(baseCandidates, args?.candidates);

    const rawPreference = savedState.preferences?.[groupId] ?? null;
    const roleProtection = evaluateRoleProtection({
      groupDef,
      role,
      preference: rawPreference,
    });
    const effectivePreference = roleProtection.preferenceApplicable ? rawPreference : null;
    const roleName = role ?? groupDef?.defaultRole?.toLowerCase();

    const candidatesWithDefaults = attachRoleDefaults(merged, {
      roleName,
      isProtected: roleProtection.isProtected,
      roleDefaultModel: args?.roleDefaultModel,
    });

    const quotaSnapshot = await readSharedQuota(context, readQuotaSnapshot);

    const explicitTarget = typeof args?.explicitTarget === 'string' && args.explicitTarget.trim()
      ? args.explicitTarget.trim()
      : null;

    const evaluated = candidatesWithDefaults.map((candidate) => {
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
        reason: buildReasonParts(entry, { protectedPreserved: roleProtection.protectedPreserved }),
      };
    });

    evaluated.sort((a, b) => {
      // 1. Hard profile/caller admission always wins (never violate hard constraints, even for explicitTarget).
      if (a.constraints.admitted !== b.constraints.admitted) {
        return a.constraints.admitted ? -1 : 1;
      }
      // 2. Availability in catalog or explicit readiness verification.
      if (a.availability.available !== b.availability.available) {
        return a.availability.available ? -1 : 1;
      }
      // 3. Explicit user selection for this turn beats soft preferences, role defaults, and quota soft-sorting.
      if (a.explicitMatch !== b.explicitMatch) {
        return a.explicitMatch ? -1 : 1;
      }
      // 4. Protected role default when no explicit role authorization was granted (independent of saved preferences).
      if (roleProtection.protectedPreserved && a.candidate.isRoleDefault !== b.candidate.isRoleDefault) {
        return a.candidate.isRoleDefault ? -1 : 1;
      }
      // 5. Soft user preference within the functional group (+1 preferred > 0 neutral > -1 avoided).
      if (a.preferenceEffect.tier !== b.preferenceEffect.tier) {
        return b.preferenceEffect.tier - a.preferenceEffect.tier;
      }
      if (a.preferenceEffect.tier === 1 && a.preferenceEffect.preferIndex !== b.preferenceEffect.preferIndex) {
        return a.preferenceEffect.preferIndex - b.preferenceEffect.preferIndex;
      }
      // 6. Quota soft-comparison among ordinary candidates: exhausted deprioritized; higher same-unit remaining wins.
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
      isRoleDefault: Boolean(entry.candidate.isRoleDefault),
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

    // Explicit target or protected role default must NEVER be silently swapped to another model due to exhausted quota;
    // surface the exhausted fact on `recommended` instead of quietly switching models.
    const pinnedExplicit = explicitTarget
      ? rankedCandidates.find((item) => item.eligible && item.explicitMatch)
      : undefined;
    const pinnedProtectedDefault = !pinnedExplicit && roleProtection.protectedPreserved
      ? rankedCandidates.find((item) => item.eligible && item.isRoleDefault)
      : undefined;

    const recommended = pinnedExplicit
      ?? pinnedProtectedDefault
      ?? rankedCandidates.find((item) => item.eligible && item.quota.status !== 'exhausted')
      ?? rankedCandidates.find((item) => item.eligible)
      ?? null;

    return {
      ok: true,
      advisoryOnly: true,
      group: {
        id: groupId,
        label: groupDef.label ?? groupId,
        role: role ?? null,
        protectedRoleDefault: roleProtection.isProtected,
        protectedDefaultPreserved: roleProtection.protectedPreserved,
        ...(roleProtection.reason ? { protectionNote: roleProtection.reason } : {}),
      },
      explicitTarget,
      preference: rawPreference
        ? {
            applied: roleProtection.preferenceApplicable,
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
            quota: recommended.quota,
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
