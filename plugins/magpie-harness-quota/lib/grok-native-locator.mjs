import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  redactProxyEndpoint,
  resolveMagpieConfigDir,
} from './antigravity-direct-quota.mjs';

export const GROK_ISSUER = 'https://auth.x.ai';
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_SCOPE = `${GROK_ISSUER}::${GROK_CLIENT_ID}`;
export const GROK_EXECUTOR_ID = 'grok-acp';

const MAX_AUTH_BYTES = 2 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hashIdentity(value, length = 12) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return crypto.createHash('sha256').update(value.trim().toLowerCase(), 'utf8').digest('hex').slice(0, length);
}

export function maskAccountIdentifier(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  const [head] = trimmed.split(' · ');
  const value = head.replace(/\s+\([^)]+\)$/, '').trim();
  const atIndex = value.indexOf('@');
  if (atIndex > 0 && atIndex < value.length - 1) {
    const local = value.slice(0, atIndex);
    const domain = value.slice(atIndex + 1);
    const visible = local.length <= 2 ? local[0] ?? '*' : `${local.slice(0, 2)}***`;
    return `${visible}@${domain}`;
  }
  if (value.length <= 6) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed) && parsed > Date.UTC(1970, 0, 1)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function resolveDefaultNativeGrokHome({ nativeGrokHome, env = process.env, homedir = os.homedir() } = {}) {
  const candidate = typeof nativeGrokHome === 'string' && nativeGrokHome.trim()
    ? nativeGrokHome.trim()
    : (typeof env.GROK_HOME === 'string' && env.GROK_HOME.trim()
      ? env.GROK_HOME.trim()
      : path.join(homedir, '.grok'));
  if (!path.isAbsolute(candidate)) {
    throw new Error('nativeGrokHome / GROK_HOME must be an absolute path on the Kiki server.');
  }
  return path.resolve(candidate);
}

