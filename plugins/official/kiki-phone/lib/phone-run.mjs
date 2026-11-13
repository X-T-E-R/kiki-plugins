import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { formatWithOptions, promisify } from 'node:util';
import { findAdb, phoneDataDir } from './environment.mjs';
import { mobilecliBinary, runtimeInstalled, upstreamEnvironment } from './prepare.mjs';
import { nodeExecutable } from './node-executable.mjs';

const defaultExecuteAdb = promisify(execFile);
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

export function attachPhoneConvenienceApis(device, screen, { platform, serial, adbBinary, signal, executeAdb = defaultExecuteAdb, delay = defaultDelay } = {}) {
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
  if (screen && typeof screen.swipe === 'function' && !screen.swipe.__kikiTuplePatched) {
    const originalSwipe = screen.swipe.bind(screen);
    const wrappedSwipe = async (directionOrX1, optsOrY1, x2, y2, duration) => {
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
      return originalSwipe(directionOrX1, optsOrY1);
    };
    wrappedSwipe.__kikiTuplePatched = true;
    screen.swipe = wrappedSwipe;
  }
  if (platform !== 'android') {
    const unsupported = (method) => async () => { throw new Error(`${method} is currently supported on Android devices only.`); };
    if (typeof device.screenState !== 'function') device.screenState = unsupported('device.screenState()');
    if (typeof device.wake !== 'function') device.wake = unsupported('device.wake()');
    if (typeof device.unlock !== 'function') device.unlock = unsupported('device.unlock()');
    if (typeof device.sleep !== 'function') device.sleep = unsupported('device.sleep()');
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
}

export async function executePhoneScript({ script, device: requested, platform = 'android' }, context = {}, support = {}) {
  const dataDir = support.dataDir || phoneDataDir();
  const output = [];
  let device;
  let driver;
  const environmentKeys = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'MOBILEMCP_DISABLE_TELEMETRY', 'npm_config_ignore_scripts', 'npm_config_cache'];
  const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    if (!support.sdk && !(await runtimeInstalled(dataDir))) throw new Error('Run phone_prepare first to install the fixed Mobilewright runtime.');
    context.signal?.throwIfAborted();
    const adbBinary = context.settings?.adbPath || process.env.KIKI_PHONE_ADB_PATH || await findAdb({ dataDir });
    Object.assign(process.env, upstreamEnvironment(adbBinary, process.env, dataDir));
    const modules = path.join(dataDir, 'runtime/node_modules');
    const sdk = support.sdk || await import(pathToFileURL(path.join(modules, 'mobilewright/dist/index.js')));
    const { MobilecliDriver } = support.driverModule || await import(pathToFileURL(path.join(modules, '@mobilewright/driver-mobilecli/dist/index.js')));
    driver = new MobilecliDriver({ mobilecliPath: await mobilecliBinary(dataDir) });
    const devices = (await driver.listDevices({ platform })).filter(item => item.state === 'online');
    let saved;
    try { saved = JSON.parse(await readFile(path.join(dataDir, 'selected-device.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const selected = requested || (saved?.platform === platform ? saved.id : undefined) || (devices.length === 1 ? devices[0].id : undefined);
    if (!selected || !devices.some(item => item.id === selected)) {
      const message = selected ? `Selected device ${selected} is not online. Inspect the device list; pass device explicitly to choose another phone.`
        : devices.length ? 'Choose one device id and pass device to phone_run.' : 'No online device. Run phone_prepare to inspect Android connection state.';
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
    output.unshift({ type: 'text', text: `Phone script failed: ${error.message || String(error)}. Observe before repeating any action whose result is unclear.` });
    return { isError: true, output };
  } finally {
    try { if (device) await device.close(); else await driver?.dispose(); }
    finally {
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
