import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  #active = 0;
  #queue = [];

  // Each ES process owns its IPC reply endpoint. Bound the number of clients per plugin host.
  constructor({ spawnProcess = spawn, concurrency = 4 } = {}) {
    this.spawnProcess = spawnProcess;
    this.concurrency = concurrency;
  }

  #drain() {
    while (this.#active < this.concurrency && this.#queue.length) this.#queue.shift()();
  }

  async run(executable, args, { signal, timeoutMs = 30000 } = {}) {
    if (signal?.aborted) throw new EverythingError('CANCELLED', 'Search cancelled before ES started.');
    return new Promise((resolve, reject) => {
      let child, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const stop = error => {
        finish(error);
        if (child) child.kill();
        else this.#queue.splice(this.#queue.indexOf(start), 1);
      };
      const abort = () => stop(new EverythingError('CANCELLED', child ? 'Search cancelled. The local ES process was stopped; Everything may still finish the query internally.' : 'Search cancelled before ES started.'));
      const timer = setTimeout(() => stop(new EverythingError('ES_TIMEOUT', child
        ? `Search timed out after ${timeoutMs} ms. Narrow by root, name or extension.`
        : `Search timed out after ${timeoutMs} ms waiting for an ES process slot.`)), timeoutMs);
      const startFailed = error => finish(new EverythingError('ES_START_FAILED', `Could not start official ES: ${error.message}. Check esPath and executable permissions.`));
      const start = () => {
        try {
          child = this.spawnProcess(executable, process.platform === 'win32' ? args.map(commandArg) : args, {
            windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) { startFailed(error); return; }
        this.#active++;
        const chunks = [];
        let bytes = 0;
        child.stdout.on('data', data => {
          if (settled) return;
          bytes += data.length;
          if (bytes > 16 * 1024 * 1024) stop(new EverythingError('ES_OUTPUT_LIMIT', 'ES output exceeded 16 MiB. Narrow the query or lower limit.'));
          else chunks.push(data);
        });
        // Never return raw diagnostics: they can contain paths that have not been filtered.
        child.stderr.resume();
        child.on('error', startFailed);
        child.once('close', (code, terminationSignal) => {
          // Keep the slot until the child closes, even when cancellation has already returned.
          this.#active--;
          try {
            if (settled) return;
            if (code !== 0 && code !== 9) {
              const hint = code === 8 ? 'Start the Everything desktop client (the service alone is insufficient), or correct the plugin instance setting.' : 'Check that Everything is running and the instance setting matches it.';
              return finish(new EverythingError('ES_FAILED', `ES failed (exit ${code ?? terminationSignal}). ${hint}`));
            }
            finish(null, { stdout: code === 9 ? '' : decodeOutput(Buffer.concat(chunks)), code });
          } catch (error) { finish(error); }
          finally { this.#drain(); }
        });
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#queue.push(start);
      this.#drain();
    });
  }
}
export const runner = new EsRunner();
export const baseArgs = settings => ['-default-argv', ...(settings.instance ? ['-instance', `"${settings.instance}"`] : [])];
export function createEsProbe(executor = runner) {
  let checked;
  return async (executable, settings, context) => {
    const options = { signal: context.signal, timeoutMs: settings.timeoutMs ?? 30000 };
    const info = await stat(executable, { bigint: true });
    const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    let es;
    if (checked?.executable === executable && checked.identity === identity) {
      es = checked.es;
    } else {
      es = (await executor.run(executable, ['-version'], options)).stdout.trim();
      const parts = es.split('.').map(Number);
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(es) || parts[0] !== 1 || parts[1] < 1 || (parts[1] === 1 && parts[2] === 0 && parts[3] < 37)) {
        throw new EverythingError('ES_VERSION', 'ES >=1.1.0.37 is required to pin its argument parser. Install the official voidtools CLI.');
      }
      checked = { executable, identity, es };
    }
    // The running instance can change independently of ES, and ES also works with Everything 1.4.
    const everything = (await executor.run(executable, [...baseArgs(settings), '-get-everything-version'], options)).stdout.trim();
    if (!/^1\.5\.\d+\.\d+$/.test(everything)) throw new EverythingError('EVERYTHING_VERSION', 'Everything 1.5 is required for this indexed-search plugin. Start Everything 1.5 and check the instance setting.');
    return { es, everything };
  };
}