async function pathStat(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Inspects a Grok `auth.json` (or `auth.json.bak`) file against Kiki's `local-original.ts`
 * `grok-build` OIDC contract (`https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`)
 * without ever returning or logging `key`, `refresh_token`, or raw JWT text.
 */
export async function inspectGrokAuthFile(authFilePath) {
  const resolvedPath = path.resolve(authFilePath);
  const st = await pathStat(resolvedPath);
  if (!st || !st.isFile()) {
    return {
      authFile: resolvedPath,
      exists: false,
      state: 'signed_out',
      reason: 'auth_file_missing',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }
  if (st.size === 0) {
    return {
      authFile: resolvedPath,
      exists: true,
      state: 'unreadable',
      reason: 'auth_file_empty',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }
  if (st.size > MAX_AUTH_BYTES) {
    return {
      authFile: resolvedPath,
      exists: true,
      state: 'unsupported',
      reason: 'auth_file_too_large',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }

  let rawJson;
  try {
    rawJson = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
  } catch {
    return {
      authFile: resolvedPath,
      exists: true,
      state: 'unreadable',
      reason: 'invalid_json',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }

  if (!isRecord(rawJson)) {
    return {
      authFile: resolvedPath,
      exists: true,
      state: 'unreadable',
      reason: 'non_object_json',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }

  const keys = Object.keys(rawJson);
  if (keys.length === 0) {
    return {
      authFile: resolvedPath,
      exists: true,
      state: 'signed_out',
      reason: 'empty_auth_object',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }

  const entry = rawJson[GROK_SCOPE];
  if (!isRecord(entry)) {
    return {
      authFile: resolvedPath,
      exists: true,
      state: 'unsupported',
      reason: 'missing_xai_oidc_scope',
      accountHash: null,
      userIdHash: null,
      maskedAccount: null,
      authMode: null,
      expiresAt: null,
      hasRefreshToken: false,
      scopeMatched: false,
    };
  }

  const authMode = typeof entry.auth_mode === 'string' ? entry.auth_mode : null;
  const issuer = typeof entry.oidc_issuer === 'string' ? entry.oidc_issuer : GROK_ISSUER;
  const clientId = typeof entry.oidc_client_id === 'string' ? entry.oidc_client_id : GROK_CLIENT_ID;
  const accessToken = typeof entry.key === 'string' && entry.key.trim() ? entry.key.trim() : null;
  const refreshToken = typeof entry.refresh_token === 'string' && entry.refresh_token.trim() ? entry.refresh_token.trim() : null;
  const email = typeof entry.email === 'string' && entry.email.trim() ? entry.email.trim() : null;
  const ownerUserId = typeof entry.user_id === 'string' && entry.user_id.trim() ? entry.user_id.trim() : null;
  const claims = accessToken ? decodeJwtPayload(accessToken) : undefined;
  const claimSub = typeof claims?.sub === 'string' && claims.sub.trim() ? claims.sub.trim() : null;
  const effectiveUserId = ownerUserId ?? claimSub;
  const who = email ?? effectiveUserId;
  const expiresAt = normalizeIsoTimestamp(entry.expires_at) ?? normalizeIsoTimestamp(claims?.exp);
  const createTime = normalizeIsoTimestamp(entry.create_time);

  const validContract = authMode === 'oidc'
    && issuer === GROK_ISSUER
    && clientId === GROK_CLIENT_ID
    && Boolean(accessToken)
    && Boolean(refreshToken)
    && Boolean(effectiveUserId)
    && Boolean(expiresAt)
    && Boolean(createTime);

  return {
    authFile: resolvedPath,
    exists: true,
    state: validContract ? 'ready' : 'unsupported',
    reason: validContract ? null : 'incomplete_or_mismatched_oidc_fields',
    accountHash: hashIdentity(who),
    emailHash: hashIdentity(email),
    userIdHash: hashIdentity(effectiveUserId),
    maskedAccount: maskAccountIdentifier(who),
    authMode,
    expiresAt,
    hasRefreshToken: Boolean(refreshToken),
    scopeMatched: true,
    // Internal-only identity tokens for exact caller matching inside this module; stripped before returning externally.
    _internalWhoLower: who ? who.toLowerCase() : null,
    _internalEmailLower: email ? email.toLowerCase() : null,
    _internalUserIdLower: effectiveUserId ? effectiveUserId.toLowerCase() : null,
  };
}

function stripInternalIdentity(record) {
  if (!isRecord(record)) return record;
  const copy = { ...record };
  delete copy._internalWhoLower;
  delete copy._internalEmailLower;
  delete copy._internalUserIdLower;
  return copy;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`Unable to read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPluginManagedGrokSlotKey(key) {
  return key === 'grok' || key.startsWith('grok#');
}

function resolveGrokAccountProxy(providersRaw, user) {
  const list = isRecord(providersRaw) && Array.isArray(providersRaw.providers) ? providersRaw.providers : [];
  const grokProvider = list.find((item) => isRecord(item) && (item.id === 'grok' || item.id === 'plugin:grok'));
  if (!grokProvider) return null;
  const userKey = typeof user === 'string' ? user.trim().toLowerCase() : '';
  const perAccount = isRecord(grokProvider.accountProxies) ? grokProvider.accountProxies[userKey] : undefined;
  const chosen = typeof perAccount === 'string' && perAccount.trim()
    ? perAccount
    : (typeof grokProvider.proxy === 'string' && grokProvider.proxy.trim() ? grokProvider.proxy : '');
  return chosen ? redactProxyEndpoint(chosen) : null;
}

/**
 * Discovers all Magpie-managed Grok slots (`logins.json` + `plugin-auth.json`), the default native
 * `~/.grok` home state (including preserved `sessions` and `auth.json.bak` recovery references),
 * and each account's canonical private `GROK_HOME` / `GROK_AUTH_PATH` locator without reading or
 * returning any secret tokens, and without copying rotating refresh tokens across directories.
 */
export async function inspectGrokManagedAccounts({
  magpieConfigDir,
  magpiePath,
  nativeGrokHome,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const resolvedMagpieDir = await resolveMagpieConfigDir({
    configDir: magpieConfigDir,
    magpiePath,
    env,
    homedir,
  });
  const defaultNativeHome = resolveDefaultNativeGrokHome({ nativeGrokHome, env, homedir });
  const defaultNativeAuthFile = path.join(defaultNativeHome, 'auth.json');
  const defaultNativeBackupFile = path.join(defaultNativeHome, 'auth.json.bak');
  const sessionsDir = path.join(defaultNativeHome, 'sessions');

  const [loginsRaw, pluginAuthRaw, providersRaw, nativeAuthInfo, nativeBackupInfo, sessionsStat] = await Promise.all([
    readJsonIfExists(path.join(resolvedMagpieDir, 'logins.json'), []),
    readJsonIfExists(path.join(resolvedMagpieDir, 'plugin-auth.json'), {}),
    readJsonIfExists(path.join(resolvedMagpieDir, 'providers.json'), {}),
    inspectGrokAuthFile(defaultNativeAuthFile),
    inspectGrokAuthFile(defaultNativeBackupFile),
    pathStat(sessionsDir),
  ]);

  const grokLogins = (Array.isArray(loginsRaw) ? loginsRaw : []).filter((row) => (
    isRecord(row)
    && typeof row.agent === 'string'
    && (row.agent === 'grok' || row.agent === 'plugin:grok' || row.agent === 'grok-plugin')
    && typeof row.user === 'string'
    && row.user.trim().length > 0
  ));

  const pluginSlots = [];
  if (isRecord(pluginAuthRaw)) {
    for (const [slotKey, slotVal] of Object.entries(pluginAuthRaw)) {
      if (!isPluginManagedGrokSlotKey(slotKey) || !isRecord(slotVal)) continue;
      // In `@magpie-community/opencode-grok-auth`, Magpie stores the slot's GROK_HOME directory path in `refresh`
      // (`plugin-auth.json`), and the account's email/user identifier in `accountId`.
      const candidateHome = typeof slotVal.home === 'string' && path.isAbsolute(slotVal.home.trim())
        ? path.resolve(slotVal.home.trim())
        : (typeof slotVal.refresh === 'string' && path.isAbsolute(slotVal.refresh.trim())
          ? path.resolve(slotVal.refresh.trim())
          : null);
      const slotAccountId = typeof slotVal.accountId === 'string' && slotVal.accountId.trim()
        ? slotVal.accountId.trim()
        : null;
      const authInspection = candidateHome
        ? await inspectGrokAuthFile(path.join(candidateHome, 'auth.json'))
        : null;
      pluginSlots.push({
        slotKey,
        slotAccountId,
        slotAccountHash: hashIdentity(slotAccountId),
        privateHomeDir: candidateHome,
        authFile: candidateHome ? path.join(candidateHome, 'auth.json') : null,
        isSharedDefaultHome: candidateHome ? normalizePathKey(candidateHome) === normalizePathKey(defaultNativeHome) : false,
        authInspection,
      });
    }
  }

  // Pair Magpie `logins.json` entries with their `plugin-auth.json` slot:
  // 1) Primary authoritative link: `login.home` === `slot.slotKey` (`internal/provider/plugin_accounts.go:241-292`,
  //    where `savedLogin.Home` stores the exact `plugin-auth.json` key such as `"grok"` or `"grok#xfgelk"`).
  // 2) Secondary fallback (legacy/fixture entries without `login.home`): match by `slotAccountId` or inspected identity.
  const accounts = [];
  const matchedSlots = new Set();

  for (const login of grokLogins) {
    const rawUser = login.user.trim();
    const rawUserLower = rawUser.toLowerCase();
    // Strip Magpie's disambiguation suffixes like `" · (2)"` or `" (xfgelk)"` (`pluginLabels` in `plugin_accounts.go`)
    const userEmailHead = rawUser
      .split(' · ')[0]
      .replace(/\s+\([^)]+\)$/, '')
      .trim()
      .toLowerCase();
    const accountHash = hashIdentity(userEmailHead) ?? hashIdentity(rawUser);
    const labelHash = hashIdentity(rawUser);
    const alias = typeof login.alias === 'string' && login.alias.trim() ? login.alias.trim() : null;
    const loginHomeSlot = typeof login.home === 'string' && login.home.trim() ? login.home.trim() : null;

    let matchedSlot = loginHomeSlot
      ? pluginSlots.find((slot) => slot.slotKey === loginHomeSlot)
      : undefined;
    if (!matchedSlot) {
      matchedSlot = pluginSlots.find((slot) => (
        !matchedSlots.has(slot.slotKey)
        && slot.slotAccountId && (
          slot.slotAccountId.toLowerCase() === rawUserLower
          || slot.slotAccountId.toLowerCase() === userEmailHead
        )
      ));
    }
    if (!matchedSlot) {
      matchedSlot = pluginSlots.find((slot) => {
        if (matchedSlots.has(slot.slotKey)) return false;
        const info = slot.authInspection;
        if (!info) return false;
        return info._internalWhoLower === rawUserLower
          || info._internalWhoLower === userEmailHead
          || info._internalEmailLower === userEmailHead
          || info._internalUserIdLower === rawUserLower;
      });
    }
    if (matchedSlot) matchedSlots.add(matchedSlot.slotKey);

    const authInfo = matchedSlot?.authInspection ?? null;
    const identityVerified = Boolean(
      matchedSlot
      && authInfo?.state === 'ready'
      && (
        authInfo._internalWhoLower === rawUserLower
        || authInfo._internalWhoLower === userEmailHead
        || authInfo._internalEmailLower === userEmailHead
        || authInfo._internalUserIdLower === rawUserLower
        || (matchedSlot.slotAccountId && authInfo.accountHash === hashIdentity(matchedSlot.slotAccountId))
      ),
    );

    accounts.push({
      loginId: typeof login.id === 'string' ? login.id : null,
      slotKey: matchedSlot?.slotKey ?? loginHomeSlot ?? null,
      accountHash: authInfo?.accountHash ?? accountHash,
      labelHash,
      userIdHash: authInfo?.userIdHash ?? null,
      maskedAccount: maskAccountIdentifier(rawUser),
      alias,
      enabled: login.on !== false,
      magpieGatewaySelected: login.first === true,
      isCliNativeHome: matchedSlot?.isSharedDefaultHome ?? false,
      redactedProxy: resolveGrokAccountProxy(providersRaw, rawUser),
      storage: matchedSlot ? {
        homeDir: matchedSlot.privateHomeDir,
        privateHomeDir: matchedSlot.privateHomeDir,
        authFile: matchedSlot.authFile,
        isSharedDefaultHome: matchedSlot.isSharedDefaultHome,
        state: authInfo?.state ?? 'unknown',
        reason: authInfo?.reason ?? null,
        expiresAt: authInfo?.expiresAt ?? null,
        hasRefreshToken: authInfo?.hasRefreshToken ?? false,
        identityVerified,
      } : null,
      // Internal matching keys stripped before returning
      _matchKeys: [
        rawUserLower,
        userEmailHead,
        alias?.toLowerCase() ?? null,
        (authInfo?.accountHash ?? accountHash)?.toLowerCase() ?? null,
        labelHash?.toLowerCase() ?? null,
        (matchedSlot?.slotKey ?? loginHomeSlot)?.toLowerCase() ?? null,
        typeof login.id === 'string' ? login.id.toLowerCase() : null,
      ].filter(Boolean),
    });
  }

  // Also surface any orphan `plugin-auth.json` Grok slots not listed in `logins.json`.
  for (const slot of pluginSlots) {
    if (matchedSlots.has(slot.slotKey)) continue;
    const authInfo = slot.authInspection;
    const labelSource = slot.slotAccountId ?? authInfo?._internalWhoLower ?? slot.slotKey;
    const accountHash = slot.slotAccountHash ?? authInfo?.accountHash;
    accounts.push({
      loginId: null,
      slotKey: slot.slotKey,
      accountHash,
      labelHash: null,
      userIdHash: authInfo?.userIdHash ?? null,
      maskedAccount: maskAccountIdentifier(labelSource),
      alias: null,
      enabled: true,
      magpieGatewaySelected: false,
      isCliNativeHome: slot.isSharedDefaultHome,
      redactedProxy: null,
      storage: {
        homeDir: slot.privateHomeDir,
        privateHomeDir: slot.privateHomeDir,
        authFile: slot.authFile,
        isSharedDefaultHome: slot.isSharedDefaultHome,
        state: authInfo?.state ?? 'unknown',
        reason: authInfo?.reason ?? null,
        expiresAt: authInfo?.expiresAt ?? null,
        hasRefreshToken: authInfo?.hasRefreshToken ?? false,
        identityVerified: authInfo?.state === 'ready',
      },
      _matchKeys: [
        slot.slotKey.toLowerCase(),
        slot.slotAccountId?.toLowerCase() ?? null,
        accountHash?.toLowerCase() ?? null,
        authInfo?._internalWhoLower ?? null,
        authInfo?._internalEmailLower ?? null,
      ].filter(Boolean),
    });
  }

  // Per `side_logins.go:237-255`, Magpie gateway routes to the first enabled account with `first: true`,
  // else the first enabled account in order. This NEVER changes `~/.grok/auth.json`.
  const gatewaySelected = accounts.find((item) => item.enabled && item.magpieGatewaySelected)
    ?? accounts.find((item) => item.enabled)
    ?? null;

  const envAuthPath = typeof env.GROK_AUTH_PATH === 'string' && env.GROK_AUTH_PATH.trim() && path.isAbsolute(env.GROK_AUTH_PATH.trim())
    ? path.resolve(env.GROK_AUTH_PATH.trim())
    : null;
  const envAuthInfo = envAuthPath ? await inspectGrokAuthFile(envAuthPath) : null;
  const effectiveNativeAuth = envAuthInfo ?? nativeAuthInfo;

  const inSyncWithDefaultHome = Boolean(
    gatewaySelected?.accountHash
    && nativeAuthInfo.state === 'ready'
    && nativeAuthInfo.accountHash === gatewaySelected.accountHash,
  );

  const recoveryReferences = [];
  if (nativeBackupInfo.exists) {
    recoveryReferences.push({
      refId: 'native-auth-json-bak',
      path: defaultNativeBackupFile,
      state: nativeBackupInfo.state,
      accountHash: nativeBackupInfo.accountHash,
      userIdHash: nativeBackupInfo.userIdHash,
      maskedAccount: nativeBackupInfo.maskedAccount,
      expiresAt: nativeBackupInfo.expiresAt,
    });
  }

  const publicAccounts = accounts.map(({ _matchKeys, ...pub }) => pub);

  return {
    magpieConfigDir: resolvedMagpieDir,
    semanticsNote: 'Magpie `accounts switch grok` (`switchSideLogin`) only reorders Magpie gateway routing in logins.json and does NOT update native ~/.grok/auth.json. When the selected account already resides in the CLI native home (~/.grok), no override is needed; when it resides in a Magpie plugin private home, use `GROK_AUTH_PATH` or `config_directory` so native Grok CLI and Magpie share the single rotating auth.json without duplicating refresh tokens.',
    magpieGatewaySelection: gatewaySelected ? {
      slotKey: gatewaySelected.slotKey,
      accountHash: gatewaySelected.accountHash,
      userIdHash: gatewaySelected.userIdHash,
      maskedAccount: gatewaySelected.maskedAccount,
      alias: gatewaySelected.alias,
      isCliNativeHome: gatewaySelected.isCliNativeHome,
      homeDir: gatewaySelected.storage?.homeDir ?? null,
      privateHomeDir: gatewaySelected.storage?.privateHomeDir ?? null,
      authFile: gatewaySelected.storage?.authFile ?? null,
      state: gatewaySelected.storage?.state ?? 'unknown',
      identityVerified: gatewaySelected.storage?.identityVerified ?? false,
    } : null,
    nativeGrokHome: {
      homeDir: defaultNativeHome,
      sessionsDir,
      sessionsPreserved: Boolean(sessionsStat?.isDirectory()),
      defaultAuthFile: stripInternalIdentity(nativeAuthInfo),
      envGrokAuthPath: envAuthInfo ? stripInternalIdentity(envAuthInfo) : null,
      effectiveAccountHash: effectiveNativeAuth.accountHash,
      inSyncWithMagpieSelection: inSyncWithDefaultHome,
      recoveryReferences,
    },
    accounts: publicAccounts,
    _internalAccounts: accounts,
  };
}

/**
 * Resolves a verified, secret-free native Grok binding locator for a target Magpie Grok account
 * (defaults to the account currently selected in Magpie when `account` is omitted).
 *
 * Supports both storage layouts discovered from Magpie's current account roster:
 * - `cli_native_default_home`: when the selected account's `auth.json` is already in the CLI native home (`~/.grok`),
 *   `requiresEnvOverride: false`, `env: {}` (no `GROK_AUTH_PATH` override needed, default `GROK_HOME` & sessions used directly).
 * - `preserve_grok_home_and_sessions`: when the selected account resides in a Magpie plugin private home,
 *   returns `env: { GROK_AUTH_PATH: "<slotHome>/auth.json" }` while leaving `GROK_HOME` at `~/.grok`
 *   (and provides `isolatedInstanceAlternative` `{ kind: "config_directory", path: "<slotHome>" }`).
 */
export async function resolveGrokNativeLocator({
  account,
  magpieConfigDir,
  magpiePath,
  nativeGrokHome,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const status = await inspectGrokManagedAccounts({
    magpieConfigDir,
    magpiePath,
    nativeGrokHome,
    env,
    homedir,
  });

  const internalAccounts = status._internalAccounts;
  let selected = null;

  if (typeof account === 'string' && account.trim()) {
    const query = account.trim().toLowerCase();
    const matches = internalAccounts.filter((item) => (
      item._matchKeys.some((key) => key === query || (query.length >= 6 && key.startsWith(query)))
    ));
    // Deduplicate matches that point to the exact same underlying authFile + accountHash
    // (for example when Magpie records both `"grok"` and `"grok#<suffix>"` pointing to `~/.grok`).
    const uniqueAuthFiles = new Set(matches.map((m) => `${m.accountHash ?? ''}|${m.storage?.authFile ?? ''}`));
    if (matches.length > 1 && uniqueAuthFiles.size > 1) {
      throw new Error(`Ambiguous Grok account selector; matched ${matches.length} distinct accounts (${matches.map((m) => m.accountHash).join(', ')}).`);
    }
    selected = matches.find((m) => m.magpieGatewaySelected && m.storage?.state === 'ready')
      ?? matches.find((m) => m.storage?.state === 'ready')
      ?? matches[0]
      ?? null;
    if (!selected) {
      throw new Error('No Magpie-managed Grok account matched selector.');
    }
  } else {
    // Prefer Magpie's active/first enabled account that has a ready auth.json; else any ready enabled account.
    selected = internalAccounts.find((item) => item.enabled && item.magpieGatewaySelected && item.storage?.state === 'ready')
      ?? internalAccounts.find((item) => item.enabled && item.magpieGatewaySelected)
      ?? internalAccounts.find((item) => item.enabled && item.storage?.state === 'ready')
      ?? null;
    if (!selected) {
      throw new Error('No enabled Magpie-managed Grok account was found.');
    }
  }

  if (!selected.storage?.authFile || !selected.storage?.homeDir) {
    throw new Error(`Selected Grok account (${selected.accountHash ?? 'unknown'}) has no managed home path in Magpie plugin-auth.json.`);
  }
  if (selected.storage.state !== 'ready' || !selected.storage.identityVerified) {
    throw new Error(
      `Selected Grok account (${selected.accountHash ?? 'unknown'}) does not have a verified ready OIDC auth.json at ${selected.storage.authFile} (state=${selected.storage.state}, reason=${selected.storage.reason ?? 'identity_mismatch'}).`,
    );
  }

  const authFile = selected.storage.authFile;
  const slotHomeDir = selected.storage.homeDir;
  const defaultHomeDir = status.nativeGrokHome.homeDir;
  const isCliNativeHome = Boolean(selected.isCliNativeHome);

  return {
    executorId: GROK_EXECUTOR_ID,
    liveMutated: false,
    singleRotatingToken: true,
    matchedAccount: {
      slotKey: selected.slotKey,
      loginId: selected.loginId,
      accountHash: selected.accountHash,
      userIdHash: selected.userIdHash,
      maskedAccount: selected.maskedAccount,
      alias: selected.alias,
      enabled: selected.enabled,
      magpieGatewaySelected: selected.magpieGatewaySelected,
      isCliNativeHome,
      expiresAt: selected.storage.expiresAt,
      identityVerified: selected.storage.identityVerified,
      redactedProxy: selected.redactedProxy,
    },
    locator: isCliNativeHome
      ? {
        mode: 'cli_native_default_home',
        requiresEnvOverride: false,
        grokHomeDir: defaultHomeDir,
        slotHomeDir,
        authFile,
        lockFile: path.join(slotHomeDir, 'auth.json.lock'),
        env: {},
        kikiExecutorOverridePatch: {
          [GROK_EXECUTOR_ID]: {
            env: {
              GROK_AUTH_PATH: null,
            },
          },
        },
        isolatedInstanceAlternative: {
          mode: 'cli_native_default_home',
          configuration: {
            kind: 'inherit',
          },
        },
      }
      : {
        mode: 'preserve_grok_home_and_sessions',
        requiresEnvOverride: true,
        grokHomeDir: defaultHomeDir,
        slotHomeDir,
        privateHomeDir: slotHomeDir,
        authFile,
        lockFile: path.join(slotHomeDir, 'auth.json.lock'),
        env: {
          GROK_AUTH_PATH: authFile,
        },
        kikiExecutorOverridePatch: {
          [GROK_EXECUTOR_ID]: {
            env: {
              GROK_AUTH_PATH: authFile,
            },
          },
        },
        isolatedInstanceAlternative: {
          mode: 'isolated_private_home',
          configuration: {
            kind: 'config_directory',
            path: slotHomeDir,
          },
        },
      },
    preservedState: {
      nativeHomeDir: defaultHomeDir,
      sessionsDir: status.nativeGrokHome.sessionsDir,
      sessionsPreserved: status.nativeGrokHome.sessionsPreserved,
      recoveryReferences: status.nativeGrokHome.recoveryReferences,
    },
  };
}
