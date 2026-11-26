import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BilibiliError } from './errors.mjs';
import { resolveProfileHome, resolveProfileRegistry } from './profiles.mjs';
import { BEFORE_SEND_CODES, callWarmDaemon, closeAllDaemons, getActiveDaemonPids, resolveDaemonPython, terminateChild } from './daemon.mjs';

export const CLI_VERSION = '1.0.0';
export { closeAllDaemons, getActiveDaemonPids };

export function validateTimeout(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 2147483647) {
    throw new BilibiliError('CONFIGURATION', 'timeoutMs must be a whole number from 1000 to 2147483647 milliseconds.');
  }
  return value;
}

export function createCli({ settings = {}, workspaceRoot, signal, spawnImpl } = {}) {
  resolveProfileRegistry(settings);
  const executable = String(settings.biliCliPath || 'bili');
  const ffmpegDir = String(settings.ffmpegDir || '').trim();
  const defaultTimeoutMs = validateTimeout(settings.timeoutMs === undefined ? 600000 : settings.timeoutMs);
  const customSpawn = spawnImpl !== undefined && spawnImpl !== spawn;
  const effectiveSpawn = spawnImpl ?? spawn;
  const daemonPython = !customSpawn && settings.useDaemon !== false ? resolveDaemonPython(executable) : null;

  return async function call(args, { write = false, timeoutMs = defaultTimeoutMs, profile } = {}) {
    validateTimeout(timeoutMs);
    const { home } = resolveProfileHome(settings, profile);
    if (signal?.aborted) throw new BilibiliError('LOCAL_ABORTED', 'Cancelled before starting bili.');

    if (daemonPython) {
      return callWarmDaemon({
        pythonPath: daemonPython,
        profileHome: home,
        ffmpegDir,
        cliVersion: CLI_VERSION,
        args,
        workspaceRoot,
        write,
        timeoutMs,
        signal,
      });
    }

    return new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let child, timer, stdout = '', started = false, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const uncertain = (code, message) => new BilibiliError(code, message, { submission: write && started ? 'unknown' : 'not_sent' });
      const abort = () => { terminateChild(child); finish(uncertain('LOCAL_ABORTED', 'Local wait cancelled. Inspect the platform before repeating an unknown write.')); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        child = effectiveSpawn(executable, ['--compact', ...args], {
          shell: false,
          windowsHide: true,
          cwd: workspaceRoot,
          env: {
            ...process.env,
            BILI_CLI_HOME: home,
            BILI_CLI_NO_RATE_LIMIT: '1',
            PYTHONUTF8: '1',
            PATH: ffmpegDir ? `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(new BilibiliError('DEPENDENCY_MISSING', `Cannot start bili: ${error.message}`));
        return;
      }
      child.once('spawn', () => { started = true; });
      timer = setTimeout(() => { terminateChild(child); finish(uncertain('TIMEOUT', 'bili timed out. An unknown write must not be retried automatically.')); }, timeoutMs);
      child.stdout.on('data', (bytes) => {
        stdout += decoder.write(bytes);
        if (stdout.length > 32 * 1024 * 1024) { terminateChild(child); finish(uncertain('OUTPUT_LIMIT', 'bili output exceeded 32 MiB.')); }
      });
      child.stderr.resume?.();
      child.once('error', (error) => finish(error.code === 'ENOENT'
        ? new BilibiliError('DEPENDENCY_MISSING', `Install bili-agent==${CLI_VERSION} in an isolated environment and set biliCliPath.`)
        : uncertain('CLI_ERROR', error.message)));
      child.once('close', (code) => {
        if (settled) return;
        let envelope;
        try {
          envelope = JSON.parse(stdout + decoder.end());
          if (!envelope || typeof envelope.ok !== 'boolean' || (envelope.ok && (envelope.data === undefined || envelope.data === null))) throw new Error('Invalid envelope');
        } catch {
          return finish(uncertain('CLI_RESPONSE_INVALID', `bili exited ${code} without a JSON receipt.${write ? ' Check the platform before sending again.' : ''}`));
        }
        if (code !== 0 || envelope.ok !== true) {
          const error = envelope.error || {};
          return finish(new BilibiliError(error.code || 'CLI_ERROR', error.message || `bili exited ${code}`, {
            submission: write && !BEFORE_SEND_CODES.has(error.code) ? 'unknown' : 'not_sent',
            suggestion: error.hint,
            detail: error.detail,
          }));
        }
        finish(undefined, envelope.data);
      });
    });
  };
}
