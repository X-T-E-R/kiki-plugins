import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAdb, phoneDataDir } from './environment.mjs';
import { adbArguments, execAdb } from './adb.mjs';
import { mobilecliBinary, parseDevices, runtimeInstalled, upstreamEnvironment } from './prepare.mjs';
import {
  DEFAULT_MOBILECLI_URL,
  disposeMobilecliServers,
  ensureMobilecliRuntimePatched,
  ensureMobilecliServer,
} from './mobilecli-server.mjs';
import { parseAndroidScreenState } from './phone-run.mjs';
import { createScrcpyManager } from './scrcpy-stream.mjs';

const defaultExecFile = execAdb;
const SESSION_IDLE_MS = 60_000;
const DEFAULT_METADATA_TTL_MS = 4_500;

export function fitDeviceFrame(aspect, width, height, rightInset = 0) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 19.5;
  const availableWidth = Math.max(0, Number(width || 0) - Math.max(0, Number(rightInset || 0)));
  const availableHeight = Math.max(0, Number(height || 0));
  if (availableWidth === 0 || availableHeight === 0) return { width: 0, height: 0 };
  const byHeight = { width: availableHeight * safeAspect, height: availableHeight };
  return byHeight.width <= availableWidth
    ? { width: Math.round(byHeight.width), height: Math.round(byHeight.height) }
    : { width: Math.round(availableWidth), height: Math.round(availableWidth / safeAspect) };
}

export function normalizePointerToDevice(normX, normY, screenWidth, screenHeight) {
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const w = Math.max(1, Math.round(Number(screenWidth) || 1080));
  const h = Math.max(1, Math.round(Number(screenHeight) || 2400));
  return {
    x: Math.min(w - 1, Math.max(0, Math.round(clamp01(normX) * w))),
    y: Math.min(h - 1, Math.max(0, Math.round(clamp01(normY) * h))),
  };
}

export function computeContainedRect(containerWidth, containerHeight, contentWidth, contentHeight) {
  const cw = Math.max(0, Number(containerWidth) || 0);
  const ch = Math.max(0, Number(containerHeight) || 0);
  const iw = Math.max(1, Number(contentWidth) || cw || 1080);
  const ih = Math.max(1, Number(contentHeight) || ch || 2400);
  if (cw <= 0 || ch <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(cw / iw, ch / ih);
  const width = iw * scale;
  const height = ih * scale;
  return {
    x: (cw - width) / 2,
    y: (ch - height) / 2,
    width,
    height,
    scale,
  };
}

export function mapContainedPointToDevice(
  offsetX,
  offsetY,
  containerWidth,
  containerHeight,
  screenWidth = 1080,
  screenHeight = 2400,
) {
  const w = Math.max(1, Math.round(Number(screenWidth) || 1080));
  const h = Math.max(1, Math.round(Number(screenHeight) || 2400));
  const rect = computeContainedRect(containerWidth, containerHeight, w, h);
  if (rect.width <= 0 || rect.height <= 0) {
    return { inside: false, normX: 0, normY: 0, x: 0, y: 0, rect };
  }
  const ox = Number(offsetX) || 0;
  const oy = Number(offsetY) || 0;
  const inside = ox >= rect.x && ox <= rect.x + rect.width && oy >= rect.y && oy <= rect.y + rect.height;
  const normX = Math.min(1, Math.max(0, (ox - rect.x) / rect.width));
  const normY = Math.min(1, Math.max(0, (oy - rect.y) / rect.height));
  return {
    inside,
    normX,
    normY,
    x: w <= 1 ? 0 : Math.min(w - 1, Math.max(0, Math.round(normX * (w - 1)))),
    y: h <= 1 ? 0 : Math.min(h - 1, Math.max(0, Math.round(normY * (h - 1)))),
    rect,
  };
}

function escapeQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildMobilewrightLocatorHint(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string' && node.text.trim()) {
    return `await screen.getByText('${escapeQuote(node.text.trim())}', { exact: true }).tap();`;
  }
  if (typeof node.label === 'string' && node.label.trim()) {
    return `await screen.getByLabel('${escapeQuote(node.label.trim())}', { exact: true }).tap();`;
  }
  if (typeof node.identifier === 'string' && node.identifier.trim()) {
    return `await screen.getByTestId('${escapeQuote(node.identifier.trim())}').tap();`;
  }
  if (node.bounds && Number.isFinite(node.bounds.x) && Number.isFinite(node.bounds.y)) {
    const cx = Math.round(node.bounds.x + (node.bounds.width || 0) / 2);
    const cy = Math.round(node.bounds.y + (node.bounds.height || 0) / 2);
    return `await device.driver.tap(${cx}, ${cy});`;
  }
  return '';
}

export function flattenViewHierarchy(tree, screenSize = { width: 1080, height: 2400 }, maxNodes = 260) {
  const out = [];
  const sw = Math.max(1, Number(screenSize?.width) || 1080);
  const sh = Math.max(1, Number(screenSize?.height) || 2400);
  let seq = 0;

  function visit(nodes, depth) {
    if (!Array.isArray(nodes) || out.length >= maxNodes) return;
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object' || out.length >= maxNodes) continue;
      const b = raw.bounds;
      const hasBounds = b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 2 && b.height > 2;
      const visibleInScreen = hasBounds && b.x + b.width > 0 && b.y + b.height > 0 && b.x < sw && b.y < sh;
      const text = typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : undefined;
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
      const identifier = typeof raw.identifier === 'string' && raw.identifier.trim() ? raw.identifier.trim() : undefined;
      const value = typeof raw.value === 'string' && raw.value.trim() ? raw.value.trim() : undefined;
      const role = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : undefined;
      const clickable = raw.clickable === true || raw.enabled === true;
      const meaningful = Boolean(text || label || value || (identifier && !identifier.startsWith('com.android.systemui:id/status_bar')));

      if (visibleInScreen && (meaningful || (clickable && b.width < sw * 0.96 && b.height < sh * 0.85))) {
        const entry = {
          id: `ax-${++seq}`,
          depth,
          role,
          text,
          label,
          identifier,
          value,
          clickable: Boolean(raw.clickable),
          focused: Boolean(raw.focused),
          bounds: {
            x: Math.max(0, Math.round(b.x)),
            y: Math.max(0, Math.round(b.y)),
            width: Math.round(b.width),
            height: Math.round(b.height),
          },
          normBounds: {
            x: Number((Math.max(0, b.x) / sw).toFixed(4)),
            y: Number((Math.max(0, b.y) / sh).toFixed(4)),
            width: Number((Math.min(sw - Math.max(0, b.x), b.width) / sw).toFixed(4)),
            height: Number((Math.min(sh - Math.max(0, b.y), b.height) / sh).toFixed(4)),
          },
        };
        entry.locator = buildMobilewrightLocatorHint(entry);
        out.push(entry);
      }
      if (Array.isArray(raw.children) && raw.children.length > 0) {
        visit(raw.children, depth + 1);
      }
    }
  }

  visit(Array.isArray(tree) ? tree : tree?.children ?? [], 0);
  return out;
}

