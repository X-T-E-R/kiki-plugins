import { lstat as lstatFile, open as openFile, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildErrorSignature,
  extractLineObservations,
  extractSessionMetaFromRelPath,
  formatErrorPreview,
  formatWorkspaceLabel,
} from './signature.mjs';
import {
  MAX_PENDING_CALLS_SAVED,
  pruneIndex,
  queryIndexReport,
  readIndexFile,
  recordErrorSignatureInIndex,
  recordStreakTransitionInIndex,
  recordToolCallInIndex,
  writeIndexAtomic,
} from './store.mjs';

export const PLUGIN_ID = 'kiki-error-pulse';
export const DEFAULT_STARTUP_DELAY_MS = 10_000;
export const DEFAULT_SCAN_INTERVAL_MINUTES = 30;
export const DEFAULT_MAX_MEGABYTES_PER_TICK = 16;
export const READ_CHUNK_BYTES = 256 * 1024;
export const COLD_LARGE_FILE_BYTES = 4 * 1024 * 1024;
export const COLD_TAIL_WINDOW_BYTES = 2 * 1024 * 1024;
export const TRACKED_CATCHUP_JUMP_BYTES = 64 * 1024 * 1024;
export const MAX_SINGLE_LINE_BYTES = 8 * 1024 * 1024;
export const TIME_SLICE_BUDGET_MS = 6;
export const FILES_PER_YIELD = 3;

const TRANSIENT_FS_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY']);
function isSkippableFsError(error) {
  return Boolean(error && typeof error.code === 'string' && TRANSIENT_FS_ERROR_CODES.has(error.code));
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

export function resolvePulseSettings(rawSettings = {}) {
  const s = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  return {
    autoScanEnabled: typeof s.autoScanEnabled === 'boolean' ? s.autoScanEnabled : true,
    scanIntervalMinutes: clampInt(s.scanIntervalMinutes, DEFAULT_SCAN_INTERVAL_MINUTES, 5, 1440),
    maxScanMegabytesPerTick: clampInt(s.maxScanMegabytesPerTick, DEFAULT_MAX_MEGABYTES_PER_TICK, 2, 64),
  };
}

export function resolvePulsePaths(context = {}, deps = {}) {
  let kikiHome = '';
  if (typeof deps.kikiHome === 'string' && deps.kikiHome.trim()) {
    kikiHome = path.resolve(deps.kikiHome.trim());
  } else if (typeof context?.kikiHome === 'string' && context.kikiHome.trim()) {
    kikiHome = path.resolve(context.kikiHome.trim());
  } else if (typeof context?.dataDir === 'string' && context.dataDir.trim()) {
    const resolvedData = path.resolve(context.dataDir.trim());
    const parent1 = path.dirname(resolvedData);
    const parent2 = path.dirname(parent1);
    if (path.basename(parent1) === 'data' && path.basename(parent2) === 'plugins') {
      kikiHome = path.dirname(parent2);
    }
  }

  if (!kikiHome) {
    const envHome = typeof deps.env?.KIKI_HOME === 'string' ? deps.env.KIKI_HOME : process.env.KIKI_HOME;
    if (typeof envHome === 'string' && envHome.trim()) {
      kikiHome = path.resolve(envHome.trim());
    } else {
      const userHome =
        typeof context?.userHome === 'string' && context.userHome.trim() ? context.userHome.trim() : os.homedir();
      kikiHome = path.join(userHome, '.kiki');
    }
  }

  const sessionsDir = path.join(kikiHome, 'sessions');
  const dataDir =
    !deps.kikiHome && typeof context?.dataDir === 'string' && context.dataDir.trim()
      ? path.resolve(context.dataDir.trim())
      : path.join(kikiHome, 'plugins', 'data', PLUGIN_ID);
  const indexPath = path.join(dataDir, 'index-v1.json');

  return { kikiHome, sessionsDir, dataDir, indexPath };
}

function yieldImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function hydrateFileRuntimeState(savedFileMeta) {
  const pendingCalls = new Map();
  const savedPending = savedFileMeta?.tailState?.pendingCalls;
  if (Array.isArray(savedPending)) {
    for (const pair of savedPending) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] && typeof pair[1] === 'object') {
        pendingCalls.set(pair[0], pair[1]);
      }
    }
  }
  const activeStreak =
    savedFileMeta?.tailState?.activeStreak && typeof savedFileMeta.tailState.activeStreak === 'object'
      ? { ...savedFileMeta.tailState.activeStreak }
      : null;
  return { pendingCalls, activeStreak };
}

