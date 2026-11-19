import { spawn } from 'node:child_process';
import { findAdb } from './environment.mjs';

const ADB_DRAIN_GRACE_MS = 50;
const ADB_START_SERVER_TIMEOUT_MS = 5_000;
const startedAdbServers = new Map();

function isAdbBinary(file) {
  return /(?:^|[\\/])adb(?:\.exe)?$/i.test(String(file || ''));
}

function shouldSkipStartServer(args) {
  const first = String(args?.[0] || '').toLowerCase();
  return first === 'version' || first === 'start-server' || first === 'kill-server' || first === 'help';
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
  try { proc.kill('SIGKILL'); } catch {
    try { proc.kill(); } catch {}
  }
}

export function resetAdbServerCache() {
  startedAdbServers.clear();
}

export function ensureAdbServerStarted(adbBinary, options = {}) {
  if (!isAdbBinary(adbBinary)) return Promise.resolve();
  const key = String(adbBinary).toLowerCase();
  const existing = startedAdbServers.get(key);
  if (existing) return existing;

  const flight = new Promise((resolve) => {
    const platform = options.platform ?? process.platform;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', onAbort);
      resolve();
    };

    let proc;
    try {
      proc = spawn(adbBinary, ['start-server'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        env: options.env,
        cwd: options.cwd,
      });
    } catch {
      startedAdbServers.delete(key);
      resolve();
      return;
    }

    const onAbort = () => {
      killProcessTree(proc, platform);
      startedAdbServers.delete(key);
      finish();
    };

    const waitMs = Math.min(ADB_START_SERVER_TIMEOUT_MS, Number(options.timeout) > 0 ? Number(options.timeout) : ADB_START_SERVER_TIMEOUT_MS);
    const timer = setTimeout(() => {
      finish();
    }, waitMs);
    timer.unref?.();

    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    proc.once('error', () => {
      startedAdbServers.delete(key);
      finish();
    });
    proc.once('exit', (code) => {
      if (code !== 0) startedAdbServers.delete(key);
      finish();
    });
    proc.unref?.();
  });

  startedAdbServers.set(key, flight);
  return flight;
}

export async function execAdb(file, args = [], options = {}) {
  const {
    encoding = 'utf8',
    env,
    cwd,
    timeout = 0,
    maxBuffer = 8 * 1024 * 1024,
    signal,
    drainGraceMs = ADB_DRAIN_GRACE_MS,
    platform = process.platform,
    skipStartServer = false,
  } = options;

  if (signal?.aborted) {
    throw Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
      killed: true,
      stdout: '',
      stderr: '',
    });
  }

  if (!skipStartServer && isAdbBinary(file) && !shouldSkipStartServer(args)) {
    await ensureAdbServerStarted(file, { env, cwd, timeout, signal, platform });
    if (signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
        killed: true,
        stdout: '',
        stderr: '',
      });
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
      cwd,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutEnded = !child.stdout;
    let stderrEnded = !child.stderr;
    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let killed = false;
    let timedOut = false;
    let aborted = false;
    let drainTimer = null;
    let timeoutTimer = null;

    const decode = (chunks) => {
      const buf = Buffer.concat(chunks);
      return encoding === 'buffer' || encoding === null ? buf : buf.toString(encoding);
    };

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener?.('abort', onAbort);
    };

    const destroyPipes = () => {
      try { child.stdout?.removeAllListeners(); child.stdout?.destroy(); } catch {}
      try { child.stderr?.removeAllListeners(); child.stderr?.destroy(); } catch {}
    };

    const settle = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = decode(stdoutChunks);
      const stderr = decode(stderrChunks);
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      if (aborted) {
        reject(Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
          killed: true,
          stdout,
          stderr,
        }));
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error(`Command timed out after ${timeout}ms`), {
          code: exitCode,
          killed: true,
          signal: exitSignal || 'SIGTERM',
          stdout,
          stderr,
        }));
        return;
      }
      if (exitCode === 0 && !exitSignal) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(`Command failed with exit code ${exitCode ?? exitSignal}`), {
        code: exitCode,
        signal: exitSignal,
        killed,
        stdout,
        stderr,
      }));
    };

    const maybeFinishAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        settle(null);
      }
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killed = true;
      killProcessTree(child, platform);
      destroyPipes();
      settle(null);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    if (Number(timeout) > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killed = true;
        killProcessTree(child, platform);
        destroyPipes();
        settle(null);
      }, timeout);
      timeoutTimer.unref?.();
    }

    const onMaxBuffer = (streamName) => {
      if (settled) return;
      killed = true;
      killProcessTree(child, platform);
      destroyPipes();
      settle(Object.assign(new Error(`${streamName} maxBuffer length exceeded`), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
      }));
    };

    child.stdout?.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.length;
      if (maxBuffer > 0 && stdoutBytes > maxBuffer) {
        onMaxBuffer('stdout');
        return;
      }
      stdoutChunks.push(buf);
    });
    child.stdout?.once('end', () => {
      stdoutEnded = true;
      maybeFinishAfterExit();
    });
    child.stdout?.once('error', () => {
      stdoutEnded = true;
      maybeFinishAfterExit();
    });

    child.stderr?.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buf.length;
      if (maxBuffer > 0 && stderrBytes > maxBuffer) {
        onMaxBuffer('stderr');
        return;
      }
      stderrChunks.push(buf);
    });
    child.stderr?.once('end', () => {
      stderrEnded = true;
      maybeFinishAfterExit();
    });
    child.stderr?.once('error', () => {
      stderrEnded = true;
      maybeFinishAfterExit();
    });

    child.once('error', (err) => {
      destroyPipes();
      settle(err);
    });

    child.once('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      if (stdoutEnded && stderrEnded) {
        settle(null);
        return;
      }
      // On Windows, adb may spawn a background daemon inheriting stdout/stderr pipes.
      // Give pipes a brief grace window to flush buffered output, then destroy them
      // and resolve promptly instead of hanging until timeout.
      drainTimer = setTimeout(() => {
        destroyPipes();
        child.unref?.();
        settle(null);
      }, Math.max(10, Number(drainGraceMs) || ADB_DRAIN_GRACE_MS));
      drainTimer.unref?.();
    });

    child.once('close', (code, sig) => {
      if (!exited) {
        exited = true;
        exitCode = code;
        exitSignal = sig;
      }
      stdoutEnded = true;
      stderrEnded = true;
      settle(null);
    });
  });
}

