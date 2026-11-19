import { createInterface } from 'node:readline';
import { buildGlobalArgs, resolveV42Binary, resolveV42Target, spawnV42Process, V42CliError } from './v42-client.mjs';

const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

const ALLOWED_OP_FIELDS = {
  screenshot: ['path'],
  move: ['x', 'y'],
  click: ['x', 'y', 'button', 'count'],
  drag: ['x1', 'y1', 'x2', 'y2', 'button', 'steps'],
  scroll: ['x', 'y', 'dx', 'dy'],
  key: ['keys'],
  type: ['text'],
  clipboard_set: ['text'],
  clipboard_watch: [],
  select_display: ['display'],
  select_window: ['window'],
  unlock: ['password'],
  status: [],
  close: [],
};

function sanitizeControlOp(op, rawParams = {}) {
  const allowed = ALLOWED_OP_FIELDS[op];
  if (!allowed) {
    throw new Error(`Unsupported desktop control op: ${op}`);
  }
  const clean = { op };
  for (const key of allowed) {
    if (rawParams[key] !== undefined && rawParams[key] !== null) {
      clean[key] = rawParams[key];
    }
  }
  if (op === 'scroll') {
    const hasX = clean.x !== undefined;
    const hasY = clean.y !== undefined;
    if (hasX !== hasY) {
      delete clean.x;
      delete clean.y;
    }
  }
  return clean;
}

export class V42DesktopControlSession {
  constructor({
    computer,
    displayId,
    quality = 'high',
    maxWidth = 0,
    maxHeight = 0,
    settings = {},
    workspaceRoot,
    env = process.env,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    openTimeoutMs = 25_000,
    spawnFn = spawnV42Process,
    resolveBin = resolveV42Binary,
    onEvent,
  }) {
    this.computer = String(computer);
    this.displayId = displayId;
    this.quality = quality;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.settings = settings;
    this.workspaceRoot = workspaceRoot;
    this.env = env;
    this.idleTimeoutMs = idleTimeoutMs;
    this.openTimeoutMs = openTimeoutMs;
    this.spawnFn = spawnFn;
    this.resolveBin = resolveBin;
    this.onEvent = onEvent;

    this.child = null;
    this.rl = null;
    this.reqSeq = 0;
    this.pending = new Map();
    this.lastStatus = null;
    this.lastClipboard = null;
    this.idleTimer = null;
    this.openingPromise = null;
    this.closed = false;
    this.stderrTail = '';
    this.serialQueue = Promise.resolve();
  }

  touchIdle() {
    clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs > 0 && !this.closed) {
      this.idleTimer = setTimeout(() => {
        void this.close();
      }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    }
  }

