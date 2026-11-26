import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BilibiliError, assert } from './errors.mjs';

export const PROFILE_NAME_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateAbsDir(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new BilibiliError('CONFIGURATION', `${label} must be an explicit absolute directory path.`);
  }
  return trimmed;
}

export function parseProfilesSetting(rawProfiles) {
  const map = new Map();
  if (rawProfiles === undefined || rawProfiles === null) return map;
  if (typeof rawProfiles !== 'string') {
    throw new BilibiliError('CONFIGURATION', 'profiles must be a JSON object string or newline-separated name=path entries.');
  }
  const text = rawProfiles.trim();
  if (!text) return map;

  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BilibiliError('CONFIGURATION', `Invalid profiles JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BilibiliError('CONFIGURATION', 'profiles JSON must be an object mapping profile names to absolute directories.');
    }
    for (const [name, rawPath] of Object.entries(parsed)) {
      if (!PROFILE_NAME_RE.test(name)) {
        throw new BilibiliError('CONFIGURATION', `Invalid profile name "${name}". Use 1-64 ASCII letters, digits, underscores or hyphens.`);
      }
      map.set(name, validateAbsDir(rawPath, `Profile "${name}" path`));
    }
    return map;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new BilibiliError('CONFIGURATION', `Invalid profiles entry "${line}". Expected name=absolutePath.`);
    }
    const name = line.slice(0, eq).trim();
    const rawPath = line.slice(eq + 1).trim();
    if (!PROFILE_NAME_RE.test(name)) {
      throw new BilibiliError('CONFIGURATION', `Invalid profile name "${name}". Use 1-64 ASCII letters, digits, underscores or hyphens.`);
    }
    map.set(name, validateAbsDir(rawPath, `Profile "${name}" path`));
  }
  return map;
}

export function resolveProfileRegistry(settings = {}) {
  const profiles = parseProfilesSetting(settings.profiles);
  const rawCliHome = settings.cliHome === undefined || settings.cliHome === null ? '' : String(settings.cliHome).trim();
  const cliHome = rawCliHome ? validateAbsDir(rawCliHome, 'cliHome') : '';

  const entries = new Map();
  if (cliHome && !profiles.has('default')) {
    entries.set('default', cliHome);
  }
  for (const [name, dir] of profiles) {
    entries.set(name, dir);
  }

  const defaultProfile = settings.defaultProfile === undefined || settings.defaultProfile === null ? '' : String(settings.defaultProfile).trim();
  if (defaultProfile) {
    if (!PROFILE_NAME_RE.test(defaultProfile)) {
      throw new BilibiliError('CONFIGURATION', `Invalid defaultProfile "${defaultProfile}".`);
    }
    if (!entries.has(defaultProfile)) {
      const known = [...entries.keys()].join(', ') || 'none';
      throw new BilibiliError('CONFIGURATION', `defaultProfile "${defaultProfile}" is not configured. Configured profiles: ${known}.`);
    }
  }

  if (entries.size === 0 && !cliHome) {
    throw new BilibiliError('CONFIGURATION', 'Set cliHome or profiles to an explicit absolute bili-agent profile directory. No default home is read.');
  }

  let defaultName = null;
  let defaultHome = null;
  if (defaultProfile) {
    defaultName = defaultProfile;
    defaultHome = entries.get(defaultProfile);
  } else if (cliHome) {
    defaultName = 'default';
    defaultHome = cliHome;
  } else if (profiles.has('default')) {
    defaultName = 'default';
    defaultHome = profiles.get('default');
  }

  return { entries, profiles, cliHome, defaultName, defaultHome };
}

export function resolveProfileHome(settings = {}, requestedProfile) {
  const registry = resolveProfileRegistry(settings);
  if (requestedProfile !== undefined && requestedProfile !== null && requestedProfile !== '') {
    if (typeof requestedProfile !== 'string' || !PROFILE_NAME_RE.test(requestedProfile)) {
      throw new BilibiliError('CONFIGURATION', `Invalid Bilibili profile "${String(requestedProfile)}". Only configured profile aliases are accepted.`);
    }
    if (requestedProfile === 'default' && registry.cliHome && !registry.profiles.has('default')) {
      return { name: 'default', home: registry.cliHome };
    }
    const home = registry.entries.get(requestedProfile);
    if (!home) {
      const known = [...registry.entries.keys()].join(', ') || 'none';
      throw new BilibiliError('CONFIGURATION', `Unknown Bilibili profile "${requestedProfile}". Configured profiles: ${known}.`);
    }
    return { name: requestedProfile, home };
  }

  if (!registry.defaultHome) {
    const known = [...registry.entries.keys()].join(', ') || 'none';
    throw new BilibiliError('CONFIGURATION', `No default Bilibili profile is set. Pass profile (${known}) or configure defaultProfile / cliHome.`);
  }
  return { name: registry.defaultName, home: registry.defaultHome };
}

export async function readStoredCredentialMid(profileHome) {
  const credFile = path.join(profileHome, 'credential.json');
  let raw;
  try {
    raw = await readFile(credFile, 'utf8');
  } catch {
    return { loggedIn: false, mid: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.sessdata) {
      return { loggedIn: false, mid: null };
    }
    const mid = parsed.dedeuserid !== undefined && parsed.dedeuserid !== null && String(parsed.dedeuserid).trim() !== ''
      ? String(parsed.dedeuserid).trim()
      : null;
    return { loggedIn: true, mid };
  } catch {
    return { loggedIn: false, mid: null };
  }
}

export async function verifyExpectedMid({ expectedMid, settings = {}, requestedProfile, probeStatus }) {
  if (expectedMid === undefined) return;
  assert(Number.isInteger(expectedMid) && expectedMid >= 1, 'ARGUMENT_INVALID', 'expectedMid must be a positive integer UID.');
  const hasConfiguredProfiles = Boolean(
    (settings.cliHome !== undefined && String(settings.cliHome).trim() !== '') ||
    (settings.profiles !== undefined && String(settings.profiles).trim() !== ''),
  );

  let profileLabel = requestedProfile || 'default';
  if (hasConfiguredProfiles) {
    const resolved = resolveProfileHome(settings, requestedProfile);
    profileLabel = resolved.name;
    const stored = await readStoredCredentialMid(resolved.home);
    if (!stored.loggedIn) {
      throw new BilibiliError('ACCOUNT_MISMATCH', `Account safety lock rejected write: profile "${profileLabel}" is not logged in (expected UID ${expectedMid}).`, { submission: 'not_sent' });
    }
    if (stored.mid !== null) {
      if (stored.mid !== String(expectedMid)) {
        throw new BilibiliError('ACCOUNT_MISMATCH', `Account safety lock rejected write: profile "${profileLabel}" has UID ${stored.mid}, expected UID ${expectedMid}.`, { submission: 'not_sent' });
      }
      return;
    }
  }

  let status;
  try {
    status = await probeStatus();
  } catch (error) {
    if (error?.code === 'not_logged_in' || error?.code === 'auth_expired' || error?.code === 'login_pending' || error?.code === 'login_expired') {
      throw new BilibiliError('ACCOUNT_MISMATCH', `Account safety lock rejected write: profile "${profileLabel}" is not logged in (expected UID ${expectedMid}).`, { submission: 'not_sent' });
    }
    throw error;
  }
  const actualMid = status?.user?.mid !== undefined && status?.user?.mid !== null ? String(status.user.mid).trim() : '';
  if (!status?.logged_in || actualMid !== String(expectedMid)) {
    throw new BilibiliError('ACCOUNT_MISMATCH', `Account safety lock rejected write: profile "${profileLabel}" has UID ${actualMid || 'none'}, expected UID ${expectedMid}.`, { submission: 'not_sent' });
  }
}
