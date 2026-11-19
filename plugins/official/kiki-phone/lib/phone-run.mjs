import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { formatWithOptions } from 'node:util';
import { findAdb, phoneDataDir } from './environment.mjs';
import { execAdb } from './adb.mjs';
import { mobilecliBinary, runtimeInstalled, upstreamEnvironment } from './prepare.mjs';
import {
  DEFAULT_MOBILECLI_URL,
  ensureMobilecliRuntimePatched,
  ensureMobilecliServer,
} from './mobilecli-server.mjs';
import { nodeExecutable } from './node-executable.mjs';
import {
  sampleGaussian,
  samplePointInBox,
  buildHumanTapKeyframes,
  buildHumanSwipeKeyframes,
  resolveDirectionEndpoints,
  sampleHumanDelayMs,
} from './human-input.mjs';

export {
  sampleGaussian,
  samplePointInBox,
  buildHumanTapKeyframes,
  buildHumanSwipeKeyframes,
  resolveDirectionEndpoints,
  sampleHumanDelayMs,
} from './human-input.mjs';

const defaultExecuteAdb = execAdb;
const locatorTapHooks = new WeakMap();
const defaultDelay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function parseAndroidScreenState({ power = '', policy = '', wmSize = '', fallbackSize } = {}) {
  const wakefulness = power.match(/mWakefulness=([A-Za-z]+)/)?.[1]
    ?? (/\bDisplay Power:\s*state=ON\b/i.test(power) ? 'Awake' : /\bDisplay Power:\s*state=OFF\b/i.test(power) ? 'Asleep' : 'Unknown');
  const awake = wakefulness === 'Awake' || wakefulness === 'Dreaming';
  const keyguardSection = policy.match(/KeyguardServiceDelegate[\s\S]{0,600}/)?.[0] ?? policy;
  const showingMatch = keyguardSection.match(/\bshowing=(true|false)\b/) ?? policy.match(/\bmShowingLockscreen=(true|false)\b/);
  const occludedMatch = keyguardSection.match(/\boccluded=(true|false)\b/);
  const secureMatch = keyguardSection.match(/\bsecure=(true|false)\b/) ?? policy.match(/\bmIsSecure=(true|false)\b/);
  const showing = showingMatch ? showingMatch[1] === 'true' : false;
  const occluded = occludedMatch ? occludedMatch[1] === 'true' : false;
  const locked = showing && !occluded;
  const secure = secureMatch ? secureMatch[1] === 'true' : false;
  const overrideSize = wmSize.match(/Override size:\s*(\d+)x(\d+)/i);
  const physicalSize = wmSize.match(/Physical size:\s*(\d+)x(\d+)/i);
  const sizeMatch = overrideSize ?? physicalSize;
  const width = sizeMatch ? Number(sizeMatch[1]) : (fallbackSize?.width || 1080);
  const height = sizeMatch ? Number(sizeMatch[2]) : (fallbackSize?.height || 2400);
  return { awake, wakefulness, locked, showing, occluded, secure, width, height };
}