  isAlive() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null && !this.closed);
  }

  async ensureStarted() {
    if (this.isAlive()) return this.lastStatus;
    if (this.openingPromise) return this.openingPromise;

    this.openingPromise = (async () => {
      this.closed = false;
      let bin;
      let companionRoot = null;
      let supportsCompanionRoot = true;
      if (this.resolveBin !== resolveV42Binary) {
        bin = await this.resolveBin({
          settings: this.settings,
          env: this.env,
          workspaceRoot: this.workspaceRoot,
        });
      } else {
        const target = await resolveV42Target({
          settings: this.settings,
          env: this.env,
        });
        if (target.capabilities?.hasDesktop === false) {
          throw new V42CliError(
            `The installed v42 CLI (${target.binPath}) does not support "v42 desktop control". Upgrade Vibe42 Companion or configure a newer v42BinPath in Plugin Settings.`,
            { code: 'cli_upgrade_required', exitCode: 2 },
          );
        }
        bin = target.binPath;
        companionRoot = target.companionRoot;
        supportsCompanionRoot = target.capabilities?.hasCompanionRootFlag !== false && !target.capabilities?.isScript;
      }

      const argv = [
        ...buildGlobalArgs(this.settings, { companionRoot, supportsCompanionRoot }),
        'desktop',
        'control',
        '--quality',
        String(this.quality),
      ];
      if (this.displayId !== undefined && this.displayId !== null) {
        argv.push('--display', String(this.displayId));
      }
      if (this.maxWidth > 0) argv.push('--max-width', String(Math.round(this.maxWidth)));
      if (this.maxHeight > 0) argv.push('--max-height', String(Math.round(this.maxHeight)));
      argv.push(this.computer);

      const child = this.spawnFn(bin, argv, { env: this.env });
      this.child = child;
      this.stderrTail = '';

      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4096);
      });

      let resolveInitialStatus;
      let rejectInitialStatus;
      const initialStatusPromise = new Promise((resolve, reject) => {
        resolveInitialStatus = resolve;
        rejectInitialStatus = reject;
      });

      const openTimer = setTimeout(() => {
        const timeoutErr = new V42CliError(
          `Timed out opening desktop control session on ${this.computer}`,
          { code: 'desktop_timeout' },
        );
        rejectInitialStatus(timeoutErr);
        if (this.child === child) {
          this.child = null;
          this.rl = null;
        }
        try { rl?.close(); } catch {}
        try { child.kill(); } catch {}
        void this.close().catch(() => {});
      }, this.openTimeoutMs);
      openTimer.unref?.();

      const rl = createInterface({ input: child.stdout });
      this.rl = rl;

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }

        if (typeof msg.event === 'string') {
          if (msg.event === 'status') {
            this.lastStatus = msg;
            clearTimeout(openTimer);
            resolveInitialStatus(msg);
          } else if (msg.event === 'clipboard' && typeof msg.text === 'string') {
            this.lastClipboard = msg.text;
          }
          this.onEvent?.(msg);
          return;
        }

        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.ok) {
            if (msg.data && typeof msg.data === 'object' && msg.data.display) {
              this.lastStatus = { ...(this.lastStatus || {}), ...msg.data };
            }
            entry.resolve(msg.data);
          } else {
            const errObj = msg.error || {};
            entry.reject(new V42CliError(errObj.message || 'desktop control op failed', {
              code: errObj.code || 'desktop_op_failed',
              details: errObj.details ?? null,
            }));
          }
        }
      });

      const handleExit = (code) => {
        clearTimeout(openTimer);
        if (this.child === child) {
          this.child = null;
          this.rl = null;
        }
        const reasonMessage = this.stderrTail.trim() || `Desktop control session exited (${code ?? 1})`;
        rejectInitialStatus(new V42CliError(reasonMessage, { code: 'desktop_session_ended', exitCode: code ?? 1 }));
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new V42CliError(reasonMessage, { code: 'desktop_session_ended', exitCode: code ?? 1 }));
        }
        this.pending.clear();
      };

      child.once('exit', handleExit);
      child.once('error', (err) => {
        clearTimeout(openTimer);
        rejectInitialStatus(err);
        handleExit(1);
      });

      const status = await initialStatusPromise;
      this.touchIdle();
      return status;
    })().finally(() => {
      this.openingPromise = null;
    });

    return this.openingPromise;
  }

  async command(op, params = {}, { timeoutMs = 25_000 } = {}) {
    const run = async () => {
      await this.ensureStarted();
      this.touchIdle();
      const payload = sanitizeControlOp(op, params);
      const id = ++this.reqSeq;
      payload.id = id;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const timeoutErr = new V42CliError(
            `Desktop op "${op}" timed out after ${timeoutMs}ms`,
            { code: 'desktop_timeout' },
          );
          const timedOutChild = this.child;
          this.child = null;
          this.rl?.close();
          this.rl = null;
          for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(timeoutErr);
          }
          this.pending.clear();
          try { timedOutChild?.kill?.(); } catch {}
          void this.close().catch(() => {});
        }, timeoutMs);
        timer.unref?.();

        this.pending.set(id, { resolve, reject, timer });
        try {
          this.child.stdin.write(`${JSON.stringify(payload)}\n`);
        } catch (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          void this.close().catch(() => {});
          reject(err);
        }
      });
    };

    const next = this.serialQueue.then(run, run);
    this.serialQueue = next.catch(() => {});
    return next;
  }

  async screenshot({ path: outPath } = {}) {
    const data = await this.command('screenshot', outPath ? { path: outPath } : {});
    const pngBuffer = data?.png_base64 ? Buffer.from(data.png_base64, 'base64') : null;
    const display = data?.display || this.lastStatus?.display || null;
    const windowInfo = data?.window || this.lastStatus?.window || null;
    const imageWidth = Number(data?.width) || Number(display?.width) || 1920;
    const imageHeight = Number(data?.height) || Number(display?.height) || 1080;
    const logicalWidth = Number(windowInfo?.frame?.width || windowInfo?.width || display?.width || imageWidth);
    const logicalHeight = Number(windowInfo?.frame?.height || windowInfo?.height || display?.height || imageHeight);

    return {
      computerId: data?.computer_id || this.computer,
      pngBase64: data?.png_base64 || null,
      pngBuffer,
      path: data?.path || outPath || null,
      imageSize: { width: imageWidth, height: imageHeight },
      logicalSize: { width: logicalWidth, height: logicalHeight },
      display,
      window: windowInfo,
      control: data?.control ?? this.lastStatus?.control ?? true,
    };
  }

  async move(x, y) {
    return this.command('move', { x: Number(x), y: Number(y) });
  }

  async click(x, y, { button = 'left', count = 1 } = {}) {
    return this.command('click', {
      x: Number(x),
      y: Number(y),
      button,
      count: Math.min(3, Math.max(1, Math.round(Number(count) || 1))),
    });
  }

  async drag(x1, y1, x2, y2, { button = 'left', steps = 12 } = {}) {
    return this.command('drag', {
      x1: Number(x1),
      y1: Number(y1),
      x2: Number(x2),
      y2: Number(y2),
      button,
      steps: Math.min(200, Math.max(1, Math.round(Number(steps) || 12))),
    });
  }

  async scroll({ dx = 0, dy = 0, x, y } = {}) {
    const params = {
      dx: Math.round(Number(dx) || 0),
      dy: Math.round(Number(dy) || 0),
    };
    if (x !== undefined && y !== undefined) {
      params.x = Number(x);
      params.y = Number(y);
    }
    return this.command('scroll', params);
  }

  async key(keys) {
    const normalized = Array.isArray(keys) ? keys.map(String) : String(keys);
    return this.command('key', { keys: normalized });
  }

  async type(text) {
    return this.command('type', { text: String(text) });
  }

  async clipboardSet(text) {
    this.lastClipboard = String(text);
    return this.command('clipboard_set', { text: String(text) });
  }

  async clipboardWatch() {
    return this.command('clipboard_watch', {});
  }

  async selectDisplay(display) {
    this.displayId = Number(display);
    return this.command('select_display', { display: Number(display) });
  }

  async selectWindow(windowId) {
    return this.command('select_window', { window: Number(windowId) });
  }

  async status() {
    return this.command('status', {});
  }

  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) return;
    this.child = null;

    if (!child.killed && child.exitCode === null) {
      try {
        child.stdin.write(`${JSON.stringify({ id: ++this.reqSeq, op: 'close' })}\n`);
        child.stdin.end();
      } catch {}
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try { child.kill(); } catch {}
          resolve();
        }, 800);
        killTimer.unref?.();
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  }
}

export class DesktopSessionManager {
  constructor({ env = process.env, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) {
    this.env = env;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessions = new Map();
  }

  acquire(computer, {
    displayId,
    quality = 'high',
    settings = {},
    workspaceRoot,
    onEvent,
  } = {}) {
    const key = String(computer);
    const existing = this.sessions.get(key);
    if (existing && existing.isAlive()) {
      existing.settings = settings;
      return existing;
    }
    const created = new V42DesktopControlSession({
      computer: key,
      displayId,
      quality,
      settings,
      workspaceRoot,
      env: this.env,
      idleTimeoutMs: this.idleTimeoutMs,
      onEvent,
    });
    this.sessions.set(key, created);
    return created;
  }

  getIfOpen(computer) {
    const session = this.sessions.get(String(computer));
    return session && session.isAlive() ? session : null;
  }

  async closeComputer(computer) {
    const key = String(computer);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session) await session.close();
  }

  async dispose() {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.close()));
  }
}
