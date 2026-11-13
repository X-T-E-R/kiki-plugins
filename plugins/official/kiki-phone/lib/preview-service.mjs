import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAdb, phoneDataDir } from './environment.mjs';
import { adbArguments } from './adb.mjs';
import { mobilecliBinary, parseDevices, runtimeInstalled, upstreamEnvironment } from './prepare.mjs';
import { parseAndroidScreenState } from './phone-run.mjs';

const defaultExecFile = promisify(execFile);
const SESSION_IDLE_MS = 60_000;

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

function normalizeDeviceRecord(raw, fallbackPlatform) {
  const platform = raw.platform === 'ios' || raw.platform === 'android' ? raw.platform : fallbackPlatform;
  const type = raw.type || (platform === 'ios' ? 'real' : 'real');
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

export function createPhonePreviewService({
  dataDir: customDataDir,
  hostPlatform = process.platform,
  executeFile = defaultExecFile,
  loadDriverModule,
} = {}) {
  const resolveDataDir = () => customDataDir || phoneDataDir();
  const deviceLocks = new Map();
  const driverSessions = new Map();

  async function withDeviceLock(key, fn) {
    const prev = deviceLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = prev.then(() => gate, () => gate);
    deviceLocks.set(key, chain);
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
      if (deviceLocks.get(key) === chain) deviceLocks.delete(key);
    }
  }

  async function readSelectedDevice(dataDir) {
    try {
      return JSON.parse(await readFile(path.join(dataDir, 'selected-device.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async function writeSelectedDevice(dataDir, selection) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'selected-device.json'), JSON.stringify(selection) + '\n');
  }

  async function resolveDriverClass(dataDir, adbBinary) {
    if (loadDriverModule) return loadDriverModule({ dataDir, adbBinary });
    const sharedEnv = upstreamEnvironment(adbBinary, process.env, dataDir);
    Object.assign(process.env, sharedEnv);
    const modPath = path.join(dataDir, 'runtime/node_modules/@mobilewright/driver-mobilecli/dist/index.js');
    return import(pathToFileURL(modPath).href);
  }

  async function closeDriverSession(key) {
    const entry = driverSessions.get(key);
    if (!entry) return;
    driverSessions.delete(key);
    clearTimeout(entry.idleTimer);
    try { await entry.driver.disconnect(); } catch {}
    try { await entry.driver.dispose(); } catch {}
  }

  function touchSessionIdle(key, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { void closeDriverSession(key); }, SESSION_IDLE_MS);
    entry.idleTimer.unref?.();
  }

  async function acquireDriverSession({ platform, deviceId, settings = {} }) {
    const dataDir = resolveDataDir();
    const key = `${platform}:${deviceId}`;
    const existing = driverSessions.get(key);
    if (existing) {
      touchSessionIdle(key, existing);
      return existing;
    }
    const ready = loadDriverModule ? true : await runtimeInstalled(dataDir);
    if (!ready) {
      throw new Error('Mobilewright runtime is not installed yet. Run phone_prepare first.');
    }
    const adbBinary = settings?.adbPath || await findAdb({ dataDir }).catch(() => undefined);
    const { MobilecliDriver } = await resolveDriverClass(dataDir, adbBinary);
    const cliPath = await mobilecliBinary(dataDir);
    const driver = new MobilecliDriver({ mobilecliPath: cliPath });
    await driver.connect({ platform, deviceId });
    const entry = { key, platform, deviceId, driver, adbBinary, dataDir, idleTimer: undefined };
    driverSessions.set(key, entry);
    touchSessionIdle(key, entry);
    return entry;
  }

  async function discoverSimulatorsDarwin() {
    if (hostPlatform !== 'darwin') return { available: false, reason: 'Xcode iOS Simulator requires macOS; physical iOS devices can connect via mobilecli / USB bridge.', devices: [] };
    try {
      const { stdout } = await executeFile('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
        encoding: 'utf8', timeout: 8_000, windowsHide: true,
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

  async function listState({ settings = {} } = {}) {
    const dataDir = resolveDataDir();
    const hasRuntime = loadDriverModule ? true : await runtimeInstalled(dataDir);
    const adbBinary = settings?.adbPath || await findAdb({ dataDir }).catch(() => undefined);
    const env = upstreamEnvironment(adbBinary, process.env, dataDir);

    const byKey = new Map();
    const diagnostics = {
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

    if (hasRuntime) {
      try {
        if (loadDriverModule) {
          const { MobilecliDriver } = await resolveDriverClass(dataDir, adbBinary);
          const probe = new MobilecliDriver({ mobilecliPath: await mobilecliBinary(dataDir) });
          try {
            const list = await probe.listDevices({ includeOffline: true });
            for (const item of list || []) {
              const norm = normalizeDeviceRecord(item, item.platform || 'android');
              byKey.set(`${norm.platform}:${norm.id}`, norm);
            }
          } finally {
            await probe.dispose?.().catch(() => {});
          }
        } else {
          const cli = await mobilecliBinary(dataDir);
          const { stdout } = await executeFile(cli, ['devices', '--include-offline'], {
            encoding: 'utf8', env, windowsHide: true, timeout: 10_000,
          });
          const parsed = JSON.parse(stdout || '{}');
          const list = Array.isArray(parsed) ? parsed : (parsed.data?.devices || parsed.devices || []);
          for (const item of list) {
            const norm = normalizeDeviceRecord(item, item.platform || 'android');
            byKey.set(`${norm.platform}:${norm.id}`, norm);
          }
        }
      } catch (error) {
        diagnostics.mobilecliError = error.message || String(error);
      }
    }

    if (adbBinary) {
      try {
        const { stdout } = await executeFile(adbBinary, ['devices', '-l'], {
          encoding: 'utf8', env, windowsHide: true, timeout: 8_000,
        });
        for (const row of parseDevices(stdout)) {
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
      } catch (error) {
        diagnostics.android.reason = error.message || String(error);
      }
    }

    if (hostPlatform === 'darwin') {
      const sim = await discoverSimulatorsDarwin();
      diagnostics.ios.available = diagnostics.ios.available || sim.available;
      if (!sim.available && sim.reason) diagnostics.ios.reason = sim.reason;
      for (const item of sim.devices) {
        const key = `ios:${item.id}`;
        if (!byKey.has(key)) byKey.set(key, item);
      }
    }

    const allDevices = sortDevices([...byKey.values()]);
    const saved = await readSelectedDevice(dataDir);
    const online = allDevices.filter((d) => d.state === 'online');
    let selected = saved && allDevices.some((d) => d.id === saved.id && d.platform === saved.platform)
      ? { id: saved.id, platform: saved.platform }
      : undefined;
    if ((!selected || !online.some((d) => d.id === selected.id && d.platform === selected.platform)) && online.length > 0) {
      selected = { id: online[0].id, platform: online[0].platform };
      await writeSelectedDevice(dataDir, selected).catch(() => {});
    }

    return {
      ok: true,
      selected,
      devices: allDevices,
      groups: {
        android: allDevices.filter((d) => d.platform === 'android'),
        ios: allDevices.filter((d) => d.platform === 'ios'),
      },
      diagnostics,
    };
  }

  async function resolveTarget({ deviceId, platform, settings = {} }) {
    const dataDir = resolveDataDir();
    if (deviceId && (platform === 'android' || platform === 'ios')) {
      return { id: String(deviceId), platform, dataDir };
    }
    const saved = await readSelectedDevice(dataDir);
    if (deviceId) {
      if (saved?.id === deviceId) return { id: String(deviceId), platform: saved.platform || 'android', dataDir };
      const state = await listState({ settings });
      const hit = state.devices.find((d) => d.id === deviceId);
      return { id: String(deviceId), platform: hit?.platform || platform || 'android', dataDir };
    }
    const state = await listState({ settings });
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

  async function captureFrame({ deviceId, platform, format = 'jpeg', quality = 74, maxWidth = 720, settings = {} } = {}) {
    const target = await resolveTarget({ deviceId, platform, settings });
    return withDeviceLock(`${target.platform}:${target.id}`, async () => {
      try {
        const session = await acquireDriverSession({ platform: target.platform, deviceId: target.id, settings });
        const screenSize = await session.driver.getScreenSize().catch(() => ({
          width: target.platform === 'ios' ? 1179 : 1080,
          height: target.platform === 'ios' ? 2556 : 2400,
        }));
        const orientation = await session.driver.getOrientation().catch(() =>
          (screenSize.width > screenSize.height ? 'landscape' : 'portrait'),
        );
        const effectiveSize = (orientation === 'landscape' || orientation === 'landscape_left' || orientation === 'landscape_right')
          && screenSize.height > screenSize.width
          ? { width: screenSize.height, height: screenSize.width }
          : screenSize;

        const wantPng = format === 'png';
        const scale = !wantPng && maxWidth && effectiveSize.width > maxWidth
          ? Math.max(0.25, Math.min(1, Number((maxWidth / effectiveSize.width).toFixed(2))))
          : undefined;
        const shotOpts = wantPng
          ? { format: 'png' }
          : { format: 'jpeg', quality: Math.min(95, Math.max(35, Number(quality) || 74)), ...(scale ? { scale } : {}) };

        let bytes;
        try {
          bytes = await session.driver.screenshot(shotOpts);
        } catch (shotErr) {
          await closeDriverSession(session.key);
          throw shotErr;
        }

        let foregroundApp = null;
        try {
          const fg = await session.driver.getForegroundApp();
          foregroundApp = fg?.bundleId || fg?.packageName || fg?.name || (typeof fg === 'string' ? fg : null);
        } catch {}

        let powerState = null;
        if (target.platform === 'android' && session.adbBinary) {
          powerState = await readAndroidPowerState(session.adbBinary, target.id, effectiveSize);
        }

        const mimeType = wantPng ? 'image/png' : 'image/jpeg';
        return {
          ok: true,
          deviceId: target.id,
          platform: target.platform,
          mimeType,
          dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
          byteLength: bytes.length,
          screenSize: effectiveSize,
          orientation,
          foregroundApp,
          powerState,
          capturedAt: Date.now(),
        };
      } catch (error) {
        return {
          ok: false,
          deviceId: target.id,
          platform: target.platform,
          error: error.message || String(error),
        };
      }
    });
  }

  async function inspectHierarchy({ deviceId, platform, settings = {} } = {}) {
    const target = await resolveTarget({ deviceId, platform, settings });
    return withDeviceLock(`${target.platform}:${target.id}`, async () => {
      try {
        const session = await acquireDriverSession({ platform: target.platform, deviceId: target.id, settings });
        const screenSize = await session.driver.getScreenSize().catch(() => ({ width: 1080, height: 2400 }));
        const rawTree = await session.driver.getViewHierarchy();
        const nodes = flattenViewHierarchy(rawTree, screenSize);
        return {
          ok: true,
          deviceId: target.id,
          platform: target.platform,
          screenSize,
          nodeCount: nodes.length,
          nodes,
        };
      } catch (error) {
        return { ok: false, deviceId: target.id, platform: target.platform, error: error.message || String(error) };
      }
    });
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
        await writeSelectedDevice(dataDir, { id, platform });
        return { ok: true, selected: { id, platform } };
      } catch (error) {
        return { ok: false, error: error.stderr?.trim() || error.message || String(error) };
      }
    }

    const target = await resolveTarget({ deviceId: input.deviceId, platform: input.platform, settings });
    return withDeviceLock(`${target.platform}:${target.id}`, async () => {
      try {
        const session = await acquireDriverSession({ platform: target.platform, deviceId: target.id, settings });
        const screenSize = await session.driver.getScreenSize().catch(() => ({
          width: target.platform === 'ios' ? 1179 : 1080,
          height: target.platform === 'ios' ? 2556 : 2400,
        }));
        const orientation = await session.driver.getOrientation().catch(() => 'portrait');
        const effectiveSize = (orientation === 'landscape' || orientation === 'landscape_left' || orientation === 'landscape_right')
          && screenSize.height > screenSize.width
          ? { width: screenSize.height, height: screenSize.width }
          : screenSize;

        switch (action) {
          case 'tap': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
              : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
            await session.driver.tap(pt.x, pt.y);
            return { ok: true, action, point: pt };
          }
          case 'doubleTap': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
              : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
            await session.driver.doubleTap(pt.x, pt.y);
            return { ok: true, action, point: pt };
          }
          case 'longPress': {
            const pt = input.normX !== undefined && input.normY !== undefined
              ? normalizePointerToDevice(input.normX, input.normY, effectiveSize.width, effectiveSize.height)
              : { x: Math.round(Number(input.x) || 0), y: Math.round(Number(input.y) || 0) };
            const duration = Math.min(5000, Math.max(250, Math.round(Number(input.durationMs) || 650)));
            await session.driver.longPress(pt.x, pt.y, duration);
            return { ok: true, action, point: pt, duration };
          }
          case 'swipe': {
            const start = input.startNormX !== undefined && input.startNormY !== undefined
              ? normalizePointerToDevice(input.startNormX, input.startNormY, effectiveSize.width, effectiveSize.height)
              : { x: Math.round(Number(input.x1) || 0), y: Math.round(Number(input.y1) || 0) };
            const end = input.endNormX !== undefined && input.endNormY !== undefined
              ? normalizePointerToDevice(input.endNormX, input.endNormY, effectiveSize.width, effectiveSize.height)
              : { x: Math.round(Number(input.x2) || 0), y: Math.round(Number(input.y2) || 0) };
            const duration = Math.min(3000, Math.max(80, Math.round(Number(input.durationMs) || 260)));
            if (typeof session.driver.call === 'function') {
              await session.driver.call('device.io.swipe', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration });
            } else if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'swipe', String(start.x), String(start.y), String(end.x), String(end.y), String(duration)]);
            } else {
              const dx = end.x - start.x;
              const dy = end.y - start.y;
              const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
              await session.driver.swipe(dir, { startX: start.x, startY: start.y, distance: Math.round(Math.hypot(dx, dy)), duration });
            }
            return { ok: true, action, start, end, duration };
          }
          case 'button': {
            const btn = String(input.button || 'HOME').toUpperCase();
            if (btn === 'HOME' || btn === 'POWER' || btn === 'VOLUME_UP' || btn === 'VOLUME_DOWN') {
              await session.driver.pressButton(btn);
            } else if (target.platform === 'android' && session.adbBinary) {
              const codeMap = { BACK: '4', RECENTS: '187', APP_SWITCH: '187', ENTER: '66', MENU: '82' };
              const keycode = codeMap[btn];
              if (!keycode) throw new Error(`Unsupported button: ${btn}`);
              await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', keycode]);
            } else {
              throw new Error(`Button ${btn} is only available on Android.`);
            }
            return { ok: true, action, button: btn };
          }
          case 'wake': {
            if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', '224']);
              await runAndroidShell(session.adbBinary, target.id, ['wm', 'dismiss-keyguard']).catch(() => '');
              const state = await readAndroidPowerState(session.adbBinary, target.id, effectiveSize);
              if (state?.locked && !state.secure) {
                const cx = Math.round(state.width * 0.5);
                await runAndroidShell(session.adbBinary, target.id, [
                  'input', 'swipe', String(cx), String(Math.round(state.height * 0.82)), String(cx), String(Math.round(state.height * 0.25)), '200',
                ]);
              }
              return { ok: true, action, powerState: await readAndroidPowerState(session.adbBinary, target.id, effectiveSize) };
            }
            await session.driver.pressButton('HOME');
            return { ok: true, action };
          }
          case 'sleep': {
            if (target.platform === 'android' && session.adbBinary) {
              await runAndroidShell(session.adbBinary, target.id, ['input', 'keyevent', '223']);
              return { ok: true, action, powerState: await readAndroidPowerState(session.adbBinary, target.id, effectiveSize) };
            }
            await session.driver.pressButton('POWER');
            return { ok: true, action };
          }
          case 'rotate': {
            const next = input.orientation || (orientation === 'portrait' ? 'landscape' : 'portrait');
            await session.driver.setOrientation(next);
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
            return { ok: true, action, url };
          }
          case 'launchApp': {
            const bundleId = String(input.bundleId ?? '').trim();
            if (!bundleId) return { ok: false, error: 'App package/bundle id cannot be empty.' };
            await session.driver.launchApp(bundleId);
            return { ok: true, action, bundleId };
          }
          default:
            return { ok: false, error: `Unknown preview action: ${String(action)}` };
        }
      } catch (error) {
        return { ok: false, deviceId: target.id, platform: target.platform, error: error.message || String(error) };
      }
    });
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
    await Promise.all([...driverSessions.keys()].map((key) => closeDriverSession(key)));
  }

  return {
    listState,
    captureFrame,
    inspectHierarchy,
    performAction,
    handlePanelRequest,
    dispose,
  };
}
