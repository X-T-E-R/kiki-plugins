import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapPointToTarget, processCapturedStagePng } from './frame-math.mjs';
import { assertSafeRemoteKeyChord } from './key-map.mjs';
import { computeSampledFrameDiff } from './png-codec.mjs';
import {
  assertValidPveHost,
  buildPveTargetId,
  buildQmpStepsForAction,
  createPveQmpDriver,
  isPveTargetId,
  parsePveTargetId,
} from './pve-qmp-driver.mjs';
import {
  buildVncTargetId,
  createRfbDriver,
  isVncTargetId,
  parseVncTargetId,
} from './rfb-driver.mjs';
import { createUuycCliClient } from './uuyc-cli.mjs';
import { UU_PORTAL_URL, createWin32SystemDriver } from './win32-driver.mjs';
import { computeRescueBounds, normalizeSessionId } from './window-topology.mjs';
import { isAsciiOnlyText } from './xt-scancode-map.mjs';

const AGENT_CURSOR_GUARD_WINDOW_MS = 20_000;
const DEFAULT_TAKEOVER_THRESHOLD_PX = 48;
const SCREENSHOT_HISTORY_LIMIT = 16;
const DEDUPE_UNCHANGED_MAX_STREAK = 2;
const HUMAN_SUMMARY_RING_LIMIT = 12;

