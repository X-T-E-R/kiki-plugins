import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classifyUuWindows } from './window-topology.mjs';

const defaultExecFile = promisify(execFile);
const WORKER_SCRIPT_PATH = fileURLToPath(new URL('./win32-worker.ps1', import.meta.url));
const WORKER_IDLE_TTL_MS = 45_000;

export const UU_PORTAL_URL = 'https://uuyc.163.com/';
export const UU_WINGET_ID = 'NetEase.UURemote';

async function checkWindowsUriScheme(scheme, executeFile) {
  for (const hive of [`HKCU\\Software\\Classes\\${scheme}`, `HKCR\\${scheme}`]) {
    try {
      await executeFile('reg.exe', ['query', hive], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000,
      });
      return true;
    } catch {
      // Try next hive.
    }
  }
  return false;
}

export async function discoverGameViewerInstall({
  settings = {},
  hostPlatform = process.platform,
  env = process.env,
  fileExists = existsSync,
  executeFile = defaultExecFile,
} = {}) {
  const customExe = String(settings?.executablePath ?? '').trim();
  const candidates = [];

  if (customExe) {
    candidates.push({ path: customExe, source: 'settings.executablePath' });
  }

  if (hostPlatform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      { path: path.join(pf, 'NetEase', 'GameViewer', 'bin', 'GameViewer.exe'), source: 'standard_path' },
      { path: path.join(pf, 'NetEase', 'GameViewer', 'GameViewer.exe'), source: 'standard_path' },
      { path: path.join(pf, 'NetEase', 'GameViewer', 'bin', 'GameViewerLauncher.exe'), source: 'standard_path' },
      { path: path.join(pf86, 'NetEase', 'GameViewer', 'bin', 'GameViewer.exe'), source: 'standard_path' },
      { path: path.join(pf86, 'NetEase', 'GameViewer', 'GameViewer.exe'), source: 'standard_path' },
    );
  } else if (hostPlatform === 'darwin') {
    candidates.push(
      { path: '/Applications/UU远程.app', source: 'standard_path' },
      { path: '/Applications/UURemote.app', source: 'standard_path' },
      { path: '/Applications/GameViewer.app', source: 'standard_path' },
    );
  }

  const found = candidates.find((item) => fileExists(item.path)) || null;
  let uriSchemes = { uuremote: false, gameviewer: false };
  if (hostPlatform === 'win32') {
    const [uuremote, gameviewer] = await Promise.all([
      checkWindowsUriScheme('uuremote', executeFile),
      checkWindowsUriScheme('gameviewer', executeFile),
    ]);
    uriSchemes = { uuremote, gameviewer };
  } else if (hostPlatform === 'darwin' && found) {
    uriSchemes = { uuremote: true, gameviewer: true };
  }

  const serviceBinaries = [];
  if (hostPlatform === 'win32' && found) {
    const baseDir = path.basename(path.dirname(found.path)).toLowerCase() === 'bin'
      ? found.path && path.dirname(found.path)
      : path.join(path.dirname(found.path), 'bin');
    for (const svcName of ['GameViewerServer.exe', 'GameViewerService.exe']) {
      const svcPath = path.join(baseDir, svcName);
      if (fileExists(svcPath)) serviceBinaries.push(svcPath);
    }
  }

  return {
    installed: Boolean(found),
    executablePath: found?.path || null,
    configuredExecutablePath: customExe || null,
    source: found?.source || (customExe ? 'settings.executablePath_missing' : 'not_found'),
    serviceBinaries,
    uriSchemes,
    wingetId: UU_WINGET_ID,
    portalUrl: UU_PORTAL_URL,
  };
}