function serializeTailState(runtimeState) {
  const pendingEntries = [...runtimeState.pendingCalls.entries()].slice(-MAX_PENDING_CALLS_SAVED);
  const activeStreak = runtimeState.activeStreak ? { ...runtimeState.activeStreak } : null;
  if (pendingEntries.length === 0 && !activeStreak) return undefined;
  return {
    ...(pendingEntries.length > 0 ? { pendingCalls: pendingEntries } : {}),
    ...(activeStreak ? { activeStreak } : {}),
  };
}

function iterateCompleteLines(text, onLine) {
  let start = 0;
  const len = text.length;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? len : nl;
    const line = end > start && text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end);
    if (line.length > 0) onLine(line);
    if (nl === -1) break;
    start = nl + 1;
  }
}

export class ErrorPulseService {
  constructor(deps = {}) {
    this.deps = deps;
    this.appContext = undefined;
    this.active = false;
    this.startupTimer = null;
    this.intervalTimer = null;
    this.currentAbortController = null;
    this.inFlightPromise = null;
    this.cachedIndex = null;
    this.cachedIndexPath = '';
    this.sessionWorkspaceCache = new Map();
  }

  now() {
    return typeof this.deps.now === 'function' ? this.deps.now() : Date.now();
  }

  async activate(context = {}) {
    await this.deactivate();
    this.appContext = context;
    this.active = true;

    if (context?.signal) {
      if (context.signal.aborted) {
        this.active = false;
        return { ok: true, activated: false };
      }
      context.signal.addEventListener(
        'abort',
        () => {
          void this.deactivate();
        },
        { once: true },
      );
    }

    const settings = resolvePulseSettings(context?.settings);
    if (settings.autoScanEnabled) {
      const startupDelayMs =
        typeof this.deps.startupDelayMs === 'number' ? Math.max(0, this.deps.startupDelayMs) : DEFAULT_STARTUP_DELAY_MS;
      const intervalMs =
        typeof this.deps.intervalMs === 'number'
          ? Math.max(50, this.deps.intervalMs)
          : settings.scanIntervalMinutes * 60_000;

      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        if (!this.active) return;
        void this.scanIncremental({ reason: 'startup', context: this.appContext }).catch(() => {});
      }, startupDelayMs);
      this.startupTimer.unref?.();

