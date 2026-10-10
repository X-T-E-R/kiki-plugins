import { spawn } from 'node:child_process';

export function spawnOwned(file, args, options = {}) {
  return spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

export async function stopOwned(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done);
    child.once('error', done);
    child.kill('SIGTERM');
    timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
  });
}

export async function command(file, args, { env, signal, timeoutMs = 15000, limit = 1024 * 1024, spawnFn = spawnOwned } = {}) {
  signal?.throwIfAborted();
  const child = spawnFn(file, args, { env });
  return new Promise((resolve, reject) => {
    let text = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { void stopOwned(child); reject(error); } else resolve(text);
    };
    const abort = () => finish(new Error('Cloudflare operation cancelled.'));
    const timer = setTimeout(() => finish(new Error('Cloudflare operation timed out. Retry or check your connection.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (bytes) => {
      text += bytes.toString();
      if (Buffer.byteLength(text) > limit) finish(new Error('Cloudflare response exceeds the supported size.'));
    });
    child.stderr.resume();
    child.once('error', () => finish(new Error('Cannot run cloudflared. Install it or choose a working executable.')));
    child.once('exit', (code) => finish(code === 0 ? undefined : new Error('cloudflared rejected the operation. Check your credentials and configuration.')));
  });
}
