import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const capabilityCache = new Map();
const targetResolveCache = new Map();
const whoamiProbeCache = new Map();
const TARGET_RESOLVE_TTL_MS = 60_000;
const WHOAMI_PROBE_TTL_MS = 60_000;
const RESOURCES_CACHE_TTL_MS = 2_000;

const EXIT_CODE_DEFAULTS = {
  2: 'invalid_argument',
  3: 'not_logged_in',
  4: 'permission_denied',
  5: 'local_storage_error',
  6: 'not_found_or_conflict',
  7: 'network_or_timeout',
  8: 'wait_timeout',
  130: 'interrupted',
  143: 'interrupted',
};

const FULL_SCRIPT_CAPABILITIES = Object.freeze({
  valid: true,
  isScript: true,
  hasComputer: true,
  hasWs: true,
  hasResources: true,
  hasTerm: true,
  hasTermList: true,
  hasTermStatus: true,
  hasTermSend: true,
  hasTermRead: true,
  hasTermWait: true,
  hasTermClose: true,
  hasAgents: true,
  hasMemo: true,
  hasLs: true,
  hasStat: true,
  hasFind: true,
  hasDesktop: true,
  hasMobile: true,
  hasCopy: true,
  hasForward: true,
  hasSkill: true,
  hasCompanionRootFlag: true,
  score: 6,
});

export function clearResolveV42BinaryCache() {
  targetResolveCache.clear();
  whoamiProbeCache.clear();
  capabilityCache.clear();
}