      this.intervalTimer = setInterval(() => {
        if (!this.active) return;
        void this.scanIncremental({ reason: 'interval', context: this.appContext }).catch(() => {});
      }, intervalMs);
      this.intervalTimer.unref?.();
    }

    return {
      ok: true,
      activated: true,
      autoScanEnabled: settings.autoScanEnabled,
      scanIntervalMinutes: settings.scanIntervalMinutes,
      maxScanMegabytesPerTick: settings.maxScanMegabytesPerTick,
    };
  }

  async deactivate() {
    this.active = false;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
    if (this.inFlightPromise) {
      await this.inFlightPromise.catch(() => {});
    }
  }

  effectiveContext(callContext) {
    if (!callContext && !this.appContext) return {};
    return {
      ...(this.appContext || {}),
      ...(callContext || {}),
      settings: callContext?.settings ?? this.appContext?.settings ?? {},
    };
  }

  async loadIndex(context) {
    const paths = resolvePulsePaths(this.effectiveContext(context), this.deps);
    if (this.cachedIndex && this.cachedIndexPath === paths.indexPath) {
      return { exists: Boolean(this.cachedIndex.updatedAt), index: this.cachedIndex, paths };
    }
    const loaded = await readIndexFile(paths.indexPath);
    if (loaded.exists) {
      pruneIndex(loaded.index, this.now());
      this.cachedIndex = loaded.index;
      this.cachedIndexPath = paths.indexPath;
    }
    return { ...loaded, paths };
  }

  /**
   * Single-flight incremental scan with O(1) unchanged skip, cold-file 2 MiB tail window,
   * 256 KiB chunked Buffer newline reader, hard byte budget, and cooperative setImmediate yielding.
   */
  async scanIncremental({ reason = 'manual', maxMegabytes, context, signal } = {}) {
    if (this.inFlightPromise) {
      const flightResult = await this.inFlightPromise;
      return { ...flightResult, reusedInFlight: true };
    }

    const effContext = this.effectiveContext(context);
    const settings = resolvePulseSettings(effContext.settings);
    const budgetMb =
      maxMegabytes !== undefined
        ? clampInt(maxMegabytes, settings.maxScanMegabytesPerTick, 1, 64)
        : settings.maxScanMegabytesPerTick;
    const budgetBytes =
      typeof this.deps.maxBytesOverride === 'number' && this.deps.maxBytesOverride > 0
        ? this.deps.maxBytesOverride
        : budgetMb * 1024 * 1024;

    const controller = new AbortController();
    this.currentAbortController = controller;
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const runPromise = this.#executeScan({
      reason,
      budgetBytes,
      effContext,
      signal: controller.signal,
    }).finally(() => {
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      if (this.currentAbortController === controller) this.currentAbortController = null;
      if (this.inFlightPromise === runPromise) this.inFlightPromise = null;
    });

    this.inFlightPromise = runPromise;
    return runPromise;
  }

  async #resolveSessionWorkspace(sessionsDir, sessionRelDir, fallbackLabel, savedWorkspace) {
    if (savedWorkspace && savedWorkspace !== 'default' && !savedWorkspace.startsWith('ws_')) {
      return savedWorkspace;
    }
    if (!sessionRelDir) return fallbackLabel;
    if (this.sessionWorkspaceCache.has(sessionRelDir)) {
      return this.sessionWorkspaceCache.get(sessionRelDir);
    }
    let resolved = fallbackLabel;
    try {
      const stateText = await readFile(path.join(sessionsDir, sessionRelDir, 'state.json'), 'utf8');
      const parsed = JSON.parse(stateText);
      if (typeof parsed?.cwd === 'string' && parsed.cwd.trim()) {
        resolved = formatWorkspaceLabel(parsed.cwd);
      }
    } catch {
      // Ignore absent or unreadable state.json.
    }
    if (this.sessionWorkspaceCache.size > 2000) this.sessionWorkspaceCache.clear();
    this.sessionWorkspaceCache.set(sessionRelDir, resolved);
    return resolved;
  }

  async #executeScan({ reason, budgetBytes, effContext, signal }) {
    const startedAtPerf = performance.now();
    const nowMs = this.now();
    const paths = resolvePulsePaths(effContext, this.deps);
    const { exists: indexExisted, index } = await readIndexFile(paths.indexPath);
    const { prunedFiles: retentionPrunedFiles } = pruneIndex(index, nowMs);

    const fsReaddir = this.deps.readdir ?? readdir;
    const fsStat = this.deps.statFile ?? lstatFile;
    const fsOpen = this.deps.openFile ?? openFile;
    const maxSingleLineBytes =
      typeof this.deps.maxSingleLineBytes === 'number' && this.deps.maxSingleLineBytes >= 256
        ? Math.trunc(this.deps.maxSingleLineBytes)
        : MAX_SINGLE_LINE_BYTES;
    const catchupJumpBytes =
      typeof this.deps.catchupJumpBytes === 'number' && this.deps.catchupJumpBytes > 0
        ? Math.trunc(this.deps.catchupJumpBytes)
        : TRACKED_CATCHUP_JUMP_BYTES;

    const chunkBytes =
      typeof this.deps.chunkBytes === 'number' && this.deps.chunkBytes >= 64
        ? Math.trunc(this.deps.chunkBytes)
        : READ_CHUNK_BYTES;

    let yieldCount = 0;
    let sliceStart = performance.now();
    let filesSinceYield = 0;
    let dirOpsSinceYield = 0;

    const maybeYield = async (force = false) => {
      const elapsed = performance.now() - sliceStart;
      if (force || elapsed >= TIME_SLICE_BUDGET_MS) {
        yieldCount += 1;
        filesSinceYield = 0;
        dirOpsSinceYield = 0;
        if (typeof this.deps.onYield === 'function') this.deps.onYield(yieldCount);
        await yieldImmediate();
        sliceStart = performance.now();
      }
    };

    const safeReadDir = async (dir) => {
      try {
        return await fsReaddir(dir, { withFileTypes: true });
      } catch (error) {
        if (isSkippableFsError(error)) return [];
        throw error;
      }
    };

    const probeWireFile = async (fullPath) => {
      try {
        const st = await fsStat(fullPath);
        if (!st || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) || !st.isFile()) {
          return null;
        }
        const relKey = path.relative(paths.sessionsDir, fullPath).replace(/\\/g, '/');
        return { fullPath, relKey, st };
      } catch (error) {
        if (isSkippableFsError(error)) return null;
        throw error;
      }
    };

    // 1. Discover wire.jsonl strictly in the actual Kiki session layout:
    //    <workspace>/<session>/wire.jsonl and <workspace>/<session>/agents/<agent>/wire.jsonl
    //    Never descend into replay-checkpoints, prompt-ingress, agent-outcomes, ego-scripts,
    //    ego-shots, request-identity, agent-message-receipts, media-originals, or wire-segments.
    const discoveredWireFiles = [];
    const workspaceDirs = [];
    const rootEntries = await safeReadDir(paths.sessionsDir);
    for (const entry of rootEntries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name === 'tmp' || entry.name === '.tmp') continue;
      workspaceDirs.push(path.join(paths.sessionsDir, entry.name));
    }

    const sessionDirs = [];
    for (let i = 0; i < workspaceDirs.length; i += 16) {
      signal.throwIfAborted();
      const batch = workspaceDirs.slice(i, i + 16);
      const batchResults = await Promise.all(
        batch.map(async (wsDir) => ({ wsDir, entries: await safeReadDir(wsDir) })),
      );
      for (const { wsDir, entries } of batchResults) {
        for (const entry of entries) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
          if (entry.name === 'tmp' || entry.name === '.tmp') continue;
          sessionDirs.push(path.join(wsDir, entry.name));
        }
      }
      dirOpsSinceYield += batch.length;
      if (dirOpsSinceYield >= 32) await maybeYield(false);
    }

    for (let i = 0; i < sessionDirs.length; i += 16) {
      signal.throwIfAborted();
      const batch = sessionDirs.slice(i, i + 16);
      const batchResults = await Promise.all(
        batch.map(async (sessionDir) => {
          const found = [];
          const rootWire = await probeWireFile(path.join(sessionDir, 'wire.jsonl'));
          if (rootWire) found.push(rootWire);

          const agentsDir = path.join(sessionDir, 'agents');
          const agentEntries = await safeReadDir(agentsDir);
          const agentDirs = agentEntries
            .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
            .map((entry) => path.join(agentsDir, entry.name));
          if (agentDirs.length > 0) {
            const agentWires = await Promise.all(
              agentDirs.map((agentDir) => probeWireFile(path.join(agentDir, 'wire.jsonl'))),
            );
            for (const wire of agentWires) {
              if (wire) found.push(wire);
            }
          }
          return found;
        }),
      );
      for (const items of batchResults) {
        for (const wire of items) discoveredWireFiles.push(wire);
      }
      dirOpsSinceYield += batch.length;
      if (dirOpsSinceYield >= 32) await maybeYield(false);
    }
    discoveredWireFiles.sort((a, b) => (a.relKey < b.relKey ? -1 : a.relKey > b.relKey ? 1 : 0));

    let filesScanned = 0;
    let filesSkippedUnchanged = 0;
    let totalBytesRead = 0;
    let budgetPaused = false;
    const seenKeys = new Set();
    const newlyScannedKeys = new Set();
    const scratchBuf = Buffer.allocUnsafe(chunkBytes);
    const coldBootstrapCutoffMs = nowMs - 7 * 24 * 3600 * 1000;
    const dirtyFiles = [];

    for (const { fullPath, relKey, st } of discoveredWireFiles) {
      seenKeys.add(relKey);
      const saved = index.files[relKey];
      // O(1) unchanged check: zero open(), zero read()!
      if (
        saved &&
        !saved.partial &&
        st.size === saved.size &&
        Math.floor(st.mtimeMs) === Math.floor(saved.mtimeMs)
      ) {
        filesSkippedUnchanged += 1;
        continue;
      }
      // Skip cold/archival logs unmodified within the cold bootstrap window without inserting into index.files.
      if (!saved && st.mtimeMs > 0 && st.mtimeMs < coldBootstrapCutoffMs) {
        filesSkippedUnchanged += 1;
        continue;
      }
      dirtyFiles.push({ fullPath, relKey, st, saved });
    }

    // Prioritize newest active session logs first so bounded ticks always capture fresh errors immediately.
    dirtyFiles.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

    for (const { fullPath, relKey, st, saved } of dirtyFiles) {
      signal.throwIfAborted();

      if (totalBytesRead >= budgetBytes) {
        budgetPaused = true;
        break;
      }

      // Determine starting byte cursor.
      let startOffset = 0;
      let skipFirstPartialLine = false;
      let runtimeState;

      if (!saved) {
        runtimeState = { pendingCalls: new Map(), activeStreak: null };
        if (st.size > COLD_LARGE_FILE_BYTES) {
          startOffset = st.size - COLD_TAIL_WINDOW_BYTES;
          skipFirstPartialLine = true;
        }
      } else if (st.size < saved.offset) {
        // File truncated or replaced with a smaller log.
        runtimeState = { pendingCalls: new Map(), activeStreak: null };
        if (st.size > COLD_LARGE_FILE_BYTES) {
          startOffset = st.size - COLD_TAIL_WINDOW_BYTES;
          skipFirstPartialLine = true;
        } else {
          startOffset = 0;
        }
      } else if (st.size - saved.offset > catchupJumpBytes) {
        // Tracked file grew by >64 MiB since last cursor: jump directly to fresh tail window.
        runtimeState = { pendingCalls: new Map(), activeStreak: null };
        startOffset = Math.max(0, st.size - COLD_TAIL_WINDOW_BYTES);
        skipFirstPartialLine = startOffset > 0;
      } else {
        startOffset = saved.offset;
        skipFirstPartialLine = Boolean(saved.discardingLine);
        runtimeState = hydrateFileRuntimeState(saved);
      }

      if (st.size === startOffset) {
        index.files[relKey] = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          offset: startOffset,
          ...(saved?.discardingLine ? { discardingLine: true } : {}),
          ...(saved?.workspace ? { workspace: saved.workspace } : {}),
          ...(saved?.tailState ? { tailState: saved.tailState } : {}),
        };
        filesSkippedUnchanged += 1;
        continue;
      }

      const pathMeta = extractSessionMetaFromRelPath(relKey);
      const workspaceLabel = await this.#resolveSessionWorkspace(
        paths.sessionsDir,
        pathMeta.sessionRelDir,
        pathMeta.workspaceFallback,
        saved?.workspace,
      );

      let pos = startOffset;
      let committedOffset = startOffset;
      let hitBudgetInFile = false;
      let carryChunks = [];
      let carryLen = 0;
      let oversizeLineDiscard = false;
      const fallbackTsMs = Math.floor(st.mtimeMs) || nowMs;

      const processSingleLine = (line, approxOffset) => {
        const observations = extractLineObservations(line, runtimeState, fallbackTsMs);
        if (!observations) return;
        const scanNowMs = this.now();

        for (const obs of observations) {
          const effWorkspace = obs.workspace ? formatWorkspaceLabel(obs.workspace) : workspaceLabel;
          const effSessionId = obs.sessionId || pathMeta.sessionId;
          const effAgentId = obs.agentId || pathMeta.agentId;

          if (obs.type === 'tool_call') {
            recordToolCallInIndex(index, { tool: obs.tool, timestamp: obs.timestamp }, scanNowMs);
            continue;
          }

          if (obs.type === 'tool_outcome') {
            if (!obs.isError) {
              if (!obs.countedCall) {
                recordToolCallInIndex(index, { tool: obs.tool, timestamp: obs.timestamp }, scanNowMs);
              }
              runtimeState.activeStreak = null;
              continue;
            }

            const sig = buildErrorSignature({
              kind: 'tool',
              tool: obs.tool,
              rawError: obs.rawError,
              exitCode: obs.exitCode,
            });
            const errorPreview = formatErrorPreview(obs.rawError, 240);
            const sample = {
              workspace: effWorkspace,
              sessionId: effSessionId,
              agentId: effAgentId,
              timestamp: obs.timestamp,
              tool: obs.tool,
              argsPreview: obs.argsPreview || '',
              errorPreview,
            };

            recordErrorSignatureInIndex(
              index,
              {
                sig,
                sample,
                timestamp: obs.timestamp,
                isLifecycle: false,
                countUncountedToolCall: !obs.countedCall,
              },
              scanNowMs,
            );

            if (runtimeState.activeStreak && runtimeState.activeStreak.tool === obs.tool) {
              runtimeState.activeStreak.count += 1;
              runtimeState.activeStreak.updatedAt = obs.timestamp;
              runtimeState.activeStreak.signatureId = sig.id;
              runtimeState.activeStreak.signature = sig.signature;
              runtimeState.activeStreak.errorPreview = errorPreview;
              recordStreakTransitionInIndex(index, runtimeState.activeStreak, scanNowMs);
            } else {
              runtimeState.activeStreak = {
                streakId: `${effSessionId}:${effAgentId}:${approxOffset}:${obs.timestamp}`,
                tool: obs.tool,
                count: 1,
                signatureId: sig.id,
                signature: sig.signature,
                startedAt: obs.timestamp,
                updatedAt: obs.timestamp,
                workspace: effWorkspace,
                sessionId: effSessionId,
                agentId: effAgentId,
                errorPreview,
              };
            }
            continue;
          }

          if (obs.type === 'lifecycle_error') {
            const sig = buildErrorSignature({
              kind: 'lifecycle',
              tool: obs.lifecycleType,
              rawError: obs.rawError,
            });
            const sample = {
              workspace: effWorkspace,
              sessionId: effSessionId,
              agentId: effAgentId,
              timestamp: obs.timestamp,
              tool: obs.lifecycleType,
              argsPreview: obs.argsPreview || '',
              errorPreview: formatErrorPreview(obs.rawError, 240),
            };
            recordErrorSignatureInIndex(
              index,
              { sig, sample, timestamp: obs.timestamp, isLifecycle: true },
              scanNowMs,
            );
          }
        }
      };

      let fh;
      try {
        fh = await fsOpen(fullPath, 'r');
      } catch (error) {
        if (isSkippableFsError(error)) continue;
        throw error;
      }
      let skippedFileOnError = false;
      try {
        while (pos < st.size) {
          signal.throwIfAborted();
          const budgetLeft = budgetBytes - totalBytesRead;
          if (budgetLeft <= 0) {
            hitBudgetInFile = true;
            budgetPaused = true;
            break;
          }

          const toRead = Math.min(chunkBytes, st.size - pos, budgetLeft);
          const { bytesRead } = await fh.read(scratchBuf, 0, toRead, pos);
          if (bytesRead <= 0) break;

          totalBytesRead += bytesRead;
          let slice = scratchBuf.subarray(0, bytesRead);
          let sliceBaseOffset = pos;
          pos += bytesRead;

          if (skipFirstPartialLine) {
            const firstNl = slice.indexOf(0x0a);
            if (firstNl === -1) {
              committedOffset = pos;
              await maybeYield(false);
              continue;
            }
            skipFirstPartialLine = false;
            committedOffset = sliceBaseOffset + firstNl + 1;
            sliceBaseOffset = committedOffset;
            slice = slice.subarray(firstNl + 1);
            if (slice.length === 0) {
              await maybeYield(false);
              continue;
            }
          }

          const lastNl = slice.lastIndexOf(0x0a);
          if (lastNl === -1) {
            if (!oversizeLineDiscard) {
              if (carryLen + slice.length > maxSingleLineBytes) {
                oversizeLineDiscard = true;
                carryChunks = [];
                carryLen = 0;
                committedOffset = pos;
              } else {
                carryChunks.push(Buffer.from(slice));
                carryLen += slice.length;
              }
            } else {
              committedOffset = pos;
            }
            await maybeYield(false);
            continue;
          }

          const head = slice.subarray(0, lastNl);
          const tail = slice.subarray(lastNl + 1);

          if (oversizeLineDiscard) {
            const firstNl = head.indexOf(0x0a);
            oversizeLineDiscard = false;
            carryChunks = [];
            carryLen = 0;
            if (firstNl !== -1 && firstNl + 1 < head.length) {
              const restText = head.subarray(firstNl + 1).toString('utf8');
              iterateCompleteLines(restText, (line) => processSingleLine(line, sliceBaseOffset + firstNl + 1));
            }
          } else if (carryLen > 0) {
            const firstNl = head.indexOf(0x0a);
            if (firstNl === -1) {
              const joined = Buffer.concat([...carryChunks, head], carryLen + head.length).toString('utf8');
              carryChunks = [];
              carryLen = 0;
              iterateCompleteLines(joined, (line) => processSingleLine(line, committedOffset));
            } else {
              const firstJoined = Buffer.concat(
                [...carryChunks, head.subarray(0, firstNl)],
                carryLen + firstNl,
              ).toString('utf8');
              carryChunks = [];
              carryLen = 0;
              iterateCompleteLines(firstJoined, (line) => processSingleLine(line, committedOffset));
              if (firstNl + 1 < head.length) {
                const restText = head.subarray(firstNl + 1).toString('utf8');
                iterateCompleteLines(restText, (line) => processSingleLine(line, sliceBaseOffset + firstNl + 1));
              }
            }
          } else if (head.length > 0) {
            const text = head.toString('utf8');
            iterateCompleteLines(text, (line) => processSingleLine(line, sliceBaseOffset));
          }

          committedOffset = sliceBaseOffset + lastNl + 1;
          if (tail.length > 0) {
            carryChunks = [Buffer.from(tail)];
            carryLen = tail.length;
          } else {
            carryChunks = [];
            carryLen = 0;
          }

          await maybeYield(false);
        }
      } catch (error) {
        if (isSkippableFsError(error)) {
          skippedFileOnError = true;
        } else {
          throw error;
        }
      } finally {
        await fh.close().catch(() => {});
      }

      if (skippedFileOnError) continue;

      // Guard against livelock even when a single line exceeds a smaller custom tick budget.
      if (
        hitBudgetInFile &&
        !oversizeLineDiscard &&
        !skipFirstPartialLine &&
        committedOffset === startOffset &&
        carryLen >= budgetBytes
      ) {
        oversizeLineDiscard = true;
        carryChunks = [];
        carryLen = 0;
        committedOffset = pos;
      }

      const isDiscardingLine = oversizeLineDiscard || skipFirstPartialLine;
      const isPartial = hitBudgetInFile && pos < st.size;
      const tailState = serializeTailState(runtimeState);
      index.files[relKey] = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        offset: committedOffset,
        ...(isPartial ? { partial: true } : {}),
        ...(isDiscardingLine ? { discardingLine: true } : {}),
        ...(workspaceLabel ? { workspace: workspaceLabel } : {}),
        ...(tailState ? { tailState } : {}),
      };
      newlyScannedKeys.add(relKey);

      filesScanned += 1;
      filesSinceYield += 1;
      if (filesSinceYield >= FILES_PER_YIELD) {
        await maybeYield(true);
      } else {
        await maybeYield(false);
      }
    }

    // Prune deleted session files only when the full directory list was walked without pausing early.
    let prunedFiles = retentionPrunedFiles;
    if (!budgetPaused) {
      for (const existingKey of Object.keys(index.files)) {
        if (!seenKeys.has(existingKey)) {
          delete index.files[existingKey];
          prunedFiles += 1;
        }
      }
    }

    const finishedNowMs = this.now();
    const scanDurationMs = Math.max(0, Math.round((performance.now() - startedAtPerf) * 100) / 100);
    const scanMeta = {
      at: finishedNowMs,
      reason,
      scanDurationMs,
      filesDiscovered: discoveredWireFiles.length,
      filesScanned,
      filesSkippedUnchanged,
      bytesRead: totalBytesRead,
      budgetPaused,
      yieldCount,
    };

    index.updatedAt = finishedNowMs;
    index.lastScan = scanMeta;

    // Persist atomically when new bytes/deletions occurred, on explicit scan_now, or on initial index creation.
    if (filesScanned > 0 || prunedFiles > 0 || reason === 'scan_now' || !indexExisted) {
      await writeIndexAtomic(paths.indexPath, index, finishedNowMs, { protectedFileKeys: newlyScannedKeys });
    }
    this.cachedIndex = index;
    this.cachedIndexPath = paths.indexPath;

    return {
      index,
      paths,
      scan: scanMeta,
      reusedInFlight: false,
    };
  }

  async executeTool(args = {}, context = {}) {
    const action = typeof args?.action === 'string' ? args.action : 'summary';
    if (!['summary', 'scan_now', 'top_signatures', 'streaks', 'samples'].includes(action)) {
      const err = new Error(`Unsupported action: ${action}`);
      err.code = 'INVALID_ACTION';
      throw err;
    }

    if (action === 'scan_now') {
      const scanOutcome = await this.scanIncremental({
        reason: 'scan_now',
        maxMegabytes: args?.maxMegabytes,
        context,
        signal: context?.signal,
      });
      const report = queryIndexReport(
        scanOutcome.index,
        {
          action: 'summary',
          windowHours: args?.windowHours,
          toolFilter: args?.toolFilter,
          limit: args?.limit,
          indexed: true,
        },
        this.now(),
      );
      return {
        ...report,
        action: 'scan_now',
        scanDurationMs: scanOutcome.scan.scanDurationMs,
        filesScanned: scanOutcome.scan.filesScanned,
        filesSkippedUnchanged: scanOutcome.scan.filesSkippedUnchanged,
        bytesRead: scanOutcome.scan.bytesRead,
        budgetPaused: scanOutcome.scan.budgetPaused,
        reusedInFlight: scanOutcome.reusedInFlight,
      };
    }

    const loaded = await this.loadIndex(context);
    return queryIndexReport(
      loaded.index,
      {
        action,
        windowHours: args?.windowHours,
        toolFilter: args?.toolFilter,
        signatureId: args?.signatureId,
        limit: args?.limit,
        indexed: loaded.exists,
      },
      this.now(),
    );
  }

  async handlePanel(action, args = {}, context = {}) {
    if (action === 'state' || action === 'summary') {
      return this.executeTool(
        {
          action: 'summary',
          windowHours: args?.windowHours ?? 168,
          toolFilter: args?.toolFilter,
          limit: args?.limit ?? 20,
        },
        context,
      );
    }
    if (action === 'scan_now' || action === 'refresh') {
      return this.executeTool(
        {
          action: 'scan_now',
          windowHours: args?.windowHours ?? 168,
          toolFilter: args?.toolFilter,
          limit: args?.limit ?? 20,
          maxMegabytes: args?.maxMegabytes,
        },
        context,
      );
    }
    if (action === 'samples') {
      return this.executeTool(
        {
          action: 'samples',
          windowHours: args?.windowHours ?? 168,
          signatureId: args?.signatureId,
          limit: args?.limit ?? 10,
        },
        context,
      );
    }
    if (action === 'streaks') {
      return this.executeTool(
        {
          action: 'streaks',
          windowHours: args?.windowHours ?? 168,
          toolFilter: args?.toolFilter,
          limit: args?.limit ?? 20,
        },
        context,
      );
    }
    const err = new Error(`Unsupported panel action: ${action}`);
    err.code = 'INVALID_PANEL_ACTION';
    throw err;
  }
}

export function createErrorPulseService(deps = {}) {
  return new ErrorPulseService(deps);
}
