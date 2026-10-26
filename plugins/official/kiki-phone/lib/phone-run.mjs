import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { formatWithOptions } from 'node:util';
import { findAdb, phoneDataDir } from './environment.mjs';
import { mobilecliBinary, runtimeInstalled, upstreamEnvironment } from './prepare.mjs';
import { nodeExecutable } from './node-executable.mjs';

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
    Object.assign(process.env, upstreamEnvironment(await findAdb({ dataDir }), process.env, dataDir));
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
    const log = (...values) => output.push({ type: 'text', text: formatWithOptions({ depth: null, maxArrayLength: null, maxStringLength: null, colors: false }, ...values) });
    const snapshot = async () => screen.viewTree();
    const screenshot = async (options = {}) => {
      const bytes = await screen.screenshot({ ...options, format: 'png' });
      output.push({ type: 'image_url', imageUrl: { url: `data:image/png;base64,${bytes.toString('base64')}` } });
      return { bytes: bytes.length, mimeType: 'image/png' };
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

let running = false;
export async function runPhoneScript(args, context = {}) {
  if (running) return { isError: true, output: 'A phone script is already running. Wait for it to finish before operating the phone.' };
  running = true;
  try {
    const node = await nodeExecutable();
    return await new Promise((resolve) => {
      const child = execFile(node, [fileURLToPath(import.meta.url), '--worker'], {
        signal: context.signal, timeout: args.timeoutMs || 90_000, maxBuffer: 24 * 1024 * 1024,
        encoding: 'utf8', windowsHide: true,
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
  } finally { running = false; }
}

if (process.argv[2] === '--worker' && process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let result;
  try { result = await executePhoneScript(JSON.parse(input)); }
  catch (error) { result = { isError: true, output: `Phone runtime cleanup failed: ${error.message}` }; }
  process.stdout.write(JSON.stringify(result));
}