export function resolveHomeDir(env = process.env) {
  const fromEnv = (typeof env?.USERPROFILE === 'string' && env.USERPROFILE.trim())
    || (typeof env?.HOME === 'string' && env.HOME.trim())
    || '';
  if (fromEnv) return fromEnv;
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

export function resolveLocalAppData(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return '';
  if (typeof env?.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) {
    return env.LOCALAPPDATA.trim();
  }
  const home = resolveHomeDir(env);
  return home ? path.join(home, 'AppData', 'Local') : '';
}

function buildSafeChildEnv(env = process.env, { agentName = 'kiki', platform = process.platform } = {}) {
  const home = resolveHomeDir(env);
  const childEnv = {
    ...env,
    V42_AGENT_NAME: env?.V42_AGENT_NAME || agentName || 'kiki',
  };
  if (home) {
    if (platform === 'win32') {
      if (!childEnv.USERPROFILE) childEnv.USERPROFILE = home;
      if (!childEnv.LOCALAPPDATA) childEnv.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
      if (!childEnv.APPDATA) childEnv.APPDATA = path.join(home, 'AppData', 'Roaming');
    } else if (!childEnv.HOME) {
      childEnv.HOME = home;
    }
  }
  return childEnv;
}

async function isExecutableFile(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  try {
    const info = await stat(candidate);
    if (!info.isFile() || info.size <= 0) return false;
    await access(candidate, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export async function pruneStaleTransferLocks(companionRoot, { maxAgeMs = 3_600_000 } = {}) {
  if (!companionRoot || typeof companionRoot !== 'string') return { removed: 0 };
  const cliDir = path.join(path.resolve(companionRoot), 'cli');
  let entries;
  try {
    entries = await readdir(cliDir);
  } catch {
    return { removed: 0 };
  }
  const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 3_600_000);
  let removed = 0;
  for (const name of entries) {
    if (!/^transfer-[0-9a-f]+\.lock$/i.test(name)) continue;
    const fullPath = path.join(cliDir, name);
    try {
      const info = await stat(fullPath);
      if (info.isFile() && info.size === 0 && info.mtimeMs < cutoff) {
        await rm(fullPath, { force: true });
        removed += 1;
      }
    } catch {}
  }
  return { removed };
}

export async function isValidCompanionRoot(dir) {
  if (!(await isDirectory(dir))) return false;
  try {
    if (await isDirectory(path.join(dir, 'data'))) return true;
  } catch {}
  try {
    const cliDir = path.join(dir, 'cli');
    if (await isDirectory(cliDir)) {
      const entries = await readdir(cliDir);
      if (entries.some((name) => /^delegated-session-.*\.json$|^profile-.*\.json$|^bootstrap-.*\.json$/i.test(name))) {
        return true;
      }
    }
  } catch {}
  return false;
}

export async function discoverCompanionRoots({
  settings = {},
  env = process.env,
  platform = process.platform,
} = {}) {
  const candidates = [];
  const pushUnique = (dir) => {
    if (!dir || typeof dir !== 'string' || !dir.trim()) return;
    const resolved = path.resolve(dir.trim());
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  if (typeof settings?.companionRoot === 'string' && settings.companionRoot.trim()) {
    pushUnique(settings.companionRoot);
  }
  if (typeof env?.V42_COMPANION_ROOT === 'string' && env.V42_COMPANION_ROOT.trim()) {
    pushUnique(env.V42_COMPANION_ROOT);
  }

  const home = resolveHomeDir(env);
  if (platform === 'win32') {
    const localAppData = resolveLocalAppData(env, platform);
    if (localAppData) {
      pushUnique(path.join(localAppData, 'ai.vibecafe.v42.companion'));
      pushUnique(path.join(localAppData, 'ai.vibecafe.v42.test.companion'));
    }
    if (home) {
      pushUnique(path.join(home, 'AppData', 'Local', 'ai.vibecafe.v42.companion'));
      pushUnique(path.join(home, 'AppData', 'Local', 'ai.vibecafe.v42.test.companion'));
      pushUnique(path.join(home, '.v42'));
    }
  } else if (platform === 'darwin') {
    if (home) {
      pushUnique(path.join(home, 'Library', 'Application Support', 'ai.vibecafe.v42.companion'));
      pushUnique(path.join(home, 'Library', 'Application Support', 'ai.vibecafe.v42.test.companion'));
      pushUnique(path.join(home, '.v42'));
    }
    pushUnique('/Applications/Vibe42.app/Contents/Resources');
  } else {
    if (home) {
      pushUnique(path.join(home, '.local', 'share', 'ai.vibecafe.v42.companion'));
      pushUnique(path.join(home, '.local', 'share', 'ai.vibecafe.v42.test.companion'));
      pushUnique(path.join(home, '.v42'));
    }
  }

  const valid = [];
  for (const dir of candidates) {
    if (await isValidCompanionRoot(dir)) {
      valid.push(dir);
    }
  }
  return valid;
}

function inferCompanionRootFromBinary(binPath) {
  const resolved = path.resolve(binPath);
  const dir = path.dirname(resolved);
  const base = path.basename(dir).toLowerCase();
  if (base === 'bin') {
    const parent = path.dirname(dir);
    const grand = path.basename(path.dirname(parent)).toLowerCase();
    const greatGrand = path.basename(path.dirname(path.dirname(parent))).toLowerCase();
    if (grand === 'releases' && greatGrand === 'updates') {
      return path.dirname(path.dirname(path.dirname(parent)));
    }
    return parent;
  }
  return null;
}

async function runQuickCapture(binPath, argv, env, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    let child;
    try {
      child = spawnV42Process(binPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ code: 1, stdout: '', stderr: err?.message || String(err), error: err });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: 7, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.once('error', (err) => finish({ code: 1, stdout, stderr, error: err }));
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

async function probeV42Capabilities(binPath, env = process.env) {
  const resolved = path.resolve(binPath);
  const cached = capabilityCache.get(resolved);
  if (cached) return cached;

  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
    capabilityCache.set(resolved, FULL_SCRIPT_CAPABILITIES);
    return FULL_SCRIPT_CAPABILITIES;
  }

  const helpRes = await runQuickCapture(resolved, ['--help'], env, 2_500);
  const out = `${helpRes.stdout}\n${helpRes.stderr}`;
  if (helpRes.error || (!out.trim() && helpRes.code !== 0)) {
    const invalid = { valid: false, isScript: false, score: 0 };
    capabilityCache.set(resolved, invalid);
    return invalid;
  }

  const hasSub = (name) => new RegExp(`^\\s{1,6}${name}\\b`, 'm').test(out);
  const hasTerm = hasSub('term');
  let termOut = '';
  if (hasTerm) {
    const termHelp = await runQuickCapture(resolved, ['term', '--help'], env, 2_200);
    termOut = `${termHelp.stdout}\n${termHelp.stderr}`;
  }
  const hasTermSub = (name) => new RegExp(`^\\s{1,6}${name}\\b`, 'm').test(termOut);

  const hasComputer = hasSub('computer');
  const hasWs = hasSub('ws');
  const hasResources = hasSub('resources');
  const hasTermList = hasTermSub('list');
  const hasTermStatus = hasTermSub('status');
  const hasTermSend = hasTermSub('send');
  const hasTermRead = hasTermSub('read');
  const hasTermWait = hasTermSub('wait');
  const hasTermClose = hasTermSub('close');
  const hasAgents = hasSub('agents');
  const hasMemo = hasSub('memo');
  const hasLs = hasSub('ls');
  const hasStat = hasSub('stat');
  const hasFind = hasSub('find');
  const hasDesktop = hasSub('desktop');
  const hasMobile = hasSub('mobile');
  const hasCopy = hasSub('copy');
  const hasForward = hasSub('forward');
  const hasSkill = hasSub('skill');
  const hasCompanionRootFlag = /--companion-root\b/.test(out);

  const score =
    (hasResources ? 1 : 0) +
    (hasComputer ? 1 : 0) +
    (hasTermList ? 1 : 0) +
    (hasTermSend && hasTermRead ? 1 : 0) +
    (hasDesktop ? 1 : 0) +
    (hasMobile ? 1 : 0);

  const cap = {
    valid: helpRes.code === 0 || /\bUsage:\s*v42/i.test(out),
    isScript: false,
    hasComputer,
    hasWs,
    hasResources,
    hasTerm,
    hasTermList,
    hasTermStatus,
    hasTermSend,
    hasTermRead,
    hasTermWait,
    hasTermClose,
    hasAgents,
    hasMemo,
    hasLs,
    hasStat,
    hasFind,
    hasDesktop,
    hasMobile,
    hasCopy,
    hasForward,
    hasSkill,
    hasCompanionRootFlag,
    score,
  };

  capabilityCache.set(resolved, cap);
  return cap;
}

async function probeWhoami(binPath, {
  companionRoot = null,
  settings = {},
  env = process.env,
  supportsCompanionRoot = true,
  cacheTtlMs = WHOAMI_PROBE_TTL_MS,
} = {}) {
  const cacheKey = [
    path.resolve(binPath),
    companionRoot || '',
    settings?.profile || '',
    settings?.teamId || '',
  ].join('\0');

  if (cacheTtlMs > 0) {
    const cached = whoamiProbeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      return cached.result;
    }
  }

  const argv = [
    ...buildGlobalArgs(settings, { companionRoot, supportsCompanionRoot }),
    'whoami',
  ];
  const res = await runQuickCapture(binPath, argv, env, 10_000);
  let result;
  if (res.code === 0) {
    try {
      const data = parseJsonEnvelope(res.stdout, res.stderr, 0);
      result = { signedIn: true, exitCode: 0, user: data, error: null };
    } catch (err) {
      result = { signedIn: false, exitCode: res.code, user: null, error: err };
    }
  } else {
    let errObj = null;
    try {
      parseJsonEnvelope(res.stdout, res.stderr, res.code);
    } catch (err) {
      errObj = err;
    }
    result = { signedIn: false, exitCode: res.code, user: null, error: errObj };
  }

  if (cacheTtlMs > 0) {
    whoamiProbeCache.set(cacheKey, { at: Date.now(), result });
  }
  return result;
}

export async function resolveV42Target({
  settings = {},
  env = process.env,
  platform = process.platform,
  cacheTtlMs = TARGET_RESOLVE_TTL_MS,
  skipWhoamiProbe = false,
} = {}) {
  const explicitSetting = (typeof settings?.v42BinPath === 'string' && settings.v42BinPath.trim())
    || (typeof settings?.v42Path === 'string' && settings.v42Path.trim())
    || '';
  const explicitCompanionRoot = (typeof settings?.companionRoot === 'string' && settings.companionRoot.trim())
    || (typeof env?.V42_COMPANION_ROOT === 'string' && env.V42_COMPANION_ROOT.trim())
    || '';
  const pathEnv = String(env?.PATH || env?.Path || '');
  const home = resolveHomeDir(env);
  const localAppData = resolveLocalAppData(env, platform);

  const cacheKey = [
    explicitSetting,
    explicitCompanionRoot,
    typeof env?.KIKI_V42_BIN === 'string' ? env.KIKI_V42_BIN.trim() : '',
    typeof env?.V42_BIN === 'string' ? env.V42_BIN.trim() : '',
    settings?.profile || '',
    settings?.teamId || '',
    pathEnv,
    localAppData,
    home,
    platform,
    skipWhoamiProbe ? '1' : '0',
  ].join('\0');

  if (cacheTtlMs > 0) {
    const cached = targetResolveCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      return cached.target;
    }
  }

  const remember = (target) => {
    if (cacheTtlMs > 0) {
      targetResolveCache.set(cacheKey, { at: Date.now(), target });
    }
    return target;
  };

  const isWin = platform === 'win32';
  const binNames = isWin ? ['v42.exe', 'v42.cmd', 'v42'] : ['v42'];
  const validCompanionRoots = await discoverCompanionRoots({ settings, env, platform });

  const resolveForSingleExplicitBin = async (binPath) => {
    const resolved = path.resolve(binPath);
    const cap = await probeV42Capabilities(resolved, env);
    if (cap.isScript) {
      return remember({
        binPath: resolved,
        companionRoot: explicitCompanionRoot ? path.resolve(explicitCompanionRoot) : null,
        capabilities: cap,
        whoami: null,
        signedIn: true,
      });
    }
    const inferredRoot = inferCompanionRootFromBinary(resolved);
    const rootOptions = [];
    const addRoot = (r) => {
      if (r && !rootOptions.includes(r)) rootOptions.push(r);
    };
    if (explicitCompanionRoot) addRoot(path.resolve(explicitCompanionRoot));
    if (inferredRoot && await isValidCompanionRoot(inferredRoot)) addRoot(inferredRoot);
    for (const r of validCompanionRoots) addRoot(r);
    rootOptions.push(null);

    if (skipWhoamiProbe) {
      return remember({
        binPath: resolved,
        companionRoot: rootOptions[0] ?? null,
        capabilities: cap,
        whoami: null,
        signedIn: null,
      });
    }

    let firstProbe = null;
    for (const root of rootOptions) {
      const probe = await probeWhoami(resolved, {
        companionRoot: root,
        settings,
        env,
        supportsCompanionRoot: cap.hasCompanionRootFlag,
        cacheTtlMs,
      });
      if (!firstProbe) firstProbe = { root, probe };
      if (probe.signedIn) {
        return remember({
          binPath: resolved,
          companionRoot: root,
          capabilities: cap,
          whoami: probe.user,
          signedIn: true,
        });
      }
      if (probe.exitCode !== 3 && probe.exitCode !== 5) break;
    }

    return remember({
      binPath: resolved,
      companionRoot: firstProbe?.root ?? rootOptions[0] ?? null,
      capabilities: cap,
      whoami: null,
      signedIn: false,
    });
  };

  if (explicitSetting) {
    if (await isExecutableFile(explicitSetting)) {
      return resolveForSingleExplicitBin(explicitSetting);
    }
    const err = new Error(
      `Configured v42 binary was not found or is not executable: ${explicitSetting}. Update v42BinPath in Kiki Plugin Settings or clear it to auto-discover.`,
    );
    err.code = 'ENOENT';
    throw err;
  }

  const explicitEnvBins = [
    typeof env?.KIKI_V42_BIN === 'string' ? env.KIKI_V42_BIN.trim() : '',
    typeof env?.V42_BIN === 'string' ? env.V42_BIN.trim() : '',
  ].filter(Boolean);

  for (const explicit of explicitEnvBins) {
    if (await isExecutableFile(explicit)) {
      return resolveForSingleExplicitBin(explicit);
    }
  }

  const standardDirs = [];
  const pushDir = (d) => {
    if (d && !standardDirs.includes(d)) standardDirs.push(d);
  };

  if (isWin) {
    const addCompanionChannelDirs = async (baseDir) => {
      if (!baseDir) return;
      const topBinDir = path.join(baseDir, 'bin');
      pushDir(topBinDir);
      // Only inspect updates/releases fallback when the active top-level bin/v42.exe is absent.
      const hasTopBin = await isExecutableFile(path.join(topBinDir, 'v42.exe'));
      if (!hasTopBin) {
        const releasesDir = path.join(baseDir, 'updates', 'releases');
        try {
          const relEntries = (await readdir(releasesDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
            .reverse();
          for (const rel of relEntries) {
            pushDir(path.join(releasesDir, rel, 'bin'));
            pushDir(path.join(releasesDir, rel));
          }
        } catch {}
      }
      pushDir(baseDir);
    };

    if (localAppData) {
      await addCompanionChannelDirs(path.join(localAppData, 'ai.vibecafe.v42.companion'));
      await addCompanionChannelDirs(path.join(localAppData, 'ai.vibecafe.v42.test.companion'));
      pushDir(path.join(localAppData, 'Vibe42', 'bin'));
      pushDir(path.join(localAppData, 'Vibe42'));
      pushDir(path.join(localAppData, 'Programs', 'Vibe42', 'bin'));
      pushDir(path.join(localAppData, 'Programs', 'Vibe42'));
    }
    if (env?.ProgramFiles) {
      pushDir(path.join(env.ProgramFiles, 'Vibe42', 'bin'));
      pushDir(path.join(env.ProgramFiles, 'Vibe42'));
    }
    if (home) {
      pushDir(path.join(home, '.v42', 'bin'));
      pushDir(path.join(home, '.vibe42', 'bin'));
    }
  } else if (platform === 'darwin') {
    if (home) {
      pushDir(path.join(home, '.v42', 'bin'));
      pushDir(path.join(home, 'Library', 'Application Support', 'ai.vibecafe.v42.companion', 'bin'));
      pushDir(path.join(home, 'Library', 'Application Support', 'ai.vibecafe.v42.test.companion', 'bin'));
      pushDir(path.join(home, 'Applications', 'Vibe42.app', 'Contents', 'Resources', 'bin'));
      pushDir(path.join(home, '.vibe42', 'bin'));
      pushDir(path.join(home, '.local', 'bin'));
    }
    pushDir('/Applications/Vibe42.app/Contents/Resources/bin');
    pushDir('/Applications/Vibe42.app/Contents/MacOS');
    pushDir('/opt/homebrew/bin');
    pushDir('/usr/local/bin');
  } else {
    if (home) {
      pushDir(path.join(home, '.v42', 'bin'));
      pushDir(path.join(home, '.local', 'share', 'ai.vibecafe.v42.companion', 'bin'));
      pushDir(path.join(home, '.local', 'share', 'ai.vibecafe.v42.test.companion', 'bin'));
      pushDir(path.join(home, '.vibe42', 'bin'));
      pushDir(path.join(home, '.local', 'bin'));
    }
    pushDir('/usr/local/bin');
    pushDir('/usr/bin');
  }

  const pathEntries = pathEnv
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const discovered = [];
  const seen = new Set();
  for (const dir of [...standardDirs, ...pathEntries]) {
    for (const name of binNames) {
      const candidate = path.resolve(dir, name);
      const normKey = isWin ? candidate.toLowerCase() : candidate;
      if (seen.has(normKey)) continue;
      seen.add(normKey);
      if (await isExecutableFile(candidate)) {
        discovered.push(candidate);
      }
    }
  }

  const evaluated = [];
  for (const binPath of discovered) {
    const cap = await probeV42Capabilities(binPath, env);
    if (!cap.valid) continue;

    const inferredRoot = inferCompanionRootFromBinary(binPath);
    const rootOptions = [];
    const addRoot = (r) => {
      if (r && !rootOptions.includes(r)) rootOptions.push(r);
    };
    if (explicitCompanionRoot) addRoot(path.resolve(explicitCompanionRoot));
    if (inferredRoot && await isValidCompanionRoot(inferredRoot)) addRoot(inferredRoot);
    for (const r of validCompanionRoots) addRoot(r);
    rootOptions.push(null);

    if (skipWhoamiProbe || cap.isScript) {
      evaluated.push({
        binPath,
        companionRoot: rootOptions[0] ?? null,
        capabilities: cap,
        whoami: null,
        signedIn: cap.isScript ? true : null,
        isTestChannel: /\.test\.companion/i.test(binPath) || /\.test\.companion/i.test(rootOptions[0] || ''),
      });
      continue;
    }

    let signedInTarget = null;
    for (const root of rootOptions) {
      const probe = await probeWhoami(binPath, {
        companionRoot: root,
        settings,
        env,
        supportsCompanionRoot: cap.hasCompanionRootFlag,
        cacheTtlMs,
      });
      if (probe.signedIn) {
        signedInTarget = {
          binPath,
          companionRoot: root,
          capabilities: cap,
          whoami: probe.user,
          signedIn: true,
          isTestChannel: /\.test\.companion/i.test(binPath) || /\.test\.companion/i.test(root || ''),
        };
        break;
      }
      if (probe.exitCode !== 3 && probe.exitCode !== 5) break;
    }

    if (signedInTarget) {
      evaluated.push(signedInTarget);
      if (!signedInTarget.isTestChannel && signedInTarget.capabilities.score >= 5) {
        return remember(signedInTarget);
      }
    } else {
      evaluated.push({
        binPath,
        companionRoot: rootOptions[0] ?? null,
        capabilities: cap,
        whoami: null,
        signedIn: false,
        isTestChannel: /\.test\.companion/i.test(binPath) || /\.test\.companion/i.test(rootOptions[0] || ''),
      });
    }
  }

  if (evaluated.length > 0) {
    evaluated.sort((a, b) => {
      const signDiff = (b.signedIn ? 1 : 0) - (a.signedIn ? 1 : 0);
      if (signDiff !== 0) return signDiff;
      const scoreDiff = (b.capabilities?.score || 0) - (a.capabilities?.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const channelDiff = (a.isTestChannel ? 1 : 0) - (b.isTestChannel ? 1 : 0);
      return channelDiff;
    });
    const best = evaluated[0];
    return remember({
      binPath: best.binPath,
      companionRoot: best.companionRoot,
      capabilities: best.capabilities,
      whoami: best.whoami,
      signedIn: best.signedIn,
    });
  }

  const configured = explicitEnvBins[0];
  const err = new Error(
    configured
      ? `Configured v42 binary was not found or is not executable: ${configured}. Update v42BinPath in Kiki Plugin Settings or clear it to auto-discover.`
      : 'Vibe42 CLI (v42) was not found. Install Vibe42 Companion, set v42BinPath in Kiki Plugin Settings, or export KIKI_V42_BIN.',
  );
  err.code = 'ENOENT';
  throw err;
}

export async function resolveV42Binary(options = {}) {
  const target = await resolveV42Target(options);
  return target.binPath;
}

export function buildGlobalArgs(settings = {}, {
  companionRoot = null,
  supportsCompanionRoot = true,
} = {}) {
  const agentName = (typeof settings?.agentName === 'string' && settings.agentName.trim()) || 'kiki';
  const args = ['--format', 'json', '--agent-name', agentName];
  const effectiveRoot = companionRoot
    || (typeof settings?.companionRoot === 'string' && settings.companionRoot.trim())
    || '';
  if (effectiveRoot && supportsCompanionRoot !== false) {
    args.push('--companion-root', effectiveRoot);
  }
  if (typeof settings?.profile === 'string' && settings.profile.trim()) {
    args.push('--profile', settings.profile.trim());
  }
  if (typeof settings?.teamId === 'string' && settings.teamId.trim()) {
    args.push('--team', settings.teamId.trim());
  }
  return args;
}

export function spawnV42Process(binPath, argv, {
  env = process.env,
  stdio = ['pipe', 'pipe', 'pipe'],
  cwd,
} = {}) {
  const ext = path.extname(binPath).toLowerCase();
  const childEnv = buildSafeChildEnv(env);

  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
    return spawn(process.execPath, [binPath, ...argv], {
      env: childEnv,
      cwd,
      stdio,
      shell: false,
      windowsHide: true,
    });
  }

  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', binPath, ...argv], {
      env: childEnv,
      cwd,
      stdio,
      shell: false,
      windowsHide: true,
    });
  }

  return spawn(binPath, argv, {
    env: childEnv,
    cwd,
    stdio,
    shell: false,
    windowsHide: true,
  });
}

export class V42CliError extends Error {
  constructor(message, { code = 'v42_error', exitCode = 1, details = null, status = null } = {}) {
    super(message);
    this.name = 'V42CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.status = status;
  }
}

export function parseJsonEnvelope(stdoutText, stderrText, exitCode) {
  const trimmedOut = String(stdoutText || '').trim();
  const trimmedErr = String(stderrText || '').trim();

  if (exitCode === 0) {
    if (!trimmedOut) return {};
    const lines = trimmedOut.split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1]);
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      if (parsed.ok) return parsed.data;
      const errObj = parsed.error || {};
      throw new V42CliError(errObj.message || 'v42 command failed', {
        code: errObj.code || 'v42_error',
        exitCode,
        details: errObj.details ?? null,
      });
    }
    return parsed;
  }

  for (const candidate of [trimmedErr, trimmedOut].filter(Boolean)) {
    const lines = candidate.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && parsed.ok === false && parsed.error) {
          const errCode = parsed.error.code || EXIT_CODE_DEFAULTS[exitCode] || 'v42_error';
          let errMsg = parsed.error.message || `v42 exited with ${exitCode}`;
          if (errCode === 'companion_unavailable' && !/Companion/i.test(errMsg)) {
            errMsg = `Vibe42 Companion daemon is not running (${errMsg}). Start the Vibe42 desktop app or Companion service, then retry.`;
          }
          throw new V42CliError(errMsg, {
            code: errCode,
            exitCode,
            details: parsed.error.details ?? null,
            status: parsed.error.details?.status ?? null,
          });
        }
      } catch (err) {
        if (err instanceof V42CliError) throw err;
      }
    }
  }

  const fallbackText = trimmedErr || trimmedOut;
  throw new V42CliError(fallbackText || `v42 command failed with exit code ${exitCode}`, {
    code: EXIT_CODE_DEFAULTS[exitCode] || 'v42_error',
    exitCode,
  });
}

