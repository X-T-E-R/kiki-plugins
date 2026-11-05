import { spawn as nodeSpawn } from 'node:child_process';

const MAX_LINE_BYTES = 4 * 1024 * 1024;

function abortError() {
  const error = new Error('Cockpit OAuth operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function backendError(message) {
  return new Error(message || 'Cockpit OAuth backend rejected the request.');
}

function responseError(value) {
  if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  return 'Cockpit OAuth backend rejected the request.';
}

/**
 * Small NDJSON client for the separately installed cockpit-harness-oauth
 * executable. It deliberately owns no account or connection data: the backend
 * process owns that state and is closed by the plugin lifecycle.
 */
export class NdjsonBackend {
  constructor({ spawnFn = nodeSpawn, onExit } = {}) {
    this.spawn = spawnFn;
    this.onExit = onExit;
    this.child = undefined;
    this.closed = true;
    this.closing = false;
    this.buffer = '';
    this.nextId = 0;
    this.pending = new Map();
    this.endPromise = undefined;
    this.endReason = undefined;
  }

  get running() {
    return this.child !== undefined && !this.closed;
  }

  async start({ backendPath, sidecarPath, dataDir, kikiHome }) {
    if (this.running) return;
    if (!backendPath || !sidecarPath) throw new Error('Configure backendPath and sidecarPath before using Cockpit OAuth.');
    const args = ['--sidecar', sidecarPath];
    if (dataDir) args.push('--data-dir', dataDir);
    let child;
    try {
      child = this.spawn(backendPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(kikiHome ? { cwd: kikiHome } : {}),
      });
    } catch {
      throw new Error('Cannot start cockpit-harness-oauth. Check backendPath and its executable permissions.');
    }
    this.child = child;
    this.closed = false;
    this.closing = false;
    this.buffer = '';
    this.endReason = undefined;
    const ended = (error) => this.#ended(child, error);
    child.once?.('error', (error) => ended(new Error('cockpit-harness-oauth exited before it could answer.')));
    child.once?.('exit', (code, signal) => {
      if (code === 0 && !signal) ended(new Error('cockpit-harness-oauth exited.'));
      else ended(new Error('cockpit-harness-oauth stopped unexpectedly.'));
    });
    child.once?.('close', (code, signal) => {
      if (code === 0 && !signal) ended(new Error('cockpit-harness-oauth exited.'));
      else ended(new Error('cockpit-harness-oauth stopped unexpectedly.'));
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.#data(chunk, child));
    child.stdout?.on('error', () => ended(new Error('cockpit-harness-oauth output closed unexpectedly.')));
    // stderr is intentionally drained but never copied into plugin stdout or
    // returned as a tool/panel result: backend logs can contain credentials.
    child.stderr?.resume?.();
    child.stdin?.on('error', () => ended(new Error('cockpit-harness-oauth input closed unexpectedly.')));
  }

  request(method, params, { signal } = {}) {
    if (!this.running || !this.child?.stdin || this.closing) {
      return Promise.reject(this.endReason ?? new Error('Cockpit OAuth backend is not running.'));
    }
    if (signal?.aborted) return Promise.reject(abortError());
    const id = ++this.nextId;
    const wireId = String(id);
    const payload = JSON.stringify({ id: wireId, method, params });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        this.pending.delete(wireId);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(abortError());
      this.pending.set(wireId, finish);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.child.stdin.write(`${payload}\n`, (error) => {
          if (error) finish(new Error('Cockpit OAuth backend input failed.'));
        });
      } catch {
        finish(new Error('Cockpit OAuth backend input failed.'));
      }
    });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    if (this.endPromise) return this.endPromise;
    this.closing = true;
    this.endPromise = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once?.('exit', done);
      child.once?.('close', done);
      child.once?.('error', done);
      if (child.exitCode !== null && child.exitCode !== undefined) done();
      try { child.stdin?.end(); } catch { done(); }
    }).finally(() => {
      this.endPromise = undefined;
      if (this.child === child && !this.closed) this.#ended(child, new Error('cockpit-harness-oauth did not close cleanly.'));
    });
    return this.endPromise;
  }

  #data(chunk, child) {
    if (this.child !== child || this.closed) return;
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.#ended(child, new Error('cockpit-harness-oauth response exceeds the supported size.'));
      return;
    }
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); }
      catch {
        this.#ended(child, new Error('cockpit-harness-oauth returned invalid NDJSON.'));
        return;
      }
      const finish = this.pending.get(String(response?.id));
      if (!finish) continue;
      if (response && response.error) finish(backendError(responseError(response.error)));
      else if (response && Object.prototype.hasOwnProperty.call(response, 'result')) finish(undefined, response.result);
      else finish(new Error('cockpit-harness-oauth returned an incomplete response.'));
    }
  }

  #ended(child, error) {
    if (this.child !== child || this.closed) return;
    const wasClosing = this.closing;
    this.closed = true;
    this.closing = false;
    this.child = undefined;
    this.endReason = error ?? new Error('cockpit-harness-oauth stopped unexpectedly.');
    for (const finish of this.pending.values()) finish(this.endReason);
    this.pending.clear();
    this.buffer = '';
    if (!wasClosing && child.exitCode === null) {
      try { child.kill?.(); } catch { /* the process is already gone */ }
    }
    this.onExit?.(this.endReason);
  }
}

export { abortError };
