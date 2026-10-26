import { access, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function phoneDataDir(env = process.env, platform = process.platform) {
  if (env.KIKI_PHONE_DATA_DIR) return path.resolve(env.KIKI_PHONE_DATA_DIR);
  const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
    : platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support')
      : env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(base, 'kiki-phone');
}

export async function findAdb({ adbPath, dataDir = phoneDataDir(), env = process.env, platform = process.platform } = {}) {
  if (adbPath) return path.resolve(adbPath);
  const executable = platform === 'win32' ? 'adb.exe' : 'adb';
  let saved;
  try { saved = JSON.parse(await readFile(path.join(dataDir, 'adb.json'), 'utf8')).adbPath; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const paths = [
    ...(adbPath ? [adbPath] : []), saved,
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools', executable),
    env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, 'platform-tools', executable),
    ...((env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, executable))),
    platform === 'win32' && path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk', 'platform-tools', executable),
    platform === 'darwin' && path.join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', executable),
    path.join(dataDir, 'sdk', 'platform-tools', executable),
  ].filter(Boolean);
  for (const candidate of paths) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); }
    catch (error) { if (adbPath && candidate === adbPath) throw new Error(`Configured ADB is unavailable: ${adbPath}`, { cause: error }); }
  }
  return undefined;
}

export async function saveAdb(adbPath, dataDir = phoneDataDir()) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'adb.json'), JSON.stringify({ adbPath }, null, 2) + '\n');
}

export function mobileEnvironment(adbPath, env = process.env) {
  if (!adbPath) return { ...env };
  const directory = path.dirname(adbPath);
  return {
    ...env,
    PATH: directory + path.delimiter + (env.PATH || env.Path || ''),
    ANDROID_HOME: path.dirname(directory),
    ANDROID_SDK_ROOT: path.dirname(directory),
  };
}
