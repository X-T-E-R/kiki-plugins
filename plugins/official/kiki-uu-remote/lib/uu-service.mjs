import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapPointToTarget, processCapturedStagePng } from './frame-math.mjs';
import { assertSafeRemoteKeyChord } from './key-map.mjs';
import {
  buildPveTargetId,
  buildQmpStepsForAction,
  createPveQmpDriver,
  isPveTargetId,
  parsePveTargetId,
} from './pve-qmp-driver.mjs';
import { createUuycCliClient } from './uuyc-cli.mjs';
import { UU_PORTAL_URL, createWin32SystemDriver } from './win32-driver.mjs';
import { computeRescueBounds, normalizeSessionId } from './window-topology.mjs';

const AGENT_CURSOR_GUARD_WINDOW_MS = 20_000;
const DEFAULT_TAKEOVER_THRESHOLD_PX = 48;

function sleep(ms, signal) {
  const clamped = Math.max(0, Math.min(30_000, Math.round(Number(ms) || 0)));
  if (clamped === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error('Aborted'));
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

export function createUuRemoteService({
  systemDriver = createWin32SystemDriver(),
  pveDriver = createPveQmpDriver(),
  cliClient = createUuycCliClient(),
  stateDir: initialStateDir = null,
  busInspector = null,
  nowFn = Date.now,
} = {}) {
  let configuredStateDir = initialStateDir;
  let selectedSessionId = null;
  const takeoverBySession = new Map();
  const lastObservationBySession = new Map();
  const lastContentRectBySession = new Map();
  const lastCursorGuardBySession = new Map();
  const pveTargetsById = new Map();
  let stateLoadedFromDir = null;

  function setStateDir(dir) {
    if (dir) configuredStateDir = path.resolve(dir);
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
      // File may not exist yet; keep current map.
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
    } catch {
      // Non-fatal if running in read-only sandbox.
    }
  }

  async function syncPersistedState(context = {}) {
    const file = resolveStateFile(context);
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
      stateLoadedFromDir = file;
    } catch {
      stateLoadedFromDir = file;
    }
    await syncPveTargets(context);
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
    } catch {
      // Non-fatal if running in read-only sandbox.
    }
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
    return {
      id: target.id,
      provider: 'pve-qmp',
      sshHost: target.sshHost,
      vmid: target.vmid,
      vmName,
      vmStatus,
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
          const live = await pveDriver.probeStatus(target, {
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

  async function inspectCombinedTopology(settings = {}, context = {}, { probePveResolution = false } = {}) {
    await syncPersistedState(context);
    const [winTopo, pveSessions] = await Promise.all([
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
    ]);

    const winSessions = Array.isArray(winTopo.sessions)
      ? winTopo.sessions.map((s) => ({ provider: 'uu-remote', ...s }))
      : [];

    return {
      ...winTopo,
      sessions: [...winSessions, ...pveSessions],
      pveSessions,
    };
  }

  async function setTakeover({ targetId, sessionId, active, holder, reason } = {}, context = {}) {
    await syncPersistedState(context);
    const rawId = targetId || sessionId || selectedSessionId;
    if (!rawId) {
      const topo = await inspectCombinedTopology(context?.settings ?? {}, context);
      if (topo.sessions.length === 1) {
        return setTakeover({ sessionId: topo.sessions[0].id, active, holder, reason }, context);
      }
      throw new Error('Takeover requires a target sessionId (uu:<hwnd> or pve:<ssh_host>:<vmid>).');
    }
    const sid = normalizeSessionId(rawId);
    const nextActive = Boolean(active);
    const controlledBy = nextActive ? (holder === 'agent' ? 'human' : holder || 'human') : (holder || 'agent');
    if (nextActive) {
      takeoverBySession.set(sid, {
        active: true,
        controlledBy,
        reason: reason ? String(reason) : 'Manual takeover lock',
        updatedAtMs: nowFn(),
      });
    } else {
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
    return {
      provider: session.provider || 'uu-remote',
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

  async function resolveTargetSession(requestedId, topo, context = {}) {
    if (!stateLoadedFromDir) await syncPersistedState(context);
    const sessions = topo.sessions;
    if (requestedId) {
      const norm = normalizeSessionId(requestedId);
      const found = sessions.find((s) => s.id === norm);
      if (found) return found;

      if (isPveTargetId(norm)) {
        const parsed = parsePveTargetId(norm, { strict: true });
        const live = await pveDriver.probeStatus(parsed, {
          probeResolution: true,
          signal: context?.signal,
        });
        return buildPveSessionObject(parsed, live, null);
      }

      throw new Error(
        `Remote session "${norm}" is not open. Call uu_sessions(action="list") to inspect active windows/VMs or uu_launch(action="connect", deviceId="<id>") to connect.`,
      );
    }
    const chosenId = pickSelectedSession(sessions);
    if (!chosenId) {
      throw new Error(
        'No active remote desktop session is open. Call uu_sessions(action="list") to find paired devices, or uu_launch(action="connect", deviceId="pve:<ssh_host>:<vmid>") / uu_launch(action="connect_device", deviceId="<id>").',
      );
    }
    return sessions.find((s) => s.id === chosenId);
  }

  async function observeSession(session, options = {}, context = {}) {
    const settings = context?.settings ?? {};
    const isPve = session.provider === 'pve-qmp' || isPveTargetId(session.id);

    if (isPve) {
      if (session.state !== 'active') {
        throw new Error(
          `PVE VM session ${session.id} ("${session.label}") is ${session.vmStatus || session.state} and cannot capture screendump frames.`,
        );
      }
      const rawCapture = await pveDriver.captureScreen(session, { signal: context?.signal });
      const registered = pveTargetsById.get(session.id);
      if (registered && (registered.width !== rawCapture.width || registered.height !== rawCapture.height)) {
        registered.width = rawCapture.width;
        registered.height = rawCapture.height;
        registered.updatedAtMs = nowFn();
        await persistPveTargets(context);
      }

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
      });

      const stageBounds = rawCapture.stageBounds;
      lastContentRectBySession.set(session.id, {
        ...processed.contentRect,
        trimmed: processed.contentTrimmed,
        axis: processed.contentAxis,
      });
      lastObservationBySession.set(session.id, {
        imageSize: processed.imageSize,
        logicalSize: processed.logicalSize,
        cropBounds: processed.cropBounds,
        contentRect: processed.contentRect,
        stageBounds,
        capturedAtMs: nowFn(),
      });

      const tk = getTakeoverEntry(session.id);
      return {
        ok: true,
        provider: 'pve-qmp',
        targetId: session.id,
        sessionId: session.id,
        label: session.label,
        capturedAtMs: nowFn(),
        mimeType: processed.mimeType,
        pngBuffer: processed.pngBuffer,
        imageBase64: processed.imageBase64,
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
    });

    const stageBounds = rawCapture.stageBounds || session.canvasBounds;
    lastContentRectBySession.set(session.id, {
      ...processed.contentRect,
      trimmed: processed.contentTrimmed,
      axis: processed.contentAxis,
    });
    lastObservationBySession.set(session.id, {
      imageSize: processed.imageSize,
      logicalSize: processed.logicalSize,
      cropBounds: processed.cropBounds,
      contentRect: processed.contentRect,
      stageBounds,
      capturedAtMs: nowFn(),
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
      targetId: session.id,
      sessionId: session.id,
      label: session.label,
      capturedAtMs: nowFn(),
      mimeType: processed.mimeType,
      pngBuffer: processed.pngBuffer,
      imageBase64: processed.imageBase64,
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

    // PVE QMP sessions run over SSH/QMP and do not share the local desktop cursor.
    if (session.provider === 'pve-qmp' || isPveTargetId(session.id)) {
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

  async function executeActionsOnPveSession(session, {
    actions,
    coordinateMode = 'normalized_1000',
    overrideHumanTakeover = false,
  }, context = {}) {
    const settings = context?.settings ?? {};
    const signal = context?.signal;

    if (!overrideHumanTakeover) {
      const guard = await checkPhysicalTakeoverGuard(session, settings, context);
      if (guard.blocked) {
        return {
          ok: false,
          status: 409,
          code: 'human_takeover_active',
          message: guard.message,
          targetId: session.id,
          sessionId: session.id,
          takeoverActive: true,
          controlledBy: 'human',
        };
      }
    }

    if (session.state !== 'active') {
      throw new Error(
        `PVE VM session ${session.id} ("${session.label}") is ${session.vmStatus || session.state} and cannot receive QMP input.`,
      );
    }

    const screenSize = {
      width: Math.max(1, session.canvasBounds?.width || 1024),
      height: Math.max(1, session.canvasBounds?.height || 768),
    };
    const results = [];
    let lastPoint = null;

    for (let idx = 0; idx < actions.length; idx += 1) {
      signal?.throwIfAborted?.();
      if (idx > 0 && !overrideHumanTakeover) {
        const midGuard = await checkPhysicalTakeoverGuard(session, settings, context);
        if (midGuard.blocked) {
          return {
            ok: false,
            status: 409,
            code: 'human_takeover_active',
            message: midGuard.message,
            targetId: session.id,
            sessionId: session.id,
            executed: results.length,
            results,
            lastPoint,
            takeoverActive: true,
            controlledBy: 'human',
          };
        }
      }

      const item = actions[idx];
      const kind = item.kind;
      const lastObs = lastObservationBySession.get(session.id) || null;

      if (kind === 'wait') {
        const durationMs = Math.max(0, Math.min(30_000, Number(item.durationMs) || 250));
        await sleep(durationMs, signal);
        results.push({ kind: 'wait', durationMs });
        continue;
      }

      if (kind === 'focus' || kind === 'restore') {
        results.push({ kind, focused: true, note: 'PVE QMP session does not require local window focus.' });
        continue;
      }

      if (kind === 'clipboard_get' || kind === 'clipboard_set') {
        throw new Error(
          `Action "${kind}" is not supported on PVE QMP session ${session.id}; use action="type" for ASCII text input.`,
        );
      }

      const compiled = buildQmpStepsForAction(item, {
        coordinateMode,
        screenSize: lastObs?.logicalSize || screenSize,
        lastObservation: lastObs,
      });
      await pveDriver.sendQmpSteps(session, compiled.steps, { signal });

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
        results.push({
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
        results.push({
          ...compiled.meta,
          ...(compiled.point ? { point: lastPoint } : {}),
        });
      }
    }

    const tk = getTakeoverEntry(session.id);
    return {
      ok: true,
      provider: 'pve-qmp',
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
    overrideHumanTakeover = false,
    allowClientHotkey = false,
  }, context = {}) {
    if (session.provider === 'pve-qmp' || isPveTargetId(session.id)) {
      return executeActionsOnPveSession(
        session,
        { actions, coordinateMode, overrideHumanTakeover },
        context,
      );
    }

    const settings = context?.settings ?? {};
    const signal = context?.signal;

    if (!overrideHumanTakeover) {
      const guard = await checkPhysicalTakeoverGuard(session, settings, context);
      if (guard.blocked) {
        return {
          ok: false,
          status: 409,
          code: 'human_takeover_active',
          message: guard.message,
          targetId: session.id,
          sessionId: session.id,
          takeoverActive: true,
          controlledBy: 'human',
        };
      }
    }

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

    for (let idx = 0; idx < actions.length; idx += 1) {
      signal?.throwIfAborted?.();
      if (idx > 0 && !overrideHumanTakeover) {
        const midGuard = await checkPhysicalTakeoverGuard(session, settings, context);
        if (midGuard.blocked) {
          return {
            ok: false,
            status: 409,
            code: 'human_takeover_active',
            message: midGuard.message,
            targetId: session.id,
            sessionId: session.id,
            executed: results.length,
            results,
            lastPoint,
            takeoverActive: true,
            controlledBy: 'human',
          };
        }
      }

      const item = actions[idx];
      const kind = item.kind;
      const lastObs = lastObservationBySession.get(session.id) || null;

      if (kind === 'wait') {
        const durationMs = Math.max(0, Math.min(30_000, Number(item.durationMs) || 250));
        await sleep(durationMs, signal);
        results.push({ kind: 'wait', durationMs });
        continue;
      }

      if (kind === 'clipboard_get') {
        const text = await systemDriver.getClipboardText();
        results.push({ kind: 'clipboard_get', text });
        continue;
      }

      if (kind === 'clipboard_set') {
        const text = String(item.text ?? '');
        await systemDriver.setClipboardText(text);
        results.push({ kind: 'clipboard_set', length: text.length });
        continue;
      }

      if (kind === 'focus' || kind === 'restore') {
        const winRes = await systemDriver.performWindowAction({ hwnd: session.hwnd, mode: kind });
        if (kind === 'restore') {
          session.state = 'active';
          if (winRes.clientBounds?.width > 0) session.canvasBounds = winRes.clientBounds;
          geometry = null;
        }
        results.push({ kind, focused: Boolean(winRes.focused) });
        continue;
      }

      const steps = [];
      if (kind === 'move') {
        const geo = await ensureGeo();
        const pt = mapPointToTarget({
          x: item.x,
          y: item.y,
          coordinateMode,
          stageBounds: geo.stageBounds,
          contentRect: geo.contentRect,
          lastObservation: lastObs,
        });
        steps.push({ op: 'mouse_move', x: pt.screenX, y: pt.screenY });
        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        if (batchRes?.cursor) {
          lastCursorGuardBySession.set(session.id, { x: batchRes.cursor.x, y: batchRes.cursor.y, atMs: nowFn() });
        } else {
          lastCursorGuardBySession.set(session.id, { x: pt.screenX, y: pt.screenY, atMs: nowFn() });
        }
        lastPoint = { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY };
        results.push({ kind: 'move', point: lastPoint, screenPoint: { x: pt.screenX, y: pt.screenY } });
        continue;
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
          const geo = await ensureGeo();
          pt = mapPointToTarget({
            x: item.x,
            y: item.y,
            coordinateMode,
            stageBounds: geo.stageBounds,
            contentRect: geo.contentRect,
            lastObservation: lastObs,
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

        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        const anchorX = batchRes?.cursor?.x ?? pt?.screenX;
        const anchorY = batchRes?.cursor?.y ?? pt?.screenY;
        if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
          lastCursorGuardBySession.set(session.id, { x: anchorX, y: anchorY, atMs: nowFn() });
        }
        if (pt) {
          lastPoint = { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY };
        }
        results.push({
          kind,
          button,
          count: (kind === 'click' || kind === 'double_click' || kind === 'right_click') ? clickCount : undefined,
          point: lastPoint,
          screenPoint: pt ? { x: pt.screenX, y: pt.screenY } : undefined,
        });
        continue;
      }

      if (kind === 'drag') {
        const geo = await ensureGeo();
        const startPt = mapPointToTarget({
          x: item.startX,
          y: item.startY,
          coordinateMode,
          stageBounds: geo.stageBounds,
          contentRect: geo.contentRect,
          lastObservation: lastObs,
        });
        const endPt = mapPointToTarget({
          x: item.endX,
          y: item.endY,
          coordinateMode,
          stageBounds: geo.stageBounds,
          contentRect: geo.contentRect,
          lastObservation: lastObs,
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

        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        const anchorX = batchRes?.cursor?.x ?? endPt.screenX;
        const anchorY = batchRes?.cursor?.y ?? endPt.screenY;
        lastCursorGuardBySession.set(session.id, { x: anchorX, y: anchorY, atMs: nowFn() });
        lastPoint = { x: endPt.x, y: endPt.y, normX: endPt.normX, normY: endPt.normY };
        results.push({
          kind: 'drag',
          button,
          start: { x: startPt.x, y: startPt.y, normX: startPt.normX, normY: startPt.normY },
          end: lastPoint,
          durationMs,
        });
        continue;
      }

      if (kind === 'scroll') {
        let pt = null;
        if (item.x !== undefined && item.y !== undefined) {
          const geo = await ensureGeo();
          pt = mapPointToTarget({
            x: item.x,
            y: item.y,
            coordinateMode,
            stageBounds: geo.stageBounds,
            contentRect: geo.contentRect,
            lastObservation: lastObs,
          });
          steps.push({ op: 'mouse_move', x: pt.screenX, y: pt.screenY });
          steps.push({ op: 'sleep', ms: 12 });
        }
        const rawDy = Number(item.deltaY) || 0;
        const rawDx = Number(item.deltaX) || 0;
        // Positive deltaY in CUA/web means scroll down -> negative Win32 WHEEL_DELTA; preserve magnitude when >= 120.
        const toWheelUnits = (delta) => {
          if (delta === 0) return 0;
          const scaled = Math.abs(delta) <= 20 ? -Math.round(delta * 120) : -Math.round(delta);
          return scaled;
        };
        steps.push({ op: 'wheel', deltaX: -toWheelUnits(rawDx), deltaY: toWheelUnits(rawDy) });
        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        if (batchRes?.cursor) {
          lastCursorGuardBySession.set(session.id, { x: batchRes.cursor.x, y: batchRes.cursor.y, atMs: nowFn() });
        }
        if (pt) {
          lastPoint = { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY };
        }
        results.push({ kind: 'scroll', deltaX: rawDx, deltaY: rawDy, point: lastPoint });
        continue;
      }

      if (kind === 'type') {
        const text = String(item.text ?? '');
        const mode = item.mode || 'auto';
        if (text.length > 0) {
          if (mode === 'clipboard') {
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
        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        if (batchRes?.cursor) {
          lastCursorGuardBySession.set(session.id, { x: batchRes.cursor.x, y: batchRes.cursor.y, atMs: nowFn() });
        }
        results.push({ kind: 'type', length: text.length, mode, submit: Boolean(item.submit) });
        continue;
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
        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        if (batchRes?.cursor) {
          lastCursorGuardBySession.set(session.id, { x: batchRes.cursor.x, y: batchRes.cursor.y, atMs: nowFn() });
        }
        results.push({ kind: 'key', keys: chord.map((k) => k.name) });
        continue;
      }

      if (kind === 'hold_key') {
        const chord = assertSafeRemoteKeyChord(item.key || item.keys, { allowClientHotkey });
        const holdMs = Math.max(20, Math.min(10_000, Math.round(Number(item.durationMs) || 300)));
        for (const k of chord) steps.push({ op: 'vk_down', vk: k.vk });
        steps.push({ op: 'sleep', ms: holdMs });
        for (let i = chord.length - 1; i >= 0; i -= 1) steps.push({ op: 'vk_up', vk: chord[i].vk });
        const batchRes = await systemDriver.sendInputBatch({ hwnd: session.hwnd, restorePreviousFocus, steps });
        if (batchRes?.cursor) {
          lastCursorGuardBySession.set(session.id, { x: batchRes.cursor.x, y: batchRes.cursor.y, atMs: nowFn() });
        }
        results.push({ kind: 'hold_key', keys: chord.map((k) => k.name), durationMs: holdMs });
        continue;
      }

      throw new Error(`Unsupported action kind: "${String(kind)}"`);
    }

    const tk = getTakeoverEntry(session.id);
    return {
      ok: true,
      targetId: session.id,
      sessionId: session.id,
      executed: results.length,
      results,
      lastPoint,
      takeoverActive: tk.active,
    };
  }

  async function resolveExplicitPveTarget(requestedId, context = {}) {
    const parsed = parsePveTargetId(requestedId, { strict: true });
    const registered = pveTargetsById.get(parsed.id);
    const live = await pveDriver.probeStatus(parsed, {
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

  async function getStatus(args = {}, context = {}) {
    await syncPersistedState(context);
    const settings = context?.settings ?? {};
    const includeCliStatus = args?.includeCliStatus !== false;

    const [install, cliVersion, topo] = await Promise.all([
      systemDriver.discoverInstallation(settings),
      cliClient.getVersion(settings, { signal: context?.signal }),
      inspectCombinedTopology(settings, context),
    ]);

    const uuSessions = topo.sessions.filter((s) => s.provider !== 'pve-qmp');
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
      },
      providerBus: busStatus,
      selectedSessionId: selected,
      sessions: sessions.map((s) => ({
        id: s.id,
        provider: s.provider,
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
        throw new Error('uu_sessions action="select" requires sessionId (uu:<hwnd> or pve:<ssh_host>:<vmid>).');
      }
      const match = topo.sessions.find((s) => s.id === targetId);
      if (!match) {
        throw new Error(`Session "${targetId}" was not found among open UU Remote windows or registered PVE VMs.`);
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
        if (session.state === 'active' && session.provider !== 'pve-qmp') {
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
    await syncPersistedState(context);
    const settings = context?.settings ?? {};
    let session;
    if (args.sessionId && isPveTargetId(args.sessionId)) {
      session = await resolveExplicitPveTarget(args.sessionId, context);
    } else {
      const topo = await inspectCombinedTopology(settings, context);
      session = await resolveTargetSession(args.sessionId, topo, context);
    }
    const coordinateMode = args.coordinateMode || 'normalized_1000';

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
        },
        context,
      );
      return {
        ok: true,
        provider: obs.provider,
        action: 'screenshot',
        sessionId: obs.sessionId,
        label: obs.label,
        imageSize: obs.imageSize,
        logicalSize: obs.logicalSize,
        contentRect: obs.contentRect,
        contentTrimmed: obs.contentTrimmed,
        cropBounds: obs.cropBounds,
        takeoverActive: obs.takeoverActive,
        controlledBy: obs.controlledBy,
        mimeType: obs.mimeType,
        imageBase64: obs.imageBase64,
      };
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

    const actResult = await executeActionsOnSession(
      session,
      {
        actions,
        coordinateMode,
        overrideHumanTakeover: Boolean(args.overrideHumanTakeover),
        allowClientHotkey: Boolean(args.allowClientHotkey),
      },
      context,
    );

    if (!actResult.ok) {
      return actResult;
    }

    const nonVisualOnly = actions.every((a) => a.kind === 'clipboard_get' || a.kind === 'clipboard_set');
    const shouldObserve = args.observeAfter !== undefined ? Boolean(args.observeAfter) : !nonVisualOnly;

    let observation = null;
    if (shouldObserve && context?.imageIn !== false) {
      await sleep(110, context?.signal);
      let refreshed = session;
      if (session.provider !== 'pve-qmp') {
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
          },
          context,
        ).catch(() => null);
      }
    }

    return {
      ...actResult,
      observation: observation
        ? {
            capturedAtMs: observation.capturedAtMs,
            imageSize: observation.imageSize,
            logicalSize: observation.logicalSize,
            contentRect: observation.contentRect,
            contentTrimmed: observation.contentTrimmed,
            mimeType: observation.mimeType,
            imageBase64: observation.imageBase64,
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
      const pveTarget = extractPveTargetInput(args);
      if (pveTarget) {
        const live = await pveDriver.probeStatus(pveTarget, {
          probeResolution: true,
          signal: context?.signal,
        });
        const existing = pveTargetsById.get(pveTarget.id);
        const now = nowFn();
        const customLabel = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : null;
        const record = {
          id: pveTarget.id,
          sshHost: pveTarget.sshHost,
          vmid: pveTarget.vmid,
          label: customLabel || existing?.label || null,
          vmName: live?.vmName || existing?.vmName || null,
          width: (Number.isFinite(live?.width) && live.width > 0 ? Math.round(live.width) : null) || existing?.width || null,
          height: (Number.isFinite(live?.height) && live.height > 0 ? Math.round(live.height) : null) || existing?.height || null,
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
      const pveTarget = extractPveTargetInput(args);
      if (pveTarget) {
        const removed = pveTargetsById.delete(pveTarget.id);
        takeoverBySession.delete(pveTarget.id);
        lastObservationBySession.delete(pveTarget.id);
        lastContentRectBySession.delete(pveTarget.id);
        if (selectedSessionId === pveTarget.id) {
          selectedSessionId = null;
        }
        await Promise.all([persistPveTargets(context), persistState(context)]);

        const hostStillUsed = [...pveTargetsById.values()].some((t) => t.sshHost === pveTarget.sshHost);
        if (!hostStillUsed) {
          await pveDriver.disconnectHost(pveTarget.sshHost).catch(() => {});
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
    return topo.sessions.map((raw) => {
      const s = decorateSession(raw);
      const isPve = s.provider === 'pve-qmp';
      return {
        id: s.id,
        providerId: 'kiki-uu-remote',
        provider: s.provider,
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
        capabilities: isPve
          ? ['screenshot', 'zoom', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'takeover']
          : [
              'screenshot',
              'zoom',
              'click',
              'move',
              'drag',
              'scroll',
              'type',
              'key',
              'clipboard',
              'takeover',
            ],
      };
    });
  }

  async function observeCuaTarget(body = {}, context = {}) {
    await syncPersistedState(context);
    let session;
    if (body.targetId && isPveTargetId(body.targetId)) {
      session = await resolveExplicitPveTarget(body.targetId, context);
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
      },
      context,
    );
    return {
      ok: true,
      targetId: obs.targetId,
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
    } else {
      const topo = await inspectCombinedTopology(context?.settings ?? {}, context);
      session = await resolveTargetSession(body.targetId, topo, context);
    }
    const actions = Array.isArray(body.actions) ? body.actions : [];
    if (actions.length === 0) {
      throw new Error('POST /v1/act requires a non-empty actions array.');
    }
    return executeActionsOnSession(
      session,
      {
        actions,
        coordinateMode: body.coordinateMode || 'normalized_1000',
        overrideHumanTakeover: Boolean(body.overrideHumanTakeover),
        allowClientHotkey: Boolean(body.allowClientHotkey),
      },
      context,
    );
  }

  async function dispose() {
    await Promise.allSettled([systemDriver.dispose(), pveDriver.dispose()]);
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
    listCuaTargets,
    observeCuaTarget,
    actOnCuaTarget,
    dispose,
  };
}