const nonempty = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL characters.`);
  return value;
};
const target = (value, name) => {
  nonempty(value, name);
  if (value.startsWith('-')) throw new Error(`${name} must not start with '-'.`);
  return value;
};
// adb shell joins its arguments before invoking the device shell. Quote there,
// not in a local shell; su -c needs a second quoting level for its command.
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function adbArguments(name, args) {
  if (name === 'android_connection') {
    switch (args.action) {
      case 'devices': return ['devices', '-l'];
      case 'pair': return ['pair', target(args.address, 'address'), nonempty(args.code, 'code')];
      case 'connect': return ['connect', target(args.address, 'address')];
      case 'disconnect': return ['disconnect', target(args.address, 'address')];
      default: throw new Error('Choose devices, pair, connect or disconnect.');
    }
  }
  if (name === 'android_shell') {
    target(args.serial, 'serial');
    if (!Array.isArray(args.argv) || args.argv.length === 0 || args.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !args.argv[0]) {
      throw new Error('argv must contain a command followed by string arguments, without NUL characters.');
    }
    const command = args.argv.map(quote).join(' ');
    return ['-s', args.serial, 'shell', args.root ? `su -c ${quote(command)}` : command];
  }
  throw new Error(`Unknown phone tool: ${name}`);
}

export async function runAdb(name, args, context = {}, execute = execAdb) {
  try {
    const argv = adbArguments(name, args);
    const binary = context.settings?.adbPath || await findAdb({ dataDir: context.dataDir }) || 'adb';
    const { stdout, stderr } = await execute(binary, argv, {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024, signal: context.signal,
    });
    return { output: JSON.stringify({ exitCode: 0, stdout, stderr }) };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return {
      isError: true,
      output: JSON.stringify({
        exitCode: typeof error.code === 'number' ? error.code : null,
        code: typeof error.code === 'string' ? error.code : undefined,
        message: missing ? 'ADB executable not found (ENOENT). Run phone_prepare({ download: true }) after user consent, install official Android platform-tools on PATH, or set plugin setting adbPath.'
          : error.killed || error.name === 'AbortError' ? 'ADB command interrupted; inspect device state via android_connection({ action: "devices" }) before repeating a modifying command.'
            : error.stderr?.trim() || (typeof error.code === 'number' ? 'ADB command failed; inspect stdout/stderr and run android_connection({ action: "devices" }) if the transport dropped.' : error.message),
        stdout: error.stdout ?? '', stderr: error.stderr ?? '',
      }),
    };
  }
}