export function parseSeatRef(seatRef) {
  const raw = String(seatRef || '').trim();
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep === raw.length - 1) {
    throw new V42CliError(
      `Invalid seat_ref "${raw}". Expected "<computer>:<terminalTarget>" (e.g. "mac-mini:@3" or "mac-mini:%5"); call v42_fleet({ scope: "seats" }) to list active targets.`,
      { code: 'invalid_seat_ref' },
    );
  }
  return {
    computer: raw.slice(0, sep),
    target: raw.slice(sep + 1),
  };
}

function inferAgentFromCommand(cmd, title) {
  const raw = String(cmd || '').trim();
  const lower = raw.toLowerCase();
  const titleLower = String(title || '').toLowerCase();
  if (/^\d+\.\d+\.\d+/.test(raw) || lower.includes('claude')) return 'claude-code';
  if (lower === 'omp' || titleLower.startsWith('π ')) return 'omp';
  if (lower === 'agy' || titleLower.includes('antigravity')) return 'agy';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('grok')) return 'grok';
  if (lower === 'kiki' || titleLower === 'kiki') return 'kiki';
  return raw || 'shell';
}

function isShellCommand(cmd) {
  const lower = String(cmd || '').trim().toLowerCase();
  return ['zsh', 'bash', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'cmd.exe', 'nu', 'v42-companion'].includes(lower);
}

