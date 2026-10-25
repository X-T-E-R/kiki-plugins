import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BilibiliError } from './errors.mjs';

export const CLI_VERSION = '1.0.0';
const beforeSend = new Set(['invalid_argument', 'not_logged_in', 'auth_expired', 'not_found', 'permission_denied', 'captcha_required', 'risk_control', 'rate_limited']);

function validateTimeout(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 2147483647) {
    throw new BilibiliError('CONFIGURATION', 'timeoutMs must be a whole number from 1000 to 2147483647 milliseconds.');
  }
  return value;
}

export function createCli({ settings = {}, workspaceRoot, signal, spawnImpl = spawn } = {}) {
  const home = String(settings.cliHome || '').trim();
  if (!home || !path.isAbsolute(home)) throw new BilibiliError('CONFIGURATION', 'Set cliHome to an explicit absolute bili-agent profile directory. No default home is read.');
  const executable = String(settings.biliCliPath || 'bili');
  const defaultTimeoutMs = validateTimeout(settings.timeoutMs === undefined ? 600000 : settings.timeoutMs);
  return async function call(args, { write = false, timeoutMs = defaultTimeoutMs } = {}) {
    validateTimeout(timeoutMs);
    if (signal?.aborted) throw new BilibiliError('LOCAL_ABORTED', 'Cancelled before starting bili.');
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
      const abort = () => { child?.kill(); finish(uncertain('LOCAL_ABORTED', 'Local wait cancelled. Inspect the platform before repeating an unknown write.')); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        child = spawnImpl(executable, ['--compact', ...args], {
          shell: false, windowsHide: true, cwd: workspaceRoot,
          env: { ...process.env, BILI_CLI_HOME: home, BILI_CLI_NO_RATE_LIMIT: '1', PYTHONUTF8: '1',
            PATH: settings.ffmpegDir ? `${settings.ffmpegDir}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(new BilibiliError('DEPENDENCY_MISSING', `Cannot start bili: ${error.message}`));
        return;
      }
      child.once('spawn', () => { started = true; });
      timer = setTimeout(() => { child.kill(); finish(uncertain('TIMEOUT', 'bili timed out. An unknown write must not be retried automatically.')); }, timeoutMs);
      child.stdout.on('data', (bytes) => {
        stdout += decoder.write(bytes);
        if (stdout.length > 32 * 1024 * 1024) { child.kill(); finish(uncertain('OUTPUT_LIMIT', 'bili output exceeded 32 MiB.')); }
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
            submission: write && !beforeSend.has(error.code) ? 'unknown' : 'not_sent', suggestion: error.hint, detail: error.detail,
          }));
        }
        finish(undefined, envelope.data);
      });
    });
  };
}
