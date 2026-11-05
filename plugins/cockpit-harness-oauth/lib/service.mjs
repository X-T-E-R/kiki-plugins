import path from 'node:path';
import { NdjsonBackend, abortError } from './backend.mjs';
import { ENGINE_IDS } from './definitions.mjs';

const STATUS = new Set(['ready', 'signed_out', 'disabled']);
const PROXY_MODES = new Set(['system', 'direct', 'custom']);
const SETTINGS_KEYS = ['backendPath', 'sidecarPath', 'dataDir'];
const ENGINE_LABELS = {
  'agy-cli': 'AGY CLI',
  'codex-app-server': 'Codex app-server',
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`Configure ${label} before using Cockpit OAuth.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > 16_384 || /[\0\r\n]/.test(value)) {
    throw new Error(`Configure a valid ${label}; it must be a single path or identifier.`);
  }
  return value;
}

function absolutePath(value, label, { required = true } = {}) {
  const result = text(value, label, { required });
  if (!result) return '';
  if (!path.isAbsolute(result)) throw new Error(`${label} must be an absolute path on the Kiki server.`);
  return result;
}

function settingsFrom(context) {
  const settings = context?.settings;
  if (!isRecord(settings)) throw new Error('Kiki did not provide Cockpit OAuth settings. Configure backendPath and sidecarPath.');
  const normalized = {
    backendPath: absolutePath(settings.backendPath, 'backendPath'),
    sidecarPath: absolutePath(settings.sidecarPath, 'sidecarPath'),
    dataDir: absolutePath(settings.dataDir, 'dataDir', { required: false }),
  };
  return normalized;
}

function fingerprint(settings) {
  return SETTINGS_KEYS.map((key) => `${key}=${settings[key] ?? ''}`).join('\u0000');
}

function signalOrNever(signal) {
  return signal ?? new AbortController().signal;
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function engineIdOf(input) {
  const engineId = input?.engineId;
  if (typeof engineId !== 'string' || !ENGINE_IDS.includes(engineId)) {
    throw new Error('Choose AGY CLI or Codex app-server as the harness engine.');
  }
  return engineId;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new Error(`Provide a valid ${label}.`);
  }
  return value;
}

function proxyOf(value) {
  if (!isRecord(value) || !PROXY_MODES.has(value.mode)) {
    throw new Error('Choose a proxy mode: system, direct, or custom.');
  }
  // The Rust backend enum rejects unknown fields for system/direct. A URL is
  // meaningful only for custom mode; silently omit it for the other modes.
  if (value.mode !== 'custom') return { mode: value.mode };
  const url = value.url;
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096 || /[\0\r\n]/.test(url)) {
    throw new Error('Custom proxy mode requires a valid single-line proxy URL.');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Custom proxy URL must be a valid URL.'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    throw new Error('Custom proxy URL must use HTTP, HTTPS, SOCKS5, or SOCKS5H.');
  }
  // Authenticated proxies are supported by the backend and remain inside the
  // private request pipe; they are never rendered or logged by this plugin.
  return { mode: 'custom', url };
}

function metadataList(value) {
  if (!Array.isArray(value)) throw new Error('cockpit-harness-oauth returned an invalid account list.');
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('cockpit-harness-oauth returned invalid account metadata.');
    const id = requiredId(item.id, 'an account id');
    const label = requiredId(item.label, 'an account label');
    if (!STATUS.has(item.status)) throw new Error('cockpit-harness-oauth returned an invalid account status.');
    return { id, label, status: item.status };
  });
}

function preparedConnection(value) {
  if (!isRecord(value) || !isRecord(value.connection)) {
    throw new Error('cockpit-harness-oauth returned an invalid lease.');
  }
  const leaseId = requiredId(value.leaseId, 'a lease id');
  const connection = value.connection;
  const protocol = requiredId(connection.protocol, 'a connection protocol');
  const baseUrl = requiredId(connection.baseUrl, 'a connection base URL');
  const apiKey = requiredId(connection.apiKey, 'a connection API key');
  if (!Array.isArray(connection.modelIds) || connection.modelIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('cockpit-harness-oauth returned invalid model metadata.');
  }
  return {
    leaseId,
    connection: { protocol, baseUrl, apiKey, modelIds: [...connection.modelIds] },
  };
}

function configView(settings) {
  return {
    backendPath: settings?.backendPath ?? '',
    sidecarPath: settings?.sidecarPath ?? '',
    dataDir: settings?.dataDir ?? '',
  };
}

/**
 * Lifecycle owner for the fixed Cockpit OAuth sidecar contract. The service is
 * inert until list(), prepare(), or a panel refresh needs the backend.
 */
export class CockpitHarnessService {
  constructor({ backendFactory = (options) => new NdjsonBackend(options), spawnFn } = {}) {
    this.backendFactory = backendFactory;
    this.spawnFn = spawnFn;
    this.backend = undefined;
    this.backendSettings = undefined;
    this.backendFingerprint = undefined;
    this.activeLeases = new Set();
    this.cleanupFailures = new Map();
    this.pendingPrepares = 0;
    this.pendingCleanups = 0;
    this.inFlight = 0;
    this.startingBackend = undefined;
    this.startingFingerprint = undefined;
    this.closed = false;
    this.deactivating = undefined;
    this.parentEof = () => this.deactivate();
    if (process.stdin && typeof process.stdin.once === 'function') process.stdin.once('end', this.parentEof);
    this.adapter = {
      list: (input, context) => this.list(input, context),
      prepare: (input, context) => this.prepare(input, context),
      release: (input, context) => this.release(input, context),
    };
  }

  async list(input, context) {
    const engineId = engineIdOf(input);
    const signal = signalOrNever(context?.signal);
    checkAborted(signal);
    const backend = await this.#backend(context, signal);
    this.inFlight++;
    try {
      const result = await backend.request('list', { engineId }, { signal });
      return metadataList(result);
    } finally {
      this.inFlight--;
    }
  }

  async prepare(input, context) {
    const engineId = engineIdOf(input);
    const accountId = requiredId(input?.accountId, 'an account id');
    const instanceId = requiredId(input?.instanceId, 'an instance id');
    const proxy = proxyOf(input?.proxy);
    const signal = signalOrNever(context?.signal);
    checkAborted(signal);
    const backend = await this.#backend(context, signal);
    this.pendingPrepares++;
    this.inFlight++;
    const request = backend.request('prepare', { engineId, accountId, instanceId, proxy });
    let settled = false;
    let aborted = false;
    let cleanupPending = false;
    let rejectPending;
    const finishCleanupTracking = () => {
      if (!cleanupPending) return;
      cleanupPending = false;
      this.pendingCleanups--;
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      settled = true;
      cleanupPending = true;
      this.pendingCleanups++;
      rejectPending?.(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await new Promise((resolve, reject) => {
        rejectPending = reject;
        request.then((value) => {
          if (settled) {
            if (aborted) {
              void this.#releaseEventual(value, backend, true).finally(finishCleanupTracking);
            }
            return;
          }
          settled = true;
          resolve(value);
        }, (error) => {
          if (settled) {
            if (aborted) finishCleanupTracking();
            return;
          }
          settled = true;
          reject(error);
        });
        if (aborted || signal.aborted) onAbort();
      });
      const prepared = preparedConnection(result);
      if (signal.aborted || aborted) {
        void this.#releaseEventual(prepared, backend);
        throw abortError();
      }
      if (this.activeLeases.has(prepared.leaseId)) {
        void this.#releaseEventual(prepared, backend);
        throw new Error('cockpit-harness-oauth returned a duplicate lease id.');
      }
      this.activeLeases.add(prepared.leaseId);
      return prepared;
    } catch (error) {
      if (aborted || signal.aborted) throw abortError();
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.pendingPrepares--;
      this.inFlight--;
    }
  }

  async release(input, context) {
    const leaseId = requiredId(input?.leaseId, 'a lease id');
    // Release is idempotent and must not bring a broker back merely to release
    // a lease this plugin no longer owns (for example after backend EOF).
    if (!this.activeLeases.has(leaseId)) return {};
    const signal = signalOrNever(context?.signal);
    checkAborted(signal);
    const backend = await this.#backend(context, signal, { releaseLeaseId: leaseId });
    this.inFlight++;
    try {
      const result = await backend.request('release', { leaseId }, { signal });
      this.activeLeases.delete(leaseId);
      this.cleanupFailures.delete(leaseId);
      return result;
    } catch (error) {
      this.cleanupFailures.set(leaseId, { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.inFlight--;
    }
  }

  async panel(action, _args, context) {
    if (action === 'configuration') return { schemaVersion: 1, configuration: configView(context?.settings) };
    if (action !== 'refresh' && action !== 'status' && action !== 'accounts') throw new Error('Unknown Cockpit OAuth panel action.');
    const configuration = configView(context?.settings);
    const engines = [...ENGINE_IDS];
    const accounts = [];
    for (const engineId of engines) {
      try {
        accounts.push({ engineId, label: ENGINE_LABELS[engineId], items: await this.list({ engineId }, context) });
      } catch (error) {
        accounts.push({ engineId, label: ENGINE_LABELS[engineId], items: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { schemaVersion: 1, configuration, accounts };
  }

  async deactivate() {
    if (this.deactivating) return this.deactivating;
    this.closed = true;
    if (process.stdin && typeof process.stdin.removeListener === 'function') process.stdin.removeListener('end', this.parentEof);
    this.deactivating = (async () => {
      const starting = this.startingBackend;
      await starting?.catch(() => undefined);
      const backend = this.backend;
      this.backend = undefined;
      this.backendSettings = undefined;
      this.backendFingerprint = undefined;
      this.activeLeases.clear();
      this.cleanupFailures.clear();
      if (backend) await backend.close();
    })();
    return this.deactivating;
  }

  async #backend(context, signal, { releaseLeaseId } = {}) {
    if (this.closed) throw new Error('Cockpit OAuth plugin has been deactivated. Re-enable it before retrying.');
    const settings = settingsFrom(context);
    const nextFingerprint = fingerprint(settings);
    if (this.backendFingerprint && this.backendFingerprint !== nextFingerprint) {
      // An explicit release of a lease already owned by the old backend is the
      // safe recovery path; it does not restart or terminate that backend.
      const cleanupKnownLease = releaseLeaseId && this.activeLeases.has(releaseLeaseId) && this.backend?.running;
      if (cleanupKnownLease) return this.backend;
      if (this.activeLeases.size > 0 || this.pendingPrepares > 0 || this.pendingCleanups > 0 || this.inFlight > 0) {
        throw new Error('Cockpit OAuth backend settings changed while leases are active. Release all leases and finish pending operations before changing backendPath, sidecarPath, or dataDir.');
      }
      const old = this.backend;
      this.backend = undefined;
      this.backendSettings = undefined;
      this.backendFingerprint = undefined;
      if (old) await old.close();
    }
    if (this.backend?.running) return this.backend;
    if (this.activeLeases.size > 0 || this.pendingPrepares > 0 || this.pendingCleanups > 0) {
      throw new Error('Cockpit OAuth backend stopped while leases were active. Re-enable the plugin and release the existing leases before retrying.');
    }
    if (this.startingBackend) {
      if (this.startingFingerprint !== nextFingerprint) {
        throw new Error('Cockpit OAuth backend settings are changing while the backend starts. Finish that operation before changing backendPath, sidecarPath, or dataDir.');
      }
      return this.startingBackend;
    }
    checkAborted(signal);
    let backend;
    backend = this.backendFactory({
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      onExit: (error) => {
        if (this.backend === backend) {
          this.backend = undefined;
          this.backendSettings = undefined;
          this.backendFingerprint = undefined;
          this.activeLeases.clear();
          this.cleanupFailures.clear();
          this.backendExitError = error;
        }
      },
    });
    this.startingFingerprint = nextFingerprint;
    this.startingBackend = (async () => {
      await backend.start({ ...settings, kikiHome: context?.kikiHome });
      this.backend = backend;
      this.backendSettings = settings;
      this.backendFingerprint = nextFingerprint;
      return backend;
    })().finally(() => {
      this.startingBackend = undefined;
      this.startingFingerprint = undefined;
    });
    return this.startingBackend;
  }

  async #releaseEventual(prepared, backend, alreadyTracked = false) {
    const leaseId = prepared?.leaseId;
    if (!leaseId) return;
    // Never release a lease id already owned by another caller: a malformed
    // backend must not let aborted cleanup terminate an unrelated lease.
    if (this.activeLeases.has(leaseId)) return;
    if (!alreadyTracked) this.pendingCleanups++;
    this.activeLeases.add(leaseId);
    try {
      try {
        await backend.request('release', { leaseId });
        this.activeLeases.delete(leaseId);
        this.cleanupFailures.delete(leaseId);
      } catch (error) {
        // Keep the lease marked active and expose the concrete failure so the
        // lifecycle owner can report it or finish cleanup during deactivation.
        this.cleanupFailures.set(leaseId, {
          phase: 'eventual-release',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (!alreadyTracked) this.pendingCleanups--;
    }
  }
}

export { configView, settingsFrom, metadataList, preparedConnection };
