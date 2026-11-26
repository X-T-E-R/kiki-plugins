import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_WRITE_DEBOUNCE_MS = 400;
export const HUMAN_ACTION_RING_LIMIT = 16;

function createEmptyLeaseState(nowMs = Date.now()) {
  return {
    schemaVersion: 1,
    updatedAtMs: nowMs,
    selectedTarget: null,
    leases: {},
    takeovers: {},
  };
}

/**
 * Per-target remote lease & Human Takeover store with in-memory state,
 * debounced atomic write-behind (zero readFile on hot input/control paths),
 * per-target AbortController cancellation, and privacy-safe human action digest.
 *
 * Crash-recovery note: debounced write-behind may lose up to `debounceMs` (400 ms)
 * of transient state on abrupt process kill; call `flush()` on clean shutdown.
 */
export function createRemoteLeaseStore({
  dataDir = null,
  fileName = 'remote-leases.json',
  debounceMs = DEFAULT_WRITE_DEBOUNCE_MS,
  nowFn = Date.now,
} = {}) {
  let resolvedDir = dataDir ? path.resolve(dataDir) : null;
  let loadedFromFile = null;
  let loadFlight = null;
  let state = createEmptyLeaseState(nowFn());
  let debounceTimer = null;
  let dirty = false;
  let writeChain = Promise.resolve();

  const activeAbortControllers = new Map();
  const humanSummaryByTarget = new Map();
  const listeners = new Set();

  function normalizeTargetKey(raw) {
    return String(raw ?? '').trim();
  }

  function resolveFilePath(overrideDir = null) {
    const dir = overrideDir ? path.resolve(overrideDir) : resolvedDir;
    return dir ? path.join(dir, fileName) : null;
  }

  function setDataDir(nextDir) {
    if (!nextDir) return;
    const nextResolved = path.resolve(nextDir);
    if (resolvedDir !== nextResolved) {
      resolvedDir = nextResolved;
      loadedFromFile = null;
      loadFlight = null;
    }
  }

  function emitChange(event) {
    for (const fn of listeners) {
      try {
        fn(event, state);
      } catch {}
    }
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function ensureLoaded(overrideDir = null) {
    if (overrideDir) setDataDir(overrideDir);
    const filePath = resolveFilePath();
    if (!filePath || loadedFromFile === filePath) {
      return state;
    }
    if (loadFlight) return loadFlight;

    loadFlight = (async () => {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          state = {
            schemaVersion: 1,
            updatedAtMs: Number(raw.updatedAtMs) || nowFn(),
            selectedTarget: raw.selectedTarget ?? null,
            leases: raw.leases && typeof raw.leases === 'object' ? { ...raw.leases } : {},
            takeovers: raw.takeovers && typeof raw.takeovers === 'object' ? { ...raw.takeovers } : {},
          };
        }
      } catch {
        state = createEmptyLeaseState(nowFn());
      }
      loadedFromFile = filePath;
      return state;
    })().finally(() => {
      loadFlight = null;
    });

    return loadFlight;
  }

  function writeSnapshotAtomic(filePath, snapshotJson) {
    const run = async () => {
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${nowFn()}.tmp`;
      await writeFile(tmp, snapshotJson, { mode: 0o600 });
      await rename(tmp, filePath);
    };
    writeChain = writeChain.then(run, run).catch(() => {});
    return writeChain;
  }

  function scheduleWriteBehind() {
    dirty = true;
    state.updatedAtMs = nowFn();
    const filePath = resolveFilePath();
    if (!filePath) return;
    if (debounceMs <= 0) {
      dirty = false;
      void writeSnapshotAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
      return;
    }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!dirty) return;
      dirty = false;
      const targetFile = resolveFilePath();
      if (targetFile) {
        void writeSnapshotAtomic(targetFile, `${JSON.stringify(state, null, 2)}\n`);
      }
    }, debounceMs);
    debounceTimer.unref?.();
  }

  async function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const filePath = resolveFilePath();
    if (dirty && filePath) {
      dirty = false;
      state.updatedAtMs = nowFn();
      await writeSnapshotAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
    } else {
      await writeChain;
    }
  }

  function getTakeover(targetKey) {
    const key = normalizeTargetKey(targetKey);
    const entry = state.takeovers[key];
    if (!entry || entry.active !== true) {
      return {
        targetKey: key,
        active: false,
        takeoverActive: false,
        controlledBy: 'agent',
        reason: null,
        updatedAtMs: entry?.updatedAtMs || 0,
      };
    }
    const controlledBy = entry.holder === 'agent' ? 'agent' : 'human';
    return {
      targetKey: key,
      active: controlledBy === 'human',
      takeoverActive: controlledBy === 'human',
      controlledBy,
      reason: entry.reason || null,
      updatedAtMs: entry.updatedAtMs || nowFn(),
    };
  }

  function setTakeover(targetKey, { active, holder = 'human', reason = null } = {}) {
    const key = normalizeTargetKey(targetKey);
    if (!key) throw new Error('setTakeover requires a non-empty targetKey');

    const prev = getTakeover(key);
    const isHuman = Boolean(active && holder !== 'agent');
    const nextReason = isHuman ? (reason ? String(reason) : 'Manual takeover lock') : null;

    if (prev.active === isHuman && prev.reason === nextReason) {
      return {
        ...prev,
        changed: false,
      };
    }

    let releasedSummary;
    if (isHuman) {
      state.takeovers[key] = {
        targetKey: key,
        active: true,
        holder: 'human',
        controlledBy: 'human',
        reason: nextReason,
        updatedAtMs: nowFn(),
      };
      const controllers = activeAbortControllers.get(key);
      if (controllers && controllers.size > 0) {
        const abortErr = Object.assign(
          new Error(`Human takeover engaged on ${key}`),
          { code: 'human_takeover_active', name: 'AbortError', targetKey: key },
        );
        for (const ac of [...controllers]) {
          try {
            ac.abort(abortErr);
          } catch {}
        }
      }
    } else {
      releasedSummary = consumeHumanSummary(key);
      delete state.takeovers[key];
    }

    scheduleWriteBehind();
    const current = getTakeover(key);
    const result = {
      ...current,
      changed: true,
      ...(!isHuman && releasedSummary.length > 0 ? { lastHumanSummary: releasedSummary } : {}),
    };
    emitChange({ kind: 'takeover', targetKey: key, takeover: result });
    return result;
  }

  function checkAgentAllowed(targetKey, { overrideHumanTakeover = false } = {}) {
    const takeover = getTakeover(targetKey);
    if (takeover.active && takeover.controlledBy === 'human' && overrideHumanTakeover !== true) {
      return {
        allowed: false,
        ok: false,
        status: 409,
        code: 'human_takeover_active',
        error_code: 'human_takeover_active',
        retryable: false,
        targetKey: takeover.targetKey,
        takeoverActive: true,
        controlledBy: 'human',
        message: `Target "${takeover.targetKey}" is under active Human Takeover. Wait for the user to hand control back or obtain explicit instruction before setting overrideHumanTakeover=true.`,
      };
    }
    return {
      allowed: true,
      ok: true,
      targetKey: takeover.targetKey,
      takeoverActive: takeover.active,
      controlledBy: takeover.controlledBy,
    };
  }

  function registerAbortableOp(targetKey, parentSignal = null, { overrideHumanTakeover = false } = {}) {
    const key = normalizeTargetKey(targetKey);
    const ac = new AbortController();
    const onParentAbort = () => {
      ac.abort(parentSignal?.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let set = null;
    if (key && !overrideHumanTakeover) {
      set = activeAbortControllers.get(key);
      if (!set) {
        set = new Set();
        activeAbortControllers.set(key, set);
      }
      set.add(ac);
    }
    return {
      signal: ac.signal,
      cleanup() {
        parentSignal?.removeEventListener?.('abort', onParentAbort);
        if (set) {
          set.delete(ac);
          if (set.size === 0) activeAbortControllers.delete(key);
        }
      },
    };
  }

  /**
   * Privacy-safe human action recorder: stores ONLY bounded action kinds,
   * coordinates, button/chord names, or character counts — NEVER typed plaintext!
   */
  function recordHumanAction(targetKey, action = {}) {
    const key = normalizeTargetKey(targetKey);
    if (!key || !action || typeof action !== 'object') return;
    const kind = String(action.kind || '').trim();
    if (!kind) return;
    const now = nowFn();
    let ring = humanSummaryByTarget.get(key);
    if (!ring) {
      ring = [];
      humanSummaryByTarget.set(key, ring);
    }
    const last = ring.length > 0 ? ring[ring.length - 1] : null;

    if (kind === 'type' || kind === 'paste') {
      const charCount = Number.isFinite(action.charCount)
        ? Math.max(0, Math.round(action.charCount))
        : String(action.text ?? '').length;
      if (last && last.kind === 'type' && now - last.atMs <= 1500) {
        last.charCount += charCount;
        last.atMs = now;
        last.summary = `typed ${last.charCount} chars`;
        return;
      }
      ring.push({ kind: 'type', charCount, atMs: now, summary: `typed ${charCount} chars` });
    } else if (kind === 'tap' || kind === 'click' || kind === 'double_click' || kind === 'right_click') {
      const x = Number.isFinite(Number(action.x)) ? Math.round(Number(action.x)) : null;
      const y = Number.isFinite(Number(action.y)) ? Math.round(Number(action.y)) : null;
      const coord = x !== null && y !== null ? `@(${x},${y})` : '';
      ring.push({ kind, x, y, atMs: now, summary: `${kind}${coord}` });
    } else if (kind === 'swipe' || kind === 'drag') {
      ring.push({
        kind,
        atMs: now,
        summary: `${kind}(${Math.round(Number(action.startX) || 0)},${Math.round(Number(action.startY) || 0)})->(${Math.round(Number(action.endX) || 0)},${Math.round(Number(action.endY) || 0)})`,
      });
    } else if (kind === 'scroll') {
      const dy = Math.round(Number(action.deltaY) || 0);
      if (last && last.kind === 'scroll' && now - last.atMs <= 800) {
        last.dy += dy;
        last.atMs = now;
        last.summary = `scroll(${last.dy})`;
        return;
      }
      ring.push({ kind: 'scroll', dy, atMs: now, summary: `scroll(${dy})` });
    } else if (kind === 'key' || kind === 'key_chord') {
      const chord = Array.isArray(action.keys) ? action.keys.join('+') : String(action.key || 'key');
      ring.push({ kind: 'key_chord', atMs: now, summary: `key:${chord.slice(0, 32)}` });
    } else {
      ring.push({ kind, atMs: now, summary: kind.slice(0, 40) });
    }

    while (ring.length > HUMAN_ACTION_RING_LIMIT) {
      ring.shift();
    }
  }

  function getHumanSummary(targetKey) {
    const ring = humanSummaryByTarget.get(normalizeTargetKey(targetKey));
    if (!ring || ring.length === 0) return [];
    return ring.map((item) => ({ kind: item.kind, summary: item.summary, atMs: item.atMs }));
  }

  function consumeHumanSummary(targetKey) {
    const key = normalizeTargetKey(targetKey);
    const summary = getHumanSummary(key);
    humanSummaryByTarget.delete(key);
    return summary;
  }

  function upsertLease(targetKey, patch = {}) {
    const key = normalizeTargetKey(targetKey);
    if (!key) return null;
    const prev = state.leases[key] || { targetKey: key, pinned: false, updatedAtMs: nowFn() };
    const next = {
      ...prev,
      ...patch,
      targetKey: key,
      updatedAtMs: nowFn(),
    };
    state.leases[key] = next;
    scheduleWriteBehind();
    emitChange({ kind: 'lease', targetKey: key, lease: next });
    return next;
  }

  function removeLease(targetKey) {
    const key = normalizeTargetKey(targetKey);
    if (!key || !state.leases[key]) return false;
    delete state.leases[key];
    scheduleWriteBehind();
    emitChange({ kind: 'lease_removed', targetKey: key });
    return true;
  }

  function listLeases() {
    return Object.values(state.leases);
  }

  return {
    setDataDir,
    ensureLoaded,
    flush,
    onChange,
    getTakeover,
    setTakeover,
    checkAgentAllowed,
    registerAbortableOp,
    recordHumanAction,
    getHumanSummary,
    consumeHumanSummary,
    upsertLease,
    removeLease,
    listLeases,
  };
}