export function createWin32SystemDriver({
  hostPlatform = process.platform,
  env = process.env,
  fileExists = existsSync,
  executeFile = defaultExecFile,
  spawnProcess = spawn,
  workerIdleMs = WORKER_IDLE_TTL_MS,
  installCacheTtlMs = 60_000,
  nowFn = Date.now,
} = {}) {
  let worker = null;
  let reqCounter = 0;
  let idleTimer = null;
  const installCache = new Map();
  const installFlights = new Map();

  function killProcessTree(proc) {
    if (!proc) return;
    if (hostPlatform === 'win32' && proc.pid) {
      try {
        const killer = spawnProcess('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer?.on?.('error', () => {});
        killer?.unref?.();
      } catch {}
    }
    try { proc.kill(); } catch {}
  }

  function clearWorkerIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function touchWorkerIdle() {
    clearWorkerIdle();
    if (workerIdleMs > 0 && worker) {
      idleTimer = setTimeout(() => {
        void dispose();
      }, workerIdleMs);
      idleTimer.unref?.();
    }
  }

  function rejectPending(w, error) {
    for (const [, entry] of w.pending) {
      clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      entry.reject(error);
    }
    w.pending.clear();
  }

  function killAndDetachWorker(w, reasonError) {
    if (!w) return;
    if (worker === w) {
      worker = null;
      clearWorkerIdle();
    }
    if (w.closed) {
      rejectPending(w, reasonError);
      return;
    }
    w.closed = true;
    rejectPending(w, reasonError);
    try { w.rl.close(); } catch {}
    try { w.child.stdin.end(); } catch {}
    killProcessTree(w.child);
  }

  function ensureWorker() {
    if (hostPlatform !== 'win32') {
      throw new Error(`Win32 UU Remote window capture/input requires Windows (current platform: ${hostPlatform}).`);
    }
    if (worker && !worker.closed) {
      touchWorkerIdle();
      return worker;
    }

    const child = spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', WORKER_SCRIPT_PATH],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    const pending = new Map();
    let stderrTail = '';
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const state = {
      child,
      rl,
      pending,
      closed: false,
    };

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || 'Win32 worker command failed'));
      }
    });

    const onExit = (code, sig) => {
      if (state.closed) return;
      state.closed = true;
      if (worker === state) worker = null;
      clearWorkerIdle();
      rl.close();
      const suffix = stderrTail.trim() ? `: ${stderrTail.trim()}` : '';
      rejectPending(state, new Error(`Win32 bridge exited (code=${code}, signal=${sig})${suffix}`));
    };

    child.once('exit', onExit);
    child.once('error', (err) => {
      state.closed = true;
      if (worker === state) worker = null;
      clearWorkerIdle();
      rejectPending(state, err);
    });

    child.unref?.();
    worker = state;
    touchWorkerIdle();
    return state;
  }

  function callWorker(payload, timeoutMs = 15_000, { signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error('Win32 worker call aborted'), { name: 'AbortError' }),
      );
    }
    const w = ensureWorker();
    const id = ++reqCounter;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const abortErr = signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error(`Win32 worker aborted on op=${payload.op}`), { name: 'AbortError' });
        killAndDetachWorker(w, abortErr);
      };
      const cleanupAbort = () => {
        signal?.removeEventListener?.('abort', onAbort);
      };
      const timer = setTimeout(() => {
        const timeoutErr = new Error(`Win32 worker timed out on op=${payload.op} after ${timeoutMs}ms`);
        killAndDetachWorker(w, timeoutErr);
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      w.pending.set(id, { resolve, reject, timer, cleanupAbort });
      try {
        w.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n', 'utf8');
      } catch (err) {
        clearTimeout(timer);
        cleanupAbort();
        w.pending.delete(id);
        killAndDetachWorker(w, err);
        reject(err);
      }
    });
  }

  async function discoverInstallation(settings = {}) {
    const key = String(settings?.executablePath ?? '').trim();
    const cached = installCache.get(key);
    if (cached && installCacheTtlMs > 0 && nowFn() - cached.at < installCacheTtlMs) {
      return cached.value;
    }
    if (installFlights.has(key)) {
      return installFlights.get(key);
    }
    const flight = discoverGameViewerInstall({ settings, hostPlatform, env, fileExists, executeFile })
      .then((value) => {
        if (installCacheTtlMs > 0) {
          installCache.set(key, { at: nowFn(), value });
        }
        return value;
      })
      .finally(() => {
        if (installFlights.get(key) === flight) installFlights.delete(key);
      });
    installFlights.set(key, flight);
    return flight;
  }

  async function inspectTopology(settings = {}) {
    if (hostPlatform !== 'win32') {
      return {
        supported: false,
        hostPlatform,
        monitors: [],
        processes: [],
        sessions: [],
        launchers: [],
        ignored: [],
        cursor: null,
        foregroundHwnd: null,
      };
    }

    const processNames = ['GameViewer'];
    const customExe = String(settings?.executablePath ?? '').trim();
    if (customExe) {
      const stem = path.basename(customExe, path.extname(customExe));
      if (stem) processNames.push(stem);
    }

    const raw = await callWorker({ op: 'enum_state', processNames }, 12_000);
    const monitors = Array.isArray(raw.monitors) ? raw.monitors : [];
    const classified = classifyUuWindows(raw.windows || [], monitors);
    return {
      supported: true,
      hostPlatform,
      monitors,
      processes: Array.isArray(raw.processes) ? raw.processes : [],
      sessions: classified.sessions,
      launchers: classified.launchers,
      ignored: classified.ignored,
      cursor: raw.cursor || null,
      foregroundHwnd: raw.foregroundHwnd ?? null,
      virtualScreen: raw.virtualScreen || null,
    };
  }

  async function getCursorState() {
    if (hostPlatform !== 'win32') return { cursor: null, foregroundHwnd: null };
    const res = await callWorker({ op: 'cursor_pos' }, 4000);
    return { cursor: res.cursor || null, foregroundHwnd: res.foregroundHwnd ?? null };
  }

  async function captureSessionStage({ hwnd, stageHwnd }) {
    const res = await callWorker(
      { op: 'capture_window', hwndTop: Number(hwnd), stageHwnd: Number(stageHwnd || hwnd) },
      12_000,
    );
    return {
      pngBuffer: Buffer.from(res.pngBase64, 'base64'),
      stageBounds: res.stageBounds,
      outerBounds: res.outerBounds,
      cursor: res.cursor || null,
    };
  }

  async function recoverOffscreenWindows(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return { moved: [] };
    const res = await callWorker({ op: 'recover_offscreen', targets }, 10_000);
    return { moved: res.moved || [] };
  }

  async function performWindowAction({ hwnd, mode }) {
    return callWorker({ op: 'window_action', hwnd: Number(hwnd), mode }, 8000);
  }

  async function getClipboardText() {
    const res = await callWorker({ op: 'clipboard_get' }, 6000);
    return String(res.text ?? '');
  }

  async function setClipboardText(text) {
    await callWorker({ op: 'clipboard_set', text: String(text ?? '') }, 6000);
    return { ok: true };
  }

  async function sendInputBatch({ hwnd, restorePreviousFocus = false, steps, signal }) {
    return callWorker(
      {
        op: 'send_batch',
        hwndTop: Number(hwnd),
        restorePreviousFocus: Boolean(restorePreviousFocus),
        steps,
      },
      25_000,
      { signal },
    );
  }

  async function releaseAllInputs({ signal } = {}) {
    if (hostPlatform !== 'win32') return { ok: true, released: false };
    return callWorker({ op: 'release_all' }, 5_000, { signal });
  }

  async function openClientExecutable(executablePath) {
    if (!executablePath) {
      throw new Error('UU Remote executable was not found. Install NetEase UU Remote or set executablePath.');
    }
    if (hostPlatform === 'darwin' && executablePath.endsWith('.app')) {
      await executeFile('open', ['-a', executablePath], { timeout: 8000 });
      return { launched: executablePath };
    }
    const child = spawnProcess(executablePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref?.();
    return { launched: executablePath, pid: child.pid ?? null };
  }

  async function openProtocolUri(uri) {
    const trimmed = String(uri ?? '').trim();
    if (!/^(?:uuremote|gameviewer):\/\//i.test(trimmed)) {
      throw new Error('Invalid URI: expected uuremote:// or gameviewer:// scheme.');
    }
    if (/[\r\n\0"<>|^&]/.test(trimmed)) {
      throw new Error('URI contains unsafe shell/control characters.');
    }
    if (hostPlatform === 'win32') {
      await executeFile('rundll32.exe', ['url.dll,FileProtocolHandler', trimmed], {
        windowsHide: true,
        timeout: 8000,
      });
      return { opened: trimmed };
    }
    if (hostPlatform === 'darwin') {
      await executeFile('open', [trimmed], { timeout: 8000 });
      return { opened: trimmed };
    }
    throw new Error(`Protocol URI launch is not supported on ${hostPlatform}.`);
  }

  async function dispose() {
    clearWorkerIdle();
    const current = worker;
    worker = null;
    if (!current || current.closed) return;
    killAndDetachWorker(current, new Error('Win32 driver disposed.'));
  }

  return {
    hostPlatform,
    discoverInstallation,
    inspectTopology,
    getCursorState,
    captureSessionStage,
    recoverOffscreenWindows,
    performWindowAction,
    getClipboardText,
    setClipboardText,
    sendInputBatch,
    releaseAllInputs,
    openClientExecutable,
    openProtocolUri,
    callWorker,
    dispose,
  };
}
