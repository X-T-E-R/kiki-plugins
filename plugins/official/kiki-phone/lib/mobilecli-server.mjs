import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const DEFAULT_MOBILECLI_PORT = 12000;
export const DEFAULT_MOBILECLI_URL = `ws://localhost:${DEFAULT_MOBILECLI_PORT}/ws`;

const managedServers = new Map();
const inflightStarts = new Map();

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function killProcessTree(proc, platform = process.platform) {
  if (!proc) return;
  if (platform === 'win32' && proc.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {}
  }
  try { proc.kill('SIGTERM'); } catch {}
}

export async function isMobilecliServerReachable(url = DEFAULT_MOBILECLI_URL, timeoutMs = 1_000) {
  let host = '127.0.0.1';
  let port = DEFAULT_MOBILECLI_PORT;
  try {
    const parsed = new URL(url);
    host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
    port = Number(parsed.port) || DEFAULT_MOBILECLI_PORT;
  } catch {}

  if (typeof globalThis.WebSocket === 'function') {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try { ws?.close?.(); } catch {}
        done(false);
      }, timeoutMs);
      timer.unref?.();
      let ws;
      try {
        ws = new globalThis.WebSocket(url);
      } catch {
        done(false);
        return;
      }
      ws.addEventListener('open', () => {
        try { ws.close(); } catch {}
        done(true);
      }, { once: true });
      ws.addEventListener('error', () => done(false), { once: true });
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host, port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export async function ensureMobilecliRuntimePatched(dataDir) {
  const distDir = path.join(dataDir, 'runtime', 'node_modules', '@mobilewright', 'driver-mobilecli', 'dist');
  let serverPatched = false;
  let driverPatched = false;

  const serverPath = path.join(distDir, 'server.js');
  try {
    const src = await readFile(serverPath, 'utf8');
    let next = src;
    if (!next.includes('windowsHide')) {
      next = next.replace(
        /(const proc = spawn\(binary,\s*serverArgs,\s*\{\s*stdio:\s*'pipe',\s*detached:\s*false,?)(\s*\}\);)/,
        "$1\n        windowsHide: true,$2",
      );
    }
    if (!next.includes("proc.on('error'")) {
      next = next.replace(
        /(const proc = spawn\(binary,\s*serverArgs,\s*\{[\s\S]*?\}\);)/,
        "$1\n    proc.on('error', () => {});",
      );
    }
    if (next !== src) {
      await writeFile(serverPath, next, 'utf8');
      serverPatched = true;
    }
  } catch {}

  const driverPath = path.join(distDir, 'driver.js');
  try {
    const src = await readFile(driverPath, 'utf8');
    let next = src;
    if (!next.includes('windowsHide')) {
      next = next.replaceAll(
        "{ encoding: 'utf8' }",
        "{ encoding: 'utf8', windowsHide: true }",
      );
    }
    if (next !== src) {
      await writeFile(driverPath, next, 'utf8');
      driverPatched = true;
    }
  } catch {}

  return { serverPatched, driverPatched };
}

export async function ensureMobilecliServer({
  binaryPath,
  port = DEFAULT_MOBILECLI_PORT,
  url,
  env = process.env,
  startupTimeoutMs = 10_000,
  pollIntervalMs = 200,
  spawnProcess = spawn,
  checkReachable = isMobilecliServerReachable,
  platform = process.platform,
} = {}) {
  let effectivePort = port;
  let effectiveUrl = url || `ws://localhost:${port}/ws`;
  if (url) {
    try {
      const parsed = new URL(url);
      effectivePort = Number(parsed.port) || port;
      effectiveUrl = url;
    } catch {}
  }

  if (await checkReachable(effectiveUrl, 1_200)) {
    return { url: effectiveUrl, started: false, serverProcess: managedServers.get(effectivePort) };
  }

  if (inflightStarts.has(effectivePort)) {
    return inflightStarts.get(effectivePort);
  }

  const startFlight = (async () => {
    if (await checkReachable(effectiveUrl, 1_000)) {
      return { url: effectiveUrl, started: false, serverProcess: managedServers.get(effectivePort) };
    }
    if (!binaryPath) {
      throw new Error(`mobilecli server is not running at ${effectiveUrl} and no mobilecli binary path was provided.`);
    }

    const args = ['server', 'start', '--listen', `localhost:${effectivePort}`];
    if (env?.DEBUG) args.push('--verbose');

    const proc = spawnProcess(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      env,
    });

    let spawnError = null;
    let exitedEarly = false;
    let exitCode = null;
    let stderrTail = '';

    proc.on('error', (err) => {
      spawnError = err;
    });
    proc.on('exit', (code) => {
      exitedEarly = true;
      exitCode = code;
      if (managedServers.get(effectivePort)?.process === proc) {
        managedServers.delete(effectivePort);
      }
    });

    const drain = (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-1024);
      if (env?.DEBUG) {
        process.stderr.write(chunk);
      }
    };
    proc.stdout?.on('data', drain);
    proc.stderr?.on('data', drain);

    const handle = {
      process: proc,
      url: effectiveUrl,
      kill: async () => {
        if (managedServers.get(effectivePort) === handle) {
          managedServers.delete(effectivePort);
        }
        killProcessTree(proc, platform);
        await new Promise((resolve) => {
          if (proc.exitCode !== null || proc.killed) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch {}
            resolve();
          }, 2_000);
          timer.unref?.();
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`Failed to spawn mobilecli server (${binaryPath}): ${spawnError.message}`);
      }
      if (exitedEarly) {
        if (await checkReachable(effectiveUrl, 800)) {
          return { url: effectiveUrl, started: false };
        }
        throw new Error(`mobilecli server exited prematurely (code=${exitCode}): ${stderrTail.trim() || 'no output'}`);
      }
      if (await checkReachable(effectiveUrl, 800)) {
        managedServers.set(effectivePort, handle);
        proc.unref?.();
        return { url: effectiveUrl, started: true, serverProcess: handle };
      }
      await sleep(pollIntervalMs);
    }

    await handle.kill().catch(() => {});
    throw new Error(`mobilecli server did not become ready at ${effectiveUrl} within ${startupTimeoutMs / 1000}s.${stderrTail.trim() ? ` (${stderrTail.trim()})` : ''}`);
  })().finally(() => {
    inflightStarts.delete(effectivePort);
  });

  inflightStarts.set(effectivePort, startFlight);
  return startFlight;
}

export async function disposeMobilecliServers() {
  const handles = [...managedServers.values()];
  managedServers.clear();
  await Promise.all(handles.map((h) => h.kill().catch(() => {})));
}