function defaultScreenSize(platform) {
  return platform === 'ios'
    ? { width: 1179, height: 2556 }
    : { width: 1080, height: 2400 };
}

function computeEffectiveSize(screenSize, orientation) {
  const base = screenSize?.width && screenSize?.height ? screenSize : { width: 1080, height: 2400 };
  const isLandscape = orientation === 'landscape' || orientation === 'landscape_left' || orientation === 'landscape_right';
  if (isLandscape && base.height > base.width) {
    return { width: base.height, height: base.width };
  }
  if (!isLandscape && orientation === 'portrait' && base.width > base.height) {
    return { width: base.height, height: base.width };
  }
  return { width: base.width, height: base.height };
}

function normalizeDeviceRecord(raw, fallbackPlatform) {
  const platform = raw.platform === 'ios' || raw.platform === 'android' ? raw.platform : fallbackPlatform;
  const type = raw.type || 'real';
  const state = raw.state || 'online';
  const screenWidth = Number(raw.screenSize?.width || raw.width || (platform === 'ios' ? 1179 : 1080));
  const screenHeight = Number(raw.screenSize?.height || raw.height || (platform === 'ios' ? 2556 : 2400));
  return {
    id: String(raw.id),
    name: String(raw.name || raw.model || raw.id),
    platform,
    type,
    state,
    version: raw.version ? String(raw.version) : undefined,
    orientation: raw.orientation || (screenWidth > screenHeight ? 'landscape' : 'portrait'),
    screenSize: { width: screenWidth, height: screenHeight },
  };
}

function sortDevices(devices) {
  const rankState = (s) => (s === 'online' ? 0 : s === 'unauthorized' ? 1 : 2);
  const rankType = (t) => (t === 'real' ? 0 : 1);
  return [...devices].sort((a, b) =>
    rankState(a.state) - rankState(b.state)
    || rankType(a.type) - rankType(b.type)
    || a.name.localeCompare(b.name),
  );
}

