import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { buildGlobalArgs, resolveV42Binary, resolveV42Target, spawnV42Process, V42CliError } from './v42-client.mjs';

export async function allocateFreeLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function probeLoopbackPort(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPortReady(port, child, stderrState, maxWaitMs = 8_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (stderrState.spawnError) {
      throw new V42CliError(
        `Failed to spawn v42 forward process: ${stderrState.spawnError.message}`,
        { code: stderrState.spawnError.code || 'forward_spawn_error', exitCode: 1 },
      );
    }
    if (child.exitCode !== null || child.killed) {
      throw new V42CliError(
        stderrState.message || `v42 forward exited prematurely with code ${child.exitCode}`,
        { code: stderrState.code || 'forward_exited', exitCode: child.exitCode ?? 1 },
      );
    }
    if (stderrState.listening || (await probeLoopbackPort(port, 250))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new V42CliError(
    `Timed out waiting for port forward listener on 127.0.0.1:${port}`,
    { code: 'forward_timeout' },
  );
}

export class PortForwardManager {
  constructor({ env = process.env, leaseStore = null, spawnFn = spawnV42Process, resolveBin = resolveV42Binary } = {}) {
    this.env = env;
    this.leaseStore = leaseStore;
    this.spawnFn = spawnFn;
    this.resolveBin = resolveBin;
    this.tunnels = new Map();
  }

  keyOf(computer, remotePort) {
    return `${computer}:${Number(remotePort)}`;
  }

  async start({
    computer,
    remotePort,
    localPort,
    settings = {},
    workspaceRoot,
  }) {
    const rPort = Number(remotePort);
    if (!computer || !Number.isInteger(rPort) || rPort < 1 || rPort > 65535) {
      throw new V42CliError('port_forward_start requires computer and remote_port (1..65535)', { code: 'invalid_port' });
    }

    const key = this.keyOf(computer, rPort);
    const existing = this.tunnels.get(key);
    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      if (!localPort || Number(localPort) === existing.localPort) {
        const healthy = await probeLoopbackPort(existing.localPort, 350);
        return {
          ...existing.info,
          healthy: healthy || existing.stderrState.listening,
          reused: true,
        };
      }
      await this.stop({ computer, remotePort: rPort });
    }

    const chosenLocalPort = localPort ? Number(localPort) : await allocateFreeLocalPort();
    let bin;
    let companionRoot = null;
    let supportsCompanionRoot = true;
    if (this.resolveBin !== resolveV42Binary) {
      bin = await this.resolveBin({ settings, env: this.env, workspaceRoot });
    } else {
      const target = await resolveV42Target({ settings, env: this.env });
      bin = target.binPath;
      companionRoot = target.companionRoot;
      supportsCompanionRoot = target.capabilities?.hasCompanionRootFlag !== false && !target.capabilities?.isScript;
    }
    const listenAddr = `127.0.0.1:${chosenLocalPort}`;
    const argv = [
      ...buildGlobalArgs(settings, { companionRoot, supportsCompanionRoot }),
      'forward',
      `${computer}:${rPort}`,
      listenAddr,
    ];

    const child = this.spawnFn(bin, argv, {
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderrState = { listening: false, code: null, message: '', spawnError: null };

    child.once('error', (err) => {
      stderrState.spawnError = err;
      stderrState.code = err?.code || 'forward_spawn_error';
      stderrState.message = err?.message || String(err);
      if (this.tunnels.get(key) === record) {
        this.tunnels.delete(key);
        void this.leaseStore?.removeForward(computer, rPort).catch(() => {});
      }
    });

    const rl = child.stderr ? createInterface({ input: child.stderr }) : null;
    rl?.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.event === 'forward_listening') {
          stderrState.listening = true;
        } else if (parsed?.ok === false && parsed?.error) {
          stderrState.code = parsed.error.code;
          stderrState.message = parsed.error.message;
        }
      } catch {
        stderrState.message = trimmed;
      }
    });
    child.stdout?.resume?.();

    const startedAtMs = Date.now();
    const info = {
      key,
      computer: String(computer),
      remotePort: rPort,
      localPort: chosenLocalPort,
      listen: listenAddr,
      url: `http://${listenAddr}`,
      pid: child.pid,
      startedAtMs,
    };

    const record = { key, child, localPort: chosenLocalPort, info, stderrState };
    this.tunnels.set(key, record);

    child.once('exit', () => {
      rl?.close();
      if (this.tunnels.get(key) === record) {
        this.tunnels.delete(key);
        void this.leaseStore?.removeForward(computer, rPort).catch(() => {});
      }
    });

    try {
      await waitForPortReady(chosenLocalPort, child, stderrState);
    } catch (err) {
      this.tunnels.delete(key);
      rl?.close();
      try { child.kill(); } catch {}
      throw err;
    }

    const healthy = await probeLoopbackPort(chosenLocalPort, 400);
    await this.leaseStore?.upsertForward(computer, rPort, {
      computerName: String(computer),
      localPort: chosenLocalPort,
      listen: listenAddr,
      pid: child.pid,
      active: true,
      startedByKiki: true,
      startedAtMs,
    });

    return {
      ...info,
      healthy: healthy || stderrState.listening,
      reused: false,
    };
  }

  async stop({ computer, remotePort, localPort } = {}) {
    let targetRecord = null;
    if (computer && remotePort) {
      targetRecord = this.tunnels.get(this.keyOf(computer, remotePort)) || null;
    } else if (localPort) {
      for (const rec of this.tunnels.values()) {
        if ((!computer || rec.info.computer === String(computer)) && rec.localPort === Number(localPort)) {
          targetRecord = rec;
          break;
        }
      }
    }

    if (!targetRecord) {
      if (computer && remotePort) {
        await this.leaseStore?.removeForward(computer, remotePort).catch(() => {});
      }
      return { stopped: false, key: computer && remotePort ? this.keyOf(computer, remotePort) : null };
    }

    this.tunnels.delete(targetRecord.key);
    const { child, info } = targetRecord;
    if (child.exitCode === null && !child.killed) {
      try { child.kill(); } catch {}
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, 800);
        t.unref?.();
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    await this.leaseStore?.removeForward(info.computer, info.remotePort).catch(() => {});
    return {
      stopped: true,
      ...info,
    };
  }

  async list({ computer } = {}) {
    const out = [];
    for (const rec of this.tunnels.values()) {
      if (rec.child.exitCode !== null || rec.child.killed) continue;
      if (computer && rec.info.computer !== String(computer)) continue;
      const healthy = await probeLoopbackPort(rec.localPort, 250);
      out.push({
        ...rec.info,
        healthy: healthy || rec.stderrState.listening,
      });
    }
    return out;
  }

  async dispose() {
    const entries = [...this.tunnels.values()];
    this.tunnels.clear();
    await Promise.allSettled(
      entries.map(async ({ child }) => {
        if (child.exitCode === null && !child.killed) {
          try { child.kill(); } catch {}
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 500);
            t.unref?.();
            child.once('exit', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
      }),
    );
  }
}
