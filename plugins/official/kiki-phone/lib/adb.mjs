import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findAdb } from './environment.mjs';

const executeFile = promisify(execFile);
const nonempty = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL characters.`);
  return value;
};
const target = (value, name) => {
  nonempty(value, name);
  if (value.startsWith('-')) throw new Error(`${name} must not start with '-'.`);
  return value;
};
// adb shell joins its arguments before invoking the device shell. Quote there,
// not in a local shell; su -c needs a second quoting level for its command.
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function adbArguments(name, args) {
  if (name === 'android_connection') {
    switch (args.action) {
      case 'devices': return ['devices', '-l'];
      case 'pair': return ['pair', target(args.address, 'address'), nonempty(args.code, 'code')];
      case 'connect': return ['connect', target(args.address, 'address')];
      case 'disconnect': return ['disconnect', target(args.address, 'address')];
      default: throw new Error('Choose devices, pair, connect or disconnect.');
    }
  }
  if (name === 'android_shell') {
    target(args.serial, 'serial');
    if (!Array.isArray(args.argv) || args.argv.length === 0 || args.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !args.argv[0]) {
      throw new Error('argv must contain a command followed by string arguments, without NUL characters.');
    }
    const command = args.argv.map(quote).join(' ');
    return ['-s', args.serial, 'shell', args.root ? `su -c ${quote(command)}` : command];
  }
  throw new Error(`Unknown phone tool: ${name}`);
}

export async function runAdb(name, args, context = {}, execute = executeFile) {
  try {
    const argv = adbArguments(name, args);
    const binary = context.settings?.adbPath || await findAdb() || 'adb';
    const { stdout, stderr } = await execute(binary, argv, {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024, signal: context.signal,
    });
    return { output: JSON.stringify({ exitCode: 0, stdout, stderr }) };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return {
      isError: true,
      output: JSON.stringify({
        exitCode: typeof error.code === 'number' ? error.code : null,
        code: typeof error.code === 'string' ? error.code : undefined,
        message: missing ? 'ADB executable not found. Install Android platform-tools and put adb on the Kiki process PATH, or set this plugin’s adbPath for connection/shell tools.'
          : error.killed || error.name === 'AbortError' ? 'ADB command interrupted; inspect device state before repeating a modifying command.'
            : error.stderr?.trim() || (typeof error.code === 'number' ? 'ADB command failed; inspect stdout and stderr.' : error.message),
        stdout: error.stdout ?? '', stderr: error.stderr ?? '',
      }),
    };
  }
}