function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function base64ByteLength(b64) {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

export function createPhonePreviewService({
  dataDir: customDataDir,
  hostPlatform = process.platform,
  executeFile = defaultExecFile,
  loadDriverModule,
  scrcpyManager: customScrcpyManager,
  metadataTtlMs = DEFAULT_METADATA_TTL_MS,
} = {}) {
  const resolveDataDir = () => customDataDir || phoneDataDir();
  const captureSessions = new Map();
  const actionSessions = new Map();
  const deviceMetaCache = new Map();
  const inflightCaptures = new Map();
  let selectedMemoryCache = null;

  const scrcpyEnabledByDefault = !loadDriverModule || Boolean(customScrcpyManager);
  const scrcpy = customScrcpyManager ?? createScrcpyManager({
    resolveDataDir,
    executeFile,
    platform: hostPlatform,
  });

  function raceTimeout(promise, ms, message) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  function ensureMetaEntry(platform, deviceId, seedSize, seedOrientation) {
    const key = `${platform}:${deviceId}`;
    let meta = deviceMetaCache.get(key);
    if (!meta) {
      const screenSize = seedSize?.width && seedSize?.height ? seedSize : defaultScreenSize(platform);
      const orientation = seedOrientation || (screenSize.width > screenSize.height ? 'landscape' : 'portrait');
      meta = {
        key,
        platform,
        deviceId,
        screenSize,
        orientation,
        effectiveSize: computeEffectiveSize(screenSize, orientation),
        foregroundApp: null,
        powerState: null,
        sizeInitialized: Boolean(seedSize?.width && seedSize?.height),
        initialized: false,
        updatedAt: 0,
        powerUpdatedAt: 0,
        refreshFlight: null,
        powerFlight: null,
      };
      deviceMetaCache.set(key, meta);
    } else if (!meta.initialized && seedSize?.width && seedSize?.height) {
      meta.screenSize = seedSize;
      if (seedOrientation) meta.orientation = seedOrientation;
      meta.effectiveSize = computeEffectiveSize(meta.screenSize, meta.orientation);
    }
    return meta;
  }

  async function readSelectedDevice(dataDir) {
    if (selectedMemoryCache?.dataDir === dataDir && selectedMemoryCache.value) {
      return selectedMemoryCache.value;
    }
    try {
      const parsed = JSON.parse(await readFile(path.join(dataDir, 'selected-device.json'), 'utf8'));
      selectedMemoryCache = { dataDir, value: parsed };
      return parsed;
    } catch {
      return undefined;
    }
  }

  async function writeSelectedDevice(dataDir, selection) {
    selectedMemoryCache = { dataDir, value: selection };
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'selected-device.json'), JSON.stringify(selection) + '\n');
  }

  async function resolveDriverClass(dataDir, adbBinary) {
    if (loadDriverModule) return loadDriverModule({ dataDir, adbBinary });
    const sharedEnv = upstreamEnvironment(adbBinary, process.env, dataDir);
    Object.assign(process.env, sharedEnv);
    await ensureMobilecliRuntimePatched(dataDir).catch(() => {});
    const modPath = path.join(dataDir, 'runtime/node_modules/@mobilewright/driver-mobilecli/dist/index.js');
    return import(pathToFileURL(modPath).href);
  }

  async function closeLaneSession(store, key) {
    const entry = store.get(key);
    if (!entry) return;
    store.delete(key);
    clearTimeout(entry.idleTimer);
    entry.prefetch = null;
    try { await entry.driver.disconnect(); } catch {}
    try { await entry.driver.dispose(); } catch {}
  }

  function touchLaneIdle(store, key, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { void closeLaneSession(store, key); }, SESSION_IDLE_MS);
    entry.idleTimer.unref?.();
  }

  async function acquireLaneSession(store, { platform, deviceId, settings = {}, warmScrcpy = false }) {
    const dataDir = resolveDataDir();
    const key = `${platform}:${deviceId}`;
    const existing = store.get(key);
    if (existing) {
      touchLaneIdle(store, key, existing);
      return existing;
    }
    const ready = loadDriverModule ? true : await runtimeInstalled(dataDir);
    if (!ready) {
      throw new Error('Mobilewright runtime is not installed yet. Run phone_prepare first.');
    }
    const adbBinary = settings?.adbPath || await findAdb({ dataDir }).catch(() => undefined);
    const { MobilecliDriver } = await resolveDriverClass(dataDir, adbBinary);
    const cliPath = await mobilecliBinary(dataDir);
    const hasCliBinary = !loadDriverModule && await access(cliPath).then(() => true, () => false);
    let serverUrl = DEFAULT_MOBILECLI_URL;
    if (hasCliBinary) {
      const started = await ensureMobilecliServer({
        binaryPath: cliPath,
        env: upstreamEnvironment(adbBinary, process.env, dataDir),
        platform: hostPlatform,
      });
      serverUrl = started.url;
    }
    const driver = new MobilecliDriver({ mobilecliPath: cliPath, autoStart: false, url: serverUrl });
    await driver.connect({ platform, deviceId, url: serverUrl });
    const entry = {
      key,
      platform,
      deviceId,
      driver,
      adbBinary,
      dataDir,
      idleTimer: undefined,
      enqueueRpc: createSerialQueue(),
      prefetch: null,
      frameSeq: 0,
    };
    store.set(key, entry);
    touchLaneIdle(store, key, entry);

    if (warmScrcpy && platform === 'android' && adbBinary && scrcpyEnabledByDefault) {
      const meta = ensureMetaEntry(platform, deviceId);
      scrcpy.warmControl({ adbBinary, serial: deviceId, fallbackSize: meta.effectiveSize });
    }
    return entry;
  }

  const acquireCaptureSession = (opts) => acquireLaneSession(captureSessions, { ...opts, warmScrcpy: true });
  const acquireActionSession = (opts) => acquireLaneSession(actionSessions, { ...opts, warmScrcpy: false });

  const FAST_STATE_TTL_MS = 15_000;
  const FAST_PROBE_TIMEOUT_MS = 1_500;
  const PEEK_WAIT_BUDGET_MS = 450;
  let cachedProbe = { key: '', at: 0, allDevices: null, diagnostics: null };
  let cachedStateSnapshot = { key: '', at: 0, value: null };
  const stateRefreshFlights = new Map();

  function emptyStateSnapshot() {
    return {
      ok: true,
      selected: undefined,
      devices: [],
      groups: { android: [], ios: [] },
      diagnostics: {
        runtimeInstalled: false,
        hostPlatform,
        android: { available: false, adbPath: null, reason: null },
        ios: { available: false, simulatorsSupported: hostPlatform === 'darwin', reason: null },
      },
    };
  }

  async function discoverSimulatorsDarwin(timeoutMs = 8_000) {
    if (hostPlatform !== 'darwin') return { available: false, reason: 'Xcode iOS Simulator requires macOS; physical iOS devices can connect via mobilecli / USB bridge.', devices: [] };
    try {
      const { stdout } = await executeFile('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      });
      const parsed = JSON.parse(stdout || '{}');
      const sims = [];
      for (const [runtimeKey, list] of Object.entries(parsed.devices || {})) {
        if (!Array.isArray(list)) continue;
        const verMatch = runtimeKey.match(/iOS[- ](\d+[.-]\d+(?:[.-]\d+)?)/i);
        const version = verMatch ? verMatch[1].replace(/-/g, '.') : undefined;
        for (const item of list) {
          if (!item?.udid || item.isAvailable === false) continue;
          sims.push({
            id: String(item.udid),
            name: String(item.name || item.udid),
            platform: 'ios',
            type: 'simulator',
            state: item.state === 'Booted' ? 'online' : 'offline',
            version,
            orientation: 'portrait',
            screenSize: { width: 1179, height: 2556 },
          });
        }
      }
      return { available: true, devices: sims };
    } catch (error) {
      return { available: false, reason: error.message || 'xcrun simctl unavailable', devices: [] };
    }
  }

  async function listState({ settings = {}, fast = false } = {}) {
    const dataDir = resolveDataDir();
    const cacheKey = String(settings?.adbPath ?? '');
    let allDevices;
    let diagnostics;

    if (fast && cachedProbe.allDevices && cachedProbe.key === cacheKey && Date.now() - cachedProbe.at < FAST_STATE_TTL_MS) {
      allDevices = cachedProbe.allDevices;
      diagnostics = cachedProbe.diagnostics;
    } else {
      const hasRuntime = loadDriverModule ? true : await runtimeInstalled(dataDir);
      const adbBinary = settings?.adbPath || await findAdb({ dataDir }).catch(() => undefined);
      const env = upstreamEnvironment(adbBinary, process.env, dataDir);

      const byKey = new Map();
      diagnostics = {
        runtimeInstalled: hasRuntime,
        hostPlatform,
        android: { available: Boolean(adbBinary), adbPath: adbBinary ?? null, reason: adbBinary ? null : 'ADB not configured. Run phone_prepare to configure official platform-tools.' },
        ios: {
          available: hasRuntime,
          simulatorsSupported: hostPlatform === 'darwin',
          reason: hostPlatform === 'darwin'
            ? null
            : 'iOS Simulator requires macOS; physical iPhone/iPad connects via USB + signed DeviceKit agent.',
        },
      };

      const mobilecliTimeout = fast ? FAST_PROBE_TIMEOUT_MS : 10_000;
      const adbTimeout = fast ? FAST_PROBE_TIMEOUT_MS : 8_000;
      const simTimeout = fast ? FAST_PROBE_TIMEOUT_MS : 8_000;

      const probeMobilecli = async () => {
        if (!hasRuntime) return [];
        if (loadDriverModule) {
          const runDriverProbe = async () => {
            const { MobilecliDriver } = await resolveDriverClass(dataDir, adbBinary);
            const probe = new MobilecliDriver({ mobilecliPath: await mobilecliBinary(dataDir) });
            try {
              const list = await probe.listDevices({ includeOffline: true });
              return (list || []).map((item) => normalizeDeviceRecord(item, item.platform || 'android'));
            } finally {
              await probe.dispose?.().catch(() => {});
            }
          };
          return fast ? raceTimeout(runDriverProbe(), mobilecliTimeout, 'mobilecli fast probe timed out') : runDriverProbe();
        }
        const cli = await mobilecliBinary(dataDir);
        const { stdout } = await executeFile(cli, ['devices', '--include-offline'], {
          encoding: 'utf8', env, windowsHide: true, timeout: mobilecliTimeout,
        });
        const parsed = JSON.parse(stdout || '{}');
        const list = Array.isArray(parsed) ? parsed : (parsed.data?.devices || parsed.devices || []);
        return list.map((item) => normalizeDeviceRecord(item, item.platform || 'android'));
      };

      const probeAdb = async () => {
        if (!adbBinary) return [];
        const { stdout } = await executeFile(adbBinary, ['devices', '-l'], {
          encoding: 'utf8', env, windowsHide: true, timeout: adbTimeout,
        });
        return parseDevices(stdout);
      };

      const [mobilecliOutcome, adbOutcome, simOutcome] = await Promise.all([
        probeMobilecli().then((items) => ({ ok: true, items }), (error) => ({ ok: false, error })),
        probeAdb().then((rows) => ({ ok: true, rows }), (error) => ({ ok: false, error })),
        hostPlatform === 'darwin' ? discoverSimulatorsDarwin(simTimeout) : Promise.resolve(null),
      ]);

      if (mobilecliOutcome.ok) {
        for (const norm of mobilecliOutcome.items) {
          byKey.set(`${norm.platform}:${norm.id}`, norm);
        }
      } else {
        diagnostics.mobilecliError = mobilecliOutcome.error?.message || String(mobilecliOutcome.error);
      }

      if (adbOutcome.ok) {
        for (const row of adbOutcome.rows) {
          const key = `android:${row.serial}`;
          if (!byKey.has(key)) {
            const modelMatch = row.details.match(/\bmodel:([^\s]+)/);
            byKey.set(key, {
              id: row.serial,
              name: modelMatch ? modelMatch[1].replace(/_/g, ' ') : row.serial,
              platform: 'android',
              type: row.serial.startsWith('emulator-') ? 'emulator' : 'real',
              state: row.state === 'device' ? 'online' : row.state,
              orientation: 'portrait',
              screenSize: { width: 1080, height: 2400 },
            });
          } else if (row.state === 'unauthorized') {
            byKey.get(key).state = 'unauthorized';
          }
        }
      } else if (adbBinary) {
        diagnostics.android.reason = adbOutcome.error?.message || String(adbOutcome.error);
      }

      if (simOutcome) {
        diagnostics.ios.available = diagnostics.ios.available || simOutcome.available;
        if (!simOutcome.available && simOutcome.reason) diagnostics.ios.reason = simOutcome.reason;
        for (const item of simOutcome.devices) {
          const key = `ios:${item.id}`;
          if (!byKey.has(key)) byKey.set(key, item);
        }
      }

      allDevices = sortDevices([...byKey.values()]);
      for (const dev of allDevices) {
        if (dev.state === 'online') {
          ensureMetaEntry(dev.platform, dev.id, dev.screenSize, dev.orientation);
        }
      }
      cachedProbe = { key: cacheKey, at: Date.now(), allDevices, diagnostics };
    }

    const saved = await readSelectedDevice(dataDir);
    const online = allDevices.filter((d) => d.state === 'online');
    let selected = saved && allDevices.some((d) => d.id === saved.id && d.platform === saved.platform)
      ? { id: saved.id, platform: saved.platform }
      : undefined;
    if ((!selected || !online.some((d) => d.id === selected.id && d.platform === selected.platform)) && online.length > 0) {
      selected = { id: online[0].id, platform: online[0].platform };
      await writeSelectedDevice(dataDir, selected).catch(() => {});
    }

    const snapshot = {
      ok: true,
      selected,
      devices: allDevices,
      groups: {
        android: allDevices.filter((d) => d.platform === 'android'),
        ios: allDevices.filter((d) => d.platform === 'ios'),
      },
      diagnostics,
    };
    cachedStateSnapshot = { key: cacheKey, at: Date.now(), value: snapshot };
    return snapshot;
  }

  function triggerBackgroundStateRefresh(settings = {}) {
    const cacheKey = String(settings?.adbPath ?? '');
    let flight = stateRefreshFlights.get(cacheKey);
    if (!flight) {
      flight = listState({ settings, fast: true }).finally(() => {
        if (stateRefreshFlights.get(cacheKey) === flight) {
          stateRefreshFlights.delete(cacheKey);
        }
      });
      flight.catch(() => {});
      stateRefreshFlights.set(cacheKey, flight);
    }
    return flight;
  }

  async function peekState({ settings = {}, maxAgeMs = FAST_STATE_TTL_MS, waitBudgetMs = PEEK_WAIT_BUDGET_MS } = {}) {
    const cacheKey = String(settings?.adbPath ?? '');
    const hasCached = cachedStateSnapshot.value !== null && cachedStateSnapshot.key === cacheKey;
    if (hasCached && Date.now() - cachedStateSnapshot.at < maxAgeMs) {
      return cachedStateSnapshot.value;
    }
    const flight = triggerBackgroundStateRefresh(settings);
    if (hasCached || waitBudgetMs <= 0) {
      return hasCached ? cachedStateSnapshot.value : emptyStateSnapshot();
    }
    try {
      return await raceTimeout(flight, waitBudgetMs, 'phone peek budget elapsed');
    } catch {
      return cachedStateSnapshot.key === cacheKey && cachedStateSnapshot.value !== null
        ? cachedStateSnapshot.value
        : emptyStateSnapshot();
    }
  }

  async function activate(context = {}) {
    triggerBackgroundStateRefresh(context?.settings ?? {});
  }

  async function resolveTarget({ deviceId, platform, settings = {} }) {
    const dataDir = resolveDataDir();
    if (deviceId && (platform === 'android' || platform === 'ios')) {
      return { id: String(deviceId), platform, dataDir };
    }
    const saved = await readSelectedDevice(dataDir);
    if (deviceId) {
      if (saved?.id === deviceId && (saved.platform === 'android' || saved.platform === 'ios')) {
        return { id: String(deviceId), platform: saved.platform, dataDir };
      }
      const state = await listState({ settings, fast: true });
      const hit = state.devices.find((d) => d.id === deviceId);
      return { id: String(deviceId), platform: hit?.platform || platform || 'android', dataDir };
    }
    if (saved?.id && (saved.platform === 'android' || saved.platform === 'ios')) {
      return { id: String(saved.id), platform: saved.platform, dataDir };
    }
    const state = await listState({ settings, fast: true });
    if (state.selected) return { ...state.selected, dataDir };
    throw new Error('No online Android or iOS device is currently connected.');
  }

  async function runAndroidShell(adbBinary, serial, shellArgs, timeout = 12_000) {
    const { stdout = '' } = await executeFile(adbBinary || 'adb', ['-s', serial, 'shell', ...shellArgs], {
      encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }

  async function readAndroidPowerState(adbBinary, serial, fallbackSize) {
    try {
      const [power, policy, wmSize] = await Promise.all([
        runAndroidShell(adbBinary, serial, ['dumpsys', 'power'], 6_000),
        runAndroidShell(adbBinary, serial, ['dumpsys', 'window', 'policy'], 6_000),
        runAndroidShell(adbBinary, serial, ['wm', 'size'], 4_000).catch(() => ''),
      ]);
      return parseAndroidScreenState({ power, policy, wmSize, fallbackSize });
    } catch {
      return null;
    }
  }

  function scheduleBackgroundPowerRefresh(meta, adbBinary) {
    if (meta.platform !== 'android' || !adbBinary || meta.powerFlight) return;
    if (meta.powerUpdatedAt > 0 && Date.now() - meta.powerUpdatedAt < metadataTtlMs) return;
    meta.powerFlight = readAndroidPowerState(adbBinary, meta.deviceId, meta.effectiveSize)
      .then((powerState) => {
        if (powerState) {
          meta.powerState = powerState;
          meta.powerUpdatedAt = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        meta.powerFlight = null;
      });
  }

  async function sampleDriverMetadata(session, meta) {
    return session.enqueueRpc(async () => {
      const screenSize = await session.driver.getScreenSize?.().catch(() => meta.screenSize) ?? meta.screenSize;
      const orientation = await session.driver.getOrientation?.().catch(() =>
        (screenSize.width > screenSize.height ? 'landscape' : 'portrait'),
      ) ?? meta.orientation;
      let foregroundApp = meta.foregroundApp;
      try {
        if (typeof session.driver.getForegroundApp === 'function') {
          const fg = await session.driver.getForegroundApp();
          foregroundApp = fg?.bundleId || fg?.packageName || fg?.name || (typeof fg === 'string' ? fg : null);
        }
      } catch {}
      meta.screenSize = screenSize?.width && screenSize?.height ? screenSize : meta.screenSize;
      meta.orientation = orientation;
      meta.effectiveSize = computeEffectiveSize(meta.screenSize, meta.orientation);
      meta.foregroundApp = foregroundApp;
      meta.sizeInitialized = true;
      meta.initialized = true;
      meta.updatedAt = Date.now();
    });
  }

  function scheduleBackgroundMetadataRefresh(session, meta) {
    if (meta.refreshFlight) return meta.refreshFlight;
    meta.refreshFlight = sampleDriverMetadata(session, meta)
      .catch(() => {})
      .finally(() => {
        meta.refreshFlight = null;
      });
    scheduleBackgroundPowerRefresh(meta, session.adbBinary);
    return meta.refreshFlight;
  }

  async function takeRawFrame(session, { wantPng, quality, scale }) {
    const mimeType = wantPng ? 'image/png' : 'image/jpeg';
    const shotOpts = wantPng
      ? { format: 'png' }
      : { format: 'jpeg', quality: Math.min(95, Math.max(35, Number(quality) || 72)), ...(scale ? { scale } : {}) };

    return session.enqueueRpc(async () => {
      if (!wantPng && typeof session.driver.call === 'function') {
        const rpcRes = await session.driver.call('device.screenshot', shotOpts);
        if (typeof rpcRes?.data === 'string' && rpcRes.data.length > 0) {
          const raw = rpcRes.data;
          const commaIdx = raw.indexOf(',');
          const b64 = commaIdx === -1 ? raw : raw.slice(commaIdx + 1);
          return {
            seq: ++session.frameSeq,
            mimeType,
            dataUrl: commaIdx === -1 ? `data:${mimeType};base64,${b64}` : raw,
            byteLength: base64ByteLength(b64),
            capturedAt: Date.now(),
          };
        }
      }
      const bytes = await session.driver.screenshot(shotOpts);
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return {
        seq: ++session.frameSeq,
        mimeType,
        dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
        byteLength: buf.length,
        capturedAt: Date.now(),
      };
    });
  }

  function startOneAheadPrefetch(session, specKey, shotParams) {
    if (session.prefetch) return;
    const promise = takeRawFrame(session, shotParams).catch(() => null);
    session.prefetch = { specKey, promise };
  }

  async function captureFrame({
    deviceId,
    platform,
    format = 'jpeg',
    quality = 72,
    maxWidth = 720,
    live = false,
    settings = {},
  } = {}) {
    let target;
    try {
      target = await resolveTarget({ deviceId, platform, settings });
    } catch (error) {
      return { ok: false, deviceId, platform, error: error.message || String(error) };
    }

    const wantPng = format === 'png';
    const flightKey = `${target.platform}:${target.id}:${wantPng ? 'png' : `jpg-${quality}-${maxWidth}`}`;
    if (inflightCaptures.has(flightKey)) {
      return inflightCaptures.get(flightKey);
    }

    const run = (async () => {
      try {
        const session = await acquireCaptureSession({ platform: target.platform, deviceId: target.id, settings });
        const meta = ensureMetaEntry(target.platform, target.id);

        if (!meta.initialized) {
          await scheduleBackgroundMetadataRefresh(session, meta);
        } else {
          if (Date.now() - meta.updatedAt >= metadataTtlMs) {
            void scheduleBackgroundMetadataRefresh(session, meta);
          } else {
            scheduleBackgroundPowerRefresh(meta, session.adbBinary);
          }
        }

        const effectiveSize = meta.effectiveSize;
        const scale = !wantPng && maxWidth && effectiveSize.width > maxWidth
          ? Math.max(0.25, Math.min(1, Number((maxWidth / effectiveSize.width).toFixed(2))))
          : undefined;
        const shotParams = { wantPng, quality, scale };

        let frame;
        if (live && !wantPng && session.prefetch?.specKey === flightKey) {
          const pendingPrefetch = session.prefetch;
          session.prefetch = null;
          frame = await pendingPrefetch.promise;
        }
        if (!frame) {
          try {
            frame = await takeRawFrame(session, shotParams);
          } catch (shotErr) {
            await closeLaneSession(captureSessions, session.key);
            throw shotErr;
          }
        }

        if (live && !wantPng) {
          startOneAheadPrefetch(session, flightKey, shotParams);
        }

        return {
          ok: true,
          deviceId: target.id,
          platform: target.platform,
          mimeType: frame.mimeType,
          dataUrl: frame.dataUrl,
          byteLength: frame.byteLength,
          screenSize: meta.effectiveSize,
          orientation: meta.orientation,
          foregroundApp: meta.foregroundApp,
          powerState: meta.powerState,
          capturedAt: frame.capturedAt,
        };
      } catch (error) {
        return {
          ok: false,
          deviceId: target.id,
          platform: target.platform,
          error: error.message || String(error),
        };
      }
    })().finally(() => {
      inflightCaptures.delete(flightKey);
    });

    inflightCaptures.set(flightKey, run);
    return run;
  }

  async function inspectHierarchy({ deviceId, platform, settings = {} } = {}) {
    let target;
    try {
      target = await resolveTarget({ deviceId, platform, settings });
    } catch (error) {
      return { ok: false, deviceId, platform, error: error.message || String(error) };
    }
    try {
      const session = await acquireActionSession({ platform: target.platform, deviceId: target.id, settings });
      const meta = ensureMetaEntry(target.platform, target.id);
      return await session.enqueueRpc(async () => {
        if (!meta.initialized) {
          const sz = await session.driver.getScreenSize?.().catch(() => meta.screenSize);
          if (sz?.width && sz?.height) {
            meta.screenSize = sz;
            meta.effectiveSize = computeEffectiveSize(sz, meta.orientation);
          }
        }
        const rawTree = await session.driver.getViewHierarchy();
        const nodes = flattenViewHierarchy(rawTree, meta.effectiveSize);
        return {
          ok: true,
          deviceId: target.id,
          platform: target.platform,
          screenSize: meta.effectiveSize,
          nodeCount: nodes.length,
          nodes,
        };
      });
    } catch (error) {
      return { ok: false, deviceId: target.id, platform: target.platform, error: error.message || String(error) };
    }
  }

  async function resolveFastScrcpyControl(target, effectiveSize, settings) {
    if (target.platform !== 'android' || !scrcpyEnabledByDefault) return null;
    const adbBinary = settings?.adbPath || await findAdb({ dataDir: target.dataDir }).catch(() => undefined);
    if (!adbBinary) return null;
    try {
      return await raceTimeout(
        scrcpy.acquireControl({ adbBinary, serial: target.id, fallbackSize: effectiveSize }),
        240,
        'scrcpy control warmup pending',
      );
    } catch {
      scrcpy.warmControl({ adbBinary, serial: target.id, fallbackSize: effectiveSize });
      return null;
    }
  }

  async function performAction(input = {}, { settings = {} } = {}) {
    const { action } = input;
    const dataDir = resolveDataDir();

    if (action === 'select') {
      if (!input.deviceId || (input.platform !== 'android' && input.platform !== 'ios')) {
        return { ok: false, error: 'select requires deviceId and platform ("android" | "ios").' };
      }
      const selected = { id: String(input.deviceId), platform: input.platform };
      await writeSelectedDevice(dataDir, selected);
      return { ok: true, selected };
    }

    if (action === 'adbConnection') {
      const adbBinary = settings?.adbPath || await findAdb({ dataDir });
      if (!adbBinary) return { ok: false, error: 'ADB is not configured yet.' };
      try {
        const argv = adbArguments('android_connection', {
          action: input.subAction,
          address: input.address,
          code: input.code,
        });
        const { stdout, stderr } = await executeFile(adbBinary, argv, {
          encoding: 'utf8', windowsHide: true, timeout: 20_000,
        });
        cachedProbe.at = 0;
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (error) {
        return { ok: false, error: error.stderr?.trim() || error.message || String(error) };
      }
    }

    if (action === 'boot') {
      const platform = input.platform === 'ios' ? 'ios' : 'android';
      const id = String(input.deviceId || '');
      if (!id) return { ok: false, error: 'boot requires deviceId.' };
      try {
        if (platform === 'ios' && hostPlatform === 'darwin') {
          await executeFile('xcrun', ['simctl', 'boot', id], { encoding: 'utf8', timeout: 30_000 });
          await executeFile('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', id], { encoding: 'utf8', timeout: 10_000 }).catch(() => {});
        } else {
          const cli = await mobilecliBinary(dataDir);
          await executeFile(cli, ['device', 'boot', '--device', id], {
            encoding: 'utf8', windowsHide: true, timeout: 60_000,
            env: upstreamEnvironment(settings?.adbPath || await findAdb({ dataDir }), process.env, dataDir),
          });
        }
        cachedProbe.at = 0;
        await writeSelectedDevice(dataDir, { id, platform });
        return { ok: true, selected: { id, platform } };
      } catch (error) {
        return { ok: false, error: error.stderr?.trim() || error.message || String(error) };
      }
    }

    let target;
    try {
      target = await resolveTarget({ deviceId: input.deviceId, platform: input.platform, settings });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }

    try {
      const meta = ensureMetaEntry(target.platform, target.id);
      const effectiveSize = meta.effectiveSize;

      if (target.platform === 'android' && ['tap', 'doubleTap', 'longPress', 'swipe', 'scroll', 'button', 'key', 'pasteText'].includes(action)) {
        const fastCtrl = await resolveFastScrcpyControl(target, effectiveSize, settings);
        if (fastCtrl) {
          try {
            if (action === 'tap') {
              const pt = input.normX !== undefined && input.normY !== undefined
                ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
                : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
              await fastCtrl.tap(pt.x, pt.y, effectiveSize);
              return { ok: true, action, point: pt, channel: 'scrcpy' };
            }
            if (action === 'doubleTap') {
              const pt = input.normX !== undefined && input.normY !== undefined
                ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
                : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
              await fastCtrl.doubleTap(pt.x, pt.y, effectiveSize);
              return { ok: true, action, point: pt, channel: 'scrcpy' };
            }
            if (action === 'longPress') {
              const pt = input.normX !== undefined && input.normY !== undefined
                ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
                : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
              const duration = Math.min(5000, Math.max(250, Math.round(Number(input.durationMs) || 650)));
              await fastCtrl.longPress(pt.x, pt.y, duration, effectiveSize);
              return { ok: true, action, point: pt, duration, channel: 'scrcpy' };
            }
            if (action === 'swipe') {
              const start = input.startNormX !== undefined && input.startNormY !== undefined
                ? normalizePointerToDevice(input.startNormX, input.startNormY, effectiveSize.width, effectiveSize.height)
                : { x: Math.round(Number(input.x1) || 0), y: Math.round(Number(input.y1) || 0) };
              const end = input.endNormX !== undefined && input.endNormY !== undefined
                ? normalizePointerToDevice(input.endNormX, input.endNormY, effectiveSize.width, effectiveSize.height)
                : { x: Math.round(Number(input.x2) || 0), y: Math.round(Number(input.y2) || 0) };
              const duration = Math.min(3000, Math.max(80, Math.round(Number(input.durationMs) || 260)));
              await fastCtrl.swipe(start.x, start.y, end.x, end.y, duration, effectiveSize);
              return { ok: true, action, start, end, duration, channel: 'scrcpy' };
            }
            if (action === 'scroll' && typeof fastCtrl.scroll === 'function') {
              const pt = input.normX !== undefined && input.normY !== undefined
                ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
                : { x: Math.round(effectiveSize.width / 2), y: Math.round(effectiveSize.height / 2) };
              const hScroll = Math.max(-8, Math.min(8, -(Number(input.deltaX) || 0) / 80));
              const vScroll = Math.max(-8, Math.min(8, -(Number(input.deltaY) || 0) / 80));
              await fastCtrl.scroll(pt.x, pt.y, hScroll, vScroll, effectiveSize);
              return { ok: true, action, point: pt, channel: 'scrcpy' };
            }
            if (action === 'button' || action === 'key') {
              const btn = String(input.button || input.key || 'HOME').toUpperCase();
              const handled = await fastCtrl.pressButton(btn);
              if (handled) return { ok: true, action, button: btn, key: btn, channel: 'scrcpy' };
            }
            if (action === 'pasteText' && typeof fastCtrl.injectText === 'function') {
              const text = String(input.text ?? '');
              if (text && await fastCtrl.injectText(text, { pasteUnicode: true })) {
                return { ok: true, action, length: text.length, channel: 'scrcpy' };
              }
            }
          } catch {}
        }
      }

      const session = await acquireActionSession({ platform: target.platform, deviceId: target.id, settings });
      return await session.enqueueRpc(async () => {
        if (!meta.sizeInitialized && typeof session.driver.getScreenSize === 'function') {
          const sz = await session.driver.getScreenSize().catch(() => meta.screenSize);
          const orient = await session.driver.getOrientation?.().catch(() => 'portrait') ?? 'portrait';
          meta.screenSize = sz;
          meta.orientation = orient;
          meta.effectiveSize = computeEffectiveSize(sz, orient);
          meta.sizeInitialized = true;
        }
        const curSize = meta.effectiveSize;

        switch (action) {
          case 'tap': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, curSize.width, curSize.height)
              : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
            await session.driver.tap(pt.x, pt.y);
            return { ok: true, action, point: pt };
          }
          case 'doubleTap': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, curSize.width, curSize.height)
              : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
            await session.driver.doubleTap(pt.x, pt.y);
            return { ok: true, action, point: pt };
          }
          case 'longPress': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, curSize.width, curSize.height)
              : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
            const duration = Math.min(5000, Math.max(250, Math.round(Number(input.durationMs) || 650)));
            await session.driver.longPress(pt.x, pt.y, duration);
            return { ok: true, action, point: pt, duration };
          }
          case 'swipe': {
            const start = input.startNormX !== undefined && input.startNormY !== undefined
              ? normalizePointerToDevice(input.startNormX, input.startNormY, curSize.width, curSize.height)
              : { x: Math.round(Number(input.x1) || 0), y: Math.round(Number(input.y1) || 0) };
            const end = input.endNormX !== undefined && input.endNormY !== undefined
              ? normalizePointerToDevice(input.endNormX, input.endNormY, curSize.width, curSize.height)
              : { x: Math.round(Number(input.x2) || 0), y: Math.round(Number(input.y2) || 0) };
            const duration = Math.min(3000, Math.max(80, Math.round(Number(input.durationMs) || 260)));
            if (typeof session.driver.call === 'function') {
              await session.driver.call('device.io.swipe', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration });
            } else if (typeof session.driver.swipe === 'function') {
              const dx = end.x - start.x;
              const dy = end.y - start.y;
              const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
              await session.driver.swipe(dir, { startX: start.x, startY: start.y, distance: Math.round(Math.hypot(dx, dy)), duration });
            } else if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'swipe', String(start.x), String(start.y), String(end.x), String(end.y), String(duration)]);
            }
            return { ok: true, action, start, end, duration };
          }
          case 'scroll': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, curSize.width, curSize.height)
              : { x: Math.round(curSize.width / 2), y: Math.round(curSize.height / 2) };
            const rawDx = Number(input.deltaX) || 0;
            const rawDy = Number(input.deltaY) || 0;
            const maxSpanY = Math.round(curSize.height * 0.36);
            const maxSpanX = Math.round(curSize.width * 0.36);
            const moveY = Math.max(-maxSpanY, Math.min(maxSpanY, -Math.round(rawDy * 2.2)));
            const moveX = Math.max(-maxSpanX, Math.min(maxSpanX, -Math.round(rawDx * 2.2)));
            const end = {
              x: Math.min(curSize.width - 1, Math.max(0, pt.x + moveX)),
              y: Math.min(curSize.height - 1, Math.max(0, pt.y + moveY)),
            };
            const duration = 180;
            if (typeof session.driver.call === 'function') {
              await session.driver.call('device.io.swipe', { x1: pt.x, y1: pt.y, x2: end.x, y2: end.y, duration });
            } else if (typeof session.driver.swipe === 'function') {
              const dir = Math.abs(moveX) > Math.abs(moveY) ? (moveX > 0 ? 'right' : 'left') : (moveY > 0 ? 'down' : 'up');
              await session.driver.swipe(dir, { startX: pt.x, startY: pt.y, distance: Math.max(60, Math.round(Math.hypot(moveX, moveY))), duration });
            } else if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'swipe', String(pt.x), String(pt.y), String(end.x), String(end.y), String(duration)]);
            }
            return { ok: true, action, point: pt, end, duration };
          }
          case 'key':
          case 'button': {
            const btn = String(input.button || input.key || 'HOME').toUpperCase();
            if (btn === 'HOME' || btn === 'POWER' || btn === 'VOLUME_UP' || btn === 'VOLUME_DOWN') {
              await session.driver.pressButton(btn);
            } else if (target.platform === 'android' && session.adbBinary) {
              const codeMap = {
                BACK: '4', RECENTS: '187', APP_SWITCH: '187', ENTER: '66', MENU: '82',
                BACKSPACE: '67', DEL: '67', DELETE: '112', FORWARD_DEL: '112', TAB: '61',
                SPACE: '62', ESCAPE: '111', ESC: '111',
                UP: '19', DPAD_UP: '19', DOWN: '20', DPAD_DOWN: '20',
                LEFT: '21', DPAD_LEFT: '21', RIGHT: '22', DPAD_RIGHT: '22',
                MOVE_HOME: '122', MOVE_END: '123', PAGE_UP: '92', PAGE_DOWN: '93',
              };
              const keycode = codeMap[btn];
              if (!keycode) throw new Error(`Unsupported button or key: ${btn}`);
              await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', keycode]);
            } else if (typeof session.driver.pressKeys === 'function') {
              await session.driver.pressKeys([btn]);
            } else {
              throw new Error(`Button ${btn} is only available on Android.`);
            }
            return { ok: true, action, button: btn, key: btn };
          }
          case 'wake': {
            if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', '224']);
              await runAndroidShell(session.adbBinary, target.id, ['wm', 'dismiss-keyguard']).catch(() => '');
              const state = await readAndroidPowerState(session.adbBinary, target.id, curSize);
              if (state?.locked && !state.secure) {
                const cx = Math.round(state.width * 0.5);
                await runAndroidShell(session.adbBinary, target.id, [
                  'input', 'swipe', String(cx), String(Math.round(state.height * 0.82)), String(cx), String(Math.round(state.height * 0.25)), '200',
                ]);
              }
              const finalPower = await readAndroidPowerState(session.adbBinary, target.id, curSize);
              meta.powerState = finalPower;
              meta.powerUpdatedAt = Date.now();
              return { ok: true, action, powerState: finalPower };
            }
            await session.driver.pressButton('HOME');
            return { ok: true, action };
          }
          case 'sleep': {
            if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', '223']);
              const finalPower = await readAndroidPowerState(session.adbBinary, target.id, curSize);
              meta.powerState = finalPower;
              meta.powerUpdatedAt = Date.now();
              return { ok: true, action, powerState: finalPower };
            }
            await session.driver.pressButton('POWER');
            return { ok: true, action };
          }
          case 'rotate': {
            const next = input.orientation || (meta.orientation === 'portrait' ? 'landscape' : 'portrait');
            await session.driver.setOrientation(next);
            meta.orientation = next;
            meta.effectiveSize = computeEffectiveSize(meta.screenSize, next);
            meta.updatedAt = 0;
            return { ok: true, action, orientation: next };
          }
          case 'appearance': {
            const mode = input.mode === 'dark' ? 'dark' : 'light';
            if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no']);
              return { ok: true, action, mode };
            }
            if (target.platform === 'ios' && hostPlatform === 'darwin') {
              await executeFile('xcrun', ['simctl', 'ui', target.id, 'appearance', mode], { encoding: 'utf8', timeout: 8_000 });
              return { ok: true, action, mode };
            }
            throw new Error('Appearance toggle requires Android ADB or macOS iOS Simulator.');
          }
          case 'pasteText':
          case 'typeText': {
            const text = String(input.text ?? '');
            if (!text) return { ok: false, error: 'Text cannot be empty.' };
            await session.driver.typeText(text);
            if (input.submit) {
              await session.driver.pressKeys(['ENTER']).catch(async () => {
                if (target.platform === 'android' && session.adbBinary) {
                  await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', '66']);
                }
              });
            }
            return { ok: true, action, length: text.length };
          }
          case 'openUrl': {
            const url = String(input.url ?? '').trim();
            if (!url) return { ok: false, error: 'URL or deep link cannot be empty.' };
            await session.driver.openUrl(url);
            meta.updatedAt = 0;
            return { ok: true, action, url };
          }
          case 'launchApp': {
            const bundleId = String(input.bundleId ?? '').trim();
            if (!bundleId) return { ok: false, error: 'App package/bundle id cannot be empty.' };
            await session.driver.launchApp(bundleId);
            meta.updatedAt = 0;
            return { ok: true, action, bundleId };
          }
          default:
            return { ok: false, error: `Unknown preview action: ${String(action)}` };
        }
      });
    } catch (error) {
      return { ok: false, deviceId: target.id, platform: target.platform, error: error.message || String(error) };
    }
  }

  async function openPanelStream(stream, args = {}, session, context = {}) {
    if (stream !== 'screen') {
      throw new Error(`Unsupported phone panel stream: ${String(stream)}`);
    }
    const settings = context?.settings ?? {};
    const body = args !== null && typeof args === 'object' ? args : {};
    const target = await resolveTarget({
      deviceId: body.deviceId,
      platform: body.platform,
      settings,
    });
    if (target.platform !== 'android') {
      throw new Error('Hardware H.264 stream is currently supported on Android devices; iOS uses fast frame mode.');
    }
    const adbBinary = settings?.adbPath || await findAdb({ dataDir: target.dataDir });
    if (!adbBinary) {
      throw new Error('ADB is not configured yet. Run phone_prepare first.');
    }
    const meta = ensureMetaEntry(target.platform, target.id);
    const handshake = await scrcpy.openVideoStream(
      {
        adbBinary,
        serial: target.id,
        maxFps: body.maxFps ?? 60,
        maxWidth: body.maxWidth ?? 1080,
        bitRate: body.bitRate ?? 4_000_000,
        fallbackSize: meta.effectiveSize,
      },
      session,
      context,
    );
    if (handshake.width && handshake.height) {
      meta.effectiveSize = { width: handshake.width, height: handshake.height };
      meta.orientation = handshake.width > handshake.height ? 'landscape' : 'portrait';
    }
    return handshake;
  }

  async function handlePanelRequest(action, args = {}, context = {}) {
    const settings = context?.settings ?? {};
    const body = args !== null && typeof args === 'object' ? args : {};
    switch (action) {
      case 'state':
        return listState({ settings });
      case 'frame':
        return captureFrame({ ...body, settings });
      case 'tree':
        return inspectHierarchy({ ...body, settings });
      case 'action':
        return performAction(body, { settings });
      default:
        return { ok: false, error: `Unsupported panel action: ${String(action)}` };
    }
  }

  async function dispose() {
    await Promise.all([
      ...[...captureSessions.keys()].map((key) => closeLaneSession(captureSessions, key)),
      ...[...actionSessions.keys()].map((key) => closeLaneSession(actionSessions, key)),
      scrcpy.dispose(),
      loadDriverModule ? Promise.resolve() : disposeMobilecliServers(),
    ]);
  }

  return {
    activate,
    peekState,
    listState,
    captureFrame,
    inspectHierarchy,
    performAction,
    openPanelStream,
    handlePanelRequest,
    dispose,
  };
}