export function attachPhoneConvenienceApis(device, screen, {
  platform,
  serial,
  adbBinary,
  signal,
  executeAdb = defaultExecuteAdb,
  delay = defaultDelay,
  rng = Math.random,
  env = process.env,
} = {}) {
  let cachedSize;
  let lastTransitionAt = 0;
  const TRANSITION_SETTLE_MS = 950;
  const isRawInput = (opts) => Boolean(opts?.raw) || /^(1|true|yes)$/i.test(String(env?.KIKI_PHONE_RAW_INPUT ?? ''));
  const rawScreenTap = typeof screen?.tap === 'function' ? screen.tap.bind(screen) : undefined;
  const rawOriginalSwipe = typeof screen?.swipe === 'function' ? screen.swipe.bind(screen) : undefined;
  const rawScreenGesture = typeof screen?.gesture === 'function' ? screen.gesture.bind(screen) : undefined;
  const waitPostTransitionSettle = async () => {
    if (!lastTransitionAt) return;
    const elapsed = Date.now() - lastTransitionAt;
    lastTransitionAt = 0;
    if (elapsed >= 0 && elapsed < TRANSITION_SETTLE_MS) {
      await delay(TRANSITION_SETTLE_MS - elapsed, signal);
    }
  };
  if (rawScreenGesture && device && typeof device.launchApp === 'function' && !device.launchApp.__kikiSettlePatched) {
    const rawLaunchApp = device.launchApp.bind(device);
    const wrappedLaunchApp = async (...args) => {
      const res = await rawLaunchApp(...args);
      lastTransitionAt = Date.now();
      return res;
    };
    wrappedLaunchApp.__kikiSettlePatched = true;
    device.launchApp = wrappedLaunchApp;
  }

  const resolveScreenDimensions = async (opts = {}) => {
    if (Number(opts?.screenWidth) > 0 && Number(opts?.screenHeight) > 0) {
      return { width: Number(opts.screenWidth), height: Number(opts.screenHeight) };
    }
    if (cachedSize) return cachedSize;
    if (typeof device?.screenSize === 'function') {
      try {
        const sz = await device.screenSize();
        if (Number(sz?.width) > 0 && Number(sz?.height) > 0) {
          cachedSize = { width: Number(sz.width), height: Number(sz.height) };
          return cachedSize;
        }
      } catch {}
    }
    cachedSize = { width: 1080, height: 2400 };
    return cachedSize;
  };

  const rawSwipe = async (directionOrX1, optsOrY1, x2, y2, duration) => {
    if (typeof directionOrX1 === 'number' && typeof optsOrY1 === 'number' && typeof x2 === 'number' && typeof y2 === 'number') {
      if (typeof device?.driver?.call === 'function') {
        return device.driver.call('device.io.swipe', {
          x1: Math.round(directionOrX1),
          y1: Math.round(optsOrY1),
          x2: Math.round(x2),
          y2: Math.round(y2),
          ...(typeof duration === 'number' ? { duration: Math.round(duration) } : {}),
        });
      }
      if (platform === 'android') {
        const args = ['-s', serial, 'shell', 'input', 'swipe', String(Math.round(directionOrX1)), String(Math.round(optsOrY1)), String(Math.round(x2)), String(Math.round(y2))];
        if (typeof duration === 'number') args.push(String(Math.round(duration)));
        await executeAdb(adbBinary || 'adb', args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, signal });
        return;
      }
    }
    if (rawOriginalSwipe) {
      if (optsOrY1 && typeof optsOrY1 === 'object' && 'raw' in optsOrY1) {
        const { raw: _raw, ...cleanOpts } = optsOrY1;
        return rawOriginalSwipe(directionOrX1, Object.keys(cleanOpts).length ? cleanOpts : undefined);
      }
      return rawOriginalSwipe(directionOrX1, optsOrY1);
    }
    throw new Error('No swipe transport available on screen.');
  };

  if (screen && typeof screen.typeText !== 'function' && typeof device?.driver?.typeText === 'function') {
    screen.typeText = async (text, options = {}) => {
      await device.driver.typeText(String(text));
      if (options?.submit) {
        if (typeof device.driver.pressKeys === 'function') await device.driver.pressKeys(['ENTER']);
        else if (platform === 'android') await executeAdb(adbBinary || 'adb', ['-s', serial, 'shell', 'input', 'keyevent', '66'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, signal });
      }
    };
  }
  if (screen && typeof screen.pressKeys !== 'function' && typeof device?.driver?.pressKeys === 'function') {
    screen.pressKeys = async (keys) => device.driver.pressKeys(keys);
  }
  if (screen && typeof screen.humanTap !== 'function') {
    screen.humanTap = async (target, yOrOpts, maybeOpts) => {
      let opts;
      let point;
      let localRng;
      if (typeof target === 'number' && typeof yOrOpts === 'number') {
        opts = maybeOpts ?? {};
        localRng = opts.rng ?? rng;
        const jitterPx = Math.max(0, Number(opts.jitterPx ?? 6));
        point = jitterPx === 0
          ? { x: Math.round(target), y: Math.round(yOrOpts) }
          : samplePointInBox(
            { x: target - jitterPx, y: yOrOpts - jitterPx, width: jitterPx * 2, height: jitterPx * 2 },
            { insetRatio: 0, sigmaRatio: 0.28, maxOffsetPx: 0, rng: localRng },
          );
      } else if (typeof target?.boundingBox === 'function') {
        opts = yOrOpts ?? {};
        localRng = opts.rng ?? rng;
        const box = await target.boundingBox(opts.timeout !== undefined ? { timeout: opts.timeout } : undefined);
        if (!box) throw new Error('Locator did not resolve to a visible bounding box.');
        point = samplePointInBox(box, { insetRatio: opts.insetRatio, sigmaRatio: opts.sigmaRatio, maxOffsetPx: opts.maxOffsetPx, rng: localRng });
      } else if (target && typeof target === 'object') {
        opts = yOrOpts ?? {};
        localRng = opts.rng ?? rng;
        const rawBox = target.bounds && typeof target.bounds === 'object' ? target.bounds : target;
        if (!Number.isFinite(Number(rawBox?.x ?? rawBox?.left)) || !Number.isFinite(Number(rawBox?.y ?? rawBox?.top))) {
          throw new TypeError('screen.humanTap expects (x, y), a { x, y, width, height } box, or a Mobilewright locator.');
        }
        point = samplePointInBox(rawBox, { insetRatio: opts.insetRatio, sigmaRatio: opts.sigmaRatio, maxOffsetPx: opts.maxOffsetPx, rng: localRng });
      } else {
        throw new TypeError('screen.humanTap expects (x, y), a { x, y, width, height } box, or a Mobilewright locator.');
      }
      const { width, height } = await resolveScreenDimensions(opts);
      const tap = buildHumanTapKeyframes(point, { holdMs: opts.holdMs, screenWidth: width, screenHeight: height, rng: localRng });
      signal?.throwIfAborted();
      if (rawScreenGesture) {
        await waitPostTransitionSettle();
        await rawScreenGesture({ pointers: [tap.points] });
      } else if (platform === 'android') {
        const [p0, p1] = tap.points;
        await executeAdb(adbBinary || 'adb', ['-s', serial, 'shell', 'input', 'swipe', String(p0.x), String(p0.y), String(p1.x), String(p1.y), String(tap.holdMs)], {
          encoding: 'utf8', windowsHide: true, timeout: 15_000, signal,
        });
      } else if (rawScreenTap) {
        await rawScreenTap(tap.x, tap.y);
      } else {
        throw new Error('No gesture or tap transport available on screen.');
      }
      return { x: tap.x, y: tap.y, holdMs: tap.holdMs };
    };
  }
  if (screen && typeof screen.humanSwipe !== 'function') {
    screen.humanSwipe = async (directionOrX1, optsOrY1, x2, y2, durationOrOpts, maybeOpts) => {
      let opts;
      let swipe;
      if (typeof directionOrX1 === 'string') {
        opts = (optsOrY1 && typeof optsOrY1 === 'object') ? optsOrY1 : (typeof optsOrY1 === 'number' ? { durationMs: optsOrY1 } : {});
        const localRng = opts.rng ?? rng;
        const { width, height } = await resolveScreenDimensions(opts);
        const endpoints = resolveDirectionEndpoints(directionOrX1, {
          width,
          height,
          startX: opts.startX,
          startY: opts.startY,
          distance: opts.distance,
          distanceRatio: opts.distanceRatio,
          rng: localRng,
        });
        swipe = buildHumanSwipeKeyframes(endpoints.x1, endpoints.y1, endpoints.x2, endpoints.y2, {
          durationMs: opts.durationMs ?? opts.duration, jitterPx: opts.jitterPx, screenWidth: width, screenHeight: height, rng: localRng,
        });
      } else if (typeof directionOrX1 === 'number' && typeof optsOrY1 === 'number' && typeof x2 === 'number' && typeof y2 === 'number') {
        opts = typeof durationOrOpts === 'number' ? { ...(maybeOpts ?? {}), durationMs: durationOrOpts } : (durationOrOpts ?? {});
        const localRng = opts.rng ?? rng;
        const { width, height } = await resolveScreenDimensions(opts);
        swipe = buildHumanSwipeKeyframes(directionOrX1, optsOrY1, x2, y2, {
          durationMs: opts.durationMs ?? opts.duration, jitterPx: opts.jitterPx, screenWidth: width, screenHeight: height, rng: localRng,
        });
      } else {
        throw new TypeError('screen.humanSwipe expects (direction, opts?) or (x1, y1, x2, y2, durationOrOpts?).');
      }
      signal?.throwIfAborted();
      if (rawScreenGesture) {
        await waitPostTransitionSettle();
        await rawScreenGesture({ pointers: [swipe.points] });
      } else if (rawOriginalSwipe || typeof device?.driver?.call === 'function') {
        await rawSwipe(swipe.x1, swipe.y1, swipe.x2, swipe.y2, swipe.durationMs);
      } else if (platform === 'android') {
        await executeAdb(adbBinary || 'adb', ['-s', serial, 'shell', 'input', 'swipe', String(swipe.x1), String(swipe.y1), String(swipe.x2), String(swipe.y2), String(swipe.durationMs)], {
          encoding: 'utf8', windowsHide: true, timeout: 15_000, signal,
        });
      } else {
        throw new Error('No gesture or swipe transport available on screen.');
      }
      return {
        x1: swipe.x1,
        y1: swipe.y1,
        x2: swipe.x2,
        y2: swipe.y2,
        durationMs: swipe.durationMs,
        steps: swipe.points.length - 1,
      };
    };
  }
  if (screen && rawScreenTap && !screen.tap.__kikiHumanPatched) {
    const wrappedTap = async (x, y, opts) => {
      if (!rawScreenGesture || isRawInput(opts)) {
        return rawScreenTap(x, y);
      }
      return screen.humanTap(x, y, { jitterPx: 4, ...opts });
    };
    wrappedTap.__kikiHumanPatched = true;
    screen.tap = wrappedTap;
  }
  if (screen && rawOriginalSwipe && !screen.swipe.__kikiTuplePatched) {
    const wrappedSwipe = async (directionOrX1, optsOrY1, x2, y2, durationOrOpts, maybeOpts) => {
      if (typeof directionOrX1 === 'number' && typeof optsOrY1 === 'number' && typeof x2 === 'number' && typeof y2 === 'number') {
        const opts = (durationOrOpts && typeof durationOrOpts === 'object') ? durationOrOpts : (maybeOpts ?? {});
        const durationVal = typeof durationOrOpts === 'number' ? durationOrOpts : (opts.duration ?? opts.durationMs);
        if (!rawScreenGesture || isRawInput(opts)) {
          return rawSwipe(directionOrX1, optsOrY1, x2, y2, durationVal);
        }
        return screen.humanSwipe(directionOrX1, optsOrY1, x2, y2, durationVal, opts);
      }
      const opts = (optsOrY1 && typeof optsOrY1 === 'object') ? optsOrY1 : undefined;
      if (!rawScreenGesture || isRawInput(opts)) {
        return rawSwipe(directionOrX1, optsOrY1);
      }
      return screen.humanSwipe(directionOrX1, optsOrY1);
    };
    wrappedSwipe.__kikiTuplePatched = true;
    screen.swipe = wrappedSwipe;
  }
  if (rawScreenGesture && screen?.root && screen?.driver && typeof screen.root.resolveActionable === 'function') {
    locatorTapHooks.set(screen.driver, async (locator, opts) => {
      if (isRawInput(opts)) return false;
      const runStep = typeof locator._step === 'function' ? (fn) => locator._step('locator.tap()', fn) : (fn) => fn();
      await runStep(async () => {
        const node = await locator.resolveActionable(opts?.timeout);
        await screen.humanTap(node.bounds, { maxOffsetPx: 52, ...opts });
      });
      return true;
    });
    const proto = Object.getPrototypeOf(screen.root);
    if (proto && typeof proto.tap === 'function' && !proto.tap.__kikiHumanPatched) {
      const rawProtoTap = proto.tap;
      const patchedLocatorTap = async function (opts) {
        const hook = this?.driver ? locatorTapHooks.get(this.driver) : undefined;
        if (hook && await hook(this, opts)) return;
        return rawProtoTap.call(this, opts);
      };
      patchedLocatorTap.__kikiHumanPatched = true;
      proto.tap = patchedLocatorTap;
    }
  }
  if (device && typeof device.humanDelay !== 'function') {
    device.humanDelay = async (minMs = 450, maxMs = 1350) => {
      const ms = sampleHumanDelayMs(minMs, maxMs, rng);
      await delay(ms, signal);
      return ms;
    };
  }
  if (platform !== 'android') {
    const unsupported = (method) => async () => { throw new Error(`${method} is currently supported on Android devices only.`); };
    if (typeof device.screenState !== 'function') device.screenState = unsupported('device.screenState()');
    if (typeof device.wake !== 'function') device.wake = unsupported('device.wake()');
    if (typeof device.unlock !== 'function') device.unlock = unsupported('device.unlock()');
    if (typeof device.sleep !== 'function') device.sleep = unsupported('device.sleep()');
    if (typeof device.ensureCleanIme !== 'function') device.ensureCleanIme = async () => ({ changed: false });
    return;
  }
  const adb = adbBinary || 'adb';
  const runShell = async (...shellArgs) => {
    signal?.throwIfAborted();
    const { stdout = '' } = await executeAdb(adb, ['-s', serial, 'shell', ...shellArgs], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal,
    });
    return stdout;
  };
  const readScreenState = async () => {
    const [power, policy, wmSize] = await Promise.all([
      runShell('dumpsys', 'power'),
      runShell('dumpsys', 'window', 'policy'),
      runShell('wm', 'size').catch(() => ''),
    ]);
    let fallbackSize;
    if (!/size:\s*\d+x\d+/i.test(wmSize) && typeof device.screenSize === 'function') {
      try { fallbackSize = await device.screenSize(); } catch {}
    }
    return parseAndroidScreenState({ power, policy, wmSize, fallbackSize });
  };
  if (typeof device.screenState !== 'function') {
    device.screenState = readScreenState;
  }
  if (typeof device.wake !== 'function') {
    device.wake = async ({ unlock = true } = {}) => {
      let state = await readScreenState();
      if (!state.awake) {
        await runShell('input', 'keyevent', '224');
        await delay(450, signal);
        state = await readScreenState();
      }
      if (!unlock || !state.locked) return state;
      await runShell('wm', 'dismiss-keyguard').catch(() => '');
      await delay(200, signal);
      state = await readScreenState();
      if (!state.locked) return state;
      if (state.secure) return { ...state, reason: 'secure_keyguard' };
      const x = Math.round(state.width * 0.5);
      const yStart = Math.round(state.height * 0.82);
      const yEnd = Math.round(state.height * 0.25);
      await runShell('input', 'swipe', String(x), String(yStart), String(x), String(yEnd), '200');
      await delay(400, signal);
      state = await readScreenState();
      if (state.locked) {
        await runShell('input', 'keyevent', '82').catch(() => '');
        await delay(250, signal);
        state = await readScreenState();
      }
      return state;
    };
  }
  if (typeof device.unlock !== 'function') {
    device.unlock = async () => {
      const state = await device.wake({ unlock: true });
      if (state.locked) {
        throw new Error(state.secure
          ? 'Device lockscreen is protected by a PIN/password/pattern; unlock the phone manually or disable lockscreen security.'
          : 'Device keyguard remained showing after wake and swipe-up dismiss.');
      }
      return state;
    };
  }
  if (typeof device.sleep !== 'function') {
    device.sleep = async () => {
      await runShell('input', 'keyevent', '223');
      await delay(300, signal);
      return readScreenState();
    };
  }
  if (typeof device.ensureCleanIme !== 'function') {
    device.ensureCleanIme = async () => {
      const current = (await runShell('settings', 'get', 'secure', 'default_input_method')).trim();
      if (!/adbkeyboard|adbime/i.test(current)) {
        return { changed: false, current };
      }
      const listOut = await runShell('ime', 'list', '-s');
      const candidates = listOut.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const restored = candidates.find(id => !/adbkeyboard|adbime/i.test(id));
      if (!restored) {
        return { changed: false, previous: current, reason: 'no_alternative_ime' };
      }
      await runShell('ime', 'set', restored);
      await runShell('ime', 'disable', current).catch(() => '');
      return { changed: true, previous: current, restored };
    };
  }
}

