import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { findAdb, phoneDataDir, saveAdb, mobileEnvironment } from './environment.mjs';

const exec = promisify(execFile);
export const PLATFORM_TOOLS_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
export const LICENSE_URL = 'https://developer.android.com/tools/releases/platform-tools';
export const pinnedPackages = ['@mobilenext/mobile-mcp@1.0.13', 'mobilecli@1.0.21', 'mobilewright@0.0.67'];

export async function runtimeInstalled(dataDir) {
  try {
    for (const [name, version] of [['@mobilenext/mobile-mcp', '1.0.13'], ['mobilecli', '1.0.21'], ['mobilewright', '0.0.67']]) {
      if (JSON.parse(await readFile(path.join(dataDir, 'runtime', 'node_modules', name, 'package.json'), 'utf8')).version !== version) return false;
    }
    return true;
  } catch { return false; }
}

export async function mobilecliBinary(dataDir) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const name = `mobilecli-${platform}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  return path.join(dataDir, 'runtime', 'node_modules', '@mobilenext', name, name + (process.platform === 'win32' ? '.exe' : ''));
}

export function npmCommand(args, env = process.env, platform = process.platform) {
  // Only fixed internal arguments are sent through the Windows command shim.
  return platform === 'win32'
    ? { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].join(' ')] }
    : { file: 'npm', args };
}

export function upstreamEnvironment(adbPath, env = process.env, dataDir = phoneDataDir(env)) {
  return { ...mobileEnvironment(adbPath, env), MOBILEMCP_DISABLE_TELEMETRY: '1', npm_config_ignore_scripts: 'true', npm_config_cache: path.join(dataDir, 'npm-cache') };
}

export function parseDevices(stdout) {
  return stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('List of devices') && !line.startsWith('*')).map(line => {
    const [serial, state, ...details] = line.trim().split(/\s+/);
    return { serial, state, details: details.join(' ') };
  });
}

export async function installOfficialTools({ consent, dataDir, execute = exec, fetchArchive = fetch }) {
  if (consent !== true) throw new Error(`Downloading Google platform-tools requires consent to ${LICENSE_URL}`);
  const staging = await mkdtemp(path.join(await mkdir(dataDir, { recursive: true }).then(() => dataDir), 'download-'));
  try {
    const response = await fetchArchive(PLATFORM_TOOLS_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Google platform-tools download returned HTTP ${response.status}`);
    const archive = path.join(staging, 'platform-tools.zip');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:KIKI_PHONE_ZIP -DestinationPath $env:KIKI_PHONE_EXTRACT'], {
      env: { ...process.env, KIKI_PHONE_ZIP: archive, KIKI_PHONE_EXTRACT: path.join(dataDir, 'sdk') }, windowsHide: true, timeout: 60_000,
    });
    return path.join(dataDir, 'sdk', 'platform-tools', 'adb.exe');
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function canonicalAdb(binary, dataDir) {
  if (path.basename(path.dirname(binary)).toLowerCase() === 'platform-tools') return binary;
  const target = path.join(dataDir, 'sdk', 'platform-tools');
  await mkdir(target, { recursive: true });
  await copyFile(binary, path.join(target, path.basename(binary)));
  for (const file of await readdir(path.dirname(binary))) {
    if (/\.dll$/i.test(file) || ['NOTICE.txt', 'source.properties'].includes(file)) await copyFile(path.join(path.dirname(binary), file), path.join(target, file));
  }
  return path.join(target, path.basename(binary));
}

export async function preparePhone({ download = false, adbPath, warmup = true, platform: targetPlatform = 'android' } = {}, {
  env = process.env, dataDir = phoneDataDir(env), platform = process.platform, nodeVersion = process.versions.node,
  execute = exec, install = installOfficialTools, signal,
} = {}) {
  const result = { status: 'checking', node: nodeVersion, dataDir, mcp: { connected: false, message: 'Preparation only; Kiki connects the MCP server when this plugin is enabled.' } };
  try {
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12.0+ is required. Install Node.js with npm, then rerun this script.');
    const options = { env, signal, encoding: 'utf8', windowsHide: true, timeout: 30_000 };
    const npm = npmCommand(['--version'], env, platform);
    result.npm = (await execute(npm.file, npm.args, options)).stdout.trim();
    let binary = targetPlatform === 'ios' ? undefined : await findAdb({ adbPath, dataDir, env, platform });
    if (targetPlatform !== 'ios') {
      if (!binary && !download) return { ...result, status: 'download_consent_required', download: { url: PLATFORM_TOOLS_URL, license: LICENSE_URL }, message: 'ADB was not found. Approve downloading Google platform-tools, set the plugin adbPath, or run the local setup script with --adb.' };
      if (!binary) {
        if (platform !== 'win32') throw new Error('Install official Android platform-tools for your OS, then rerun preparation. Automatic download currently supports Windows.');
        binary = await install({ consent: download, dataDir, execute });
      }
      const version = (await execute(binary, ['version'], options)).stdout.trim();
      if (!/^Android Debug Bridge version \d+\.\d+\.\d+(?:\r?\n|$)/.test(version)) throw new Error('Selected executable did not report an Android Debug Bridge version. Choose an official adb in plugin settings or with --adb in the local setup script.');
      binary = await canonicalAdb(binary, dataDir);
      await saveAdb(binary, dataDir);
      result.adb = { path: binary, version };
    }
    const sharedEnv = upstreamEnvironment(binary, env, dataDir);
    if (warmup && !(await runtimeInstalled(dataDir))) {
      const runtime = path.join(dataDir, 'runtime');
      await mkdir(runtime, { recursive: true });
      await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'kiki-phone-runtime', version: '0.1.0', private: true }));
      const upstream = npmCommand(['install', '--prefix', '.', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...pinnedPackages], sharedEnv, platform);
      await execute(upstream.file, upstream.args, { ...options, cwd: runtime, env: sharedEnv, timeout: 240_000 });
    }
    result.runtimeInstalled = await runtimeInstalled(dataDir);
    if (targetPlatform === 'ios') return { ...result, status: 'runtime_ready', message: 'Upstream packages are prepared. iOS UI use still requires a trusted device and a valid signed DeviceKit agent.' };
    const { stdout, stderr } = await execute(binary, ['devices', '-l'], { ...options, env: sharedEnv });
    result.devices = parseDevices(stdout);
    result.stdout = stdout;
    result.stderr = stderr;
    result.status = result.devices.some(device => device.state === 'device') ? 'transport_ready'
      : result.devices.some(device => device.state === 'unauthorized') ? 'authorization_required'
        : result.devices.some(device => device.state === 'offline') ? 'device_offline' : 'no_device';
    result.message = { transport_ready: 'ADB is ready. Enable Kiki Phone and select a device through Mobile MCP; UI readiness is checked there.', authorization_required: 'Unlock the phone and accept the USB debugging RSA prompt, then rerun preparation.', device_offline: 'The device is offline. Check the cable or wireless debugging connection, then rerun preparation.', no_device: 'Runtime preparation is complete. Connect a phone with USB debugging enabled, or pair/connect wireless debugging.' }[result.status];
    return result;
  } catch (error) {
    return { ...result, status: 'error', message: error.stderr?.trim() || error.message, code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
