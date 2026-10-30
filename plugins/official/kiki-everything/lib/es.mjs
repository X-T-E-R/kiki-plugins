import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLease, clientIdentity } from './lease.mjs';

// Adapted from elis132/everything-mcp@22a60bd backend.py/config.py (MIT).
export class EverythingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function splitQueryTerms(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    if (' \t\r\n'.includes(query[i])) { i++; continue; }
    const start = i;
    let quoted = false;
    while (i < query.length && (quoted || !' \t\r\n'.includes(query[i]))) {
      if (query.startsWith('"""', i)) { i += 3; continue; }
      if (query[i] === '"') quoted = !quoted;
      i++;
    }
    tokens.push(query.slice(start, i) + (quoted ? '"' : ''));
  }
  return tokens;
}
export const notASwitch = term => /^[-/]/.test(term) ? `"${term.replaceAll('"', '')}"` : term;
export const commandArg = arg => /[ \t]/.test(arg) && !arg.includes('"') ? `"${arg}"` : arg;
export function decodeOutput(data) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new EverythingError('ES_ENCODING', 'ES returned invalid UTF-8. Use official ES >=1.1.0.37 with redirected UTF-8 output; do not treat this response as file paths.'); }
}
const exists = file => access(file).then(() => true, () => false);
export async function resolveEsPath(settings = {}, env = process.env) {
  if (settings.esPath) {
    if (!path.isAbsolute(settings.esPath) || !await exists(settings.esPath)) {
      throw new EverythingError('ES_NOT_FOUND', 'Configured esPath is missing or is not absolute. Set esPath to the official voidtools es.exe, or clear it to use PATH / WinGet discovery.');
    }
    return settings.esPath;
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'es.exe' : 'es');
    if (await exists(candidate)) return candidate;
  }
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  for (const name of (await readdir(packages).catch(() => [])).sort()) {
    if (!name.startsWith('voidtools.Everything.Cli_')) continue;
    const candidate = path.join(packages, name, 'es.exe');
    if (await exists(candidate)) return candidate;
  }
  throw new EverythingError('ES_NOT_FOUND', 'Official voidtools es.exe was not found. Install with winget install --id voidtools.Everything.Cli -e, or set this plugin\'s esPath to its absolute path. Everything must also be running.');
}
export class EsRunner {
  constructor({ spawnProcess = spawn, lock = acquireLease, identity = clientIdentity, watchMs = 2000 } = {}) {
    this.spawnProcess = spawnProcess; this.lock = lock; this.identity = identity; this.watchMs = watchMs; this.pending = false;
  }
  async run(executable, args, { signal, timeoutMs = 30000 } = {}) {
    if (signal?.aborted) throw new EverythingError('CANCELLED', 'Search cancelled before ES started.');
    if (this.pending) throw new EverythingError('ES_BUSY', 'Everything is still running an earlier query. Wait and retry; cancellation stops waiting, not the indexed query.');
    this.pending = true;
    let lease;
    try { lease = await this.lock(); }
    catch (error) { this.pending = false; throw error; }
    if (signal?.aborted) { await lease.release(); this.pending = false; throw new EverythingError('CANCELLED', 'Search cancelled before ES started.'); }
    const instanceIndex = args.indexOf('-instance');
    const instance = instanceIndex < 0 ? '' : args[instanceIndex + 1].replaceAll('"', '');
    const identity = args.includes('-version') ? null : await this.identity(instance).catch(() => null);
    if (signal?.aborted) { await lease.release(); this.pending = false; throw new EverythingError('CANCELLED', 'Search cancelled before ES started.'); }
    let child;
    try {
      child = this.spawnProcess(executable, process.platform === 'win32' ? args.map(commandArg) : args, {
        windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { await lease.release(); this.pending = false; throw error; }
    return new Promise((resolve, reject) => {
      const chunks = [], errors = [];
      let bytes = 0, overflow = false, settled = false, closed = false, watcher;
      const watch = () => {
        if (!identity || watcher || closed) return;
        const tick = async () => {
          if (closed) return;
          const current = await this.identity(instance).catch(() => null);
          if (closed) return;
          if (current !== identity && current !== null) { child.kill(); return; }
          watcher = setTimeout(tick, this.watchMs);
        };
        watcher = setTimeout(tick, this.watchMs);
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => { watch(); finish(new EverythingError('CANCELLED', 'Stopped waiting for ES. Everything may still be running the query; further calls report busy until ES exits.')); };
      const timer = setTimeout(() => { watch(); finish(new EverythingError('ES_TIMEOUT', `Search timed out after ${timeoutMs} ms. Everything may still be running the query; calls report busy until ES exits. Narrow by root, name or extension; ask the user to restart Everything if it stays busy.`)); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', data => { bytes += data.length; if (bytes <= 16 * 1024 * 1024) chunks.push(data); else overflow = true; });
      child.stderr.on('data', data => { if (errors.reduce((n, b) => n + b.length, 0) < 65536) errors.push(data); });
      child.once('error', error => finish(new EverythingError('ES_START_FAILED', `Could not start official ES: ${error.message}. Check esPath and executable permissions.`)));
      child.once('close', async (code, terminationSignal) => {
        closed = true; clearTimeout(watcher);
        try {
          await lease.release();
          this.pending = false;
          if (overflow) return finish(new EverythingError('ES_OUTPUT_LIMIT', 'ES output exceeded 16 MiB. Narrow the query or lower limit.'));
          const stdout = decodeOutput(Buffer.concat(chunks)), stderr = decodeOutput(Buffer.concat(errors));
          if (code !== 0 && code !== 9) {
            const hint = code === 8 ? 'Start the Everything desktop client (the service alone is insufficient), or correct the plugin instance setting.' : 'Check that Everything is running and the instance setting matches it.';
            return finish(new EverythingError('ES_FAILED', `ES failed (exit ${code ?? terminationSignal}): ${stderr.trim() || stdout.trim() || 'No diagnostic output'}. ${hint}`));
          }
          finish(null, { stdout: code === 9 ? '' : stdout, stderr, code });
        } catch (error) { this.pending = false; finish(error); }
      });
    });
  }
}
export const runner = new EsRunner();
export const baseArgs = settings => ['-default-argv', ...(settings.instance ? ['-instance', `"${settings.instance}"`] : [])];
export async function checkEs(executable, settings, context, executor = runner) {
  const options = { signal: context.signal, timeoutMs: Math.min(settings.timeoutMs ?? 30000, 4000) };
  const es = (await executor.run(executable, ['-version'], options)).stdout.trim();
  const parts = es.split('.').map(Number);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(es) || parts[0] !== 1 || parts[1] < 1 || (parts[1] === 1 && parts[2] === 0 && parts[3] < 37)) {
    throw new EverythingError('ES_VERSION', `ES >=1.1.0.37 is required to pin its argument parser; found ${es || 'an unrecognized executable'}. Install the official voidtools CLI.`);
  }
  const everything = (await executor.run(executable, [...baseArgs(settings), '-get-everything-version'], options)).stdout.trim();
  if (!/^1\.5\./.test(everything)) throw new EverythingError('EVERYTHING_VERSION', `Everything 1.5 is required for this indexed-search plugin; received ${everything || 'no version'}. Start Everything 1.5 and check the instance setting.`);
  return { es, everything };
}
