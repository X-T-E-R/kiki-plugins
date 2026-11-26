import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { formatWithOptions } from 'node:util';
import { findAdb, phoneDataDir } from './environment.mjs';
import { execAdb } from './adb.mjs';
import { mobilecliBinary, runtimeInstalled, upstreamEnvironment } from './prepare.mjs';
import {
  DEFAULT_MOBILECLI_PORT,
  DEFAULT_MOBILECLI_URL,
  ensureMobilecliRuntimePatched,
  ensureMobilecliServer,
} from './mobilecli-server.mjs';
import { nodeExecutable } from './node-executable.mjs';
import { isHyperOsBottomEdgeZone } from './scrcpy-stream.mjs';
import { createRemoteLeaseStore } from './remote-lease.mjs';
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

export const WARM_WORKER_IDLE_TTL_MS = 5 * 60_000;
export const phoneLeaseStore = createRemoteLeaseStore();

const defaultExecuteAdb = execAdb;
const locatorTapHooks = new WeakMap();
const defaultDelay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

function isInjectEventsError(err) {
  return /INJECT_EVENTS|SecurityException|Injecting to another application/i.test(
    String(err?.message || err?.stderr || err || ''),
  );
}

function killWorkerProcessTree(proc, platform = process.platform) {
  if (!proc) return;
  if (platform === 'win32' && proc.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {}
  }
  try { proc.kill('SIGKILL'); } catch {
    try { proc.kill(); } catch {}
  }
}

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
  let injectBlocked = false;
  const TRANSITION_SETTLE_MS = 950;
  const isRawInput = (opts) => Boolean(opts?.raw) || /^(1|true|yes)$/i.test(String(env?.KIKI_PHONE_RAW_INPUT ?? ''));
  const isForceAdbRaw = (opts) => platform === 'android' && opts?.transport === 'raw';
  const rawScreenTap = typeof screen?.tap === 'function' ? screen.tap.bind(screen) : undefined;
  const rawOriginalSwipe = typeof screen?.swipe === 'function' ? screen.swipe.bind(screen) : undefined;
  const rawScreenGesture = typeof screen?.gesture === 'function' ? screen.gesture.bind(screen) : undefined;

  const adbTapFallback = async (x, y, holdMs = 0) => {
    const rx = String(Math.round(x));
    const ry = String(Math.round(y));
    const args = holdMs >= 50
      ? ['-s', serial, 'shell', 'input', 'swipe', rx, ry, rx, ry, String(Math.round(holdMs))]
      : ['-s', serial, 'shell', 'input', 'tap', rx, ry];
    await executeAdb(adbBinary || 'adb', args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, signal });
  };

  const adbSwipeFallback = async (x1, y1, x2, y2, durationMs) => {
    const args = [
      '-s', serial, 'shell', 'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
    ];
    if (typeof durationMs === 'number' && durationMs > 0) {
      args.push(String(Math.round(durationMs)));
    }
    await executeAdb(adbBinary || 'adb', args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, signal });
  };

  const shouldUseBottomEdgeAdb = (y, screenHeight, opts) =>
    platform === 'android' && Boolean(serial) && (
      isForceAdbRaw(opts)
      || injectBlocked
      || isHyperOsBottomEdgeZone(y, screenHeight)
    );

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

  const rawSwipe = async (directionOrX1, optsOrY1, x2, y2, duration, extraOpts) => {
    if (typeof directionOrX1 === 'number' && typeof optsOrY1 === 'number' && typeof x2 === 'number' && typeof y2 === 'number') {
      const { height } = await resolveScreenDimensions(extraOpts);
      if (shouldUseBottomEdgeAdb(optsOrY1, height, extraOpts) || shouldUseBottomEdgeAdb(y2, height, extraOpts)) {
        await adbSwipeFallback(directionOrX1, optsOrY1, x2, y2, duration);
        return;
      }
      if (typeof device?.driver?.call === 'function') {
        try {
          return await device.driver.call('device.io.swipe', {
            x1: Math.round(directionOrX1),
            y1: Math.round(optsOrY1),
            x2: Math.round(x2),
            y2: Math.round(y2),
            ...(typeof duration === 'number' ? { duration: Math.round(duration) } : {}),
          });
        } catch (err) {
          if (platform === 'android' && serial && isInjectEventsError(err)) {
            injectBlocked = true;
            await adbSwipeFallback(directionOrX1, optsOrY1, x2, y2, duration);
            return;
          }
          throw err;
        }
      }
      if (platform === 'android') {
        await adbSwipeFallback(directionOrX1, optsOrY1, x2, y2, duration);
        return;
      }
    }
    if (rawOriginalSwipe) {
      if (optsOrY1 && typeof optsOrY1 === 'object' && ('raw' in optsOrY1 || 'transport' in optsOrY1)) {
        const { raw: _raw, transport: _transport, ...cleanOpts } = optsOrY1;
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

      if (shouldUseBottomEdgeAdb(tap.y, height, opts)) {
        await adbTapFallback(tap.x, tap.y, opts?.transport === 'raw' ? 0 : tap.holdMs);
        return { x: tap.x, y: tap.y, holdMs: tap.holdMs, channel: 'adb_input_fallback' };
      }

      if (rawScreenGesture) {
        await waitPostTransitionSettle();
        try {
          await rawScreenGesture({ pointers: [tap.points] });
        } catch (err) {
          if (platform === 'android' && serial && isInjectEventsError(err)) {
            injectBlocked = true;
            await adbTapFallback(tap.x, tap.y, tap.holdMs);
            return { x: tap.x, y: tap.y, holdMs: tap.holdMs, channel: 'adb_input_fallback' };
          }
          throw err;
        }
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
      let screenDims;
      if (typeof directionOrX1 === 'string') {
        opts = (optsOrY1 && typeof optsOrY1 === 'object') ? optsOrY1 : (typeof optsOrY1 === 'number' ? { durationMs: optsOrY1 } : {});
        const localRng = opts.rng ?? rng;
        screenDims = await resolveScreenDimensions(opts);
        const endpoints = resolveDirectionEndpoints(directionOrX1, {
          width: screenDims.width,
          height: screenDims.height,
          startX: opts.startX,
          startY: opts.startY,
          distance: opts.distance,
          distanceRatio: opts.distanceRatio,
          rng: localRng,
        });
        swipe = buildHumanSwipeKeyframes(endpoints.x1, endpoints.y1, endpoints.x2, endpoints.y2, {
          durationMs: opts.durationMs ?? opts.duration, jitterPx: opts.jitterPx, screenWidth: screenDims.width, screenHeight: screenDims.height, rng: localRng,
        });
      } else if (typeof directionOrX1 === 'number' && typeof optsOrY1 === 'number' && typeof x2 === 'number' && typeof y2 === 'number') {
        opts = typeof durationOrOpts === 'number' ? { ...(maybeOpts ?? {}), durationMs: durationOrOpts } : (durationOrOpts ?? {});
        const localRng = opts.rng ?? rng;
        screenDims = await resolveScreenDimensions(opts);
        swipe = buildHumanSwipeKeyframes(directionOrX1, optsOrY1, x2, y2, {
          durationMs: opts.durationMs ?? opts.duration, jitterPx: opts.jitterPx, screenWidth: screenDims.width, screenHeight: screenDims.height, rng: localRng,
        });
      } else {
        throw new TypeError('screen.humanSwipe expects (direction, opts?) or (x1, y1, x2, y2, durationOrOpts?).');
      }
      signal?.throwIfAborted();

      if (shouldUseBottomEdgeAdb(swipe.y1, screenDims.height, opts) || shouldUseBottomEdgeAdb(swipe.y2, screenDims.height, opts)) {
        await adbSwipeFallback(swipe.x1, swipe.y1, swipe.x2, swipe.y2, swipe.durationMs);
        return {
          x1: swipe.x1,
          y1: swipe.y1,
          x2: swipe.x2,
          y2: swipe.y2,
          durationMs: swipe.durationMs,
          steps: swipe.points.length - 1,
          channel: 'adb_input_fallback',
        };
      }

      if (rawScreenGesture) {
        await waitPostTransitionSettle();
        try {
          await rawScreenGesture({ pointers: [swipe.points] });
        } catch (err) {
          if (platform === 'android' && serial && isInjectEventsError(err)) {
            injectBlocked = true;
            await adbSwipeFallback(swipe.x1, swipe.y1, swipe.x2, swipe.y2, swipe.durationMs);
            return {
              x1: swipe.x1,
              y1: swipe.y1,
              x2: swipe.x2,
              y2: swipe.y2,
              durationMs: swipe.durationMs,
              steps: swipe.points.length - 1,
              channel: 'adb_input_fallback',
            };
          }
          throw err;
        }
      } else if (rawOriginalSwipe || typeof device?.driver?.call === 'function') {
        await rawSwipe(swipe.x1, swipe.y1, swipe.x2, swipe.y2, swipe.durationMs, opts);
      } else if (platform === 'android') {
        await adbSwipeFallback(swipe.x1, swipe.y1, swipe.x2, swipe.y2, swipe.durationMs);
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
      if (isForceAdbRaw(opts)) {
        await adbTapFallback(x, y, 0);
        return { x: Math.round(x), y: Math.round(y), channel: 'adb_input_fallback' };
      }
      if (!rawScreenGesture || isRawInput(opts)) {
        const { height } = await resolveScreenDimensions(opts);
        if (shouldUseBottomEdgeAdb(y, height, opts)) {
          await adbTapFallback(x, y, 0);
          return { x: Math.round(x), y: Math.round(y), channel: 'adb_input_fallback' };
        }
        try {
          return await rawScreenTap(x, y);
        } catch (err) {
          if (platform === 'android' && serial && isInjectEventsError(err)) {
            injectBlocked = true;
            await adbTapFallback(x, y, 0);
            return { x: Math.round(x), y: Math.round(y), channel: 'adb_input_fallback' };
          }
          throw err;
        }
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
        if (isForceAdbRaw(opts) || !rawScreenGesture || isRawInput(opts)) {
          return rawSwipe(directionOrX1, optsOrY1, x2, y2, durationVal, opts);
        }
        return screen.humanSwipe(directionOrX1, optsOrY1, x2, y2, durationVal, opts);
      }
      const opts = (optsOrY1 && typeof optsOrY1 === 'object') ? optsOrY1 : undefined;
      if (isForceAdbRaw(opts)) {
        const dims = await resolveScreenDimensions(opts);
        const ep = resolveDirectionEndpoints(directionOrX1, { width: dims.width, height: dims.height, rng });
        await adbSwipeFallback(ep.x1, ep.y1, ep.x2, ep.y2, opts?.durationMs ?? opts?.duration ?? 260);
        return;
      }
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

export async function executePhoneScript({
  script,
  deviceId,
  device: requested,
  platform = 'android',
  overrideHumanTakeover = false,
} = {}, context = {}, support = {}) {
  const dataDir = support.dataDir || phoneDataDir();
  const output = [];
  let device;
  let driver;
  let startedServer;
  const warmState = support.warmState || null;
  const environmentKeys = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'MOBILEMCP_DISABLE_TELEMETRY', 'npm_config_ignore_scripts', 'npm_config_cache'];
  const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    if (!support.sdk && !warmState?.runtimeVerified && !(await runtimeInstalled(dataDir))) {
      throw new Error('Mobilewright runtime missing. Run phone_prepare first.');
    }
    if (warmState) warmState.runtimeVerified = true;
    context.signal?.throwIfAborted();

    const adbBinary = context.settings?.adbPath || process.env.KIKI_PHONE_ADB_PATH || warmState?.adbBinary || await findAdb({ dataDir });
    if (warmState && adbBinary) warmState.adbBinary = adbBinary;
    Object.assign(process.env, upstreamEnvironment(adbBinary, process.env, dataDir));

    const modules = path.join(dataDir, 'runtime/node_modules');
    if (!support.driverModule && !warmState?.runtimePatched) {
      await ensureMobilecliRuntimePatched(dataDir).catch(() => {});
      if (warmState) warmState.runtimePatched = true;
    }

    const sdk = support.sdk || warmState?.sdk || await import(pathToFileURL(path.join(modules, 'mobilewright/dist/index.js')));
    const driverMod = support.driverModule || warmState?.driverMod || await import(pathToFileURL(path.join(modules, '@mobilewright/driver-mobilecli/dist/index.js')));
    if (warmState) {
      warmState.sdk = sdk;
      warmState.driverMod = driverMod;
    }
    const { MobilecliDriver } = driverMod;

    const cliPath = warmState?.cliPath || await mobilecliBinary(dataDir);
    const hasCliBinary = warmState?.hasCliBinary !== undefined
      ? warmState.hasCliBinary
      : await access(cliPath).then(() => true, () => false);
    if (warmState) {
      warmState.cliPath = cliPath;
      warmState.hasCliBinary = hasCliBinary;
    }

    const workerPort = Number(support.mobilecliPort) || DEFAULT_MOBILECLI_PORT;
    let serverUrl = warmState?.serverUrl || `ws://localhost:${workerPort}/ws`;
    if (!support.driverModule && !support.sdk && script && hasCliBinary && !warmState?.serverReady) {
      const ensured = await ensureMobilecliServer({
        binaryPath: cliPath,
        port: workerPort,
        env: process.env,
      });
      serverUrl = ensured.url;
      if (warmState) {
        warmState.serverUrl = serverUrl;
        warmState.serverReady = true;
        if (ensured.started) warmState.startedServer = ensured.serverProcess;
      } else if (ensured.started) {
        startedServer = ensured.serverProcess;
      }
    }

    driver = warmState?.driver || new MobilecliDriver({ mobilecliPath: cliPath, autoStart: false, url: serverUrl });
    if (warmState) warmState.driver = driver;

    const explicitTarget = deviceId || requested;
    let devices = null;
    let selected = explicitTarget;

    if (!selected || !script || !warmState?.connectedDevices?.has(`${platform}:${selected}`)) {
      devices = (await driver.listDevices({ platform })).filter(item => item.state === 'online');
      let saved;
      if (!explicitTarget) {
        try { saved = JSON.parse(await readFile(path.join(dataDir, 'selected-device.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      selected = explicitTarget || (saved?.platform === platform ? saved.id : undefined) || (devices.length === 1 ? devices[0].id : undefined);
      if (!selected || !devices.some(item => item.id === selected)) {
        const message = selected
          ? `Selected device ${selected} is not online. Run android_connection({ action: "devices" }) to check USB/wireless state, or pass an online device id to phone_run.`
          : devices.length
            ? 'Multiple phones online. Choose one device id from devices[] and pass deviceId or device to phone_run.'
            : 'No online device. Run android_connection({ action: "devices" }) or phone_prepare to check USB/wireless debugging.';
        return { isError: Boolean(script || explicitTarget), output: JSON.stringify({ message, devices, selected, platform }) };
      }
      // Non-destructive deviceId: NEVER overwrite selected-device.json when deviceId was explicitly supplied!
      if (!deviceId) {
        await writeFile(path.join(dataDir, 'selected-device.json'), JSON.stringify({ platform, id: selected }) + '\n');
      }
    }

    if (support.leaseStore) {
      const gate = support.leaseStore.checkAgentAllowed(selected, { overrideHumanTakeover });
      if (!gate.allowed) {
        return { isError: true, output: JSON.stringify(gate) };
      }
    }

    if (!script) return { output: JSON.stringify({ devices, selected, platform }) };

    const devCacheKey = `${platform}:${selected}`;
    if (warmState) {
      if (!warmState.connectedDevices) warmState.connectedDevices = new Map();
      device = warmState.connectedDevices.get(devCacheKey);
      if (!device) {
        device = await sdk.connectDevice({ platform, deviceId: selected, driver });
        warmState.connectedDevices.set(devCacheKey, device);
      }
    } else {
      device = await sdk.connectDevice({ platform, deviceId: selected, driver });
    }

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
    if (warmState && selectedKeyFromArgs({ deviceId, requested, platform })) {
      const key = selectedKeyFromArgs({ deviceId, requested, platform });
      const cached = warmState.connectedDevices?.get(key);
      if (cached) {
        warmState.connectedDevices.delete(key);
        await cached.close?.().catch(() => {});
      }
    }
    output.unshift({ type: 'text', text: `Phone script failed: ${error.message || String(error)}. Re-observe via snapshot() or screenshot() before retrying any modifying action.` });
    return { isError: true, output };
  } finally {
    try {
      if (!warmState) {
        if (device) await device.close();
        else await driver?.dispose();
      }
    } finally {
      if (!warmState && startedServer) await startedServer.kill().catch(() => {});
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
}

function selectedKeyFromArgs({ deviceId, requested, platform }) {
  const id = deviceId || requested;
  return id ? `${platform || 'android'}:${id}` : '';
}

export function createPhoneScriptRunner({
  executeFile: customExecuteFile,
  spawnWorker = spawn,
  resolveNode = nodeExecutable,
  dataDir,
  leaseStore = phoneLeaseStore,
  idleTtlMs = WARM_WORKER_IDLE_TTL_MS,
  basePort = DEFAULT_MOBILECLI_PORT + 10,
} = {}) {
  const runningBySerial = new Map();
  const warmWorkers = new Map();
  const serialPortSlots = new Map();
  let nextSlotOffset = 0;
  let reqSeq = 0;
  const lifetime = new AbortController();

  function allocateSlotPort(serialKey) {
    if (serialKey === '__default__') return DEFAULT_MOBILECLI_PORT;
    if (!serialPortSlots.has(serialKey)) {
      serialPortSlots.set(serialKey, basePort + (nextSlotOffset++ % 48));
    }
    return serialPortSlots.get(serialKey);
  }

  function evictWarmWorker(poolKey, kill = true) {
    const entry = warmWorkers.get(poolKey);
    if (!entry) return;
    warmWorkers.delete(poolKey);
    clearTimeout(entry.idleTimer);
    if (kill) {
      killWorkerProcessTree(entry.proc);
    }
  }

  function touchWarmWorkerIdle(poolKey, entry) {
    clearTimeout(entry.idleTimer);
    if (idleTtlMs > 0) {
      entry.idleTimer = setTimeout(() => {
        evictWarmWorker(poolKey, true);
      }, idleTtlMs);
      entry.idleTimer.unref?.();
    }
  }

  async function acquireWarmWorker(poolKey, effectiveDataDir, serialKey, adbPath) {
    const existing = warmWorkers.get(poolKey);
    if (existing && existing.proc.connected && existing.proc.exitCode === null && !existing.proc.killed) {
      touchWarmWorkerIdle(poolKey, existing);
      return existing;
    }
    evictWarmWorker(poolKey, true);

    const node = await resolveNode();
    const port = allocateSlotPort(serialKey);
    const workerEnv = { ...process.env };
    if (effectiveDataDir) workerEnv.KIKI_PHONE_DATA_DIR = effectiveDataDir;
    if (adbPath) workerEnv.KIKI_PHONE_ADB_PATH = adbPath;

    const proc = spawnWorker(
      node,
      [fileURLToPath(import.meta.url), '--warm-worker', '--port', String(port)],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
        env: workerEnv,
      },
    );

    let stderrTail = '';
    proc.stderr?.on('data', (c) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-2048);
    });
    proc.stderr?.unref?.();

    const entry = {
      poolKey,
      serialKey,
      port,
      proc,
      idleTimer: null,
      pending: null,
      getStderr: () => stderrTail,
    };

    proc.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (entry.pending && msg.id === entry.pending.id) {
        const current = entry.pending;
        entry.pending = null;
        current.resolve(msg.result);
      }
    });

    const onWorkerDead = (err) => {
      if (warmWorkers.get(poolKey) === entry) {
        warmWorkers.delete(poolKey);
      }
      clearTimeout(entry.idleTimer);
      if (entry.pending) {
        const current = entry.pending;
        entry.pending = null;
        current.reject(err || new Error(stderrTail.trim() || 'Phone worker exited unexpectedly'));
      }
    };
    proc.once('error', onWorkerDead);
    proc.once('exit', (code, sig) => onWorkerDead(new Error(stderrTail.trim() || `worker exited (${code ?? sig})`)));
    proc.once('disconnect', () => onWorkerDead(new Error(stderrTail.trim() || 'worker IPC disconnected')));

    proc.channel?.unref?.();
    proc.unref?.();
    warmWorkers.set(poolKey, entry);
    touchWarmWorkerIdle(poolKey, entry);
    return entry;
  }

  async function resolveEffectiveSerialKey(args = {}, effectiveDataDir) {
    const explicit = String(args?.deviceId || args?.device || '').trim();
    if (explicit) return explicit;
    if (!customExecuteFile && effectiveDataDir) {
      try {
        const saved = JSON.parse(await readFile(path.join(effectiveDataDir, 'selected-device.json'), 'utf8'));
        const platform = args?.platform || 'android';
        if (saved?.id && (!saved.platform || saved.platform === platform)) {
          return String(saved.id);
        }
      } catch {}
    }
    return '__default__';
  }

  return {
    async run(args = {}, context = {}) {
      const effectiveDataDir = dataDir || context.dataDir || (!customExecuteFile ? phoneDataDir() : undefined);
      const syncSerialKey = String(args?.deviceId || args?.device || '').trim() || '__default__';

      if (runningBySerial.has(syncSerialKey)) {
        const targetLabel = syncSerialKey === '__default__' ? 'the phone' : `device ${syncSerialKey}`;
        return {
          isError: true,
          output: `A phone script is already running on ${targetLabel}. Wait for it to finish or pass deviceId for a different phone.`,
        };
      }

      const claimedKeys = new Set([syncSerialKey]);
      let releaseReservation;
      const reservation = new Promise((resolve) => { releaseReservation = resolve; });
      runningBySerial.set(syncSerialKey, reservation);

      let abortOp = { signal: null, cleanup() {} };
      try {
        if (leaseStore && effectiveDataDir && !customExecuteFile) {
          await leaseStore.ensureLoaded(effectiveDataDir);
        }

        const serialKey = (syncSerialKey === '__default__' && !customExecuteFile)
          ? await resolveEffectiveSerialKey(args, effectiveDataDir)
          : syncSerialKey;

        if (serialKey !== syncSerialKey) {
          if (runningBySerial.has(serialKey)) {
            return {
              isError: true,
              output: `A phone script is already running on device ${serialKey}. Wait for it to finish or pass deviceId for a different phone.`,
            };
          }
          claimedKeys.add(serialKey);
          runningBySerial.set(serialKey, reservation);
        }

        if (serialKey !== '__default__' && leaseStore) {
          const gate = leaseStore.checkAgentAllowed(serialKey, {
            overrideHumanTakeover: Boolean(args?.overrideHumanTakeover),
          });
          if (!gate.allowed) {
            return { isError: true, output: JSON.stringify(gate) };
          }
        }

        const baseSignal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
        if (baseSignal.aborted) {
          return {
            isError: true,
            output: 'Phone script interrupted or failed: Aborted. Observe before repeating an action; completed actions are not rolled back.',
          };
        }

        abortOp = (serialKey !== '__default__' && leaseStore)
          ? leaseStore.registerAbortableOp(serialKey, baseSignal, { overrideHumanTakeover: Boolean(args?.overrideHumanTakeover) })
          : { signal: baseSignal, cleanup() {} };
        const signal = abortOp.signal;

        // Legacy injected executeFile path (used by deterministic unit fixtures)
        if (customExecuteFile) {
          const node = await resolveNode();
          return await new Promise((resolve) => {
            const workerEnv = { ...process.env };
            if (dataDir) workerEnv.KIKI_PHONE_DATA_DIR = dataDir;
            if (context.settings?.adbPath) workerEnv.KIKI_PHONE_ADB_PATH = context.settings.adbPath;
            const child = customExecuteFile(node, [fileURLToPath(import.meta.url), '--worker'], {
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
        }

        // Warm per-serial IPC worker pool path (<80ms warm execution)
        const poolKey = `${effectiveDataDir || ''}::${serialKey}`;
        const worker = await acquireWarmWorker(poolKey, effectiveDataDir, serialKey, context.settings?.adbPath);
        const id = ++reqSeq;
        const timeoutMs = Math.max(1_000, Number(args.timeoutMs) || 90_000);

        return await new Promise((resolve) => {
          let settled = false;
          const finish = (val, killWorker = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            worker.pending = null;
            worker.proc.channel?.unref?.();
            worker.proc.unref?.();
            if (killWorker) {
              evictWarmWorker(poolKey, true);
            } else {
              touchWarmWorkerIdle(poolKey, worker);
            }
            resolve(val);
          };

          const onAbort = () => {
            const reason = signal.reason;
            if (reason && reason.code === 'human_takeover_active') {
              finish({
                isError: true,
                output: JSON.stringify({
                  ok: false,
                  code: 'human_takeover_active',
                  error_code: 'human_takeover_active',
                  targetKey: serialKey,
                  message: reason.message || `Human takeover engaged on ${serialKey}`,
                }),
              }, true);
              return;
            }
            finish({
              isError: true,
              output: `Phone script interrupted or failed: ${reason?.message || 'Aborted'}. Observe before repeating an action; completed actions are not rolled back.`,
            }, true);
          };

          const timer = setTimeout(() => {
            finish({
              isError: true,
              output: `Phone script interrupted or failed: Timed out after ${timeoutMs}ms. Observe before repeating an action; completed actions are not rolled back.`,
            }, true);
          }, timeoutMs);
          timer.unref?.();

          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });

          worker.pending = {
            id,
            resolve: (res) => finish(res, false),
            reject: (err) => finish({
              isError: true,
              output: `Phone script interrupted or failed: ${err.message || String(err)}. Observe before repeating an action; completed actions are not rolled back.`,
            }, true),
          };

          worker.proc.channel?.ref?.();
          try {
            worker.proc.send({
              id,
              args,
              dataDir: effectiveDataDir,
              adbPath: context.settings?.adbPath,
            });
          } catch (err) {
            finish({
              isError: true,
              output: `Phone script interrupted or failed: ${err.message || String(err)}. Observe before repeating an action; completed actions are not rolled back.`,
            }, true);
          }
        });
      } catch (error) {
        return { isError: true, output: error.message };
      } finally {
        for (const k of claimedKeys) {
          if (runningBySerial.get(k) === reservation) {
            runningBySerial.delete(k);
          }
        }
        abortOp.cleanup();
        releaseReservation();
      }
    },
    async close() {
      lifetime.abort(new Error('Phone script runner disposed'));
      for (const key of [...warmWorkers.keys()]) {
        evictWarmWorker(key, true);
      }
      await Promise.allSettled([...runningBySerial.values()]);
    },
  };
}

const defaultRunner = createPhoneScriptRunner();
export function runPhoneScript(args, context = {}) {
  return defaultRunner.run(args, context);
}

export async function disposeDefaultPhoneRunner() {
  for (const fn of [...warmCleanupCallbacks]) {
    try { await fn(); } catch {}
  }
}

const warmCleanupCallbacks = new Set();
warmCleanupCallbacks.add(() => defaultRunner.close());

if (process.argv[2] === '--worker' && process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let result;
  try { result = await executePhoneScript(JSON.parse(input)); }
  catch (error) { result = { isError: true, output: `Phone runtime cleanup failed: ${error.message}` }; }
  process.stdout.write(JSON.stringify(result));
} else if (process.argv[2] === '--warm-worker' && process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIdx = process.argv.indexOf('--port');
  const slotPort = portIdx !== -1 ? Number(process.argv[portIdx + 1]) || DEFAULT_MOBILECLI_PORT : DEFAULT_MOBILECLI_PORT;
  const warmState = {
    sdk: null,
    driverMod: null,
    driver: null,
    connectedDevices: new Map(),
    startedServer: null,
    serverReady: false,
    serverUrl: `ws://localhost:${slotPort}/ws`,
    runtimeVerified: false,
    runtimePatched: false,
    cliPath: null,
    hasCliBinary: undefined,
    adbBinary: null,
  };

  let shuttingDown = false;
  const shutdownWarmWorker = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const dev of warmState.connectedDevices.values()) {
      await dev.close?.().catch(() => {});
    }
    warmState.connectedDevices.clear();
    await warmState.driver?.dispose?.().catch(() => {});
    if (warmState.startedServer) {
      await warmState.startedServer.kill().catch(() => {});
    }
    process.exit(0);
  };

  let idleExitTimer = setTimeout(shutdownWarmWorker, WARM_WORKER_IDLE_TTL_MS);
  idleExitTimer.unref?.();

  process.on('disconnect', () => { void shutdownWarmWorker(); });
  process.on('SIGTERM', () => { void shutdownWarmWorker(); });
  process.on('SIGINT', () => { void shutdownWarmWorker(); });

  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    clearTimeout(idleExitTimer);
    idleExitTimer = setTimeout(shutdownWarmWorker, WARM_WORKER_IDLE_TTL_MS);
    idleExitTimer.unref?.();

    let result;
    try {
      result = await executePhoneScript(
        msg.args || {},
        { settings: msg.adbPath ? { adbPath: msg.adbPath } : {} },
        {
          dataDir: msg.dataDir || process.env.KIKI_PHONE_DATA_DIR,
          mobilecliPort: slotPort,
          warmState,
        },
      );
    } catch (error) {
      result = { isError: true, output: `Phone runtime cleanup failed: ${error.message}` };
    }
    if (process.connected) {
      try { process.send({ id: msg.id, result }); } catch {}
    }
  });
}