export function flattenResourcesTerminals(resourcesData, { computer, workspace, idle, busy } = {}) {
  const computers = Array.isArray(resourcesData?.computers) ? resourcesData.computers : [];
  const workspaces = Array.isArray(resourcesData?.workspaces) ? resourcesData.workspaces : [];
  const compById = new Map(computers.map((c) => [c.id, c]));

  let matchedCompIds = null;
  if (computer) {
    const q = String(computer).toLowerCase();
    matchedCompIds = new Set(
      computers
        .filter((c) => String(c.id).toLowerCase() === q || String(c.name || '').toLowerCase() === q)
        .map((c) => c.id),
    );
    if (matchedCompIds.size === 0) matchedCompIds.add(String(computer));
  }

  let matchedWsIds = null;
  if (workspace) {
    const q = String(workspace).toLowerCase();
    matchedWsIds = new Set(
      workspaces
        .filter((w) => String(w.id).toLowerCase() === q || String(w.name || '').toLowerCase() === q)
        .map((w) => w.id),
    );
    if (matchedWsIds.size === 0) matchedWsIds.add(String(workspace));
  }

  const flattened = [];
  const groups = Array.isArray(resourcesData?.terminals) ? resourcesData.terminals : [];
  for (const group of groups) {
    if (Array.isArray(group?.terminals)) {
      const compId = group.computer_id;
      if (matchedCompIds && !matchedCompIds.has(compId)) continue;
      const compMeta = compById.get(compId);
      for (const win of group.terminals) {
        const wsId = win.workspaceId || win.workspace_id || null;
        if (matchedWsIds && (!wsId || !matchedWsIds.has(wsId))) continue;
        const panes = Array.isArray(win.panes) && win.panes.length > 0 ? win.panes : [null];
        const primaryPane = panes.find((p) => p?.active) || panes[0];
        const cmd = primaryPane?.currentCommand || primaryPane?.current_command || win.current_command || '';
        const paneTitle = primaryPane?.title || '';
        const winName = win.name || win.window_name || paneTitle || win.id;
        const inferredApp = inferAgentFromCommand(cmd, paneTitle || winName);
        const inferredIdle = win.idle !== undefined ? Boolean(win.idle) : isShellCommand(cmd);
        if (idle && !inferredIdle) continue;
        if (busy && inferredIdle) continue;
        flattened.push({
          computer_id: compId,
          computer_name: compMeta?.name || compId,
          window_id: win.id || win.window_id,
          pane_id: primaryPane?.id || win.pane_id || null,
          window_name: winName,
          title: paneTitle && paneTitle !== compMeta?.name ? `${winName} · ${paneTitle}` : winName,
          workspace_id: wsId,
          cwd: primaryPane?.currentPath || primaryPane?.current_path || win.cwd || null,
          current_command: cmd || null,
          active: Boolean(win.active),
          idle: inferredIdle,
          agent: win.agent || {
            app: inferredApp,
            state: inferredIdle ? 'idle' : 'working',
          },
        });
      }
    } else if (group && (group.window_id || group.pane_id || group.target)) {
      if (matchedCompIds && !matchedCompIds.has(group.computer_id)) continue;
      if (matchedWsIds && (!group.workspace_id || !matchedWsIds.has(group.workspace_id))) continue;
      if (idle && !group.idle) continue;
      if (busy && group.idle) continue;
      flattened.push(group);
    }
  }

  return { terminals: flattened, computers };
}

