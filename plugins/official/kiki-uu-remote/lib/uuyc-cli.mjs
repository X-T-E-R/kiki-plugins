import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const defaultExecFile = promisify(execFile);

export function stripUtf8Bom(text) {
  const str = String(text ?? '');
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

export function parseCliJsonOutput(stdout) {
  const cleaned = stripUtf8Bom(stdout).trim();
  if (!cleaned) {
    throw new Error('uuyc-cli returned empty stdout when JSON was expected.');
  }
  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    const firstBrace = cleaned.search(/[\[{]/);
    if (firstBrace > 0) {
      return JSON.parse(cleaned.slice(firstBrace));
    }
    throw firstErr;
  }
}

export function assertSafeDeviceId(deviceId, operation = 'operation') {
  const trimmed = String(deviceId ?? '').trim();
  if (!trimmed) {
    throw new Error(`uuyc-cli ${operation} requires a non-empty deviceId.`);
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`Invalid deviceId "${trimmed}": cannot start with "-".`);
  }
  if (/[\r\n\0]/.test(trimmed)) {
    throw new Error('Invalid deviceId: control characters are not permitted.');
  }
  return trimmed;
}

async function queryWindowsRegistryInstDir(executeFile, hostPlatform) {
  if (hostPlatform !== 'win32') return [];
  const keys = [
    ['HKCU\\Software\\Netease\\GameViewer', 'instDir'],
    ['HKLM\\SOFTWARE\\Netease\\GameViewerSetup', 'instDir'],
    ['HKLM\\SOFTWARE\\Netease\\GameViewerSetup', 'Path'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Netease\\GameViewerSetup', 'instDir'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Netease\\GameViewerSetup', 'Path'],
  ];
  const dirs = [];
  for (const [regKey, valueName] of keys) {
    try {
      const { stdout } = await executeFile('reg.exe', ['query', regKey, '/v', valueName], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2500,
      });
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const match = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.+)$`, 'i').exec(line);
        if (match && match[1]) {
          dirs.push(match[1].trim().replace(/^"+|"+$/g, ''));
        }
      }
    } catch {
      // Registry key may not exist on all installations.
    }
  }
  return dirs;
}

async function resolveOnPath(binaryName, executeFile, hostPlatform) {
  const locator = hostPlatform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await executeFile(locator, [binaryName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2500,
    });
    const first = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

export async function discoverUuycCli({
  settings = {},
  hostPlatform = process.platform,
  env = process.env,
  fileExists = existsSync,
  executeFile = defaultExecFile,
  registryDirs = null,
} = {}) {
  const binName = hostPlatform === 'win32' ? 'uuyc-cli.exe' : 'uuyc-cli';
  const explicitCli = String(settings?.cliPath ?? '').trim();
  if (explicitCli) {
    return fileExists(explicitCli)
      ? { available: true, path: explicitCli, source: 'settings.cliPath' }
      : { available: false, path: null, configuredPath: explicitCli, source: 'settings.cliPath_missing' };
  }

  const candidates = [];
  const explicitExe = String(settings?.executablePath ?? '').trim();
  if (explicitExe) {
    const exeDir = path.dirname(explicitExe);
    candidates.push(
      { path: path.join(exeDir, binName), source: 'executablePath_dir' },
      { path: path.join(exeDir, 'bin', binName), source: 'executablePath_bin' },
    );
  }

  if (hostPlatform === 'win32') {
    const instDirs = Array.isArray(registryDirs)
      ? registryDirs
      : await queryWindowsRegistryInstDir(executeFile, hostPlatform);
    for (const dir of instDirs) {
      candidates.push(
        { path: path.join(dir, 'bin', 'uuyc-cli.exe'), source: 'registry' },
        { path: path.join(dir, 'uuyc-cli.exe'), source: 'registry' },
      );
    }

    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      { path: path.join(programFiles, 'NetEase', 'GameViewer', 'bin', 'uuyc-cli.exe'), source: 'standard_path' },
      { path: path.join(programFilesX86, 'NetEase', 'GameViewer', 'bin', 'uuyc-cli.exe'), source: 'standard_path' },
    );
  } else if (hostPlatform === 'darwin') {
    candidates.push(
      { path: '/Applications/UURemote.app/Contents/MacOS/uuyc-cli', source: 'standard_path' },
      { path: '/Applications/UU远程.app/Contents/MacOS/uuyc-cli', source: 'standard_path' },
      { path: '/Applications/GameViewer.app/Contents/MacOS/uuyc-cli', source: 'standard_path' },
    );
  }

  for (const candidate of candidates) {
    if (fileExists(candidate.path)) {
      return { available: true, path: candidate.path, source: candidate.source };
    }
  }

  const fromPath = await resolveOnPath(hostPlatform === 'win32' ? 'uuyc-cli.exe' : 'uuyc-cli', executeFile, hostPlatform)
    || (hostPlatform === 'win32' ? await resolveOnPath('uuyc-cli', executeFile, hostPlatform) : null);
  if (fromPath) {
    return { available: true, path: fromPath, source: 'PATH' };
  }

  return { available: false, path: null, source: 'not_found' };
}

async function runCliBinary(cliPath, args, { executeFile = defaultExecFile, timeoutMs = 8000, signal } = {}) {
  const lower = cliPath.toLowerCase();
  const isNodeScript = lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.cjs');
  const command = isNodeScript ? process.execPath : cliPath;
  const finalArgs = isNodeScript ? [cliPath, ...args] : args;

  const { stdout = '', stderr = '' } = await executeFile(command, finalArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    signal,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    stdout: stripUtf8Bom(stdout),
    stderr: stripUtf8Bom(stderr),
  };
}

function normalizeDeviceItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.device_id ?? raw.deviceId ?? raw.id ?? '').trim();
  if (!id) return null;
  const name = String(raw.name ?? raw.device_name ?? raw.alias ?? raw.hostname ?? id).trim();
  const online = typeof raw.online === 'boolean'
    ? raw.online
    : typeof raw.is_online === 'boolean'
      ? raw.is_online
      : /^(?:online|connected|ready|1|true)$/i.test(String(raw.status ?? raw.state ?? ''));
  const connected = typeof raw.connected === 'boolean'
    ? raw.connected
    : typeof raw.is_connected === 'boolean'
      ? raw.is_connected
      : /^(?:connected|streaming|in_session)$/i.test(String(raw.connection_status ?? raw.status ?? ''));
  return {
    deviceId: id,
    name,
    online,
    connected,
    os: raw.os ?? raw.platform ?? undefined,
    raw,
  };
}

function extractArrayPayload(parsed, keys) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(parsed[key])) return parsed[key];
    if (parsed.data && Array.isArray(parsed.data[key])) return parsed.data[key];
  }
  if (Array.isArray(parsed.data)) return parsed.data;
  return [];
}

export function createUuycCliClient({
  hostPlatform = process.platform,
  env = process.env,
  fileExists = existsSync,
  executeFile = defaultExecFile,
  staticCacheTtlMs = 60_000,
  deviceFreshTtlMs = 15_000,
  deviceStaleTtlMs = 120_000,
  nowFn = Date.now,
} = {}) {
  const cliCache = new Map();
  const cliFlights = new Map();
  const versionCache = new Map();
  const versionFlights = new Map();
  const deviceCache = new Map();
  const deviceFlights = new Map();

  function invalidateDeviceCache() {
    deviceCache.clear();
  }

  function settingsKey(settings = {}) {
    return `${String(settings?.cliPath ?? '').trim()}|${String(settings?.executablePath ?? '').trim()}`;
  }

  async function resolveCli(settings = {}) {
    const key = settingsKey(settings);
    const cached = cliCache.get(key);
    if (cached && staticCacheTtlMs > 0 && nowFn() - cached.at < staticCacheTtlMs) {
      return cached.value;
    }
    if (cliFlights.has(key)) {
      return cliFlights.get(key);
    }
    const flight = discoverUuycCli({ settings, hostPlatform, env, fileExists, executeFile })
      .then((value) => {
        if (staticCacheTtlMs > 0) {
          cliCache.set(key, { at: nowFn(), value });
        }
        return value;
      })
      .finally(() => {
        if (cliFlights.get(key) === flight) cliFlights.delete(key);
      });
    cliFlights.set(key, flight);
    return flight;
  }

  async function execJson(cliPath, args, opts = {}) {
    const { stdout } = await runCliBinary(cliPath, args, { executeFile, ...opts });
    return parseCliJsonOutput(stdout);
  }

  async function getVersion(settings = {}, opts = {}) {
    const key = settingsKey(settings);
    const cached = versionCache.get(key);
    if (!opts.force && cached && staticCacheTtlMs > 0 && nowFn() - cached.at < staticCacheTtlMs) {
      return cached.value;
    }
    if (!opts.force && versionFlights.has(key)) {
      return versionFlights.get(key);
    }
    const flight = (async () => {
      const found = await resolveCli(settings);
      if (!found.available || !found.path) {
        return { available: false, path: null, source: found.source, version: null };
      }
      try {
        const { stdout } = await runCliBinary(found.path, ['--version'], {
          executeFile,
          timeoutMs: opts.timeoutMs ?? 4000,
          signal: opts.signal,
        });
        const version = stdout.trim().split(/\r?\n/)[0]?.trim() || null;
        return { available: true, path: found.path, source: found.source, version };
      } catch (error) {
        return {
          available: true,
          path: found.path,
          source: found.source,
          version: null,
          error: error.message || String(error),
        };
      }
    })()
      .then((value) => {
        if (staticCacheTtlMs > 0) {
          versionCache.set(key, { at: nowFn(), value });
        }
        return value;
      })
      .finally(() => {
        if (versionFlights.get(key) === flight) versionFlights.delete(key);
      });
    versionFlights.set(key, flight);
    return flight;
  }

  async function getStatus(settings = {}, opts = {}) {
    const found = await resolveCli(settings);
    if (!found.available || !found.path) {
      return { ok: false, available: false, reason: 'uuyc-cli not installed' };
    }
    try {
      const data = await execJson(found.path, ['status', '--json'], {
        timeoutMs: opts.timeoutMs ?? 5000,
        signal: opts.signal,
      });
      return { ok: true, available: true, path: found.path, data };
    } catch (error) {
      return {
        ok: false,
        available: true,
        path: found.path,
        error: error.stderr?.trim() || error.message || String(error),
      };
    }
  }

  async function fetchDevicesLive(settings = {}, opts = {}) {
    const found = await resolveCli(settings);
    if (!found.available || !found.path) {
      return { ok: false, available: false, devices: [], connections: null };
    }
    const [listRes, statusRes] = await Promise.all([
      execJson(found.path, ['device', 'list', '--json'], {
        timeoutMs: opts.timeoutMs ?? 6000,
        signal: opts.signal,
      }).then((data) => ({ ok: true, data }), (error) => ({ ok: false, error })),
      execJson(found.path, ['device', 'status', '--json'], {
        timeoutMs: opts.timeoutMs ?? 6000,
        signal: opts.signal,
      }).then((data) => ({ ok: true, data }), (error) => ({ ok: false, error })),
    ]);

    const rawItems = listRes.ok
      ? extractArrayPayload(listRes.data, ['devices', 'items', 'list'])
      : [];
    const statusItems = statusRes.ok
      ? extractArrayPayload(statusRes.data, ['connections', 'sessions', 'devices', 'items'])
      : [];

    const connectedIds = new Set();
    for (const item of statusItems) {
      const id = String(item?.device_id ?? item?.deviceId ?? item?.id ?? '').trim();
      const active = item?.connected !== false && !/^(?:disconnected|closed|idle|false)$/i.test(String(item?.status ?? item?.state ?? 'connected'));
      if (id && active) connectedIds.add(id);
    }

    const devices = rawItems
      .map(normalizeDeviceItem)
      .filter(Boolean)
      .map((dev) => ({
        ...dev,
        connected: dev.connected || connectedIds.has(dev.deviceId),
      }));

    return {
      ok: listRes.ok || statusRes.ok,
      available: true,
      path: found.path,
      devices,
      deviceStatus: statusRes.ok ? statusRes.data : null,
      error: !listRes.ok && !statusRes.ok
        ? (listRes.error?.stderr?.trim() || listRes.error?.message || 'uuyc-cli device list failed')
        : undefined,
    };
  }

  function startDeviceRefresh(key, settings, opts = {}) {
    let flight = deviceFlights.get(key);
    if (!flight) {
      flight = fetchDevicesLive(settings, opts)
        .then((value) => {
          if (deviceFreshTtlMs > 0 || deviceStaleTtlMs > 0) {
            deviceCache.set(key, { at: nowFn(), value });
          }
          return value;
        })
        .finally(() => {
          if (deviceFlights.get(key) === flight) deviceFlights.delete(key);
        });
      flight.catch(() => {});
      deviceFlights.set(key, flight);
    }
    return flight;
  }

  async function listDevices(settings = {}, opts = {}) {
    const key = settingsKey(settings);
    const cached = deviceCache.get(key);
    if (!opts.force && cached) {
      const age = nowFn() - cached.at;
      if (age < deviceFreshTtlMs) {
        return cached.value;
      }
      if (age < deviceStaleTtlMs) {
        startDeviceRefresh(key, settings, { timeoutMs: opts.timeoutMs });
        return cached.value;
      }
    }
    if (opts.force) {
      const value = await fetchDevicesLive(settings, opts);
      if (deviceFreshTtlMs > 0 || deviceStaleTtlMs > 0) {
        deviceCache.set(key, { at: nowFn(), value });
      }
      return value;
    }
    return startDeviceRefresh(key, settings, opts);
  }

  async function listTerminals(deviceId, settings = {}, opts = {}) {
    const safeId = assertSafeDeviceId(deviceId, 'term ls');
    const found = await resolveCli(settings);
    if (!found.available || !found.path) {
      return { ok: false, available: false, deviceId: safeId, terminals: [] };
    }
    try {
      const data = await execJson(found.path, ['term', '-d', safeId, 'ls', '--json'], {
        timeoutMs: opts.timeoutMs ?? 6000,
        signal: opts.signal,
      });
      const terminals = extractArrayPayload(data, ['sessions', 'terminals', 'items', 'list']);
      return { ok: true, available: true, deviceId: safeId, terminals, raw: data };
    } catch (error) {
      return {
        ok: false,
        available: true,
        deviceId: safeId,
        terminals: [],
        error: error.stderr?.trim() || error.message || String(error),
      };
    }
  }

  async function connectDevice(deviceId, settings = {}, opts = {}) {
    const safeId = assertSafeDeviceId(deviceId, 'device connect');
    const found = await resolveCli(settings);
    if (!found.available || !found.path) {
      throw new Error('Official uuyc-cli was not found. Install UU Remote v4.46+ or configure cliPath in plugin settings.');
    }
    const data = await execJson(found.path, ['device', 'connect', safeId, '--json'], {
      timeoutMs: opts.timeoutMs ?? 20000,
      signal: opts.signal,
    });
    invalidateDeviceCache();
    return { ok: true, deviceId: safeId, path: found.path, result: data };
  }

  async function disconnectDevice(deviceId, settings = {}, opts = {}) {
    // Hard safety invariant: NEVER run `uuyc-cli device disconnect` without a positional deviceId,
    // because omitting deviceId disconnects ALL active remote sessions simultaneously.
    const safeId = assertSafeDeviceId(deviceId, 'device disconnect');
    const found = await resolveCli(settings);
    if (!found.available || !found.path) {
      throw new Error('Official uuyc-cli was not found. Configure cliPath in plugin settings.');
    }
    const data = await execJson(found.path, ['device', 'disconnect', safeId, '--json'], {
      timeoutMs: opts.timeoutMs ?? 15000,
      signal: opts.signal,
    });
    invalidateDeviceCache();
    return { ok: true, deviceId: safeId, path: found.path, result: data };
  }

  return {
    resolveCli,
    getVersion,
    getStatus,
    listDevices,
    invalidateDeviceCache,
    listTerminals,
    connectDevice,
    disconnectDevice,
  };
}
