import { spawn } from 'node:child_process';
import { readFile, access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export class SitesError extends Error {
  constructor(code, message, recovery = 'Edit the connection or target and retry.') { super(message); this.code = code; this.recovery = recovery; }
}
export const errorView = error => ({ code: error.code || 'error', message: error instanceof SitesError ? error.message : 'The operation failed. No credential values were included in this response.', recovery: error.recovery || 'Check service access and configuration, then retry.' });
export function dataDirectory(settings) {
  if (settings.dataDirectory && !path.isAbsolute(settings.dataDirectory)) throw new SitesError('invalid_data_directory', 'dataDirectory must be an absolute server path.');
  return settings.dataDirectory || path.join(process.env.KIKI_HOME || path.join(os.homedir(), '.kiki'), 'plugin-data', 'kiki-sites');
}
export class Store {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async read() {
    try { return JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { version: 1, connections: [], targets: [], jobs: [], previews: [] }; throw new SitesError('state_unreadable', 'Sites configuration could not be read. The existing file was preserved.', 'Check the configured dataDirectory permissions or restore its state.json backup.'); }
  }
  async update(mutator) {
    const operation = this.queue.then(async () => {
      const state = await this.read(); const result = await mutator(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const tmp = path.join(this.directory, `state.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(tmp, path.join(this.directory, 'state.json')); return result;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
}
export function scrub(text, secrets = []) {
  let safe = String(text).replace(/\u001b\[[0-9;]*m/g, '');
  for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/(bearer\s+|token[=:]\s*)[^\s"']+/gi, '$1[redacted]');
}
export async function executable(command, env = process.env) {
  let candidates = path.isAbsolute(command) ? [command] : (env.PATH || env.Path || '').split(path.delimiter).flatMap(dir => process.platform === 'win32' ? [path.join(dir, `${command}.exe`), path.join(dir, `${command}.cmd`), path.join(dir, command)] : [path.join(dir, command)]);
  for (const file of candidates) {
    try { await access(file); } catch { continue; }
    if (/\.(?:mjs|js|cjs)$/i.test(file)) return { command: /^node(?:\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : (await executable('node', env)).command, prefix: [file] };
    if (file.toLowerCase().endsWith('.cmd')) {
      const shim = await readFile(file, 'utf8');
      const match = shim.match(/"%dp0%\\([^"\r\n]+\.(?:js|mjs|cjs))"/i) || shim.match(/"%~dp0\\?([^"\r\n]+\.(?:js|mjs|cjs))"/i) || shim.match(/SET\s+"NPM_CLI_JS=%~dp0\\([^"\r\n]+\.js)"/i);
      if (!match) throw new SitesError('unsupported_cli_shim', 'This Windows command shim is not a Node CLI shim.', 'Set cliPath to the official .exe or JavaScript entry file.');
      const js = path.resolve(path.dirname(file), match[1].replaceAll('\\', '/')); await access(js);
      return { command: /^node(?:\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : (await executable('node', env)).command, prefix: [js] };
    }
    return { command: file, prefix: [] };
  }
  throw new SitesError('missing_cli', `Official CLI ${path.basename(command)} is not available.`, 'Install the official CLI from its documented source, then set cliPath or put it on PATH. Sites never downloads or installs a CLI automatically.');
}
export async function run(command, args, options = {}) {
  options.signal?.throwIfAborted();
  const resolved = await executable(command, { ...process.env, ...options.env });
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env, CI: '1', NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.once('error', () => child.kill());
      } else child.kill();
    };
    const timeout = setTimeout(stop, options.timeout || 20 * 60 * 1000);
    options.signal?.addEventListener('abort', stop, { once: true });
    const capture = stream => chunk => {
      const text = chunk.toString(); if (stream === 'stdout') stdout = (stdout + text).slice(-1024 * 1024); else stderr = (stderr + text).slice(-1024 * 1024);
      options.onText?.(scrub(text, options.secrets));
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.on('error', () => reject(new SitesError('cli_start_failed', 'The official CLI could not start.', 'Check cliPath and executable permissions.')));
    child.on('close', code => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', stop);
      if (stopped) { reject(new SitesError(options.signal?.aborted ? 'cancelled' : 'timeout', 'Stopped local waiting; a remote request may already exist.', 'Check the provider dashboard before retrying a deployment.')); return; }
      if (code !== 0) {
        const text = `${stdout}\n${stderr}`;
        const auth = /401|unauthori[sz]ed|expired|invalid.*token/i.test(text); const offline = /ENOTFOUND|ECONN|network|fetch failed|timed? out/i.test(text);
        reject(new SitesError(auth ? 'expired' : offline ? 'offline' : /not logged|login|authenticate|credentials/i.test(text) ? 'not_logged_in' : 'cli_failed', auth ? 'Authentication was rejected or expired.' : offline ? 'The service could not be reached.' : 'The official CLI did not complete the operation.', auth ? 'Sign in again or replace the API token.' : 'Check official CLI configuration/service status and retry.')); return;
      }
      resolve({ stdout: scrub(stdout, options.secrets), stderr: scrub(stderr, options.secrets) });
    });
  });
}
export async function request(url, { token, username, headers = {}, method = 'GET', body, signal, fetchImpl = fetch } = {}) {
  let response; const deadline = AbortSignal.timeout(45000); const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try { response = await fetchImpl(url, { method, signal: combined, headers: { Accept: 'application/json', ...(token ? { Authorization: username ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` : `Bearer ${token}` } : {}), ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' }); }
  catch { if (signal?.aborted) throw new SitesError('cancelled', 'Stopped local waiting; the remote result may be unknown.', 'Check the provider before retrying.'); throw new SitesError('offline', 'The service could not be reached.', 'Check connectivity and retry the status check. Credentials were preserved.'); }
  if (!response.ok) throw new SitesError(response.status === 401 ? 'expired' : response.status === 403 ? 'forbidden' : method !== 'GET' && response.status >= 500 ? 'result_unknown' : 'api_failed', `The service returned HTTP ${response.status}.`, response.status === 401 ? 'Sign in again or replace the API token.' : method !== 'GET' && response.status >= 500 ? 'Check the provider before deploying again; the request may have been accepted.' : 'Check the account permissions and target identifier.');
  try { return response.status === 204 ? {} : await response.json(); }
  catch { throw new SitesError(method === 'GET' ? 'invalid_api_output' : 'result_unknown', 'The service response could not be read.', method === 'GET' ? 'Retry the status check.' : 'Check the provider before deploying again; the request may have been accepted.'); }
}