export async function executePhoneScript({ script, device: requested, platform = 'android' }, context = {}, support = {}) {
  const dataDir = support.dataDir || phoneDataDir();
  const output = [];
  let device;
  let driver;
  let startedServer;
  const environmentKeys = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'MOBILEMCP_DISABLE_TELEMETRY', 'npm_config_ignore_scripts', 'npm_config_cache'];
  const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    if (!support.sdk && !(await runtimeInstalled(dataDir))) throw new Error('Mobilewright runtime missing. Run phone_prepare first.');
    context.signal?.throwIfAborted();
    const adbBinary = context.settings?.adbPath || process.env.KIKI_PHONE_ADB_PATH || await findAdb({ dataDir });
    Object.assign(process.env, upstreamEnvironment(adbBinary, process.env, dataDir));
    const modules = path.join(dataDir, 'runtime/node_modules');
    if (!support.driverModule) {
      await ensureMobilecliRuntimePatched(dataDir).catch(() => {});
    }
    const sdk = support.sdk || await import(pathToFileURL(path.join(modules, 'mobilewright/dist/index.js')));
    const { MobilecliDriver } = support.driverModule || await import(pathToFileURL(path.join(modules, '@mobilewright/driver-mobilecli/dist/index.js')));
    const cliPath = await mobilecliBinary(dataDir);
    const hasCliBinary = await access(cliPath).then(() => true, () => false);
    let serverUrl = DEFAULT_MOBILECLI_URL;
    if (!support.driverModule && !support.sdk && script && hasCliBinary) {
      const ensured = await ensureMobilecliServer({
        binaryPath: cliPath,
        env: process.env,
      });
      serverUrl = ensured.url;
      if (ensured.started) startedServer = ensured.serverProcess;
    }
    driver = new MobilecliDriver({ mobilecliPath: cliPath, autoStart: false, url: serverUrl });
    const devices = (await driver.listDevices({ platform })).filter(item => item.state === 'online');
    let saved;
    try { saved = JSON.parse(await readFile(path.join(dataDir, 'selected-device.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const selected = requested || (saved?.platform === platform ? saved.id : undefined) || (devices.length === 1 ? devices[0].id : undefined);
    if (!selected || !devices.some(item => item.id === selected)) {
      const message = selected
        ? `Selected device ${selected} is not online. Run android_connection({ action: "devices" }) to check USB/wireless state, or pass an online device id to phone_run.`
        : devices.length
          ? 'Multiple phones online. Choose one device id from devices[] and pass device to phone_run.'
          : 'No online device. Run android_connection({ action: "devices" }) or phone_prepare to check USB/wireless debugging.';
      return { isError: Boolean(script || requested), output: JSON.stringify({ message, devices, selected, platform }) };
    }
    await writeFile(path.join(dataDir, 'selected-device.json'), JSON.stringify({ platform, id: selected }) + '\n');
    if (!script) return { output: JSON.stringify({ devices, selected, platform }) };
    device = await sdk.connectDevice({ platform, deviceId: selected, driver });
    const screen = device.screen;
    attachPhoneConvenienceApis(device, screen, {
      platform,
      serial: selected,
      adbBinary,
      signal: context.signal,
      executeAdb: support.executeAdb,
      delay: support.delay,
      rng: support.rng,
      env: support.env ?? process.env,
    });
    const log = (...values) => output.push({ type: 'text', text: formatWithOptions({ depth: null, maxArrayLength: null, maxStringLength: null, colors: false }, ...values) });
    const snapshot = async () => screen.viewTree();
    const screenshot = async (options = {}) => {
      const { attach = true, ...rest } = options;
      const bytes = await screen.screenshot({ ...rest, format: 'png' });
      if (attach !== false) {
        output.push({ type: 'image_url', imageUrl: { url: `data:image/png;base64,${bytes.toString('base64')}` } });
      }
      return { bytes: bytes.length, mimeType: 'image/png', path: rest.path };
    };
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)('device', 'screen', 'expect', 'snapshot', 'screenshot', 'console', script);
    context.signal?.throwIfAborted();
    const result = await execute(device, screen, sdk.expect, snapshot, screenshot, { log, info: log, warn: log, error: log });
    output.unshift({ type: 'text', text: JSON.stringify({ device: selected, platform, result: result ?? null }) });
    return { output };
  } catch (error) {
    output.unshift({ type: 'text', text: `Phone script failed: ${error.message || String(error)}. Re-observe via snapshot() or screenshot() before retrying any modifying action.` });
    return { isError: true, output };
  } finally {
    try { if (device) await device.close(); else await driver?.dispose(); }
    finally {
      if (startedServer) await startedServer.kill().catch(() => {});
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
}

export function createPhoneScriptRunner({ executeFile = execFile, resolveNode = nodeExecutable, dataDir } = {}) {
  let running;
  const lifetime = new AbortController();
  return {
    async run(args, context = {}) {
      if (running) return { isError: true, output: 'A phone script is already running. Wait for it to finish before operating the phone.' };
      const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
      running = (async () => {
        try {
          const node = await resolveNode();
          return await new Promise((resolve) => {
            const workerEnv = { ...process.env };
            if (dataDir) workerEnv.KIKI_PHONE_DATA_DIR = dataDir;
            if (context.settings?.adbPath) workerEnv.KIKI_PHONE_ADB_PATH = context.settings.adbPath;
            const child = executeFile(node, [fileURLToPath(import.meta.url), '--worker'], {
              signal, timeout: args.timeoutMs || 90_000, maxBuffer: 24 * 1024 * 1024,
              encoding: 'utf8', windowsHide: true,
              env: workerEnv,
            }, (error, stdout, stderr) => {
              if (error) resolve({ isError: true, output: `Phone script interrupted or failed: ${stderr || error.message}. Observe before repeating an action; completed actions are not rolled back.` });
              else {
                try { resolve(JSON.parse(stdout)); }
                catch { resolve({ isError: true, output: `Phone script returned invalid output: ${stdout}\n${stderr}` }); }
              }
            });
            child.stdin.on('error', () => {});
            child.stdin.end(JSON.stringify(args));
          });
        } catch (error) {
          return { isError: true, output: error.message };
        }
      })();
      try { return await running; }
      finally { running = undefined; }
    },
    async close() {
      lifetime.abort(new Error('Phone script runner disposed'));
      await running;
    },
  };
}

const defaultRunner = createPhoneScriptRunner();
export function runPhoneScript(args, context = {}) {
  return defaultRunner.run(args, context);
}

if (process.argv[2] === '--worker' && process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let result;
  try { result = await executePhoneScript(JSON.parse(input)); }
  catch (error) { result = { isError: true, output: `Phone runtime cleanup failed: ${error.message}` }; }
  process.stdout.write(JSON.stringify(result));
}
