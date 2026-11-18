import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST_PS1_PATH = path.join(LIB_DIR, 'win32-host.ps1');
const NATIVE_CS_PATH = path.join(LIB_DIR, 'win32-native.cs');
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

export function parseKeyChordTokens(keyOrKeys) {
  if (Array.isArray(keyOrKeys)) {
    return keyOrKeys
      .flatMap((part) => String(part).split('+'))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof keyOrKeys === 'string') {
    const trimmed = keyOrKeys.trim();
    if (trimmed === '+') return ['PLUS'];
    return trimmed
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function createWin32Bridge({
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  powershellExecutable = 'powershell.exe',
} = {}) {
  let proc = null;
  let startupPromise = null;
  let disposed = false;
  let nextReqId = 0;
  let idleTimer = null;
  const pending = new Map();
  let stderrTail = '';

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function touchIdle() {
    clearIdleTimer();
    if (disposed || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      if (pending.size === 0) {
        void stopWorker();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  function syncChildRef() {
    if (!proc) return;
    if (pending.size > 0) proc.ref?.();
    else proc.unref?.();
  }

  function rejectAllPending(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
    syncChildRef();
  }

  function resolvePowerShellPath() {
    if (powershellExecutable !== 'powershell.exe') return powershellExecutable;
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    return path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  async function ensureStarted() {
    if (disposed) throw new Error('Win32 bridge has been disposed');
    if (proc && proc.exitCode === null && !proc.killed) {
      touchIdle();
      return proc;
    }
    if (startupPromise) return startupPromise;

    startupPromise = new Promise((resolve, reject) => {
      stderrTail = '';
      const exe = resolvePowerShellPath();
      const child = spawn(
        exe,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          HOST_PS1_PATH,
          '-CsPath',
          NATIVE_CS_PATH,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );

      child.stdin.setDefaultEncoding('utf8');

      let readyResolved = false;
      const bootTimer = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          try { child.kill(); } catch {}
          reject(new Error(`Win32 C# bridge startup timed out. Stderr: ${stderrTail.trim()}`));
        }
      }, 20_000);
      bootTimer.unref?.();

      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
      });

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (!line) return;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.method === 'ready') {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(bootTimer);
            proc = child;
            syncChildRef();
            touchIdle();
            resolve(child);
          }
          return;
        }
        if (msg.id !== undefined && msg.id !== null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          syncChildRef();
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || 'Win32 bridge RPC failed'));
          } else {
            entry.resolve(msg.result);
          }
        }
      });

      const handleExit = (code, signal) => {
        clearTimeout(bootTimer);
        if (proc === child) proc = null;
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Win32 bridge exited during startup (code=${code}, signal=${signal}): ${stderrTail.trim()}`));
          return;
        }
        rejectAllPending(new Error(`Win32 bridge process exited unexpectedly (code=${code}, signal=${signal}): ${stderrTail.trim()}`));
      };

      child.once('error', (err) => {
        clearTimeout(bootTimer);
        if (proc === child) proc = null;
        if (!readyResolved) {
          readyResolved = true;
          reject(err);
        } else {
          rejectAllPending(err);
        }
      });

      child.once('exit', handleExit);
    }).finally(() => {
      startupPromise = null;
    });

    return startupPromise;
  }

  async function rpc(method, params = {}, { timeoutMs = 15_000, signal = null } = {}) {
    signal?.throwIfAborted?.();
    const child = await ensureStarted();
    const id = ++nextReqId;
    touchIdle();

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(id);
        syncChildRef();
        clearTimeout(timer);
        reject(signal.reason || new Error('Win32 RPC aborted'));
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        syncChildRef();
        signal?.removeEventListener?.('abort', onAbort);
        reject(new Error(`Win32 bridge method "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      pending.set(id, {
        resolve: (val) => {
          signal?.removeEventListener?.('abort', onAbort);
          touchIdle();
          resolve(val);
        },
        reject: (err) => {
          signal?.removeEventListener?.('abort', onAbort);
          reject(err);
        },
        timer,
      });
      syncChildRef();

      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', 'utf8');
      } catch (writeErr) {
        pending.delete(id);
        syncChildRef();
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        reject(writeErr);
      }
    });
  }

  async function stopWorker() {
    clearIdleTimer();
    const child = proc;
    proc = null;
    if (!child) return;
    try {
      if (child.exitCode === null && !child.killed) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'shutdown', params: {} }) + '\n');
        child.stdin.end();
      }
    } catch {}
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 600);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    rejectAllPending(new Error('Win32 bridge stopped'));
  }

  async function dispose() {
    disposed = true;
    await stopWorker();
  }

  return {
    platform: 'win32',
    isReady: () => Boolean(proc && proc.exitCode === null && !proc.killed),
    warmup: (opts) => rpc('ping', {}, opts),
    listMonitors: (opts) => rpc('listMonitors', {}, opts),
    getCursorPos: (opts) => rpc('getCursorPos', {}, { timeoutMs: 3_000, ...opts }),
    listWindows: (query = '', opts = {}) => rpc('listWindows', { query }, opts),
    focusWindow: (hwnd, opts = {}) => rpc('focusWindow', { hwnd: String(hwnd) }, opts),
    restoreWindow: (hwnd, opts = {}) => rpc('restoreWindow', { hwnd: String(hwnd) }, opts),
    capture: (params, opts = {}) => rpc('capture', params, { timeoutMs: 12_000, ...opts }),
    mouseMove: (screenX, screenY, opts = {}) => rpc('mouseMove', { screenX, screenY }, opts),
    mouseClick: ({ screenX, screenY, button = 'left', count = 1, modifiers = [] }, opts = {}) =>
      rpc('mouseClick', { screenX, screenY, button, count, modifiers }, opts),
    mouseDown: ({ hasCoords = false, screenX = 0, screenY = 0, button = 'left' }, opts = {}) =>
      rpc('mouseDown', { hasCoords, screenX, screenY, button }, opts),
    mouseUp: ({ hasCoords = false, screenX = 0, screenY = 0, button = 'left' }, opts = {}) =>
      rpc('mouseUp', { hasCoords, screenX, screenY, button }, opts),
    mouseDrag: ({ startX, startY, endX, endY, button = 'left', durationMs = 220 }, opts = {}) =>
      rpc('mouseDrag', { startX, startY, endX, endY, button, durationMs }, opts),
    mouseScroll: ({ screenX, screenY, deltaX = 0, deltaY = 0 }, opts = {}) =>
      rpc('mouseScroll', { screenX, screenY, deltaX, deltaY }, opts),
    keyChord: (keys, opts = {}) => rpc('keyChord', { keys: parseKeyChordTokens(keys) }, opts),
    holdKey: (key, durationMs = 250, opts = {}) => rpc('holdKey', { key: String(key), durationMs }, opts),
    typeText: ({ text, mode = 'auto', submit = false }, opts = {}) =>
      rpc('typeText', { text: String(text ?? ''), mode, submit }, opts),
    clipboardGet: (opts = {}) => rpc('clipboardGet', {}, opts),
    clipboardSet: (text, opts = {}) => rpc('clipboardSet', { text: String(text ?? ''), excludeFromHistory: false }, opts),
    releaseAllInputs: (opts = {}) => rpc('releaseAll', {}, { timeoutMs: 3_000, ...opts }).catch(() => ({ ok: false })),
    dispose,
  };
}