function sleep(ms, signal) {
  const clamped = Math.max(0, Math.min(30_000, Math.round(Number(ms) || 0)));
  if (clamped === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, clamped);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultStateDir({ dataDir, kikiHome, env = process.env } = {}) {
  if (dataDir) return path.resolve(dataDir);
  const home = kikiHome || env.KIKI_HOME || env.KIMI_CODE_HOME || path.join(os.homedir(), '.kiki');
  return path.join(path.resolve(home), 'plugins', 'data', 'kiki-uu-remote');
}

function isAbortForTakeover(err) {
  return err?.code === 'human_takeover_active';
}

function createUnicodeUnsupportedPayload(sessionId, {
  rfbExtendedClipboardNegotiated,
  vdagentConfigured,
  vdagentConnected,
  unicodeClipboard = false,
  guestAgent = false,
  clipboard = false,
  reason = '',
} = {}) {
  const detail = reason ? ` (${reason})` : '';
  return {
    ok: false,
    code: 'unicode_input_unsupported',
    effect: 'refused',
    targetId: sessionId,
    sessionId,
    capabilities: {
      ...(rfbExtendedClipboardNegotiated !== undefined
        ? { rfbExtendedClipboardNegotiated: Boolean(rfbExtendedClipboardNegotiated) }
        : {}),
      ...(vdagentConfigured !== undefined ? { vdagentConfigured: Boolean(vdagentConfigured) } : {}),
      ...(vdagentConnected !== undefined ? { vdagentConnected: Boolean(vdagentConnected) } : {}),
      unicodeClipboard: Boolean(unicodeClipboard),
      guestAgent: Boolean(guestAgent),
      clipboard: Boolean(clipboard),
    },
    message: `Target ${sessionId} does not support Unicode / clipboard injection${detail}.`,
    hint: 'Enable RFB ExtendedClipboard (PVE clipboard=vnc + running guest spice-vdagent) or QEMU Guest Agent, or use ASCII-only input.',
  };
}

/**
 * Pure Win32 step compiler for a single coalescable mouse/keyboard/type action.
 * Exported so unit tests can assert byte-for-byte step equivalence between single and coalesced batches.
 */
export function compileWin32StepsForAction(item, {
  coordinateMode = 'normalized_1000',
  zoomRelative = false,
  stageBounds = { x: 0, y: 0, width: 1920, height: 1080 },
  contentRect = null,
  lastObservation = null,
  allowClientHotkey = false,
} = {}) {
  const kind = item.kind;
  const steps = [];

  if (kind === 'move') {
    const pt = mapPointToTarget({
      x: item.x,
      y: item.y,
      coordinateMode,
      zoomRelative,
      stageBounds,
      contentRect,
      lastObservation,
    });
    steps.push({ op: 'mouse_move', x: pt.screenX, y: pt.screenY });
    return {
      steps,
      point: pt,
      result: {
        kind: 'move',
        point: { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY },
        screenPoint: { x: pt.screenX, y: pt.screenY },
      },
    };
  }

  if (
    kind === 'click' ||
    kind === 'double_click' ||
    kind === 'right_click' ||
    kind === 'mouse_down' ||
    kind === 'mouse_up'
  ) {
    const button = kind === 'right_click' ? 'right' : (item.button || 'left');
    let pt = null;
    if (item.x !== undefined && item.y !== undefined) {
      pt = mapPointToTarget({
        x: item.x,
        y: item.y,
        coordinateMode,
        zoomRelative,
        stageBounds,
        contentRect,
        lastObservation,
      });
      steps.push({ op: 'mouse_move', x: pt.screenX, y: pt.screenY });
      steps.push({ op: 'sleep', ms: 12 });
    }

    const modChords = Array.isArray(item.modifiers) && item.modifiers.length > 0
      ? assertSafeRemoteKeyChord(item.modifiers, { allowClientHotkey })
      : [];
    for (const mod of modChords) {
      steps.push({ op: 'vk_down', vk: mod.vk });
    }

    const clickCount = kind === 'double_click'
      ? 2
      : kind === 'right_click'
        ? 1
        : Math.max(1, Math.min(3, Math.round(Number(item.count) || 1)));
    if (kind === 'click' || kind === 'double_click' || kind === 'right_click') {
      for (let c = 0; c < clickCount; c += 1) {
        steps.push({ op: 'mouse_down', button });
        steps.push({ op: 'sleep', ms: 24 });
        steps.push({ op: 'mouse_up', button });
        if (c + 1 < clickCount) steps.push({ op: 'sleep', ms: 48 });
      }
    } else if (kind === 'mouse_down') {
      steps.push({ op: 'mouse_down', button });
    } else {
      steps.push({ op: 'mouse_up', button });
    }

    for (let m = modChords.length - 1; m >= 0; m -= 1) {
      steps.push({ op: 'vk_up', vk: modChords[m].vk });
    }

    const pointSummary = pt ? { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY } : null;
    return {
      steps,
      point: pt,
      result: {
        kind,
        button,
        count: (kind === 'click' || kind === 'double_click' || kind === 'right_click') ? clickCount : undefined,
        point: pointSummary,
        screenPoint: pt ? { x: pt.screenX, y: pt.screenY } : undefined,
      },
    };
  }

  if (kind === 'drag') {
    const startPt = mapPointToTarget({
      x: item.startX,
      y: item.startY,
      coordinateMode,
      zoomRelative,
      stageBounds,
      contentRect,
      lastObservation,
    });
    const endPt = mapPointToTarget({
      x: item.endX,
      y: item.endY,
      coordinateMode,
      zoomRelative,
      stageBounds,
      contentRect,
      lastObservation,
    });
    const button = item.button || 'left';
    const durationMs = Math.max(80, Math.min(5000, Math.round(Number(item.durationMs) || 260)));
    const segments = Math.max(6, Math.min(24, Math.round(durationMs / 18)));
    const stepSleep = Math.max(8, Math.round(durationMs / segments));

    steps.push({ op: 'mouse_move', x: startPt.screenX, y: startPt.screenY });
    steps.push({ op: 'sleep', ms: 20 });
    steps.push({ op: 'mouse_down', button });
    steps.push({ op: 'sleep', ms: 24 });
    for (let s = 1; s <= segments; s += 1) {
      const t = s / segments;
      const ix = Math.round(startPt.screenX + (endPt.screenX - startPt.screenX) * t);
      const iy = Math.round(startPt.screenY + (endPt.screenY - startPt.screenY) * t);
      steps.push({ op: 'mouse_move', x: ix, y: iy });
      steps.push({ op: 'sleep', ms: stepSleep });
    }
    steps.push({ op: 'mouse_up', button });

    const endSummary = { x: endPt.x, y: endPt.y, normX: endPt.normX, normY: endPt.normY };
    return {
      steps,
      point: endPt,
      startPoint: startPt,
      result: {
        kind: 'drag',
        button,
        start: { x: startPt.x, y: startPt.y, normX: startPt.normX, normY: startPt.normY },
        end: endSummary,
        durationMs,
      },
    };
  }

  if (kind === 'scroll') {
    let pt = null;
    if (item.x !== undefined && item.y !== undefined) {
      pt = mapPointToTarget({
        x: item.x,
        y: item.y,
        coordinateMode,
        zoomRelative,
        stageBounds,
        contentRect,
        lastObservation,
      });
      steps.push({ op: 'mouse_move', x: pt.screenX, y: pt.screenY });
      steps.push({ op: 'sleep', ms: 12 });
    }
    const rawDy = Number(item.deltaY) || 0;
    const rawDx = Number(item.deltaX) || 0;
    const toWheelUnits = (delta) => {
      if (delta === 0) return 0;
      return Math.abs(delta) <= 20 ? -Math.round(delta * 120) : -Math.round(delta);
    };
    steps.push({ op: 'wheel', deltaX: -toWheelUnits(rawDx), deltaY: toWheelUnits(rawDy) });
    const pointSummary = pt ? { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY } : null;
    return {
      steps,
      point: pt,
      result: { kind: 'scroll', deltaX: rawDx, deltaY: rawDy, point: pointSummary },
    };
  }

  if (kind === 'type') {
    const text = String(item.text ?? '');
    const mode = item.mode || 'auto';
    const hasNewline = /[\r\n]/.test(text);
    const hasNonAscii = /[^\x00-\x7f]/.test(text);
    const useClipboard = mode === 'clipboard' || (mode === 'auto' && (hasNewline || (hasNonAscii && text.length > 8)));
    if (text.length > 0) {
      if (useClipboard) {
        steps.push({ op: 'clipboard_paste', text });
      } else {
        steps.push({ op: 'unicode_text', text });
      }
    }
    if (item.submit) {
      steps.push({ op: 'sleep', ms: 20 });
      steps.push({ op: 'vk_down', vk: 0x0d });
      steps.push({ op: 'sleep', ms: 20 });
      steps.push({ op: 'vk_up', vk: 0x0d });
    }
    return {
      steps,
      point: null,
      result: {
        kind: 'type',
        length: text.length,
        mode: useClipboard ? 'clipboard' : (mode === 'auto' ? 'unicode' : mode),
        submit: Boolean(item.submit),
      },
    };
  }

  if (kind === 'key') {
    const chordInput = item.keys !== undefined ? item.keys : item.key;
    const chord = assertSafeRemoteKeyChord(chordInput, { allowClientHotkey });
    for (const k of chord) {
      steps.push({ op: 'vk_down', vk: k.vk });
      steps.push({ op: 'sleep', ms: 14 });
    }
    for (let i = chord.length - 1; i >= 0; i -= 1) {
      steps.push({ op: 'vk_up', vk: chord[i].vk });
      if (i > 0) steps.push({ op: 'sleep', ms: 10 });
    }
    return {
      steps,
      point: null,
      result: { kind: 'key', keys: chord.map((k) => k.name) },
    };
  }

  if (kind === 'hold_key') {
    const chord = assertSafeRemoteKeyChord(item.key || item.keys, { allowClientHotkey });
    const holdMs = Math.max(20, Math.min(10_000, Math.round(Number(item.durationMs) || 300)));
    for (const k of chord) steps.push({ op: 'vk_down', vk: k.vk });
    steps.push({ op: 'sleep', ms: holdMs });
    for (let i = chord.length - 1; i >= 0; i -= 1) steps.push({ op: 'vk_up', vk: chord[i].vk });
    return {
      steps,
      point: null,
      result: { kind: 'hold_key', keys: chord.map((k) => k.name), durationMs: holdMs },
    };
  }

  throw new Error(`Unsupported action kind: "${String(kind)}"`);
}

export function createUuRemoteService({
  systemDriver = createWin32SystemDriver(),
  pveDriver,
  rfbDriver,
  cliClient = createUuycCliClient(),
  stateDir: initialStateDir = null,
  busInspector = null,
  nowFn = Date.now,
} = {}) {
  const effectivePveDriver = pveDriver === undefined ? createPveQmpDriver({ nowFn }) : pveDriver;
  const effectiveRfbDriver = rfbDriver === undefined ? createRfbDriver({ nowFn }) : rfbDriver;
  // Use RFB as primary transport for PVE in production and whenever rfbDriver is provided.
  // If a caller injected a custom pveDriver mock without an rfbDriver, stay on QMP deterministically.
  const pveRfbEnabled = Boolean(effectiveRfbDriver) && (rfbDriver !== undefined || pveDriver === undefined);

  let configuredStateDir = initialStateDir;
  let selectedSessionId = null;
  let shotSeq = 0;

  const takeoverBySession = new Map();
  const lastObservationBySession = new Map();
  const lastContentRectBySession = new Map();
  const lastCursorGuardBySession = new Map();
  const screenshotHistoryBySession = new Map();
  const dedupeStateBySession = new Map();
  const humanSummaryBySession = new Map();
  const activeActionControllers = new Map();
  const pveTargetsById = new Map();
  const vncTargetsById = new Map();
  const pveFallbackToQmp = new Map(); // One-time per-session RFB -> QMP fallback cache (OQ5)
  const pveVdagentBySession = new Map(); // Live QMP query-chardev vdagentConfigured/vdagentConnected per PVE target
  const pveQgaAvailableBySession = new Map(); // Cached QGA availability per PVE target (updated lazily on probeQga)
  let stateLoadedFromDir = null;
  let stateLoadFlight = null;
  let externalDiskDirty = false;

  function invalidateSessionGeometry(sessionId, dims = null) {
    const sid = normalizeSessionId(sessionId);
    screenshotHistoryBySession.delete(sid);
    lastContentRectBySession.delete(sid);
    lastObservationBySession.delete(sid);
    if (dims && Number.isFinite(dims.width) && dims.width > 0 && Number.isFinite(dims.height) && dims.height > 0) {
      const w = Math.round(dims.width);
      const h = Math.round(dims.height);
      const pveTarget = pveTargetsById.get(sid);
      if (pveTarget) {
        pveTarget.width = w;
        pveTarget.height = h;
      }
      const vncTarget = vncTargetsById.get(sid);
      if (vncTarget) {
        vncTarget.width = w;
        vncTarget.height = h;
      }
    }
  }

  effectiveRfbDriver?.onResize?.((targetId, dims) => {
    invalidateSessionGeometry(targetId, dims);
  });

  function setStateDir(dir) {
    if (dir) {
      const resolved = path.resolve(dir);
      if (configuredStateDir !== resolved) {
        configuredStateDir = resolved;
        stateLoadedFromDir = null;
        externalDiskDirty = true;
      }
    }
  }

  function resolveStateDir(context = {}) {
    return configuredStateDir || defaultStateDir({ dataDir: context?.dataDir, kikiHome: context?.kikiHome });
  }

  function resolveStateFile(context = {}) {
    return path.join(resolveStateDir(context), 'runtime-state.json');
  }

  function resolvePveTargetsFile(context = {}) {
    return path.join(resolveStateDir(context), 'pve-targets.json');
  }

  function resolveVncTargetsFile(context = {}) {
    return path.join(resolveStateDir(context), 'vnc-targets.json');
  }

  async function syncPveTargets(context = {}) {
    const file = resolvePveTargetsFile(context);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const list = Array.isArray(raw?.targets) ? raw.targets : Array.isArray(raw) ? raw : [];
      pveTargetsById.clear();
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const parsed = item.id
          ? parsePveTargetId(item.id, { strict: false })
          : (item.sshHost && item.vmid ? parsePveTargetId(`pve:${item.sshHost}:${item.vmid}`, { strict: false }) : null);
        if (!parsed) continue;
        pveTargetsById.set(parsed.id, {
          id: parsed.id,
          sshHost: parsed.sshHost,
          vmid: parsed.vmid,
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : null,
          vmName: typeof item.vmName === 'string' && item.vmName.trim() ? item.vmName.trim() : null,
          width: Number.isFinite(item.width) && item.width > 0 ? Math.round(item.width) : null,
          height: Number.isFinite(item.height) && item.height > 0 ? Math.round(item.height) : null,
          addedAtMs: Number(item.addedAtMs) || nowFn(),
          updatedAtMs: Number(item.updatedAtMs) || nowFn(),
        });
      }
    } catch {
      // File may not exist yet.
    }
  }

  async function persistPveTargets(context = {}) {
    const file = resolvePveTargetsFile(context);
    const dir = path.dirname(file);
    try {
      await mkdir(dir, { recursive: true });
      const payload = {
        version: 1,
        targets: [...pveTargetsById.values()],
        updatedAtMs: nowFn(),
      };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, file);
    } catch {}
  }

  async function syncVncTargets(context = {}) {
    const file = resolveVncTargetsFile(context);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const list = Array.isArray(raw?.targets) ? raw.targets : Array.isArray(raw) ? raw : [];
      vncTargetsById.clear();
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const parsed = item.id
          ? parseVncTargetId(item.id, { strict: false })
          : (item.host ? parseVncTargetId(buildVncTargetId(item.host, item.port ?? 5900), { strict: false }) : null);
        if (!parsed) continue;
        let sshHost = null;
        if (typeof item.sshHost === 'string' && item.sshHost.trim()) {
          try { sshHost = assertValidPveHost(item.sshHost); } catch { sshHost = null; }
        }
        vncTargetsById.set(parsed.id, {
          id: parsed.id,
          host: parsed.host,
          port: parsed.port,
          sshHost,
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : null,
          desktopName: typeof item.desktopName === 'string' && item.desktopName.trim() ? item.desktopName.trim() : null,
          width: Number.isFinite(item.width) && item.width > 0 ? Math.round(item.width) : null,
          height: Number.isFinite(item.height) && item.height > 0 ? Math.round(item.height) : null,
          addedAtMs: Number(item.addedAtMs) || nowFn(),
          updatedAtMs: Number(item.updatedAtMs) || nowFn(),
        });
      }
    } catch {
      // File may not exist yet.
    }
  }

  async function persistVncTargets(context = {}) {
    const file = resolveVncTargetsFile(context);
    const dir = path.dirname(file);
    try {
      await mkdir(dir, { recursive: true });
      // Explicitly serialize ONLY non-secret fields; NEVER persist vncPassword!
      const targets = [...vncTargetsById.values()].map((t) => ({
        id: t.id,
        host: t.host,
        port: t.port,
        sshHost: t.sshHost || null,
        label: t.label || null,
        desktopName: t.desktopName || null,
        width: t.width || null,
        height: t.height || null,
        addedAtMs: t.addedAtMs,
        updatedAtMs: t.updatedAtMs,
      }));
      const payload = { version: 1, targets, updatedAtMs: nowFn() };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, file);
    } catch {}
  }

  async function syncPersistedState(context = {}, { force = false } = {}) {
    const dir = resolveStateDir(context);
    const file = path.join(dir, 'runtime-state.json');
    if (!force && stateLoadedFromDir === dir && !externalDiskDirty) {
      return;
    }
    if (stateLoadFlight) {
      return stateLoadFlight;
    }
    stateLoadFlight = (async () => {
      externalDiskDirty = false;
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        if (typeof raw.selectedSessionId === 'string' && raw.selectedSessionId) {
          selectedSessionId = raw.selectedSessionId;
        }
        takeoverBySession.clear();
        if (raw.takeover && typeof raw.takeover === 'object') {
          for (const [sid, entry] of Object.entries(raw.takeover)) {
            if (entry && typeof entry === 'object') {
              takeoverBySession.set(sid, {
                active: Boolean(entry.active),
                controlledBy: entry.active ? (entry.controlledBy || 'human') : 'agent',
                reason: entry.reason || undefined,
                updatedAtMs: Number(entry.updatedAtMs) || nowFn(),
              });
            }
          }
        }
      } catch {
        // State file may not exist yet.
      }
      await Promise.all([syncPveTargets(context), syncVncTargets(context)]);
      stateLoadedFromDir = dir;
    })().finally(() => {
      stateLoadFlight = null;
    });
    return stateLoadFlight;
  }

  async function persistState(context = {}) {
    const file = resolveStateFile(context);
    const dir = path.dirname(file);
    try {
      await mkdir(dir, { recursive: true });
      const takeoverObj = {};
      for (const [sid, val] of takeoverBySession.entries()) {
        if (val.active) takeoverObj[sid] = val;
      }
      const payload = {
        selectedSessionId,
        takeover: takeoverObj,
        updatedAtMs: nowFn(),
      };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, file);
    } catch {}
  }

  function getTakeoverEntry(sessionId) {
    const norm = normalizeSessionId(sessionId);
    const hit = takeoverBySession.get(norm);
    if (!hit || !hit.active) {
      return { active: false, controlledBy: 'agent', reason: undefined };
    }
    return {
      active: true,
      controlledBy: hit.controlledBy || 'human',
      reason: hit.reason,
      updatedAtMs: hit.updatedAtMs,
    };
  }

  function shouldUsePveRfb(sessionId) {
    return pveRfbEnabled && !pveFallbackToQmp.has(normalizeSessionId(sessionId));
  }

  function getTransportForSession(session) {
    if (!session) return 'uu-win32';
    if (isVncTargetId(session.id) || session.provider === 'rfb') return 'rfb';
    if (isPveTargetId(session.id) || session.provider === 'pve-qmp') {
      return shouldUsePveRfb(session.id) ? 'pve-rfb' : 'pve-qmp';
    }
    return 'uu-win32';
  }

  // --- Human panel action debounced summary ring buffer (bytebot pattern) ---

  function recordHumanPanelAction(sessionId, action = {}) {
    const sid = normalizeSessionId(sessionId);
    if (!sid || !action || typeof action !== 'object') return;
    const kind = String(action.kind || action.subAction || '').trim();
    if (!kind) return;
    const now = nowFn();
    let ring = humanSummaryBySession.get(sid);
    if (!ring) {
      ring = [];
      humanSummaryBySession.set(sid, ring);
    }
    const last = ring.length > 0 ? ring[ring.length - 1] : null;

    if (kind === 'type' || kind === 'paste') {
      const charCount = String(action.text ?? '').length;
      if (last && last.kind === 'type' && now - last.atMs <= 1500) {
        last.charCount += charCount;
        last.events += 1;
        last.submit = Boolean(last.submit || action.submit);
        last.atMs = now;
        last.summary = `typed ${last.charCount} chars${last.submit ? ' + Enter' : ''}`;
        return;
      }
      ring.push({
        kind: 'type',
        charCount,
        events: 1,
        submit: Boolean(action.submit),
        atMs: now,
        summary: `typed ${charCount} chars${action.submit ? ' + Enter' : ''}`,
      });
    } else if (kind === 'scroll') {
      const dx = Number(action.deltaX) || 0;
      const dy = Number(action.deltaY) || 0;
      if (last && last.kind === 'scroll' && now - last.atMs <= 800) {
        last.deltaX += dx;
        last.deltaY += dy;
        last.events += 1;
        last.atMs = now;
        last.summary = `scrolled (${last.deltaX}, ${last.deltaY})`;
        return;
      }
      ring.push({
        kind: 'scroll',
        deltaX: dx,
        deltaY: dy,
        events: 1,
        atMs: now,
        summary: `scrolled (${dx}, ${dy})`,
      });
    } else if (kind === 'click' || kind === 'double_click' || kind === 'right_click') {
      const x = Number.isFinite(Number(action.x)) ? Math.round(Number(action.x)) : null;
      const y = Number.isFinite(Number(action.y)) ? Math.round(Number(action.y)) : null;
      const button = kind === 'right_click' ? 'right' : (action.button || 'left');
      const count = kind === 'double_click' ? 2 : (Number(action.count) || 1);
      if (
        last &&
        last.kind === 'click' &&
        last.button === button &&
        now - last.atMs <= 500 &&
        x !== null && last.x !== null && Math.abs(x - last.x) <= 20 &&
        y !== null && last.y !== null && Math.abs(y - last.y) <= 20
      ) {
        last.count += count;
        last.atMs = now;
        last.summary = `${button} click x${last.count} at (${x}, ${y})`;
        return;
      }
      ring.push({
        kind: 'click',
        button,
        count,
        x,
        y,
        atMs: now,
        summary: `${button} click${count > 1 ? ` x${count}` : ''}${x !== null ? ` at (${x}, ${y})` : ''}`,
      });
    } else if (kind === 'key') {
      const label = Array.isArray(action.keys) ? action.keys.join('+') : String(action.key || '');
      ring.push({ kind: 'key', keys: label, atMs: now, summary: `pressed ${label}` });
    } else if (kind === 'drag') {
      ring.push({
        kind: 'drag',
        atMs: now,
        summary: `dragged (${action.startX},${action.startY})->(${action.endX},${action.endY})`,
      });
    } else {
      ring.push({ kind, atMs: now, summary: kind });
    }

    while (ring.length > HUMAN_SUMMARY_RING_LIMIT) {
      ring.shift();
    }
  }

  function getLastHumanSummary(sessionId) {
    const ring = humanSummaryBySession.get(normalizeSessionId(sessionId));
    if (!ring || ring.length === 0) return [];
    return ring.map((e) => ({ kind: e.kind, summary: e.summary, atMs: e.atMs }));
  }

  function clearHumanSummary(sessionId) {
    humanSummaryBySession.delete(normalizeSessionId(sessionId));
  }

  // --- Session builders ---

  function buildPveSessionObject(target, liveStatus = null, probeError = null) {
    const vmStatus = liveStatus?.vmStatus || (probeError ? 'unreachable' : 'stopped');
    const running = Boolean(liveStatus?.running) || vmStatus === 'running';
    const vmName = liveStatus?.vmName || target.vmName || null;
    const width = (Number.isFinite(liveStatus?.width) && liveStatus.width > 0 ? Math.round(liveStatus.width) : null)
      || target.width
      || 1024;
    const height = (Number.isFinite(liveStatus?.height) && liveStatus.height > 0 ? Math.round(liveStatus.height) : null)
      || target.height
      || 768;
    const label = target.label || vmName || `PVE ${target.sshHost} VM ${target.vmid}`;
    const state = running ? 'active' : probeError ? 'disconnected' : 'stopped';
    const transport = shouldUsePveRfb(target.id) ? 'pve-rfb' : 'pve-qmp';
    // Fail-closed: if liveStatus omits vdagent fields, treat as false rather than assuming vdagent exists.
    const vdagentConfigured = liveStatus !== null && liveStatus !== undefined
      ? Boolean(liveStatus.vdagentConfigured)
      : false;
    const vdagentConnected = liveStatus !== null && liveStatus !== undefined
      ? Boolean(liveStatus.vdagentConnected)
      : false;
    pveVdagentBySession.set(target.id, { vdagentConfigured, vdagentConnected });
    return {
      id: target.id,
      provider: 'pve-qmp', // Preserved unconditionally per Frame Audit OQ5
      transport,
      sshHost: target.sshHost,
      vmid: target.vmid,
      vmName,
      vmStatus,
      vdagentConfigured,
      vdagentConnected,
      label,
      state,
      dpi: 96,
      scaleFactor: 1,
      outerBounds: { x: 0, y: 0, width, height },
      canvasBounds: { x: 0, y: 0, width, height },
      ...(probeError ? { error: probeError } : {}),
    };
  }

  function buildVncSessionObject(target, liveCaps = null, probeError = null) {
    const width = (Number.isFinite(liveCaps?.width) && liveCaps.width > 0 ? Math.round(liveCaps.width) : null)
      || target.width
      || 1024;
    const height = (Number.isFinite(liveCaps?.height) && liveCaps.height > 0 ? Math.round(liveCaps.height) : null)
      || target.height
      || 768;
    const desktopName = liveCaps?.name || target.desktopName || null;
    const label = target.label || desktopName || `VNC ${target.host}:${target.port}`;
    const state = probeError ? 'disconnected' : 'active';
    return {
      id: target.id,
      provider: 'rfb',
      transport: 'rfb',
      host: target.host,
      port: target.port,
      ...(target.sshHost ? { sshHost: target.sshHost } : {}),
      desktopName,
      label,
      state,
      dpi: 96,
      scaleFactor: 1,
      outerBounds: { x: 0, y: 0, width, height },
      canvasBounds: { x: 0, y: 0, width, height },
      ...(probeError ? { error: probeError } : {}),
    };
  }

  async function probeRegisteredPveSessions(context = {}, { probeResolution = false } = {}) {
    if (pveTargetsById.size === 0) return [];
    let dirty = false;
    const entries = [...pveTargetsById.values()];
    const results = await Promise.all(
      entries.map(async (target) => {
        try {
          const needRes = probeResolution || !target.width || !target.height;
          const live = await effectivePveDriver.probeStatus(target, {
            probeResolution: needRes,
            signal: context?.signal,
          });
          if (live?.vmName && live.vmName !== target.vmName) {
            target.vmName = live.vmName;
            dirty = true;
          }
          if (Number.isFinite(live?.width) && live.width > 0 && Number.isFinite(live?.height) && live.height > 0) {
            if (target.width !== Math.round(live.width) || target.height !== Math.round(live.height)) {
              target.width = Math.round(live.width);
              target.height = Math.round(live.height);
              dirty = true;
            }
          }
          if (dirty) target.updatedAtMs = nowFn();
          return buildPveSessionObject(target, live, null);
        } catch (err) {
          return buildPveSessionObject(target, null, err?.message || String(err));
        }
      }),
    );
    if (dirty) {
      await persistPveTargets(context);
    }
    return results;
  }

  async function listRegisteredVncSessions() {
    if (vncTargetsById.size === 0) return [];
    const results = [];
    for (const target of vncTargetsById.values()) {
      const caps = effectiveRfbDriver
        ? await effectiveRfbDriver.getSessionCapabilities(target).catch(() => null)
        : null;
      results.push(buildVncSessionObject(target, caps, null));
    }
    return results;
  }

  async function inspectCombinedTopology(settings = {}, context = {}, { probePveResolution = false } = {}) {
    await syncPersistedState(context);
    const [winTopo, pveSessions, vncSessions] = await Promise.all([
      systemDriver.inspectTopology(settings).catch((error) => ({
        supported: systemDriver.hostPlatform === 'win32',
        hostPlatform: systemDriver.hostPlatform,
        monitors: [],
        processes: [],
        sessions: [],
        launchers: [],
        ignored: [],
        error: error?.message || String(error),
      })),
      probeRegisteredPveSessions(context, { probeResolution: probePveResolution }),
      listRegisteredVncSessions(),
    ]);

    const winSessions = Array.isArray(winTopo.sessions)
      ? winTopo.sessions.map((s) => ({ provider: 'uu-remote', transport: 'uu-win32', ...s }))
      : [];

    return {
      ...winTopo,
      sessions: [...winSessions, ...pveSessions, ...vncSessions],
      pveSessions,
      vncSessions,
    };
  }

  async function releaseSessionInputs(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return;
    try {
      if (isVncTargetId(sid)) {
        await effectiveRfbDriver?.releaseAllInputs?.(sid, { conservative: true });
      } else if (isPveTargetId(sid)) {
        if (shouldUsePveRfb(sid)) {
          await effectiveRfbDriver?.releaseAllInputs?.(sid, { conservative: true });
        } else {
          await effectivePveDriver?.releaseAllInputs?.(sid);
        }
      } else {
        await systemDriver?.releaseAllInputs?.();
      }
    } catch {
      // Best-effort release on abort/takeover.
    }
  }

  async function setTakeover({ targetId, sessionId, active, holder, reason } = {}, context = {}) {
    await syncPersistedState(context);
    const rawId = targetId || sessionId || selectedSessionId;
    if (!rawId) {
      const topo = await inspectCombinedTopology(context?.settings ?? {}, context);
      if (topo.sessions.length === 1) {
        return setTakeover({ sessionId: topo.sessions[0].id, active, holder, reason }, context);
      }
      throw new Error('Takeover requires a target sessionId (uu:<hwnd>, pve:<ssh_host>:<vmid>, or vnc:<host>:<port>).');
    }
    const sid = normalizeSessionId(rawId);
    const nextActive = Boolean(active);
    const controlledBy = nextActive ? (holder === 'agent' ? 'human' : holder || 'human') : (holder || 'agent');
    const prev = takeoverBySession.get(sid);
    if (prev && prev.active === nextActive && prev.controlledBy === controlledBy && (!reason || prev.reason === String(reason))) {
      return {
        ok: true,
        targetId: sid,
        sessionId: sid,
        takeoverActive: nextActive,
        controlledBy,
        reason: prev.reason,
        changed: false,
      };
    }
    let releasedSummary;

    if (nextActive) {
      takeoverBySession.set(sid, {
        active: true,
        controlledBy,
        reason: reason ? String(reason) : 'Manual takeover lock',
        updatedAtMs: nowFn(),
      });
      // B4: Immediately abort all in-flight agent action loops on this session and release held keys/buttons.
      const controllers = activeActionControllers.get(sid);
      if (controllers && controllers.size > 0) {
        const abortReason = Object.assign(
          new Error(`Human takeover engaged on ${sid}`),
          { code: 'human_takeover_active', name: 'AbortError' },
        );
        for (const ac of [...controllers]) {
          try { ac.abort(abortReason); } catch {}
        }
      }
      await releaseSessionInputs(sid);
    } else {
      releasedSummary = getLastHumanSummary(sid);
      takeoverBySession.delete(sid);
      lastCursorGuardBySession.delete(sid);
    }
    await persistState(context);
    return {
      ok: true,
      targetId: sid,
      sessionId: sid,
      takeoverActive: nextActive,
      controlledBy,
      reason: nextActive ? takeoverBySession.get(sid)?.reason : undefined,
      ...(!nextActive && releasedSummary && releasedSummary.length > 0 ? { lastHumanSummary: releasedSummary } : {}),
    };
  }

  function decorateSession(session) {
    const tk = getTakeoverEntry(session.id);
    const cachedContentRect = lastContentRectBySession.get(session.id) || {
      x: 0,
      y: 0,
      width: session.canvasBounds.width,
      height: session.canvasBounds.height,
      trimmed: false,
      axis: 'none',
    };
    const transport = session.transport || getTransportForSession(session);
    const summary = getLastHumanSummary(session.id);
    return {
      provider: session.provider || 'uu-remote',
      transport,
      ...session,
      contentRect: {
        x: cachedContentRect.x,
        y: cachedContentRect.y,
        width: cachedContentRect.width,
        height: cachedContentRect.height,
      },
      contentTrimmed: Boolean(cachedContentRect.trimmed),
      takeoverActive: tk.active,
      controlledBy: tk.controlledBy,
      takeoverReason: tk.reason,
      ...(summary.length > 0 ? { lastHumanSummary: summary } : {}),
    };
  }

  function pickSelectedSession(sessions) {
    if (selectedSessionId && sessions.some((s) => s.id === selectedSessionId)) {
      return selectedSessionId;
    }
    const firstActive = sessions.find((s) => s.state === 'active');
    if (firstActive) {
      selectedSessionId = firstActive.id;
      return selectedSessionId;
    }
    if (sessions.length > 0) {
      selectedSessionId = sessions[0].id;
      return selectedSessionId;
    }
    return null;
  }

  async function resolveExplicitPveTarget(requestedId, context = {}) {
    const parsed = parsePveTargetId(requestedId, { strict: true });
    const registered = pveTargetsById.get(parsed.id);
    const live = await effectivePveDriver.probeStatus(parsed, {
      probeResolution: !registered?.width || !registered?.height,
      signal: context?.signal,
    });
    if (registered) {
      let dirty = false;
      if (live?.vmName && live.vmName !== registered.vmName) {
        registered.vmName = live.vmName;
        dirty = true;
      }
      if (Number.isFinite(live?.width) && live.width > 0 && Number.isFinite(live?.height) && live.height > 0) {
        if (registered.width !== Math.round(live.width) || registered.height !== Math.round(live.height)) {
          registered.width = Math.round(live.width);
          registered.height = Math.round(live.height);
          dirty = true;
        }
      }
      if (dirty) {
        registered.updatedAtMs = nowFn();
        await persistPveTargets(context);
      }
      return buildPveSessionObject(registered, live, null);
    }
    return buildPveSessionObject(parsed, live, null);
  }

  async function resolveExplicitVncTarget(requestedId) {
    const parsed = parseVncTargetId(requestedId, { strict: true });
    const registered = vncTargetsById.get(parsed.id);
    const target = registered || { ...parsed, sshHost: null, label: null, desktopName: null, width: null, height: null };
    const caps = effectiveRfbDriver
      ? await effectiveRfbDriver.getSessionCapabilities(target).catch(() => null)
      : null;
    return buildVncSessionObject(target, caps, null);
  }

  async function resolveTargetSession(requestedId, topo, context = {}) {
    if (!stateLoadedFromDir) await syncPersistedState(context);
    const sessions = topo.sessions;
    if (requestedId) {
      const norm = normalizeSessionId(requestedId);
      const found = sessions.find((s) => s.id === norm);
      if (found) return found;

      if (isPveTargetId(norm)) {
        return resolveExplicitPveTarget(norm, context);
      }
      if (isVncTargetId(norm)) {
        return resolveExplicitVncTarget(norm);
      }

      throw new Error(
        `Remote session "${norm}" is not open. Call uu_sessions(action="list") to inspect active windows/VMs or uu_launch(action="connect", deviceId="<id>") to connect.`,
      );
    }
    const chosenId = pickSelectedSession(sessions);
    if (!chosenId) {
      throw new Error(
        'No active remote desktop session is open. Call uu_sessions(action="list") to find paired devices, or uu_launch(action="connect", deviceId="pve:<ssh_host>:<vmid>" | "vnc:<host>:<port>").',
      );
    }
    return sessions.find((s) => s.id === chosenId);
  }

  function recordScreenshotHistory(sessionId, entry) {
    const sid = normalizeSessionId(sessionId);
    let history = screenshotHistoryBySession.get(sid);
    if (!history) {
      history = [];
      screenshotHistoryBySession.set(sid, history);
    }
    history.push(entry);
    while (history.length > SCREENSHOT_HISTORY_LIMIT) {
      history.shift();
    }
  }

  function validateScreenshotIdGeometry(session, screenshotId) {
    const sid = normalizeSessionId(session.id);
    const history = screenshotHistoryBySession.get(sid);
    const match = history ? history.find((item) => item.screenshotId === screenshotId) : null;
    if (!match) {
      return {
        ok: false,
        status: 409,
        code: 'capture_geometry_mismatch',
        effect: 'refused',
        targetId: sid,
        sessionId: sid,
        screenshotId,
        message: `screenshotId "${screenshotId}" is unknown or was invalidated by a resize/reconnect on ${sid}.`,
        hint: 'Capture a fresh screenshot with uu_control(action="screenshot") before acting.',
      };
    }

    const curContent = lastContentRectBySession.get(sid) || {
      x: 0,
      y: 0,
      width: session.canvasBounds?.width || match.logicalSize.width,
      height: session.canvasBounds?.height || match.logicalSize.height,
    };
    const curLogicalW = curContent.width || session.canvasBounds?.width;
    const curLogicalH = curContent.height || session.canvasBounds?.height;
    const stageChanged = Boolean(
      match.stageSize &&
      session.canvasBounds?.width > 0 &&
      session.canvasBounds?.height > 0 &&
      (match.stageSize.width !== session.canvasBounds.width ||
        match.stageSize.height !== session.canvasBounds.height),
    );

    const geomChanged =
      stageChanged ||
      match.logicalSize.width !== curLogicalW ||
      match.logicalSize.height !== curLogicalH ||
      match.contentRect.x !== curContent.x ||
      match.contentRect.y !== curContent.y ||
      match.contentRect.width !== curContent.width ||
      match.contentRect.height !== curContent.height;

    if (geomChanged) {
      return {
        ok: false,
        status: 409,
        code: 'capture_geometry_mismatch',
        effect: 'refused',
        targetId: sid,
        sessionId: sid,
        screenshotId,
        expectedGeometry: { logicalSize: match.logicalSize, contentRect: match.contentRect },
        currentGeometry: { logicalSize: { width: curLogicalW, height: curLogicalH }, contentRect: curContent },
        message: `Target geometry changed since screenshotId "${screenshotId}" on ${sid}.`,
        hint: 'Capture a fresh screenshot with uu_control(action="screenshot") before acting.',
      };
    }
    return { ok: true, entry: match };
  }

  async function getSessionTransportAndCapabilities(sessionId, session = null) {
    const sid = normalizeSessionId(sessionId);
    if (isVncTargetId(sid)) {
      const caps = effectiveRfbDriver
        ? await effectiveRfbDriver.getSessionCapabilities(vncTargetsById.get(sid) || sid).catch(() => null)
        : null;
      return {
        transport: 'rfb',
        capabilities: {
          unicodeClipboard: Boolean(caps?.unicodeClipboard),
          extendedClipboard: Boolean(caps?.extendedClipboard),
          qemuExtendedKeyEvent: Boolean(caps?.qemuExtendedKeyEvent),
          continuousUpdates: Boolean(caps?.continuousUpdates),
          guestAgent: false,
          clipboard: Boolean(caps?.unicodeClipboard),
        },
      };
    }
    if (isPveTargetId(sid)) {
      const usingRfb = shouldUsePveRfb(sid);
      const caps = usingRfb && effectiveRfbDriver
        ? await effectiveRfbDriver.getSessionCapabilities(pveTargetsById.get(sid) || sid).catch(() => null)
        : null;
      // Fail-closed: PVE QEMU VNC negotiates pseudoExtendedClipboard even when no qemu-vdagent
      // chardev exists or guest spice-vdagent is disconnected, silently black-holing clipboard UTF-8.
      const vd = session && typeof session.vdagentConnected === 'boolean'
        ? {
            vdagentConfigured: Boolean(session.vdagentConfigured),
            vdagentConnected: Boolean(session.vdagentConnected),
          }
        : (pveVdagentBySession.get(sid) || { vdagentConfigured: false, vdagentConnected: false });
      const rfbExtendedClipboardNegotiated = Boolean(caps?.unicodeClipboard);
      const effectiveRfbUnicodeClipboard = rfbExtendedClipboardNegotiated && vd.vdagentConnected;
      const guestAgent = Boolean(pveQgaAvailableBySession.get(sid));
      return {
        transport: usingRfb ? 'pve-rfb' : 'pve-qmp',
        capabilities: {
          rfbExtendedClipboardNegotiated,
          vdagentConfigured: vd.vdagentConfigured,
          vdagentConnected: vd.vdagentConnected,
          unicodeClipboard: effectiveRfbUnicodeClipboard,
          extendedClipboard: Boolean(caps?.extendedClipboard),
          qemuExtendedKeyEvent: Boolean(caps?.qemuExtendedKeyEvent),
          continuousUpdates: Boolean(caps?.continuousUpdates),
          guestAgent,
          clipboard: effectiveRfbUnicodeClipboard || guestAgent,
        },
      };
    }
    return {
      transport: 'uu-win32',
      capabilities: {
        unicodeClipboard: true,
        extendedClipboard: false,
        qemuExtendedKeyEvent: false,
        continuousUpdates: false,
        guestAgent: false,
        clipboard: true,
      },
    };
  }

  async function captureRemoteFrame(session, context = {}) {
    const isPve = session.provider === 'pve-qmp' || isPveTargetId(session.id);
    const isVnc = session.provider === 'rfb' || isVncTargetId(session.id);

    if (isVnc) {
      if (!effectiveRfbDriver) {
        throw new Error(`RFB driver is unavailable for VNC target ${session.id}.`);
      }
      const rawCapture = await effectiveRfbDriver.captureRgba(
        vncTargetsById.get(session.id) || session,
        { signal: context?.signal },
      );
      const reg = vncTargetsById.get(session.id);
      if (reg && (reg.width !== rawCapture.width || reg.height !== rawCapture.height || (rawCapture.desktopName && reg.desktopName !== rawCapture.desktopName))) {
        reg.width = rawCapture.width;
        reg.height = rawCapture.height;
        if (rawCapture.desktopName) reg.desktopName = rawCapture.desktopName;
        reg.updatedAtMs = nowFn();
        await persistVncTargets(context);
      }
      return { rawCapture, provider: 'rfb', transport: 'rfb' };
    }

    if (isPve) {
      if (session.state !== 'active') {
        throw new Error(
          `PVE VM session ${session.id} ("${session.label}") is ${session.vmStatus || session.state} and cannot capture frames.`,
        );
      }
      if (shouldUsePveRfb(session.id)) {
        try {
          const rawCapture = await effectiveRfbDriver.captureRgba(session, { signal: context?.signal });
          const registered = pveTargetsById.get(session.id);
          if (registered && (registered.width !== rawCapture.width || registered.height !== rawCapture.height)) {
            registered.width = rawCapture.width;
            registered.height = rawCapture.height;
            registered.updatedAtMs = nowFn();
            await persistPveTargets(context);
          }
          return { rawCapture, provider: 'pve-qmp', transport: 'pve-rfb' };
        } catch (rfbErr) {
          if (rfbErr?.name === 'AbortError' || context?.signal?.aborted) throw rfbErr;
          pveFallbackToQmp.set(session.id, { reason: rfbErr?.message || String(rfbErr), atMs: nowFn() });
        }
      }

      const rawCapture = await effectivePveDriver.captureScreen(session, { signal: context?.signal });
      const registered = pveTargetsById.get(session.id);
      if (registered && (registered.width !== rawCapture.width || registered.height !== rawCapture.height)) {
        registered.width = rawCapture.width;
        registered.height = rawCapture.height;
        registered.updatedAtMs = nowFn();
        await persistPveTargets(context);
      }
      return { rawCapture, provider: 'pve-qmp', transport: 'pve-qmp' };
    }

    return null;
  }

  async function observeSession(session, options = {}, context = {}) {
    const settings = context?.settings ?? {};
    const isPve = session.provider === 'pve-qmp' || isPveTargetId(session.id);
    const isVnc = session.provider === 'rfb' || isVncTargetId(session.id);
    const overlay = options.overlay === 'grid' ? 'grid' : 'none';

    if (isPve || isVnc) {
      const { rawCapture, provider, transport } = await captureRemoteFrame(session, context);
      const autoTrim = options.autoTrimBlackBars !== undefined ? Boolean(options.autoTrimBlackBars) : false;
      const remoteAspect = options.remoteAspect ?? settings?.remoteAspect;
      const prevObs = lastObservationBySession.get(session.id) || null;

      const processed = processCapturedStagePng(rawCapture.image, {
        autoTrimBlackBars: autoTrim,
        remoteAspect,
        zoom: options.zoom || null,
        coordinateMode: options.coordinateMode || 'normalized_1000',
        maxWidth: options.maxWidth ?? 1440,
        maxHeight: options.maxHeight ?? 1080,
        lastObservation: prevObs,
        pngCompressionLevel: options.pngCompressionLevel ?? 3,
        overlay,
      });

      if (
        prevObs &&
        (prevObs.logicalSize.width !== processed.logicalSize.width ||
          prevObs.logicalSize.height !== processed.logicalSize.height)
      ) {
        screenshotHistoryBySession.delete(session.id);
      }

      const capturedAtMs = nowFn();
      const screenshotId = `shot_${++shotSeq}`;
      const stageBounds = rawCapture.stageBounds;
      lastContentRectBySession.set(session.id, {
        ...processed.contentRect,
        trimmed: processed.contentTrimmed,
        axis: processed.contentAxis,
      });
      lastObservationBySession.set(session.id, {
        screenshotId,
        imageSize: processed.imageSize,
        logicalSize: processed.logicalSize,
        cropBounds: processed.cropBounds,
        contentRect: processed.contentRect,
        stageBounds,
        frameHash: processed.frameHash,
        rgbaImage: processed.rgbaImage,
        capturedAtMs,
      });
      recordScreenshotHistory(session.id, {
        screenshotId,
        logicalSize: processed.logicalSize,
        contentRect: processed.contentRect,
        stageSize: { width: stageBounds.width, height: stageBounds.height },
        cropBounds: processed.cropBounds,
        capturedAtMs,
        frameHash: processed.frameHash,
        rgba: processed.rgbaImage,
      });

      const tk = getTakeoverEntry(session.id);
      return {
        ok: true,
        provider,
        transport,
        targetId: session.id,
        sessionId: session.id,
        label: session.label,
        screenshotId,
        frameHash: processed.frameHash,
        overlay: processed.overlay,
        capturedAtMs,
        mimeType: processed.mimeType,
        pngBuffer: processed.pngBuffer,
        imageBase64: processed.imageBase64,
        rgbaImage: processed.rgbaImage,
        imageSize: processed.imageSize,
        logicalSize: processed.logicalSize,
        cropBounds: processed.cropBounds,
        contentRect: processed.contentRect,
        contentTrimmed: processed.contentTrimmed,
        contentAxis: processed.contentAxis,
        stageBounds,
        cursor: { x: 0, y: 0 },
        takeoverActive: tk.active,
        controlledBy: tk.controlledBy,
        accessibility: [],
      };
    }

    if (session.state === 'minimized') {
      throw new Error(
        `Session ${session.id} ("${session.label}") is minimized and cannot render PrintWindow frames. Call uu_control(sessionId="${session.id}", action="restore") first.`,
      );
    }
    const rawCapture = await systemDriver.captureSessionStage({
      hwnd: session.hwnd,
      stageHwnd: session.stageHwnd,
    });

    const autoTrim = options.autoTrimBlackBars !== undefined
      ? Boolean(options.autoTrimBlackBars)
      : settings?.autoTrimBlackBars !== false;
    const remoteAspect = options.remoteAspect ?? settings?.remoteAspect;
    const prevObs = lastObservationBySession.get(session.id) || null;

    const processed = processCapturedStagePng(rawCapture.pngBuffer, {
      autoTrimBlackBars: autoTrim,
      remoteAspect,
      zoom: options.zoom || null,
      coordinateMode: options.coordinateMode || 'normalized_1000',
      maxWidth: options.maxWidth ?? 1440,
      maxHeight: options.maxHeight ?? 1080,
      lastObservation: prevObs,
      pngCompressionLevel: options.pngCompressionLevel ?? 3,
      overlay,
    });

    if (
      prevObs &&
      (prevObs.logicalSize.width !== processed.logicalSize.width ||
        prevObs.logicalSize.height !== processed.logicalSize.height)
    ) {
      screenshotHistoryBySession.delete(session.id);
    }

    const capturedAtMs = nowFn();
    const screenshotId = `shot_${++shotSeq}`;
    const stageBounds = rawCapture.stageBounds || session.canvasBounds;
    lastContentRectBySession.set(session.id, {
      ...processed.contentRect,
      trimmed: processed.contentTrimmed,
      axis: processed.contentAxis,
    });
    lastObservationBySession.set(session.id, {
      screenshotId,
      imageSize: processed.imageSize,
      logicalSize: processed.logicalSize,
      cropBounds: processed.cropBounds,
      contentRect: processed.contentRect,
      stageBounds,
      frameHash: processed.frameHash,
      rgbaImage: processed.rgbaImage,
      capturedAtMs,
    });
    recordScreenshotHistory(session.id, {
      screenshotId,
      logicalSize: processed.logicalSize,
      contentRect: processed.contentRect,
      stageSize: { width: stageBounds.width, height: stageBounds.height },
      cropBounds: processed.cropBounds,
      capturedAtMs,
      frameHash: processed.frameHash,
      rgba: processed.rgbaImage,
    });

    let cursorInTarget = { x: 0, y: 0 };
    if (rawCapture.cursor && Number.isFinite(rawCapture.cursor.x) && Number.isFinite(rawCapture.cursor.y)) {
      const relX = rawCapture.cursor.x - (stageBounds.x + processed.contentRect.x);
      const relY = rawCapture.cursor.y - (stageBounds.y + processed.contentRect.y);
      cursorInTarget = {
        x: Math.max(0, Math.min(Math.max(0, processed.logicalSize.width - 1), Math.round(relX))),
        y: Math.max(0, Math.min(Math.max(0, processed.logicalSize.height - 1), Math.round(relY))),
      };
    }

    const tk = getTakeoverEntry(session.id);
    return {
      ok: true,
      provider: 'uu-remote',
      transport: 'uu-win32',
      targetId: session.id,
      sessionId: session.id,
      label: session.label,
      screenshotId,
      frameHash: processed.frameHash,
      overlay: processed.overlay,
      capturedAtMs,
      mimeType: processed.mimeType,
      pngBuffer: processed.pngBuffer,
      imageBase64: processed.imageBase64,
      rgbaImage: processed.rgbaImage,
      imageSize: processed.imageSize,
      logicalSize: processed.logicalSize,
      cropBounds: processed.cropBounds,
      contentRect: processed.contentRect,
      contentTrimmed: processed.contentTrimmed,
      contentAxis: processed.contentAxis,
      stageBounds,
      cursor: cursorInTarget,
      takeoverActive: tk.active,
      controlledBy: tk.controlledBy,
      accessibility: [],
    };
  }

  async function checkPhysicalTakeoverGuard(session, settings = {}, context = {}) {
    await syncPersistedState(context);
    const existing = getTakeoverEntry(session.id);
    if (existing.active) {
      return {
        blocked: true,
        code: 'human_takeover_active',
        message: `Human takeover is active on ${session.id}${existing.reason ? ` (${existing.reason})` : ''}. Stop immediately and yield to the user; wait until takeover is released via the UU Remote panel or uu_sessions(action="takeover", sessionId="${session.id}", active=false).`,
        takeoverActive: true,
        controlledBy: existing.controlledBy || 'human',
      };
    }

    // Remote PVE/VNC sessions do not share the local desktop cursor.
    if (session.provider === 'pve-qmp' || session.provider === 'rfb' || isPveTargetId(session.id) || isVncTargetId(session.id)) {
      return { blocked: false };
    }

    const thresholdPx = Math.max(
      8,
      Math.round(Number(settings?.takeoverThresholdPx) || DEFAULT_TAKEOVER_THRESHOLD_PX),
    );
    const guardAnchor = lastCursorGuardBySession.get(session.id);
    if (guardAnchor && nowFn() - guardAnchor.atMs <= AGENT_CURSOR_GUARD_WINDOW_MS) {
      const liveCursorState = await systemDriver.getCursorState();
      const cur = liveCursorState?.cursor;
      if (cur && Number.isFinite(cur.x) && Number.isFinite(cur.y)) {
        const displacement = Math.hypot(cur.x - guardAnchor.x, cur.y - guardAnchor.y);
        if (displacement > thresholdPx) {
          const reason = `Physical cursor moved ${Math.round(displacement)}px (threshold ${thresholdPx}px)`;
          await setTakeover({ sessionId: session.id, active: true, holder: 'human', reason }, context);
          return {
            blocked: true,
            code: 'human_takeover_active',
            message: `Human takeover automatically engaged on ${session.id}: ${reason}.`,
            takeoverActive: true,
            controlledBy: 'human',
            displacementPx: Math.round(displacement),
          };
        }
      }
    }

    return { blocked: false };
  }

  async function ensureFreshContentGeometry(session, settings = {}, context = {}) {
    const cached = lastContentRectBySession.get(session.id);
    if (cached && cached.width > 0 && cached.height > 0) {
      return { stageBounds: session.canvasBounds, contentRect: cached };
    }
    if (settings?.autoTrimBlackBars === false && !settings?.remoteAspect) {
      return {
        stageBounds: session.canvasBounds,
        contentRect: { x: 0, y: 0, width: session.canvasBounds.width, height: session.canvasBounds.height },
      };
    }
    try {
      const obs = await observeSession(session, { maxWidth: 640, maxHeight: 480 }, context);
      return { stageBounds: obs.stageBounds, contentRect: obs.contentRect };
    } catch {
      return {
        stageBounds: session.canvasBounds,
        contentRect: { x: 0, y: 0, width: session.canvasBounds.width, height: session.canvasBounds.height },
      };
    }
  }

  function registerSessionActionController(sessionId, parentSignal, overrideHumanTakeover) {
    const sid = normalizeSessionId(sessionId);
    const ac = new AbortController();
    const onParentAbort = () => {
      ac.abort(parentSignal?.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let set = null;
    if (!overrideHumanTakeover) {
      set = activeActionControllers.get(sid);
      if (!set) {
        set = new Set();
        activeActionControllers.set(sid, set);
      }
      set.add(ac);
    }
    return {
      signal: ac.signal,
      cleanup() {
        parentSignal?.removeEventListener?.('abort', onParentAbort);
        if (set) {
          set.delete(ac);
          if (set.size === 0) activeActionControllers.delete(sid);
        }
      },
    };
  }

  async function tryPveQgaClipboardOrType(session, item, { sendPasteViaRfb = false, signal } = {}) {
    if (typeof effectivePveDriver?.probeQga !== 'function') {
      pveQgaAvailableBySession.set(session.id, false);
      return { handled: false, guestAgent: false };
    }
    const qga = await effectivePveDriver.probeQga(session, { signal });
    pveQgaAvailableBySession.set(session.id, Boolean(qga?.available));
    if (!qga?.available) {
      return { handled: false, guestAgent: false };
    }
    if (item.kind === 'clipboard_get') {
      const clip = await effectivePveDriver.qgaClipboardGet(session, { osType: qga.osType, signal });
      return { handled: true, guestAgent: true, result: { kind: 'clipboard_get', text: clip.text, mode: 'qga_guest_exec' } };
    }
    if (item.kind === 'clipboard_set') {
      const text = String(item.text ?? '');
      const setRes = await effectivePveDriver.qgaClipboardSet(session, text, { osType: qga.osType, signal });
      return { handled: true, guestAgent: true, result: { kind: 'clipboard_set', length: setRes.length, mode: 'qga_guest_exec' } };
    }
    if (item.kind === 'type') {
      const text = String(item.text ?? '');
      await effectivePveDriver.qgaClipboardSet(session, text, { osType: qga.osType, signal });
      await sleep(40, signal);
      if (sendPasteViaRfb && effectiveRfbDriver) {
        await effectiveRfbDriver.executeActions(
          session,
          [{ kind: 'key', keys: ['Ctrl', 'v'] }, ...(item.submit ? [{ kind: 'key', key: 'Enter' }] : [])],
          { signal },
        );
      } else {
        const pasteSteps = [
          ...buildQmpStepsForAction({ kind: 'key', keys: ['Ctrl', 'v'] }).steps,
          ...(item.submit ? [{ op: 'sleep', ms: 25 }, ...buildQmpStepsForAction({ kind: 'key', key: 'Enter' }).steps] : []),
        ];
        await effectivePveDriver.sendQmpSteps(session, pasteSteps, { signal });
      }
      return {
        handled: true,
        guestAgent: true,
        result: { kind: 'type', length: text.length, mode: 'qga_clipboard_paste', submit: Boolean(item.submit) },
      };
    }
    return { handled: false, guestAgent: true };
  }

  async function executeActionsOnRfbSession(session, {
    actions,
    coordinateMode = 'normalized_1000',
    zoomRelative = false,
    overrideHumanTakeover = false,
    signal,
  }, context = {}) {
    const isPve = isPveTargetId(session.id) || session.provider === 'pve-qmp';
    const provider = isPve ? 'pve-qmp' : 'rfb';
    const transport = isPve ? 'pve-rfb' : 'rfb';
    const targetObj = isPve ? (pveTargetsById.get(session.id) || session) : (vncTargetsById.get(session.id) || session);
    const lastObs = lastObservationBySession.get(session.id) || null;

    const results = [];
    let lastPoint = null;
    let rfbBytesSent = false;

    for (let idx = 0; idx < actions.length; idx += 1) {
      if (signal?.aborted) {
        if (isAbortForTakeover(signal.reason)) {
          return {
            ok: false,
            status: 409,
            code: 'human_takeover_active',
            effect: 'refused',
            message: `Human takeover interrupted action batch on ${session.id}.`,
            targetId: session.id,
            sessionId: session.id,
            provider,
            transport,
            executed: results.length,
            results,
            lastPoint,
            takeoverActive: true,
            controlledBy: 'human',
          };
        }
        throw signal.reason;
      }

      const item = actions[idx];
      const needsClipboard = item.kind === 'clipboard_get'
        || item.kind === 'clipboard_set'
        || (item.kind === 'type' && (item.mode === 'clipboard' || !isAsciiOnlyText(item.text ?? '')));

      if (isPve && needsClipboard) {
        const rfbCaps = await effectiveRfbDriver.getSessionCapabilities(targetObj).catch(() => null);
        const rfbExtendedClipboardNegotiated = Boolean(rfbCaps?.unicodeClipboard);
        const vdagentConfigured = Boolean(session.vdagentConfigured);
        const vdagentConnected = Boolean(session.vdagentConnected);
        const rfbConnected = rfbCaps?.connected !== false && rfbCaps != null;
        const effectiveRfbUnicodeClipboard = rfbExtendedClipboardNegotiated && vdagentConnected;

        if (!vdagentConnected || (rfbConnected && !effectiveRfbUnicodeClipboard)) {
          // Gate out QEMU VNC ExtendedClipboard black hole before sending any RFB clipboard packet.
          const qgaAttempt = await tryPveQgaClipboardOrType(session, item, { sendPasteViaRfb: true, signal });
          if (qgaAttempt.handled) {
            rfbBytesSent = true;
            results.push(qgaAttempt.result);
            continue;
          }
          const reason = !vdagentConfigured
            ? 'PVE VM has no qemu-vdagent chardev configured'
            : !vdagentConnected
              ? 'PVE VM qemu-vdagent chardev is configured but guest spice-vdagent is not connected (frontend-open=false)'
              : 'RFB server did not negotiate ExtendedClipboard UTF-8 and QEMU Guest Agent is unavailable';
          return {
            ...createUnicodeUnsupportedPayload(session.id, {
              rfbExtendedClipboardNegotiated,
              vdagentConfigured,
              vdagentConnected,
              unicodeClipboard: false,
              guestAgent: false,
              clipboard: false,
              reason,
            }),
            provider,
            transport,
            executed: results.length,
            results,
          };
        }
      }

      try {
        const stepRes = await effectiveRfbDriver.executeActions(targetObj, [item], {
          coordinateMode,
          zoomRelative,
          lastObservation: lastObs,
          allowLatin1Clipboard: false,
          signal,
        });
        if (item.kind !== 'wait' && item.kind !== 'focus' && item.kind !== 'restore') {
          rfbBytesSent = true;
        }
        if (stepRes.results?.length) results.push(...stepRes.results);
        if (stepRes.lastPoint) lastPoint = stepRes.lastPoint;
      } catch (err) {
        if (isAbortForTakeover(err) || (signal?.aborted && isAbortForTakeover(signal.reason))) {
          return {
            ok: false,
            status: 409,
            code: 'human_takeover_active',
            effect: 'refused',
            message: `Human takeover interrupted action batch on ${session.id}.`,
            targetId: session.id,
            sessionId: session.id,
            provider,
            transport,
            executed: results.length,
            results,
            lastPoint,
            takeoverActive: true,
            controlledBy: 'human',
          };
        }
        if (err?.code === 'unicode_input_unsupported') {
          if (isPve) {
            const qgaAttempt = await tryPveQgaClipboardOrType(session, item, { sendPasteViaRfb: true, signal });
            if (qgaAttempt.handled) {
              rfbBytesSent = true;
              results.push(qgaAttempt.result);
              continue;
            }
          }
          const rfbCaps = isPve
            ? await effectiveRfbDriver.getSessionCapabilities(targetObj).catch(() => null)
            : null;
          return {
            ...createUnicodeUnsupportedPayload(session.id, {
              ...(isPve
                ? {
                    rfbExtendedClipboardNegotiated: Boolean(rfbCaps?.unicodeClipboard),
                    vdagentConfigured: Boolean(session.vdagentConfigured),
                    vdagentConnected: Boolean(session.vdagentConnected),
                  }
                : {}),
              unicodeClipboard: false,
              guestAgent: false,
              clipboard: false,
              reason: err.message,
            }),
            provider,
            transport,
            executed: results.length,
            results,
          };
        }
        // Only propagate fallback signal if PVE failed BEFORE sending any non-idempotent bytes
        if (isPve && !rfbBytesSent && err?.failedBeforeSending) {
          throw err;
        }
        throw err;
      }
    }

    const tk = getTakeoverEntry(session.id);
    return {
      ok: true,
      provider,
      transport,
      targetId: session.id,
      sessionId: session.id,
      executed: results.length,
      results,
      lastPoint,
      takeoverActive: tk.active,
    };
  }

  async function executeActionsOnPveQmpSession(session, {
    actions,
    coordinateMode = 'normalized_1000',
    zoomRelative = false,
    overrideHumanTakeover = false,
    signal,
  }, context = {}) {
    const settings = context?.settings ?? {};
    const screenSize = {
      width: Math.max(1, session.canvasBounds?.width || 1024),
      height: Math.max(1, session.canvasBounds?.height || 768),
    };
    const results = [];
    let lastPoint = null;
    let pendingSteps = [];
    let pendingResults = [];

    const flushPending = async () => {
      if (pendingSteps.length === 0) return;
      if (signal?.aborted) throw signal.reason;
      if (!overrideHumanTakeover) {
        const guard = await checkPhysicalTakeoverGuard(session, settings, context);
        if (guard.blocked) {
          throw Object.assign(new Error(guard.message), { code: 'human_takeover_active', guard });
        }
      }
      const stepsToSend = pendingSteps;
      const resultsToCommit = pendingResults;
      pendingSteps = [];
      pendingResults = [];
      await effectivePveDriver.sendQmpSteps(session, stepsToSend, { signal });
      results.push(...resultsToCommit);
    };

    try {
      for (let idx = 0; idx < actions.length; idx += 1) {
        if (signal?.aborted) throw signal.reason;
        const item = actions[idx];
        const kind = item.kind;
        const lastObs = lastObservationBySession.get(session.id) || null;

        if (kind === 'wait') {
          await flushPending();
          const durationMs = Math.max(0, Math.min(30_000, Number(item.durationMs) || 250));
          await sleep(durationMs, signal);
          results.push({ kind: 'wait', durationMs });
          continue;
        }

        if (kind === 'focus' || kind === 'restore') {
          await flushPending();
          results.push({ kind, focused: true, note: 'PVE QMP session does not require local window focus.' });
          continue;
        }

        if (kind === 'clipboard_get' || kind === 'clipboard_set') {
          await flushPending();
          const qgaAttempt = await tryPveQgaClipboardOrType(session, item, { sendPasteViaRfb: false, signal });
          if (qgaAttempt.handled) {
            results.push(qgaAttempt.result);
            continue;
          }
          return {
            ...createUnicodeUnsupportedPayload(session.id, {
              rfbExtendedClipboardNegotiated: false,
              vdagentConfigured: Boolean(session.vdagentConfigured),
              vdagentConnected: Boolean(session.vdagentConnected),
              unicodeClipboard: false,
              guestAgent: false,
              clipboard: false,
              reason: `Action "${kind}" requires RFB ExtendedClipboard + vdagent or QEMU Guest Agent`,
            }),
            provider: 'pve-qmp',
            transport: 'pve-qmp',
            executed: results.length,
            results,
          };
        }

        if (kind === 'type' && (item.mode === 'clipboard' || !isAsciiOnlyText(item.text ?? ''))) {
          await flushPending();
          const qgaAttempt = await tryPveQgaClipboardOrType(session, item, { sendPasteViaRfb: false, signal });
          if (qgaAttempt.handled) {
            results.push(qgaAttempt.result);
            continue;
          }
          return {
            ...createUnicodeUnsupportedPayload(session.id, {
              rfbExtendedClipboardNegotiated: false,
              vdagentConfigured: Boolean(session.vdagentConfigured),
              vdagentConnected: Boolean(session.vdagentConnected),
              unicodeClipboard: false,
              guestAgent: false,
              clipboard: false,
              reason: 'PVE QMP keyboard input supports ASCII only and QEMU Guest Agent is unavailable',
            }),
            provider: 'pve-qmp',
            transport: 'pve-qmp',
            executed: results.length,
            results,
          };
        }

        const compiled = buildQmpStepsForAction(item, {
          coordinateMode,
          zoomRelative,
          screenSize: lastObs?.logicalSize || screenSize,
          lastObservation: lastObs,
        });
        pendingSteps.push(...compiled.steps);

        if (compiled.point) {
          lastPoint = {
            x: compiled.point.x,
            y: compiled.point.y,
            normX: compiled.point.normX,
            normY: compiled.point.normY,
            qmpAbs: { x: compiled.point.absX, y: compiled.point.absY },
          };
        }

        if (kind === 'drag') {
          pendingResults.push({
            kind: 'drag',
            button: compiled.meta.button,
            start: {
              x: compiled.startPoint.x,
              y: compiled.startPoint.y,
              normX: compiled.startPoint.normX,
              normY: compiled.startPoint.normY,
            },
            end: lastPoint,
            durationMs: compiled.meta.durationMs,
          });
        } else {
          pendingResults.push({
            ...compiled.meta,
            ...(compiled.point ? { point: lastPoint } : {}),
          });
        }
      }

      await flushPending();
    } catch (err) {
      if (isAbortForTakeover(err) || (signal?.aborted && isAbortForTakeover(signal.reason))) {
        return {
          ok: false,
          status: 409,
          code: 'human_takeover_active',
          effect: 'refused',
          message: err?.guard?.message || `Human takeover active on ${session.id}.`,
          targetId: session.id,
          sessionId: session.id,
          provider: 'pve-qmp',
          transport: 'pve-qmp',
          executed: results.length,
          results,
          lastPoint,
          takeoverActive: true,
          controlledBy: 'human',
        };
      }
      throw err;
    }

    const tk = getTakeoverEntry(session.id);
    return {
      ok: true,
      provider: 'pve-qmp',
      transport: 'pve-qmp',
      targetId: session.id,
      sessionId: session.id,
      executed: results.length,
      results,
      lastPoint,
      takeoverActive: tk.active,
    };
  }

  async function executeActionsOnSession(session, {
    actions,
    coordinateMode = 'normalized_1000',
    zoomRelative = false,
    overrideHumanTakeover = false,
    allowClientHotkey = false,
  }, context = {}) {
    const settings = context?.settings ?? {};
    const { signal: effectiveSignal, cleanup: cleanupController } = registerSessionActionController(
      session.id,
      context?.signal,
      overrideHumanTakeover,
    );

    try {
      if (!overrideHumanTakeover) {
        const guard = await checkPhysicalTakeoverGuard(session, settings, context);
        if (guard.blocked) {
          return {
            ok: false,
            status: 409,
            code: 'human_takeover_active',
            effect: 'refused',
            message: guard.message,
            targetId: session.id,
            sessionId: session.id,
            provider: session.provider || 'uu-remote',
            transport: getTransportForSession(session),
            takeoverActive: true,
            controlledBy: 'human',
          };
        }
      }

      const isVnc = session.provider === 'rfb' || isVncTargetId(session.id);
      const isPve = session.provider === 'pve-qmp' || isPveTargetId(session.id);

      if (isVnc) {
        return await executeActionsOnRfbSession(
          session,
          { actions, coordinateMode, zoomRelative, overrideHumanTakeover, signal: effectiveSignal },
          context,
        );
      }

      if (isPve) {
        if (session.state !== 'active') {
          throw new Error(
            `PVE VM session ${session.id} ("${session.label}") is ${session.vmStatus || session.state} and cannot receive input.`,
          );
        }
        if (shouldUsePveRfb(session.id)) {
          try {
            return await executeActionsOnRfbSession(
              session,
              { actions, coordinateMode, zoomRelative, overrideHumanTakeover, signal: effectiveSignal },
              context,
            );
          } catch (rfbErr) {
            if (rfbErr?.failedBeforeSending && !rfbErr?.replaySuppressed && !isAbortForTakeover(rfbErr) && !effectiveSignal.aborted) {
              pveFallbackToQmp.set(session.id, { reason: rfbErr?.message || String(rfbErr), atMs: nowFn() });
            } else {
              throw rfbErr;
            }
          }
        }
        return await executeActionsOnPveQmpSession(
          session,
          { actions, coordinateMode, zoomRelative, overrideHumanTakeover, signal: effectiveSignal },
          context,
        );
      }

      // --- UU Win32 Path with Coalesced sendInputBatch ---
      const onlyRestore = actions.length === 1 && actions[0]?.kind === 'restore';
      if (session.state === 'minimized' && !onlyRestore && !actions.some((a) => a.kind === 'restore')) {
        throw new Error(
          `Session ${session.id} ("${session.label}") is minimized. Call uu_control(sessionId="${session.id}", action="restore") before sending input.`,
        );
      }

      let geometry = null;
      const ensureGeo = async () => {
        if (!geometry) {
          geometry = await ensureFreshContentGeometry(session, settings, context);
        }
        return geometry;
      };

      const results = [];
      let lastPoint = null;
      const restorePreviousFocus = Boolean(settings?.restorePreviousFocus);

      let pendingSteps = [];
      let pendingResults = [];
      let pendingFallbackCursor = null;

      const flushWin32Batch = async () => {
        if (pendingSteps.length === 0) return;
        if (effectiveSignal.aborted) throw effectiveSignal.reason;
        if (!overrideHumanTakeover) {
          const midGuard = await checkPhysicalTakeoverGuard(session, settings, context);
          if (midGuard.blocked) {
            throw Object.assign(new Error(midGuard.message), { code: 'human_takeover_active', guard: midGuard });
          }
        }
        const stepsToSend = pendingSteps;
        const resultsToCommit = pendingResults;
        const fallbackCursor = pendingFallbackCursor;
        pendingSteps = [];
        pendingResults = [];
        pendingFallbackCursor = null;

        const batchRes = await systemDriver.sendInputBatch({
          hwnd: session.hwnd,
          restorePreviousFocus,
          steps: stepsToSend,
          signal: effectiveSignal,
        });
        const anchorX = batchRes?.cursor?.x ?? fallbackCursor?.x;
        const anchorY = batchRes?.cursor?.y ?? fallbackCursor?.y;
        if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
          lastCursorGuardBySession.set(session.id, { x: anchorX, y: anchorY, atMs: nowFn() });
        }
        results.push(...resultsToCommit);
      };

      try {
        for (let idx = 0; idx < actions.length; idx += 1) {
          if (effectiveSignal.aborted) throw effectiveSignal.reason;

          const item = actions[idx];
          const kind = item.kind;
          const lastObs = lastObservationBySession.get(session.id) || null;

          if (kind === 'wait') {
            await flushWin32Batch();
            const durationMs = Math.max(0, Math.min(30_000, Number(item.durationMs) || 250));
            await sleep(durationMs, effectiveSignal);
            results.push({ kind: 'wait', durationMs });
            continue;
          }

          if (kind === 'clipboard_get') {
            await flushWin32Batch();
            const text = await systemDriver.getClipboardText();
            results.push({ kind: 'clipboard_get', text });
            continue;
          }

          if (kind === 'clipboard_set') {
            await flushWin32Batch();
            const text = String(item.text ?? '');
            await systemDriver.setClipboardText(text);
            results.push({ kind: 'clipboard_set', length: text.length });
            continue;
          }

          if (kind === 'focus' || kind === 'restore') {
            await flushWin32Batch();
            const winRes = await systemDriver.performWindowAction({ hwnd: session.hwnd, mode: kind });
            if (kind === 'restore') {
              session.state = 'active';
              if (winRes.clientBounds?.width > 0) session.canvasBounds = winRes.clientBounds;
              geometry = null;
            }
            results.push({ kind, focused: Boolean(winRes.focused) });
            continue;
          }

          const needsGeo = ['move', 'drag'].includes(kind) ||
            (['click', 'double_click', 'right_click', 'mouse_down', 'mouse_up', 'scroll'].includes(kind) &&
              item.x !== undefined && item.y !== undefined);
          const geo = needsGeo ? await ensureGeo() : null;

          const compiled = compileWin32StepsForAction(item, {
            coordinateMode,
            zoomRelative,
            stageBounds: geo?.stageBounds || session.canvasBounds,
            contentRect: geo?.contentRect || lastContentRectBySession.get(session.id) || null,
            lastObservation: lastObs,
            allowClientHotkey,
          });
          pendingSteps.push(...compiled.steps);
          if (compiled.point) {
            lastPoint = { x: compiled.point.x, y: compiled.point.y, normX: compiled.point.normX, normY: compiled.point.normY };
            pendingFallbackCursor = { x: compiled.point.screenX, y: compiled.point.screenY };
          }
          // Preserve prior lastPoint in click/scroll result when x/y omitted
          const resObj = { ...compiled.result };
          if ((kind === 'click' || kind === 'double_click' || kind === 'right_click' || kind === 'mouse_down' || kind === 'mouse_up' || kind === 'scroll') && resObj.point === null) {
            resObj.point = lastPoint;
          }
          pendingResults.push(resObj);
        }

        await flushWin32Batch();
      } catch (err) {
        if (isAbortForTakeover(err) || (effectiveSignal.aborted && isAbortForTakeover(effectiveSignal.reason))) {
          return {
            ok: false,
            status: 409,
            code: 'human_takeover_active',
            effect: 'refused',
            message: err?.guard?.message || `Human takeover active on ${session.id}.`,
            targetId: session.id,
            sessionId: session.id,
            provider: 'uu-remote',
            transport: 'uu-win32',
            executed: results.length,
            results,
            lastPoint,
            takeoverActive: true,
            controlledBy: 'human',
          };
        }
        throw err;
      }

      const tk = getTakeoverEntry(session.id);
      return {
        ok: true,
        provider: 'uu-remote',
        transport: 'uu-win32',
        targetId: session.id,
        sessionId: session.id,
        executed: results.length,
        results,
        lastPoint,
        takeoverActive: tk.active,
      };
    } finally {
      cleanupController();
    }
  }

  function extractPveTargetInput(args = {}) {
    if (args.pveHost !== undefined || args.vmid !== undefined) {
      const id = buildPveTargetId(args.pveHost, args.vmid);
      return parsePveTargetId(id, { strict: true });
    }
    const candidate = args.deviceId ?? args.sessionId;
    if (isPveTargetId(candidate)) {
      return parsePveTargetId(candidate, { strict: true });
    }
    return null;
  }

  function extractVncTargetInput(args = {}) {
    if (args.vncHost !== undefined) {
      const id = buildVncTargetId(args.vncHost, args.vncPort ?? 5900);
      const parsed = parseVncTargetId(id, { strict: true });
      const sshHost = args.sshHost ? assertValidPveHost(args.sshHost) : null;
      return { ...parsed, sshHost };
    }
    const candidate = args.deviceId ?? args.sessionId;
    if (isVncTargetId(candidate)) {
      const parsed = parseVncTargetId(candidate, { strict: true });
      const sshHost = args.sshHost ? assertValidPveHost(args.sshHost) : null;
      return { ...parsed, sshHost };
    }
    return null;
  }

  function applyDedupeUnchanged(sessionId, obs, dedupeUnchanged) {
    const sid = normalizeSessionId(sessionId);
    let state = dedupeStateBySession.get(sid);
    if (!state) {
      state = { lastHash: null, streak: 0 };
      dedupeStateBySession.set(sid, state);
    }

    if (!dedupeUnchanged) {
      state.lastHash = obs.frameHash;
      state.streak = 0;
      return { deduped: false, unchanged: false, unchangedStreak: 0 };
    }

    if (state.lastHash && obs.frameHash && state.lastHash === obs.frameHash && state.streak < DEDUPE_UNCHANGED_MAX_STREAK) {
      state.streak += 1;
      return { deduped: true, unchanged: true, unchangedStreak: state.streak };
    }

    state.lastHash = obs.frameHash;
    state.streak = 0;
    return { deduped: false, unchanged: false, unchangedStreak: 0 };
  }

  async function getStatus(args = {}, context = {}) {
    await syncPersistedState(context);
    const settings = context?.settings ?? {};
    const includeCliStatus = args?.includeCliStatus !== false;

    const [install, cliVersion, topo] = await Promise.all([
      systemDriver.discoverInstallation(settings),
      cliClient.getVersion(settings, { signal: context?.signal }),
      inspectCombinedTopology(settings, context),
    ]);

    const uuSessions = topo.sessions.filter((s) => s.provider === 'uu-remote');
    const mainClientRunning = topo.launchers.length > 0 || uuSessions.length > 0 || topo.processes.some(
      (p) => !/server|service/i.test(String(p.name || '')),
    );

    let cliStatus = null;
    if (includeCliStatus && cliVersion.available && mainClientRunning) {
      cliStatus = await cliClient.getStatus(settings, { signal: context?.signal });
    }

    const sessions = topo.sessions.map(decorateSession);
    const selected = pickSelectedSession(sessions);
    const busStatus = typeof busInspector === 'function' ? await busInspector(context) : null;

    return {
      ok: true,
      hostPlatform: systemDriver.hostPlatform,
      installation: install,
      cli: {
        available: cliVersion.available,
        path: cliVersion.path,
        source: cliVersion.source,
        version: cliVersion.version,
        diagnostics: cliStatus?.ok ? cliStatus.data : null,
        diagnosticsError: cliStatus && !cliStatus.ok ? cliStatus.error : undefined,
      },
      runtime: {
        mainClientRunning,
        launcherOpen: topo.launchers.length > 0,
        processes: topo.processes,
        activeSessions: sessions.filter((s) => s.state === 'active').length,
        minimizedSessions: sessions.filter((s) => s.state === 'minimized').length,
        offscreenSessions: sessions.filter((s) => s.state === 'offscreen').length,
        offscreenLaunchers: topo.launchers.filter((l) => l.offscreen).length,
        pveTargets: pveTargetsById.size,
        vncTargets: vncTargetsById.size,
      },
      providerBus: busStatus,
      selectedSessionId: selected,
      sessions: sessions.map((s) => ({
        id: s.id,
        provider: s.provider,
        transport: s.transport,
        label: s.label,
        state: s.state,
        ...(s.vmStatus ? { vmStatus: s.vmStatus } : {}),
        canvasBounds: s.canvasBounds,
        dpi: s.dpi,
        takeoverActive: s.takeoverActive,
      })),
      portalUrl: UU_PORTAL_URL,
    };
  }

  async function manageSessions(args = {}, context = {}) {
    await syncPersistedState(context);
    const settings = context?.settings ?? {};
    const action = args?.action || 'list';

    if (action === 'takeover') {
      if (typeof args.active !== 'boolean') {
        throw new Error('uu_sessions action="takeover" requires boolean active=true|false.');
      }
      return setTakeover(
        {
          sessionId: args.sessionId,
          active: args.active,
          holder: args.active ? 'human' : 'agent',
          reason: args.reason,
        },
        context,
      );
    }

    const topo = await inspectCombinedTopology(settings, context, {
      probePveResolution: Boolean(args.probeContentRect),
    });

    if (action === 'select') {
      const targetId = normalizeSessionId(args.sessionId);
      if (!targetId) {
        throw new Error('uu_sessions action="select" requires sessionId (uu:<hwnd>, pve:<ssh_host>:<vmid>, or vnc:<host>:<port>).');
      }
      const match = topo.sessions.find((s) => s.id === targetId);
      if (!match) {
        throw new Error(`Session "${targetId}" was not found among open UU Remote windows, registered PVE VMs, or VNC targets.`);
      }
      selectedSessionId = match.id;
      await persistState(context);
      return {
        ok: true,
        selectedSessionId,
        session: decorateSession(match),
      };
    }

    if (args.probeContentRect) {
      for (const session of topo.sessions) {
        if (session.state === 'active' && session.provider === 'uu-remote') {
          await observeSession(session, { maxWidth: 640, maxHeight: 480 }, context).catch(() => {});
        }
      }
    }

    const sessions = topo.sessions.map(decorateSession);
    const selected = pickSelectedSession(sessions);

    let pairedDevices = [];
    let cliDeviceError;
    if (args.includeDevices !== false) {
      const devList = await cliClient.listDevices(settings, { signal: context?.signal });
      if (devList.available) {
        pairedDevices = devList.devices;
        if (!devList.ok && devList.error) cliDeviceError = devList.error;
      }
    }

    let remoteTerminals = [];
    if (args.includeTerminals) {
      const targetDeviceIds = args.deviceId
        ? [String(args.deviceId).trim()]
        : pairedDevices.filter((d) => d.connected || d.online).map((d) => d.deviceId);
      const termResults = await Promise.all(
        targetDeviceIds.map((id) => cliClient.listTerminals(id, settings, { signal: context?.signal })),
      );
      remoteTerminals = termResults.filter((r) => r.available);
    }

    return {
      ok: true,
      selectedSessionId: selected,
      sessions,
      offscreenCount: sessions.filter((s) => s.state === 'offscreen').length +
        topo.launchers.filter((l) => l.offscreen).length,
      pairedDevices,
      remoteTerminals: args.includeTerminals ? remoteTerminals : undefined,
      cliDeviceError,
    };
  }

  async function controlSession(args = {}, context = {}) {
    const startedAtMs = nowFn();
    await syncPersistedState(context);
    const settings = context?.settings ?? {};
    let session;
    if (args.sessionId && isPveTargetId(args.sessionId)) {
      session = await resolveExplicitPveTarget(args.sessionId, context);
    } else if (args.sessionId && isVncTargetId(args.sessionId)) {
      session = await resolveExplicitVncTarget(args.sessionId);
    } else {
      const topo = await inspectCombinedTopology(settings, context);
      session = await resolveTargetSession(args.sessionId, topo, context);
    }

    const coordinateMode = args.coordinateMode || 'normalized_1000';
    const overlay = args.overlay === 'grid' ? 'grid' : 'none';
    const dedupeUnchanged = Boolean(args.dedupeUnchanged);

    const isExplicitScreenshot = !Array.isArray(args.actions) && (!args.action || args.action === 'screenshot');
    if (isExplicitScreenshot) {
      const obs = await observeSession(
        session,
        {
          zoom: args.zoom,
          coordinateMode,
          maxWidth: args.maxWidth ?? 1440,
          maxHeight: args.maxHeight ?? 1080,
          autoTrimBlackBars: args.autoTrimBlackBars,
          remoteAspect: args.remoteAspect,
          overlay,
        },
        context,
      );
      const dedupeInfo = applyDedupeUnchanged(session.id, obs, dedupeUnchanged);
      const capInfo = await getSessionTransportAndCapabilities(session.id, session).catch(() => null);
      const latencyMs = Math.max(0, Math.round(nowFn() - startedAtMs));
      return {
        ok: true,
        provider: obs.provider,
        transport: obs.transport,
        capabilities: capInfo?.capabilities,
        action: 'screenshot',
        sessionId: obs.sessionId,
        label: obs.label,
        screenshotId: obs.screenshotId,
        frameHash: obs.frameHash,
        overlay: obs.overlay,
        latencyMs,
        imageSize: obs.imageSize,
        logicalSize: obs.logicalSize,
        contentRect: obs.contentRect,
        contentTrimmed: obs.contentTrimmed,
        cropBounds: obs.cropBounds,
        takeoverActive: obs.takeoverActive,
        controlledBy: obs.controlledBy,
        ...(dedupeInfo.deduped
          ? { unchanged: true, deduped: true, unchangedStreak: dedupeInfo.unchangedStreak }
          : { mimeType: obs.mimeType, imageBase64: obs.imageBase64 }),
      };
    }

    // Opt-in screenshotId geometry guard (OQ3: enforced strictly only when caller supplies screenshotId).
    if (args.screenshotId !== undefined && args.screenshotId !== null && String(args.screenshotId).trim() !== '') {
      const geomCheck = validateScreenshotIdGeometry(session, String(args.screenshotId).trim());
      if (!geomCheck.ok) {
        return {
          ...geomCheck,
          provider: session.provider || 'uu-remote',
          transport: getTransportForSession(session),
          latencyMs: Math.max(0, Math.round(nowFn() - startedAtMs)),
        };
      }
    }

    const actions = Array.isArray(args.actions) && args.actions.length > 0
      ? args.actions
      : [
          {
            kind: args.action,
            x: args.x,
            y: args.y,
            startX: args.startX,
            startY: args.startY,
            endX: args.endX,
            endY: args.endY,
            button: args.button,
            count: args.count,
            modifiers: args.modifiers,
            deltaX: args.deltaX,
            deltaY: args.deltaY,
            durationMs: args.durationMs,
            text: args.text,
            submit: args.submit,
            mode: args.mode,
            key: args.key,
            keys: args.keys,
          },
        ];

    const nonVisualOnly = actions.every((a) => a.kind === 'clipboard_get' || a.kind === 'clipboard_set');
    const verifiedReadbackOnly = actions.every((a) =>
      a.kind === 'clipboard_get' ||
      ((a.kind === 'focus' || a.kind === 'restore') && session.provider === 'uu-remote'),
    );
    const shouldObserve = args.observeAfter !== undefined ? Boolean(args.observeAfter) : !nonVisualOnly;
    const wantSettle = args.waitForSettle !== false;

    // Snapshot pre-action state for settle & diff
    const beforeObs = lastObservationBySession.get(session.id) || null;
    const beforeRgba = beforeObs?.rgbaImage || null;
    const rfbStartSeq = (isVncTargetId(session.id) || (isPveTargetId(session.id) && shouldUsePveRfb(session.id)))
      ? (effectiveRfbDriver?.getCurrentFrameSeq?.(session) ?? 0)
      : 0;

    const actResult = await executeActionsOnSession(
      session,
      {
        actions,
        coordinateMode,
        zoomRelative: Boolean(args.zoomRelative),
        overrideHumanTakeover: Boolean(args.overrideHumanTakeover),
        allowClientHotkey: Boolean(args.allowClientHotkey),
      },
      context,
    );

    if (!actResult.ok) {
      return {
        ...actResult,
        effect: actResult.effect || 'refused',
        latencyMs: Math.max(0, Math.round(nowFn() - startedAtMs)),
      };
    }

    const activeTransport = actResult.transport || getTransportForSession(session);
    let settleMode = 'none';
    let observation = null;
    let diff = null;

    if (shouldObserve && context?.imageIn !== false) {
      if (wantSettle) {
        if (activeTransport === 'pve-rfb' || activeTransport === 'rfb') {
          settleMode = 'rfb_dirty_rect';
          await effectiveRfbDriver.waitForSettle(session, {
            startSeq: rfbStartSeq,
            maxWaitMs: args.settleMs ?? 1200,
            signal: context?.signal,
          }).catch(() => {});
        } else if (activeTransport === 'pve-qmp') {
          settleMode = 'dual_frame_diff';
          const delay = args.settleMs !== undefined ? Math.min(args.settleMs, 2000) : 120;
          if (delay > 0) await sleep(delay, context?.signal);
        } else {
          settleMode = 'fixed_delay';
          const delay = args.settleMs !== undefined ? Math.min(args.settleMs, 2000) : 110;
          if (delay > 0) await sleep(delay, context?.signal);
        }
      }

      let refreshed = session;
      if (session.provider === 'uu-remote') {
        const freshTopo = await systemDriver.inspectTopology(settings);
        refreshed = freshTopo.sessions.find((s) => s.id === session.id) || session;
      }
      if (refreshed.state === 'active') {
        observation = await observeSession(
          refreshed,
          {
            coordinateMode,
            maxWidth: args.maxWidth ?? 1440,
            maxHeight: args.maxHeight ?? 1080,
            autoTrimBlackBars: args.autoTrimBlackBars,
            remoteAspect: args.remoteAspect,
            overlay,
          },
          context,
        ).catch(() => null);
      }

      if (observation && beforeRgba && observation.rgbaImage) {
        diff = computeSampledFrameDiff(beforeRgba, observation.rgbaImage);
      }
    }

    let effect = 'unverifiable';
    if (verifiedReadbackOnly) {
      effect = 'confirmed';
    } else if (diff && !diff.changed) {
      effect = 'suspected_noop';
    } else {
      effect = 'unverifiable';
    }

    const dedupeInfo = observation ? applyDedupeUnchanged(session.id, observation, dedupeUnchanged) : null;
    const latencyMs = Math.max(0, Math.round(nowFn() - startedAtMs));

    return {
      ...actResult,
      transport: activeTransport,
      effect,
      settleMode,
      ...(diff ? { diff } : {}),
      latencyMs,
      ...(observation ? { screenshotId: observation.screenshotId, frameHash: observation.frameHash } : {}),
      observation: observation
        ? {
            screenshotId: observation.screenshotId,
            frameHash: observation.frameHash,
            overlay: observation.overlay,
            capturedAtMs: observation.capturedAtMs,
            imageSize: observation.imageSize,
            logicalSize: observation.logicalSize,
            contentRect: observation.contentRect,
            contentTrimmed: observation.contentTrimmed,
            ...(dedupeInfo?.deduped
              ? { unchanged: true, deduped: true, unchangedStreak: dedupeInfo.unchangedStreak }
              : { mimeType: observation.mimeType, imageBase64: observation.imageBase64 }),
          }
        : undefined,
    };
  }

  async function waitForSessionWindow(waitMs, settings, signal) {
    const deadline = nowFn() + Math.max(0, Math.min(30_000, Number(waitMs) || 0));
    let topo = await systemDriver.inspectTopology(settings);
    while (topo.sessions.length === 0 && nowFn() < deadline) {
      await sleep(350, signal);
      topo = await systemDriver.inspectTopology(settings);
    }
    return topo;
  }

  async function launchAction(args = {}, context = {}) {
    await syncPersistedState(context);
    const settings = context?.settings ?? {};
    const action = args?.action;
    const waitMs = args?.waitForWindowMs ?? 4000;

    if (action === 'recover_offscreen') {
      const topo = await systemDriver.inspectTopology(settings);
      const primaryMonitor = topo.monitors.find((m) => m.primary) || topo.monitors[0] || null;
      const filterId = args.sessionId ? normalizeSessionId(args.sessionId) : null;

      const strandedSessions = topo.sessions.filter(
        (s) => s.state === 'offscreen' && (!filterId || s.id === filterId),
      );
      const strandedLaunchers = filterId ? [] : topo.launchers.filter((l) => l.offscreen);
      const targets = [
        ...strandedSessions.map((s, idx) => ({
          hwnd: s.hwnd,
          id: s.id,
          label: s.label,
          ...computeRescueBounds(s.outerBounds, primaryMonitor, idx),
        })),
        ...strandedLaunchers.map((l, idx) => ({
          hwnd: l.hwnd,
          id: `launcher:${l.hwnd}`,
          label: l.title,
          ...computeRescueBounds(l.outerBounds, primaryMonitor, strandedSessions.length + idx),
        })),
      ];

      if (targets.length === 0) {
        return { ok: true, action, rescuedCount: 0, rescued: [] };
      }

      const movedRes = await systemDriver.recoverOffscreenWindows(targets);
      return {
        ok: true,
        action,
        rescuedCount: movedRes.moved.length,
        rescued: targets.map((t) => ({ id: t.id, label: t.label, targetBounds: { x: t.x, y: t.y, width: t.width, height: t.height } })),
      };
    }

    if (action === 'open_client') {
      const install = await systemDriver.discoverInstallation(settings);
      const launchRes = await systemDriver.openClientExecutable(install.executablePath);
      const topo = waitMs > 0
        ? await waitForSessionWindow(Math.min(waitMs, 2500), settings, context?.signal).catch(() => null)
        : null;
      return {
        ok: true,
        action,
        launched: launchRes.launched,
        pid: launchRes.pid,
        sessions: topo ? topo.sessions.map(decorateSession) : undefined,
        portalUrl: UU_PORTAL_URL,
      };
    }

    if (action === 'open_uri') {
      const uriRes = await systemDriver.openProtocolUri(args.uri);
      const topo = waitMs > 0
        ? await waitForSessionWindow(waitMs, settings, context?.signal).catch(() => null)
        : null;
      return {
        ok: true,
        action,
        opened: uriRes.opened,
        sessions: topo ? topo.sessions.map(decorateSession) : undefined,
      };
    }

    if (action === 'connect' || action === 'connect_device') {
      const vncTarget = extractVncTargetInput(args);
      if (vncTarget) {
        if (!effectiveRfbDriver) {
          throw new Error('RFB driver is not available in this service instance.');
        }
        if (args.vncPassword !== undefined) {
          effectiveRfbDriver.setVncPassword(vncTarget.id, args.vncPassword);
        }
        const rfbSession = await effectiveRfbDriver.ensureConnected(vncTarget, { signal: context?.signal });
        const existing = vncTargetsById.get(vncTarget.id);
        const now = nowFn();
        const customLabel = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : null;
        const record = {
          id: vncTarget.id,
          host: vncTarget.host,
          port: vncTarget.port,
          sshHost: vncTarget.sshHost ?? existing?.sshHost ?? null,
          label: customLabel || existing?.label || null,
          desktopName: rfbSession.client?.name || existing?.desktopName || null,
          width: rfbSession.framebuffer?.width || rfbSession.client?.width || existing?.width || null,
          height: rfbSession.framebuffer?.height || rfbSession.client?.height || existing?.height || null,
          addedAtMs: existing?.addedAtMs || now,
          updatedAtMs: now,
        };
        vncTargetsById.set(record.id, record);
        selectedSessionId = record.id;
        await Promise.all([persistVncTargets(context), persistState(context)]);

        const liveCaps = await effectiveRfbDriver.getSessionCapabilities(record);
        const decorated = decorateSession(buildVncSessionObject(record, liveCaps, null));
        return {
          ok: true,
          action,
          provider: 'rfb',
          transport: 'rfb',
          deviceId: record.id,
          sessionId: record.id,
          selectedSessionId: record.id,
          session: decorated,
          sessions: [decorated],
        };
      }

      const pveTarget = extractPveTargetInput(args);
      if (pveTarget) {
        // Explicit connect resets any prior one-time RFB -> QMP fallback and stale QGA cache.
        pveFallbackToQmp.delete(pveTarget.id);
        pveQgaAvailableBySession.delete(pveTarget.id);
        const live = await effectivePveDriver.probeStatus(pveTarget, {
          probeResolution: true,
          forceRefresh: true,
          signal: context?.signal,
        });
        let rfbDims = null;
        if (pveRfbEnabled && live?.running) {
          try {
            const rfbSess = await effectiveRfbDriver.ensureConnected(pveTarget, { signal: context?.signal });
            if (rfbSess?.framebuffer?.width > 0 && rfbSess?.framebuffer?.height > 0) {
              rfbDims = { width: rfbSess.framebuffer.width, height: rfbSess.framebuffer.height };
            }
          } catch (rfbErr) {
            pveFallbackToQmp.set(pveTarget.id, { reason: rfbErr?.message || String(rfbErr), atMs: nowFn() });
          }
        }
        const existing = pveTargetsById.get(pveTarget.id);
        const now = nowFn();
        const customLabel = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : null;
        const record = {
          id: pveTarget.id,
          sshHost: pveTarget.sshHost,
          vmid: pveTarget.vmid,
          label: customLabel || existing?.label || null,
          vmName: live?.vmName || existing?.vmName || null,
          width: rfbDims?.width || (Number.isFinite(live?.width) && live.width > 0 ? Math.round(live.width) : null) || existing?.width || null,
          height: rfbDims?.height || (Number.isFinite(live?.height) && live.height > 0 ? Math.round(live.height) : null) || existing?.height || null,
          addedAtMs: existing?.addedAtMs || now,
          updatedAtMs: now,
        };
        pveTargetsById.set(record.id, record);
        selectedSessionId = record.id;
        await Promise.all([persistPveTargets(context), persistState(context)]);

        const decorated = decorateSession(buildPveSessionObject(record, live, null));
        return {
          ok: true,
          action,
          provider: 'pve-qmp',
          transport: decorated.transport,
          deviceId: record.id,
          sessionId: record.id,
          selectedSessionId: record.id,
          session: decorated,
          sessions: [decorated],
        };
      }

      const cliRes = await cliClient.connectDevice(args.deviceId, settings, { signal: context?.signal });
      const topo = waitMs > 0
        ? await waitForSessionWindow(waitMs, settings, context?.signal).catch(() => null)
        : null;
      const sessions = topo ? topo.sessions.map(decorateSession) : [];
      const selected = pickSelectedSession(sessions);
      if (selected) await persistState(context);
      return {
        ok: true,
        action,
        deviceId: cliRes.deviceId,
        cliResult: cliRes.result,
        selectedSessionId: selected,
        sessions,
      };
    }

    if (action === 'disconnect' || action === 'disconnect_device') {
      const vncTarget = extractVncTargetInput(args);
      if (vncTarget) {
        const removed = vncTargetsById.delete(vncTarget.id);
        takeoverBySession.delete(vncTarget.id);
        invalidateSessionGeometry(vncTarget.id);
        dedupeStateBySession.delete(vncTarget.id);
        humanSummaryBySession.delete(vncTarget.id);
        if (selectedSessionId === vncTarget.id) selectedSessionId = null;
        effectiveRfbDriver?.clearVncPassword?.(vncTarget.id);
        await effectiveRfbDriver?.disconnectTarget?.(vncTarget.id).catch(() => {});
        await Promise.all([persistVncTargets(context), persistState(context)]);
        return {
          ok: true,
          action,
          provider: 'rfb',
          transport: 'rfb',
          deviceId: vncTarget.id,
          sessionId: vncTarget.id,
          removed,
        };
      }

      const pveTarget = extractPveTargetInput(args);
      if (pveTarget) {
        const removed = pveTargetsById.delete(pveTarget.id);
        takeoverBySession.delete(pveTarget.id);
        invalidateSessionGeometry(pveTarget.id);
        dedupeStateBySession.delete(pveTarget.id);
        humanSummaryBySession.delete(pveTarget.id);
        pveFallbackToQmp.delete(pveTarget.id);
        pveVdagentBySession.delete(pveTarget.id);
        pveQgaAvailableBySession.delete(pveTarget.id);
        if (selectedSessionId === pveTarget.id) {
          selectedSessionId = null;
        }
        await effectiveRfbDriver?.disconnectTarget?.(pveTarget.id).catch(() => {});
        await Promise.all([persistPveTargets(context), persistState(context)]);

        const hostStillUsed = [...pveTargetsById.values()].some((t) => t.sshHost === pveTarget.sshHost);
        if (!hostStillUsed) {
          await effectivePveDriver.disconnectHost(pveTarget.sshHost).catch(() => {});
        }
        return {
          ok: true,
          action,
          provider: 'pve-qmp',
          deviceId: pveTarget.id,
          sessionId: pveTarget.id,
          removed,
        };
      }

      const cliRes = await cliClient.disconnectDevice(args.deviceId, settings, { signal: context?.signal });
      return {
        ok: true,
        action,
        deviceId: cliRes.deviceId,
        cliResult: cliRes.result,
      };
    }

    throw new Error(`Unsupported uu_launch action: "${String(action)}"`);
  }

  // --- CUA Provider Bus v1 Adapter Methods ---
  async function listCuaTargets(context = {}) {
    await syncPersistedState(context);
    const topo = await inspectCombinedTopology(context?.settings ?? {}, context);
    return Promise.all(
      topo.sessions.map(async (raw) => {
        const s = decorateSession(raw);
        const isUu = s.provider === 'uu-remote';
        const info = await getSessionTransportAndCapabilities(s.id, s);
        const caps = ['screenshot', 'zoom', 'grid', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'takeover'];
        if (isUu || info.capabilities.clipboard) {
          caps.push('clipboard');
        }
        return {
          id: s.id,
          providerId: 'kiki-uu-remote',
          provider: s.provider,
          transport: s.transport,
          kind: 'remote-desktop',
          label: s.label,
          platform: 'desktop',
          online: s.state === 'active',
          state: s.state,
          takeoverActive: s.takeoverActive,
          controlledBy: s.controlledBy,
          dimensions: {
            width: Math.max(1, s.contentRect.width || s.canvasBounds.width),
            height: Math.max(1, s.contentRect.height || s.canvasBounds.height),
            scaleFactor: 1,
          },
          capabilities: caps,
        };
      }),
    );
  }

  async function observeCuaTarget(body = {}, context = {}) {
    await syncPersistedState(context);
    let session;
    if (body.targetId && isPveTargetId(body.targetId)) {
      session = await resolveExplicitPveTarget(body.targetId, context);
    } else if (body.targetId && isVncTargetId(body.targetId)) {
      session = await resolveExplicitVncTarget(body.targetId);
    } else {
      const topo = await inspectCombinedTopology(context?.settings ?? {}, context);
      session = await resolveTargetSession(body.targetId, topo, context);
    }
    const obs = await observeSession(
      session,
      {
        zoom: body.zoom || null,
        coordinateMode: body.coordinateMode || 'normalized_1000',
        maxWidth: body.maxWidth,
        maxHeight: body.maxHeight,
        overlay: body.overlay === 'grid' ? 'grid' : 'none',
      },
      context,
    );
    return {
      ok: true,
      targetId: obs.targetId,
      transport: obs.transport,
      screenshotId: obs.screenshotId,
      frameHash: obs.frameHash,
      overlay: obs.overlay,
      capturedAtMs: obs.capturedAtMs,
      mimeType: obs.mimeType,
      imageBase64: obs.imageBase64,
      imageSize: obs.imageSize,
      logicalSize: obs.logicalSize,
      cropBounds: obs.cropBounds,
      contentRect: obs.contentRect,
      cursor: obs.cursor,
      takeoverActive: obs.takeoverActive,
      controlledBy: obs.controlledBy,
      accessibility: [],
    };
  }

  async function actOnCuaTarget(body = {}, context = {}) {
    await syncPersistedState(context);
    let session;
    if (body.targetId && isPveTargetId(body.targetId)) {
      session = await resolveExplicitPveTarget(body.targetId, context);
    } else if (body.targetId && isVncTargetId(body.targetId)) {
      session = await resolveExplicitVncTarget(body.targetId);
    } else {
      const topo = await inspectCombinedTopology(context?.settings ?? {}, context);
      session = await resolveTargetSession(body.targetId, topo, context);
    }
    const actions = Array.isArray(body.actions) ? body.actions : [];
    if (actions.length === 0) {
      throw new Error('POST /v1/act requires a non-empty actions array.');
    }
    if (body.screenshotId) {
      const check = validateScreenshotIdGeometry(session, String(body.screenshotId).trim());
      if (!check.ok) return check;
    }
    const started = nowFn();
    const res = await executeActionsOnSession(
      session,
      {
        actions,
        coordinateMode: body.coordinateMode || 'normalized_1000',
        zoomRelative: Boolean(body.zoomRelative),
        overrideHumanTakeover: Boolean(body.overrideHumanTakeover),
        allowClientHotkey: Boolean(body.allowClientHotkey),
      },
      context,
    );
    return {
      ...res,
      effect: res.ok ? (res.effect || 'unverifiable') : (res.effect || 'refused'),
      latencyMs: Math.max(0, Math.round(nowFn() - started)),
    };
  }

  function subscribeSessionUpdates(sessionId, listener) {
    const sid = normalizeSessionId(sessionId);
    if (!effectiveRfbDriver || typeof effectiveRfbDriver.subscribeUpdates !== 'function') {
      return () => {};
    }
    if (isVncTargetId(sid) || (isPveTargetId(sid) && shouldUsePveRfb(sid))) {
      return effectiveRfbDriver.subscribeUpdates(sid, listener);
    }
    return () => {};
  }

  function subscribeSessionClipboard(sessionId, listener) {
    const sid = normalizeSessionId(sessionId);
    if (!effectiveRfbDriver || typeof effectiveRfbDriver.subscribeClipboard !== 'function') {
      return () => {};
    }
    if (isVncTargetId(sid) || (isPveTargetId(sid) && shouldUsePveRfb(sid))) {
      return effectiveRfbDriver.subscribeClipboard(sid, listener);
    }
    return () => {};
  }

  function resolveRegisteredRfbTarget(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (isVncTargetId(sid)) {
      return vncTargetsById.get(sid) || sid;
    }
    if (isPveTargetId(sid) && shouldUsePveRfb(sid)) {
      return pveTargetsById.get(sid) || sid;
    }
    return null;
  }

  async function buildRfbKeyframePacket(sessionId, { signal } = {}) {
    const target = resolveRegisteredRfbTarget(sessionId);
    if (!target || typeof effectiveRfbDriver?.buildKeyframePacket !== 'function') return null;
    const tk = getTakeoverEntry(sessionId);
    return effectiveRfbDriver.buildKeyframePacket(target, { takeoverActive: tk.active, signal });
  }

  function buildRfbCoalescedBoundsPacket(sessionId, bounds) {
    const target = resolveRegisteredRfbTarget(sessionId);
    if (!target || typeof effectiveRfbDriver?.buildCoalescedBoundsPacket !== 'function') return null;
    const tk = getTakeoverEntry(sessionId);
    return effectiveRfbDriver.buildCoalescedBoundsPacket(target, bounds, { takeoverActive: tk.active });
  }

  function sendLiveRfbInput(sessionId, event = {}, context = {}) {
    const sid = normalizeSessionId(sessionId);
    const target = resolveRegisteredRfbTarget(sid);
    if (!target || !effectiveRfbDriver) return false;

    if (event.engageTakeover && !getTakeoverEntry(sid).active) {
      void setTakeover(
        {
          sessionId: sid,
          active: true,
          holder: 'human',
          reason: 'Interactive input from UU Remote workspace panel',
        },
        context,
      ).catch(() => {});
    }

    if (event.type === 'pointer') {
      if (event.op === 1 && typeof recordHumanPanelAction === 'function') {
        recordHumanPanelAction(sid, { kind: 'click', x: event.norm1000X, y: event.norm1000Y });
      }
      return effectiveRfbDriver.sendLivePointer?.(target, event) ?? false;
    }
    if (event.type === 'wheel') {
      recordHumanPanelAction(sid, { kind: 'scroll', deltaY: event.deltaY });
      return effectiveRfbDriver.sendLiveWheel?.(target, event) ?? false;
    }
    if (event.type === 'key') {
      if (event.down) {
        recordHumanPanelAction(sid, { kind: 'key', key: event.code || event.key });
      }
      return effectiveRfbDriver.sendLiveRawKey?.(target, event) ?? false;
    }
    return false;
  }

  async function dispose() {
    for (const set of activeActionControllers.values()) {
      for (const ac of set) {
        try { ac.abort(new Error('Service disposed')); } catch {}
      }
    }
    activeActionControllers.clear();
    await Promise.allSettled([
      systemDriver?.dispose?.(),
      effectivePveDriver?.dispose?.(),
      effectiveRfbDriver?.dispose?.(),
    ]);
  }

  return {
    setStateDir,
    getStatus,
    manageSessions,
    controlSession,
    launchAction,
    observeSession,
    resolveTargetSession,
    inspectTopology: (settings = {}, context = {}) => inspectCombinedTopology(settings, context),
    setTakeover,
    recordHumanPanelAction,
    getLastHumanSummary,
    clearHumanSummary,
    getSessionTransportAndCapabilities,
    getTakeoverEntry,
    subscribeSessionUpdates,
    subscribeSessionClipboard,
    buildRfbKeyframePacket,
    buildRfbCoalescedBoundsPacket,
    sendLiveRfbInput,
    listCuaTargets,
    observeCuaTarget,
    actOnCuaTarget,
    dispose,
  };
}
