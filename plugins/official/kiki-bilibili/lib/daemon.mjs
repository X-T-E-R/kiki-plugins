import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BilibiliError } from './errors.mjs';

export const BEFORE_SEND_CODES = new Set([
  'invalid_argument',
  'not_logged_in',
  'auth_expired',
  'not_found',
  'permission_denied',
  'captcha_required',
  'risk_control',
  'rate_limited',
]);

const DAEMON_SCRIPT = path.join(import.meta.dirname, 'daemon.py');
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const BOOT_TIMEOUT_MS = 20000;

const pool = new Map();
let nextRequestId = 0;

export function terminateChild(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn(
        path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', shell: false },
      );
      killer.unref?.();
      killer.once('error', () => { try { child.kill(); } catch {} });
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    try { child.kill('SIGKILL'); } catch { try { child.kill(); } catch {} }
  }
}

export function resolveDaemonPython(biliExecutable) {
  if (!existsSync(DAEMON_SCRIPT)) return null;
  const exe = String(biliExecutable || '').trim();
  if (!exe) return null;

  const candidatesInDir = (dir) => (
    process.platform === 'win32'
      ? [path.join(dir, 'python.exe')]
      : [path.join(dir, 'python3'), path.join(dir, 'python')]
  );

  if (path.isAbsolute(exe) || exe.includes('/') || exe.includes('\\')) {
    const dir = path.dirname(path.resolve(exe));
    for (const candidate of candidatesInDir(dir)) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const binNames = process.platform === 'win32'
    ? (exe.toLowerCase().endsWith('.exe') ? [exe] : [`${exe}.exe`, exe])
    : [exe];
  for (const dir of pathDirs) {
    const foundBili = binNames.some((n) => existsSync(path.join(dir, n)));
    if (!foundBili) continue;
    if (!existsSync(path.join(path.dirname(dir), 'pyvenv.cfg'))) continue;
    for (const candidate of candidatesInDir(dir)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

class WarmDaemon {
  constructor({ key, pythonPath, profileHome, ffmpegDir, cliVersion }) {
    this.key = key;
    this.pythonPath = pythonPath;
    this.profileHome = profileHome;
    this.ffmpegDir = ffmpegDir;
    this.cliVersion = cliVersion;
    this.child = null;
    this.pid = null;
    this.dead = false;
    this.pending = new Map();
    this.idleTimer = null;
    this.readyPromise = null;
    this.closedPromise = null;
    this._resolveReady = null;
    this._rejectReady = null;
    this._bootSettled = false;
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
  }

  start() {
    this.readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    const bootTimer = setTimeout(() => {
      if (!this._bootSettled) {
        this._failBoot(new BilibiliError('TIMEOUT', 'Warm bili daemon timed out during startup.'));
        this.killAndEvict();
      }
    }, BOOT_TIMEOUT_MS);
    bootTimer.unref?.();

    let child;
    try {
      child = spawn(this.pythonPath, ['-B', DAEMON_SCRIPT], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          ...process.env,
          BILI_CLI_HOME: this.profileHome,
          BILI_CLI_NO_RATE_LIMIT: '1',
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          PATH: this.ffmpegDir ? `${this.ffmpegDir}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH,
        },
      });
    } catch (error) {
      clearTimeout(bootTimer);
      this.dead = true;
      pool.delete(this.key);
      this._failBoot(new BilibiliError('DEPENDENCY_MISSING', `Cannot start Python daemon: ${error.message}`));
      return this;
    }

    this.child = child;
    this.pid = child.pid ?? null;
    this.closedPromise = new Promise((resolve) => {
      child.once('close', () => resolve());
    });

    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      clearTimeout(bootTimer);
      const mapped = error.code === 'ENOENT'
        ? new BilibiliError('DEPENDENCY_MISSING', `Install bili-agent==${this.cliVersion} in an isolated environment and set biliCliPath.`)
        : new BilibiliError('CLI_ERROR', error.message);
      if (!this._bootSettled) {
        this._failBoot(mapped);
      }
      this._handleCrash(error.message);
    });

    child.stdout.on('data', (chunk) => {
      this._buffer += this._decoder.write(chunk);
      if (this._buffer.length > MAX_LINE_BYTES) {
        this.killAndEvict('bili output exceeded 32 MiB.', 'OUTPUT_LIMIT');
        return;
      }
      let nl;
      while ((nl = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, nl).trim();
        this._buffer = this._buffer.slice(nl + 1);
        if (!line) continue;
        this._onLine(line, bootTimer);
      }
    });

    child.once('close', (code) => {
      clearTimeout(bootTimer);
      const tail = (this._buffer + this._decoder.end()).trim();
      this._buffer = '';
      if (tail) this._onLine(tail, bootTimer);
      if (!this._bootSettled) {
        this._failBoot(new BilibiliError('DEPENDENCY_MISSING', `Warm bili daemon exited (${code}) before ready.`));
      }
      this._handleCrash(`bili daemon exited ${code} without a JSON receipt.`);
    });

    this._syncRefState();
    return this;
  }

  _failBoot(error) {
    if (this._bootSettled) return;
    this._bootSettled = true;
    this.dead = true;
    if (pool.get(this.key) === this) pool.delete(this.key);
    this._rejectReady?.(error);
  }

  _onLine(line, bootTimer) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.killAndEvict('bili daemon emitted invalid JSON.', 'CLI_RESPONSE_INVALID');
      return;
    }

    if (!this._bootSettled) {
      clearTimeout(bootTimer);
      if (msg?.type === 'ready') {
        this._bootSettled = true;
        if (msg.pid) this.pid = msg.pid;
        this._syncRefState();
        this._resolveReady?.();
        return;
      }
      if (msg?.type === 'init_error') {
        this._failBoot(new BilibiliError('DEPENDENCY_MISSING', `bili-agent daemon failed to initialize: ${msg.message}`));
        this.killAndEvict();
        return;
      }
    }

    const reqId = msg?.id;
    const entry = reqId !== undefined ? this.pending.get(reqId) : undefined;
    if (!entry) return;
    this.pending.delete(reqId);
    entry.cleanup();
    this._syncRefState();

    if (msg.ok !== true || msg.data === undefined || msg.data === null) {
      if (msg.ok === true) {
        entry.reject(new BilibiliError('CLI_RESPONSE_INVALID', 'bili daemon returned an empty data receipt.', {
          submission: entry.write ? 'unknown' : 'not_sent',
        }));
        return;
      }
      const err = msg.error || {};
      entry.reject(new BilibiliError(err.code || 'CLI_ERROR', err.message || `bili exited ${msg.exit_code ?? 1}`, {
        submission: entry.write && !BEFORE_SEND_CODES.has(err.code) ? 'unknown' : 'not_sent',
        suggestion: err.hint,
        detail: err.detail,
      }));
      return;
    }

    entry.resolve(msg.data);
  }

  _syncRefState() {
    if (this.dead || !this.child) return;
    if (this.pending.size > 0 || !this._bootSettled) {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.child.ref?.();
      this.child.stdout?.ref?.();
    } else {
      this.child.unref?.();
      this.child.stdout?.unref?.();
      if (!this.idleTimer) {
        this.idleTimer = setTimeout(() => {
          this.shutdownGracefully();
        }, IDLE_TIMEOUT_MS);
        this.idleTimer.unref?.();
      }
    }
  }

  _handleCrash(reasonMessage, codeOverride = 'CLI_RESPONSE_INVALID') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.dead = true;
    if (pool.get(this.key) === this) pool.delete(this.key);
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      const suffix = entry.write && !reasonMessage.includes('Check the platform')
        ? ' Check the platform before sending again.'
        : '';
      entry.reject(new BilibiliError(codeOverride, `${reasonMessage}${suffix}`, {
        submission: entry.write ? 'unknown' : 'not_sent',
      }));
    }
  }

  killAndEvict(reasonMessage = 'bili daemon terminated.', codeOverride = 'CLI_RESPONSE_INVALID') {
    if (pool.get(this.key) === this) pool.delete(this.key);
    this.dead = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    terminateChild(this.child);
    if (this.pending.size > 0) {
      this._handleCrash(reasonMessage, codeOverride);
    }
  }

  async shutdownGracefully() {
    if (pool.get(this.key) === this) pool.delete(this.key);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.dead || !this.child) return;
    this.dead = true;
    this.child.ref?.();
    try {
      if (this.child.stdin?.writable) {
        this.child.stdin.write('{"cmd":"shutdown"}\n');
        this.child.stdin.end();
      }
    } catch {}
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), 400);
    });
    const outcome = await Promise.race([this.closedPromise, timeout]);
    if (outcome === 'timeout' && this.child.exitCode === null) {
      terminateChild(this.child);
      await Promise.race([
        this.closedPromise,
        new Promise((r) => setTimeout(r, 300)),
      ]);
    }
  }

  destroySync() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.dead = true;
    try {
      if (this.child?.stdin?.writable) {
        this.child.stdin.end();
      }
    } catch {}
    if (this.child?.exitCode === null) {
      terminateChild(this.child);
    }
  }

  isUsable() {
    return !this.dead && this.child !== null && this.child.exitCode === null && !this.child.killed && Boolean(this.child.stdin?.writable);
  }

  async request({ args, cwd, write, timeoutMs, signal }) {
    await this.readyPromise;
    if (signal?.aborted) {
      throw new BilibiliError('LOCAL_ABORTED', 'Cancelled before starting bili.', { submission: 'not_sent' });
    }
    if (!this.isUsable()) {
      throw new BilibiliError('CLI_ERROR', 'Warm daemon closed before dispatch.', { submission: 'not_sent', retryableBeforeSend: true });
    }

    return new Promise((resolve, reject) => {
      const id = ++nextRequestId;
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        this._syncRefState();
        reject(err);
      };

      const finishResolve = (data) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(data);
      };

      const onAbort = () => {
        const err = new BilibiliError('LOCAL_ABORTED', 'Local wait cancelled. Inspect the platform before repeating an unknown write.', {
          submission: write ? 'unknown' : 'not_sent',
        });
        finishReject(err);
        if (write) {
          this.killAndEvict('Daemon terminated due to aborted write.');
        }
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        const err = new BilibiliError('TIMEOUT', 'bili timed out. An unknown write must not be retried automatically.', {
          submission: write ? 'unknown' : 'not_sent',
        });
        finishReject(err);
        if (write) {
          this.killAndEvict('Daemon terminated due to timed-out write.', 'TIMEOUT');
        }
      }, timeoutMs);

      this.pending.set(id, {
        write,
        cleanup,
        resolve: finishResolve,
        reject: finishReject,
      });
      this._syncRefState();

      const payload = `${JSON.stringify({ id, args, cwd: cwd || null, write: Boolean(write) })}\n`;
      try {
        this.child.stdin.write(payload);
      } catch (writeErr) {
        // Failed synchronously before bytes entered pipe only if stdin was already destroyed;
        // for writes treat conservatively unless stream never accepted write.
        finishReject(new BilibiliError('CLI_ERROR', writeErr.message, {
          submission: write ? 'unknown' : 'not_sent',
        }));
        this.killAndEvict(writeErr.message);
      }
    });
  }
}

function getOrCreateDaemon({ pythonPath, profileHome, ffmpegDir, cliVersion }) {
  const normHome = path.resolve(profileHome);
  const normPy = path.resolve(pythonPath);
  const normFfmpeg = ffmpegDir ? path.resolve(ffmpegDir) : '';
  const key = `${normPy}\0${normHome}\0${normFfmpeg}`;
  const existing = pool.get(key);
  if (existing && (existing.isUsable() || !existing._bootSettled) && !existing.dead) {
    return existing;
  }
  if (existing) pool.delete(key);
  const created = new WarmDaemon({ key, pythonPath: normPy, profileHome: normHome, ffmpegDir: normFfmpeg, cliVersion });
  pool.set(key, created);
  return created.start();
}

export async function callWarmDaemon({ pythonPath, profileHome, ffmpegDir, cliVersion, args, workspaceRoot, write, timeoutMs, signal }) {
  if (signal?.aborted) {
    throw new BilibiliError('LOCAL_ABORTED', 'Cancelled before starting bili.', { submission: 'not_sent' });
  }
  let worker = getOrCreateDaemon({ pythonPath, profileHome, ffmpegDir, cliVersion });
  try {
    return await worker.request({ args, cwd: workspaceRoot, write, timeoutMs, signal });
  } catch (error) {
    if (error?.retryableBeforeSend && !write) {
      worker = getOrCreateDaemon({ pythonPath, profileHome, ffmpegDir, cliVersion });
      return worker.request({ args, cwd: workspaceRoot, write, timeoutMs, signal });
    }
    throw error;
  }
}

export async function closeAllDaemons() {
  const workers = [...pool.values()];
  pool.clear();
  await Promise.allSettled(workers.map((w) => w.shutdownGracefully()));
}

export function getActiveDaemonPids() {
  const out = [];
  for (const w of pool.values()) {
    if (!w.dead && w.pid) {
      out.push({ key: w.key, pid: w.pid, profileHome: w.profileHome });
    }
  }
  return out;
}

process.once('exit', () => {
  for (const w of pool.values()) {
    w.destroySync();
  }
  pool.clear();
});