class StdioBridgeSession {
  constructor(binPath, settings, env, companionRoot = null) {
    this.binPath = binPath;
    this.settings = settings;
    this.env = env;
    this.companionRoot = companionRoot;
    this.child = null;
    this.reqId = 0;
    this.pending = new Map();
    this.unsupported = false;
  }

  async ensureOpen() {
    if (this.unsupported) return false;
    if (this.child && !this.child.killed && this.child.exitCode === null) return true;

    const argv = [...buildGlobalArgs(this.settings, { companionRoot: this.companionRoot }), 'bridge', '--stdio'];
    const child = spawnV42Process(this.binPath, argv, { env: this.env });
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const waiter = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error || msg.ok === false) {
          const errInfo = msg.error || {};
          waiter.reject(new V42CliError(errInfo.message || 'bridge RPC error', {
            code: errInfo.code || 'bridge_error',
            details: errInfo.details ?? null,
            status: errInfo.status ?? null,
          }));
        } else {
          waiter.resolve(msg.result !== undefined ? msg.result : msg.data);
        }
      }
    });

    const onExit = (code) => {
      if (this.child === child) this.child = null;
      if (code === 2) this.unsupported = true;
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new V42CliError('v42 bridge process exited', { code: 'bridge_closed', exitCode: code ?? 1 }));
      }
      this.pending.clear();
    };
    child.once('exit', onExit);
    child.once('error', () => onExit(1));
    child.stderr?.resume();
    return true;
  }

  async close() {
    const child = this.child;
    this.child = null;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('bridge closed'));
    }
    this.pending.clear();
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {}
  }
}

export class V42Client {
  constructor({ env = process.env, fetchFn = fetch } = {}) {
    this.env = env;
    this.fetchFn = fetchFn;
    this.stdioBridge = null;
    this.stdioBridgeKey = '';
    this.resourcesCache = new Map();
    this.resourcesInFlight = new Map();
    this.transferInFlight = new Map();
  }

  async resolveTarget(context = {}) {
    return resolveV42Target({
      settings: context.settings,
      env: this.env,
      skipWhoamiProbe: context.skipWhoamiProbe,
    });
  }

  async resolveBinary(context = {}) {
    const target = await this.resolveTarget(context);
    return target.binPath;
  }

  requireCapability(target, flagName, commandLabel) {
    if (target?.capabilities?.[flagName] === false) {
      throw new V42CliError(
        `The installed v42 CLI (${target.binPath}) does not support "${commandLabel}". Upgrade Vibe42 Companion or configure a newer v42BinPath in Plugin Settings.`,
        { code: 'cli_upgrade_required', exitCode: 2, details: { command: commandLabel, binPath: target.binPath } },
      );
    }
  }

  async runJson(subcommandArgs, {
    settings = {},
    workspaceRoot,
    stdinText,
    timeoutMs = 30_000,
    signal,
    resolvedTarget = null,
  } = {}) {
    signal?.throwIfAborted();
    const target = resolvedTarget || await this.resolveTarget({ settings, workspaceRoot });
    const argv = [
      ...buildGlobalArgs(settings, {
        companionRoot: target.companionRoot,
        supportsCompanionRoot: target.capabilities?.hasCompanionRootFlag !== false && !target.capabilities?.isScript,
      }),
      ...subcommandArgs,
    ];

    return new Promise((resolve, reject) => {
      const child = spawnV42Process(target.binPath, argv, { env: this.env });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(val);
      };

      const onAbort = () => {
        try { child.kill(); } catch {}
        finish(reject, signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            try { child.kill(); } catch {}
            finish(reject, new V42CliError(`v42 ${subcommandArgs[0] || ''} timed out after ${timeoutMs}ms`, { code: 'cli_timeout', exitCode: 7 }));
          }, timeoutMs)
        : null;
      timer?.unref?.();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (err) => finish(reject, err));
      child.once('close', (code) => {
        try {
          const data = parseJsonEnvelope(stdout, stderr, code ?? 1);
          finish(resolve, data);
        } catch (err) {
          finish(reject, err);
        }
      });

      if (stdinText !== undefined) {
        child.stdin.end(stdinText, 'utf8');
      } else {
        child.stdin.end();
      }
    });
  }

  async gatewayRequest(method, endpointPath, {
    query = {},
    body,
    settings = {},
    signal,
    timeoutMs = 15_000,
  } = {}) {
    const endpoint = typeof settings?.gatewayEndpoint === 'string'
      ? settings.gatewayEndpoint.trim()
      : (this.env.V42_GATEWAY_ENDPOINT || '').trim();
    if (!endpoint) return null;

    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/|$)/i.test(endpoint)) {
      const url = new URL(endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`, endpoint);
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
      const timeoutSig = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      let res;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: combinedSignal,
        });
      } catch {
        return null;
      }
      if (res.status === 404 || res.status === 501) return null;
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        const errInfo = payload?.error || payload || {};
        throw new V42CliError(errInfo.message || `Gateway HTTP ${res.status}`, {
          code: errInfo.code || `http_${res.status}`,
          status: res.status,
          details: errInfo,
        });
      }
      return payload?.data !== undefined ? payload.data : payload;
    }

    return null;
  }

  async whoami(ctx = {}) {
    const target = await this.resolveTarget(ctx);
    if (target.whoami) return target.whoami;
    return this.runJson(['whoami'], { ...ctx, resolvedTarget: target });
  }

  async listResources(ctx = {}) {
    const target = await this.resolveTarget(ctx);
    const cacheKey = `${target.binPath}\0${target.companionRoot || ''}\0${ctx.settings?.profile || ''}\0${ctx.settings?.teamId || ''}`;
    if (!ctx.forceRefresh) {
      const cached = this.resourcesCache.get(cacheKey);
      if (cached && Date.now() - cached.at < RESOURCES_CACHE_TTL_MS) {
        return cached.data;
      }
      const inFlight = this.resourcesInFlight.get(cacheKey);
      if (inFlight) return inFlight;
    }

    const promise = this.runJson(['resources'], { ...ctx, resolvedTarget: target })
      .then((data) => {
        this.resourcesCache.set(cacheKey, { at: Date.now(), data });
        return data;
      })
      .finally(() => {
        this.resourcesInFlight.delete(cacheKey);
      });
    this.resourcesInFlight.set(cacheKey, promise);
    return promise;
  }

  async listComputers(ctx = {}) {
    const target = await this.resolveTarget(ctx);
    if (target.capabilities?.hasComputer) {
      try {
        const data = await this.runJson(['computer', 'list'], { ...ctx, resolvedTarget: target });
        return Array.isArray(data?.computers) ? data.computers : (Array.isArray(data) ? data : []);
      } catch (err) {
        if (err?.code !== 'invalid_argument') throw err;
      }
    }
    const res = await this.listResources(ctx);
    return Array.isArray(res?.computers) ? res.computers : [];
  }

  async listWorkspaces(ctx = {}) {
    const target = await this.resolveTarget(ctx);
    if (target.capabilities?.hasWs !== false) {
      try {
        const data = await this.runJson(['ws', 'list'], { ...ctx, resolvedTarget: target });
        return Array.isArray(data?.workspaces) ? data.workspaces : (Array.isArray(data) ? data : []);
      } catch (err) {
        if (err?.code !== 'invalid_argument') throw err;
      }
    }
    const res = await this.listResources(ctx);
    return Array.isArray(res?.workspaces) ? res.workspaces : [];
  }

  async listTerminals({ computer, workspace, idle, busy, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    if (target.capabilities?.hasTermList) {
      const argv = ['term', 'list'];
      if (workspace) argv.push('--workspace', String(workspace));
      if (idle) argv.push('--idle');
      if (busy) argv.push('--busy');
      if (computer) argv.push(String(computer));
      try {
        const data = await this.runJson(argv, { ...ctx, resolvedTarget: target });
        return {
          terminals: Array.isArray(data?.terminals) ? data.terminals : [],
          computers: Array.isArray(data?.computers) ? data.computers : [],
        };
      } catch (err) {
        if (err?.code !== 'invalid_argument') throw err;
      }
    }
    const res = await this.listResources(ctx);
    return flattenResourcesTerminals(res, { computer, workspace, idle, busy });
  }

  async listAgents(ctx = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasAgents', 'v42 agents list');
    const data = await this.runJson(['agents', 'list'], { ...ctx, resolvedTarget: target });
    return Array.isArray(data?.agents) ? data.agents : (Array.isArray(data?.launchers) ? data.launchers : (Array.isArray(data) ? data : []));
  }

  async createTerminal({ computer, workspace, cwd, title, agent, launcher, command, ...ctx }) {
    const target = await this.resolveTarget(ctx);
    const argv = ['term', 'new', String(computer)];
    if (workspace) argv.push('--workspace', String(workspace));
    if (cwd) argv.push('--cwd', String(cwd));
    if (title) argv.push('--name', String(title));
    if (launcher) argv.push('--launcher', String(launcher));
    else if (agent) argv.push('--agent', String(agent));
    if (command) argv.push('--command', String(command));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async terminalStatus(computer, targetRef, ctx = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasTermStatus', 'v42 term status');
    return this.runJson(['term', 'status', String(computer), String(targetRef)], { ...ctx, resolvedTarget: target });
  }

  async terminalSend(computer, targetRef, {
    text,
    enter = false,
    keys = [],
    paste = false,
    useStdin = false,
    ...ctx
  } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasTermSend', 'v42 term send');
    const argv = ['term', 'send'];
    let stdinText;
    const hasText = text !== undefined && text !== null && text !== '';
    const shouldStdin = hasText && (useStdin || String(text).includes('\n') || String(text).length > 512);

    if (shouldStdin) {
      argv.push('--stdin');
      stdinText = String(text);
    }
    if (hasText && paste) argv.push('--paste');
    for (const key of keys) {
      argv.push('--key', String(key));
    }
    if (enter) argv.push('--enter');

    argv.push(String(computer), String(targetRef));
    if (hasText && !shouldStdin) {
      argv.push('--', String(text));
    }
    return this.runJson(argv, { ...ctx, resolvedTarget: target, stdinText });
  }

  async terminalRead(computer, targetRef, { history, all = false, raw = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasTermRead', 'v42 term read');
    const argv = ['term', 'read'];
    if (all) argv.push('--all');
    else if (Number.isFinite(history) && history > 0) argv.push('--history', String(Math.round(history)));
    if (raw) argv.push('--raw');
    argv.push(String(computer), String(targetRef));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async terminalWait(computer, targetRef, { until = 'done', match, timeoutSec = 25, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasTermWait', 'v42 term wait');
    const secs = Math.max(1, Math.ceil(Number(timeoutSec) || 25));
    const argv = ['term', 'wait', '--until', String(until), '--timeout', String(secs)];
    if (match) argv.push('--match', String(match));
    argv.push(String(computer), String(targetRef));
    try {
      const data = await this.runJson(argv, {
        ...ctx,
        resolvedTarget: target,
        timeoutMs: (secs + 8) * 1000,
      });
      return { timedOut: false, exitCode: 0, data };
    } catch (err) {
      if (err instanceof V42CliError && (err.exitCode === 8 || err.code === 'wait_timeout')) {
        return { timedOut: true, exitCode: 8, code: 'wait_timeout', data: err.details || null };
      }
      throw err;
    }
  }

  async terminalClose(computer, targets, { force = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasTermClose', 'v42 term close');
    const list = Array.isArray(targets) ? targets : [targets];
    const argv = ['term', 'close'];
    if (force) argv.push('--force');
    argv.push(String(computer), ...list.map(String));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  buildCopyScopeArgs({ workspace, computer, root, copy } = {}) {
    const argv = [];
    if (workspace) argv.push('--workspace', String(workspace));
    else if (computer) {
      argv.push('--computer', String(computer));
      if (root) argv.push('--root', String(root));
    } else if (root) {
      argv.push('--root', String(root));
    }
    if (copy !== undefined && copy !== null && copy !== '') {
      argv.push('--copy', String(copy));
    }
    return argv;
  }

  async copyStatus(scope = {}, ctx = {}) {
    return this.runJson(['copy', 'status', ...this.buildCopyScopeArgs(scope)], ctx);
  }

  async copyChanges({ from, to, ...scope } = {}, ctx = {}) {
    const argv = ['copy', 'changes', ...this.buildCopyScopeArgs(scope)];
    if (from) argv.push('--from', String(from));
    if (to) argv.push('--to', String(to));
    return this.runJson(argv, ctx);
  }

  async copyDiff(filePath, { from, to, ...scope } = {}, ctx = {}) {
    const argv = ['copy', 'diff', ...this.buildCopyScopeArgs(scope)];
    if (from) argv.push('--from', String(from));
    if (to) argv.push('--to', String(to));
    argv.push(String(filePath));
    return this.runJson(argv, ctx);
  }

  async copySave({ message, ...scope } = {}, ctx = {}) {
    const argv = ['copy', 'save', ...this.buildCopyScopeArgs(scope)];
    if (message) argv.push('-m', String(message));
    return this.runJson(argv, ctx);
  }

  async copyApply({ paths = [], all = true, ...scope } = {}, ctx = {}) {
    const argv = ['copy', 'apply', ...this.buildCopyScopeArgs(scope)];
    if (paths.length > 0) argv.push(...paths.map(String));
    else if (all) argv.push('--all');
    return this.runJson(argv, ctx);
  }

  async copyPush({ branch, ...scope } = {}, ctx = {}) {
    if (!branch) throw new V42CliError('copy push requires branch name', { code: 'missing_branch' });
    const argv = ['copy', 'push', '--branch', String(branch), ...this.buildCopyScopeArgs(scope)];
    return this.runJson(argv, ctx);
  }

  async listMemos(workspace, { done = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMemo', 'v42 memo list');
    const argv = ['memo', 'list'];
    if (done) argv.push('--done');
    argv.push(String(workspace));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async copyTransfer(source, destination, { recursive = true, restart = false, ...ctx } = {}) {
    const key = `cp\0${source}\0${destination}\0${recursive ? '1' : '0'}`;
    if (this.transferInFlight.has(key)) {
      return this.transferInFlight.get(key);
    }
    const target = await this.resolveTarget(ctx);
    const argv = ['cp'];
    if (recursive) argv.push('-r');
    if (restart) argv.push('--restart');
    argv.push(String(source), String(destination));
    const run = this.runJson(argv, { ...ctx, resolvedTarget: target, timeoutMs: ctx.timeoutMs || 120_000 })
      .finally(() => {
        this.transferInFlight.delete(key);
        if (target?.companionRoot) {
          void pruneStaleTransferLocks(target.companionRoot).catch(() => {});
        }
      });
    this.transferInFlight.set(key, run);
    return run;
  }

  async syncTransfer(source, destination, { deleteExtra = false, restart = false, ...ctx } = {}) {
    const key = `sync\0${source}\0${destination}\0${deleteExtra ? '1' : '0'}`;
    if (this.transferInFlight.has(key)) {
      return this.transferInFlight.get(key);
    }
    const target = await this.resolveTarget(ctx);
    const argv = ['sync'];
    if (deleteExtra) argv.push('--delete');
    if (restart) argv.push('--restart');
    argv.push(String(source), String(destination));
    const run = this.runJson(argv, { ...ctx, resolvedTarget: target, timeoutMs: ctx.timeoutMs || 180_000 })
      .finally(() => {
        this.transferInFlight.delete(key);
        if (target?.companionRoot) {
          void pruneStaleTransferLocks(target.companionRoot).catch(() => {});
        }
      });
    this.transferInFlight.set(key, run);
    return run;
  }

  async listRemoteDir(location, { all = false, long = true, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasLs', 'v42 ls');
    const argv = ['ls'];
    if (all) argv.push('-a');
    if (long) argv.push('-l');
    argv.push(String(location));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async statRemote(location, ctx = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasStat', 'v42 stat');
    return this.runJson(['stat', String(location)], { ...ctx, resolvedTarget: target });
  }

  async findRemote(location, pattern, { limit, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasFind', 'v42 find');
    const argv = ['find', String(location), String(pattern)];
    if (Number.isFinite(limit) && limit > 0) argv.push('--limit', String(Math.round(limit)));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async desktopWindows(computer, ctx = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasDesktop', 'v42 desktop windows');
    return this.runJson(['desktop', 'windows', String(computer)], { ...ctx, resolvedTarget: target });
  }

  async desktopScreenshotOneShot(computer, { displayId, windowId, quality = 'high', ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasDesktop', 'v42 desktop screenshot');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kiki-v42-dshot-'));
    const outFile = path.join(tempDir, 'desktop.png');
    try {
      const argv = ['desktop', 'screenshot', '-o', outFile, '--quality', String(quality)];
      if (displayId !== undefined && displayId !== null) argv.push('--display', String(displayId));
      if (windowId !== undefined && windowId !== null) argv.push('--window', String(windowId));
      argv.push(String(computer));
      const meta = await this.runJson(argv, { ...ctx, resolvedTarget: target, timeoutMs: ctx.timeoutMs || 35_000 });
      const pngBuffer = await readFile(outFile);
      return { meta, pngBuffer };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  buildMobilePrefix({ computer, local = false } = {}) {
    const argv = ['mobile'];
    if (local) argv.push('--local');
    else if (computer && computer !== 'local') argv.push('-c', String(computer));
    return argv;
  }

  async mobileDevices({ computer, refresh = false, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    if (!target.capabilities?.hasMobile) return [];
    const argv = [...this.buildMobilePrefix({ computer, local }), 'devices'];
    if (refresh) argv.push('--refresh');
    const data = await this.runJson(argv, { ...ctx, resolvedTarget: target });
    return Array.isArray(data?.devices) ? data.devices : (Array.isArray(data) ? data : []);
  }

  async mobileScreenshot(deviceId, { computer, maxEdge = 0, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile screenshot');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kiki-v42-mshot-'));
    const outFile = path.join(tempDir, 'mobile.png');
    try {
      const argv = [...this.buildMobilePrefix({ computer, local }), 'screenshot', '-o', outFile];
      if (maxEdge > 0) argv.push('--max-edge', String(Math.round(maxEdge)));
      argv.push(String(deviceId));
      const meta = await this.runJson(argv, { ...ctx, resolvedTarget: target, timeoutMs: ctx.timeoutMs || 30_000 });
      const pngBuffer = await readFile(outFile);
      return { meta, pngBuffer };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async mobileUiTree(deviceId, { computer, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile ui-tree');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'ui-tree', String(deviceId)];
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async mobileTap(deviceId, x, y, { computer, pixel = true, refId, hash, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile tap');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'tap'];
    if (refId) {
      argv.push('--ref', String(refId));
      if (hash) argv.push('--hash', String(hash));
      argv.push(String(deviceId));
    } else {
      if (pixel) argv.push('--pixel');
      argv.push(String(deviceId), String(Math.round(x)), String(Math.round(y)));
    }
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async mobileLongPress(deviceId, x, y, { computer, pixel = true, durationMs = 600, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile long-press');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'long-press'];
    if (pixel) argv.push('--pixel');
    if (durationMs) argv.push('--duration-ms', String(Math.round(durationMs)));
    argv.push(String(deviceId), String(Math.round(x)), String(Math.round(y)));
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async mobileSwipe(deviceId, x1, y1, x2, y2, { computer, pixel = true, durationMs = 300, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile swipe');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'swipe'];
    if (pixel) argv.push('--pixel');
    if (durationMs) argv.push('--duration-ms', String(Math.round(durationMs)));
    argv.push(
      String(deviceId),
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
    );
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async mobileType(deviceId, text, { computer, enter = false, refId, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile type');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'type', '--stdin'];
    if (refId) argv.push('--ref', String(refId));
    if (enter) argv.push('--enter');
    argv.push(String(deviceId));
    return this.runJson(argv, { ...ctx, resolvedTarget: target, stdinText: String(text) });
  }

  async mobileKey(deviceId, key, { computer, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile key');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'key', String(deviceId), String(key)];
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async mobileWake(deviceId, { computer, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile wake');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'wake', String(deviceId)];
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async mobileUnlock(deviceId, { computer, local = false, ...ctx } = {}) {
    const target = await this.resolveTarget(ctx);
    this.requireCapability(target, 'hasMobile', 'v42 mobile unlock');
    const argv = [...this.buildMobilePrefix({ computer, local }), 'unlock', String(deviceId)];
    return this.runJson(argv, { ...ctx, resolvedTarget: target });
  }

  async fetchAgentView(computer, targetRef, { sinceCursor, limit = 50, mode = 'turns', ...ctx } = {}) {
    const gwMethod = mode === 'turns' ? '/api/agent-view/turns' : '/api/agent-view/view';
    const gwView = await this.gatewayRequest('GET', gwMethod, {
      query: { computer, pane: targetRef, terminal: targetRef, since: sinceCursor, limit },
      ...ctx,
    });
    if (gwView) return { source: 'gateway', envelope: gwView };

    const resolvedTarget = await this.resolveTarget(ctx);
    let statusInfo = null;
    let screenInfo = { lines: [] };

    if (resolvedTarget.capabilities?.hasTermStatus) {
      [statusInfo, screenInfo] = await Promise.all([
        this.terminalStatus(computer, targetRef, ctx),
        resolvedTarget.capabilities?.hasTermRead
          ? this.terminalRead(computer, targetRef, { history: Math.min(200, Math.max(40, limit * 4)), ...ctx }).catch(() => ({ lines: [] }))
          : Promise.resolve({ lines: [] }),
      ]);
    } else {
      const listing = await this.listTerminals({ computer, ...ctx });
      statusInfo = listing.terminals.find((t) => t.pane_id === targetRef || t.window_id === targetRef) || {
        window_id: targetRef,
        pane_id: targetRef.startsWith('%') ? targetRef : null,
        idle: true,
      };
    }

    const agentMeta = statusInfo?.agent || statusInfo?.panes?.[0]?.agent || null;
    const rawState = agentMeta?.state || (statusInfo?.idle ? 'idle' : 'working');
    const normalizedStatus = ['working', 'blocked', 'done', 'error', 'idle'].includes(rawState)
      ? rawState
      : (statusInfo?.idle ? 'idle' : 'working');
    const session = statusInfo?.agent_session || statusInfo?.session || 'tmux';
    const terminalKey = statusInfo?.pane_entity_id || statusInfo?.window_entity_id || statusInfo?.pane_id || statusInfo?.window_id || targetRef;
    const lines = Array.isArray(screenInfo?.lines) ? screenInfo.lines : [];
    const seq = lines.length;
    const cursor = statusInfo?.cursor || `${terminalKey}:${session}:${seq}`;

    const pending = statusInfo?.pending || (normalizedStatus === 'blocked'
      ? {
          id: `pending-${terminalKey}`,
          kind: agentMeta?.kind || 'other',
          title: agentMeta?.title || 'Remote agent awaits input',
          message: agentMeta?.message || lines.slice(-6).join('\n'),
        }
      : null);

    const rows = Array.isArray(statusInfo?.rows)
      ? statusInfo.rows
      : lines.length > 0
        ? [
            {
              id: `row-${seq}`,
              kind: 'assistant',
              text: lines.slice(-Math.min(lines.length, limit)).join('\n'),
            },
          ]
        : [];

    return {
      source: 'cli',
      envelope: {
        terminal: terminalKey,
        windowId: statusInfo?.window_id || targetRef,
        paneId: statusInfo?.pane_id || null,
        session,
        cursor,
        cwd: statusInfo?.cwd || null,
        title: statusInfo?.window_name || statusInfo?.title || agentMeta?.title || targetRef,
        agent: {
          kind: agentMeta?.app || statusInfo?.current_command || 'shell',
          title: agentMeta?.title || null,
        },
        state: {
          status: normalizedStatus,
          kind: agentMeta?.kind || null,
          message: agentMeta?.message || null,
        },
        pending,
        rows,
        screenLines: lines,
      },
    };
  }

  async dispose() {
    await this.stdioBridge?.close();
    this.stdioBridge = null;
    this.resourcesCache.clear();
    this.resourcesInFlight.clear();
  }
}
