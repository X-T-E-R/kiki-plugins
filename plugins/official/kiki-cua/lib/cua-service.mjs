import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertCoordinateMode,
  resolveActionsGeometry,
  resolveZoomCropBounds,
  targetPixelsToNormalized1000,
} from './coordinates.mjs';
import { normalizeCuaSettings } from './definitions.mjs';
import { applyGridOverlayToPng, parsePngDimensions } from './png-utils.mjs';
import {
  actProviderTarget,
  discoverCuaProviders,
  fetchProviderTargets,
  observeProviderTarget,
  resolveCuaProviderBusDir,
  setProviderTakeover,
} from './provider-bus.mjs';
import { createUnixDriver } from './unix-driver.mjs';
import { createWin32Bridge } from './win32-bridge.mjs';

export const STREAM_FRAME_MAGIC = 0x4b;
export const STREAM_PNG_KIND = 0x02;

export function packPngStreamFrame({ width, height, seq = 0, timestampMs = Date.now(), pngBytes }) {
  const payload = Buffer.isBuffer(pngBytes) ? pngBytes : Buffer.from(pngBytes);
  const out = Buffer.allocUnsafe(16 + payload.length);
  out[0] = STREAM_FRAME_MAGIC;
  out[1] = STREAM_PNG_KIND;
  out.writeUInt16BE(Math.min(65535, Math.max(0, Math.round(width) || 0)), 2);
  out.writeUInt16BE(Math.min(65535, Math.max(0, Math.round(height) || 0)), 4);
  out.writeUInt16BE(seq & 0xffff, 6);
  out.writeDoubleBE(Number(timestampMs) || 0, 8);
  payload.copy(out, 16);
  return out;
}

function sleepMs(ms, signal) {
  const delay = Math.max(0, Math.round(Number(ms) || 0));
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted during wait'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, delay);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason || new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function createCuaService({
  platform = process.platform,
  localDriver: injectedDriver = null,
  env = process.env,
  dataDir: initialDataDir = null,
} = {}) {
  let driver = injectedDriver;
  let activeDataDir = initialDataDir;
  let activeSettings = normalizeCuaSettings({});
  let selectedTargetId = null;
  let selectionLoadedFromDisk = false;

  const pinnedWindows = new Map();
  const targetLedger = new Map();
  const liveStreamSubscribers = new Set();

  let fastSummaryCache = { at: 0, value: null };

  function getDriver() {
    if (!driver) {
      driver = platform === 'win32'
        ? createWin32Bridge()
        : createUnixDriver({ platform });
    }
    return driver;
  }

  function resolveStateDir(context = null) {
    if (activeDataDir) return path.resolve(activeDataDir);
    const home = context?.kikiHome || env?.KIKI_HOME || env?.KIMI_CODE_HOME;
    if (home) return path.join(path.resolve(home), 'plugins', 'data', 'kiki-cua');
    return path.join(os.homedir(), '.kiki', 'plugins', 'data', 'kiki-cua');
  }

  async function ensureSelectionLoaded(context = null) {
    if (selectionLoadedFromDisk || selectedTargetId) return;
    selectionLoadedFromDisk = true;
    try {
      const stateFile = path.join(resolveStateDir(context), 'selected-target.json');
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
      if (typeof parsed?.selectedTargetId === 'string' && parsed.selectedTargetId.trim()) {
        selectedTargetId = parsed.selectedTargetId.trim();
      }
    } catch {}
  }

  async function persistSelectedTarget(targetId, context = null) {
    selectedTargetId = targetId;
    selectionLoadedFromDisk = true;
    try {
      const dir = resolveStateDir(context);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'selected-target.json'),
        JSON.stringify({ selectedTargetId: targetId, updatedAtMs: Date.now() }, null, 2) + '\n',
        'utf8',
      );
    } catch {}
  }

  function canonicalLedgerKey(targetId, primaryMonitorId = 'local:monitor-0') {
    if (!targetId || targetId === 'local:primary') return primaryMonitorId;
    return targetId;
  }

  function getLedgerEntry(key) {
    let entry = targetLedger.get(key);
    if (!entry) {
      entry = {
        key,
        takeoverActive: false,
        controlledBy: 'agent',
        takeoverReason: null,
        takeoverUpdatedAtMs: 0,
        lastObservation: null,
        lastSyntheticCursor: null,
        lastAction: null,
      };
      targetLedger.set(key, entry);
    }
    return entry;
  }

  function broadcastStreamEvent(eventPayload) {
    for (const sub of liveStreamSubscribers) {
      try {
        sub.sendMeta(eventPayload);
      } catch {}
    }
  }

  async function collectAllTargets({ context = null, signal = null, fast = false } = {}) {
    await ensureSelectionLoaded(context);
    if (fast && fastSummaryCache.value && Date.now() - fastSummaryCache.at < 3_500) {
      return fastSummaryCache.value;
    }

    const drv = getDriver();
    const monitorData = await drv.listMonitors({ signal });
    const monitors = Array.isArray(monitorData?.monitors) ? monitorData.monitors : [];
    const primaryMon = monitors.find((m) => m.primary) || monitors[0] || {
      id: 'local:monitor-0',
      index: 0,
      deviceName: 'Primary',
      primary: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      dpiX: 96,
      scaleFactor: 1,
    };
    const primaryId = primaryMon.id || 'local:monitor-0';

    const localTargets = [];
    const primaryLedger = getLedgerEntry(primaryId);

    localTargets.push({
      id: 'local:primary',
      aliasFor: primaryId,
      providerId: 'local',
      kind: 'local-display',
      label: `Primary Display (${primaryMon.bounds.width}×${primaryMon.bounds.height} @ ${Math.round((primaryMon.scaleFactor || 1) * 100)}%)`,
      platform,
      online: true,
      primary: true,
      takeoverActive: primaryLedger.takeoverActive,
      controlledBy: primaryLedger.controlledBy,
      takeoverReason: primaryLedger.takeoverReason,
      bounds: primaryMon.bounds,
      dimensions: {
        width: primaryMon.bounds.width,
        height: primaryMon.bounds.height,
        scaleFactor: primaryMon.scaleFactor || 1,
        dpi: primaryMon.dpiX || 96,
      },
      capabilities: ['screenshot', 'zoom', 'grid', 'som', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'clipboard', 'takeover', 'windows'],
    });

    for (const mon of monitors) {
      const ledger = getLedgerEntry(mon.id);
      localTargets.push({
        id: mon.id,
        providerId: 'local',
        kind: 'local-display',
        label: `Display ${mon.index}${mon.primary ? ' · Primary' : ''} (${mon.bounds.width}×${mon.bounds.height} @ ${Math.round((mon.scaleFactor || 1) * 100)}%)`,
        platform,
        online: true,
        primary: Boolean(mon.primary),
        takeoverActive: ledger.takeoverActive,
        controlledBy: ledger.controlledBy,
        takeoverReason: ledger.takeoverReason,
        bounds: mon.bounds,
        dimensions: {
          width: mon.bounds.width,
          height: mon.bounds.height,
          scaleFactor: mon.scaleFactor || 1,
          dpi: mon.dpiX || 96,
        },
        capabilities: ['screenshot', 'zoom', 'grid', 'som', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'clipboard', 'takeover', 'windows'],
      });
    }

    for (const [winTargetId, winMeta] of pinnedWindows) {
      const ledger = getLedgerEntry(winTargetId);
      localTargets.push({
        id: winTargetId,
        providerId: 'local',
        kind: 'local-window',
        hwnd: winMeta.hwnd,
        label: `Window: ${winMeta.title || winMeta.hwnd}`,
        platform,
        online: true,
        takeoverActive: ledger.takeoverActive,
        controlledBy: ledger.controlledBy,
        takeoverReason: ledger.takeoverReason,
        bounds: winMeta.bounds || { x: 0, y: 0, width: 1280, height: 800 },
        dimensions: {
          width: winMeta.bounds?.width || 1280,
          height: winMeta.bounds?.height || 800,
          scaleFactor: winMeta.scaleFactor || 1,
          dpi: winMeta.dpi || 96,
        },
        capabilities: ['screenshot', 'zoom', 'grid', 'som', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'clipboard', 'takeover'],
      });
    }

    const busDir = resolveCuaProviderBusDir({ env, context, dataDir: activeDataDir });
    const discovery = await discoverCuaProviders({ busDir });
    const remoteTargetBatches = await Promise.all(
      discovery.providers.map(async (provider) => {
        try {
          const items = await fetchProviderTargets(provider, { signal });
          return items.map((t) => {
            const ledger = getLedgerEntry(t.id);
            const takeoverActive = Boolean(t.takeoverActive || ledger.takeoverActive);
            if (t.takeoverActive !== undefined) {
              ledger.takeoverActive = Boolean(t.takeoverActive);
              ledger.controlledBy = t.takeoverActive ? 'human' : (t.controlledBy || 'agent');
            }
            return {
              ...t,
              takeoverActive,
              controlledBy: takeoverActive ? 'human' : (t.controlledBy || ledger.controlledBy || 'agent'),
              _provider: provider,
            };
          });
        } catch {
          return [];
        }
      }),
    );

    const remoteTargets = remoteTargetBatches.flat();
    const allTargets = [...localTargets, ...remoteTargets];

    if (!selectedTargetId || !allTargets.some((t) => t.id === selectedTargetId)) {
      if (selectedTargetId && selectedTargetId.startsWith('local:window:')) {
        const hwnd = selectedTargetId.slice('local:window:'.length);
        pinnedWindows.set(selectedTargetId, { hwnd, title: hwnd, bounds: { x: 0, y: 0, width: 1280, height: 800 } });
      } else {
        selectedTargetId = 'local:primary';
      }
    }

    const result = {
      selectedTargetId: selectedTargetId || 'local:primary',
      primaryMonitorId: primaryId,
      virtualScreen: monitorData?.virtualScreen || { x: 0, y: 0, width: primaryMon.bounds.width, height: primaryMon.bounds.height },
      cursor: monitorData?.cursor || { x: 0, y: 0 },
      targets: allTargets,
      providers: discovery.providers.map((p) => ({
        providerId: p.providerId,
        displayName: p.displayName,
        endpoint: p.endpoint,
        pid: p.pid,
        updatedAtMs: p.updatedAtMs,
        capabilities: p.capabilities,
      })),
      rejectedLeases: discovery.rejected,
      busDir,
    };

    fastSummaryCache = { at: Date.now(), value: result };
    return result;
  }

  async function resolveActiveTarget(requestedTargetId, { context = null, signal = null } = {}) {
    const inventory = await collectAllTargets({ context, signal });
    const wantedId = (typeof requestedTargetId === 'string' && requestedTargetId.trim())
      ? requestedTargetId.trim()
      : (inventory.selectedTargetId || 'local:primary');

    let target = inventory.targets.find((t) => t.id === wantedId);
    if (!target && wantedId.startsWith('local:window:')) {
      const hwnd = wantedId.slice('local:window:'.length);
      const winRes = await getDriver().listWindows('', { signal });
      const matched = (winRes?.windows || []).find((w) => String(w.hwnd).toLowerCase() === hwnd.toLowerCase());
      const meta = {
        hwnd: matched?.hwnd || hwnd,
        title: matched?.title || hwnd,
        bounds: matched?.bounds || { x: 0, y: 0, width: 1280, height: 800 },
        scaleFactor: matched?.scaleFactor || 1,
        dpi: matched?.dpi || 96,
      };
      pinnedWindows.set(wantedId, meta);
      fastSummaryCache.at = 0;
      const refreshed = await collectAllTargets({ context, signal });
      target = refreshed.targets.find((t) => t.id === wantedId);
    }

    if (!target) {
      throw new Error(`Unknown or offline CUA target "${wantedId}". Run cua_targets({ action: "list" }) to inspect available targets.`);
    }

    const ledgerKey = canonicalLedgerKey(target.id, inventory.primaryMonitorId);
    const ledger = getLedgerEntry(ledgerKey);
    return { target, ledger, inventory };
  }

  function stripInternalTargetFields(t) {
    const { _provider, ...publicTarget } = t;
    return publicTarget;
  }

  async function executeTargetsTool(args = {}, context = {}) {
    const action = args?.action || 'list';
    const signal = context?.signal;

    if (action === 'list') {
      fastSummaryCache.at = 0;
      const inv = await collectAllTargets({ context, signal });
      return {
        output: JSON.stringify({
          ok: true,
          selectedTargetId: inv.selectedTargetId,
          virtualScreen: inv.virtualScreen,
          targets: inv.targets.map(stripInternalTargetFields),
          providers: inv.providers,
        }, null, 2),
      };
    }

    if (action === 'select') {
      const targetId = typeof args?.targetId === 'string' ? args.targetId.trim() : '';
      if (!targetId) {
        return { isError: true, output: JSON.stringify({ ok: false, code: 'missing_target_id', message: 'select requires targetId' }) };
      }
      const { target } = await resolveActiveTarget(targetId, { context, signal });
      await persistSelectedTarget(target.id, context);
      fastSummaryCache.at = 0;
      broadcastStreamEvent({ type: 'selected', selectedTargetId: target.id });
      return {
        output: JSON.stringify({
          ok: true,
          selectedTargetId: target.id,
          target: stripInternalTargetFields(target),
        }, null, 2),
      };
    }

    if (action === 'takeover') {
      const { target, ledger } = await resolveActiveTarget(args?.targetId, { context, signal });
      const active = args?.takeoverActive !== undefined ? Boolean(args.takeoverActive) : true;
      const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim() : null;

      if (target._provider) {
        const remoteRes = await setProviderTakeover(target._provider, {
          targetId: target.id,
          active,
          holder: active ? 'human' : 'agent',
          reason: reason || undefined,
        }, { signal });
        ledger.takeoverActive = Boolean(remoteRes?.takeoverActive ?? active);
        ledger.controlledBy = remoteRes?.controlledBy || (ledger.takeoverActive ? 'human' : 'agent');
      } else {
        ledger.takeoverActive = active;
        ledger.controlledBy = active ? 'human' : 'agent';
        if (active) {
          await getDriver().releaseAllInputs({ signal });
        } else {
          ledger.lastSyntheticCursor = null;
        }
      }
      ledger.takeoverReason = active ? reason : null;
      ledger.takeoverUpdatedAtMs = Date.now();
      fastSummaryCache.at = 0;

      broadcastStreamEvent({
        type: 'takeover',
        targetId: target.id,
        takeoverActive: ledger.takeoverActive,
        controlledBy: ledger.controlledBy,
        reason: ledger.takeoverReason,
      });

      return {
        output: JSON.stringify({
          ok: true,
          targetId: target.id,
          takeoverActive: ledger.takeoverActive,
          controlledBy: ledger.controlledBy,
          reason: ledger.takeoverReason,
        }, null, 2),
      };
    }

    return { isError: true, output: JSON.stringify({ ok: false, message: `Unsupported cua_targets action: ${String(action)}` }) };
  }

  async function captureTargetObservation({
    targetId,
    maxWidth,
    maxHeight,
    zoom = null,
    coordinateMode = 'normalized_1000',
    overlay = 'none',
    includeAccessibility = false,
    context = null,
    signal = null,
    recordObservation = true,
  } = {}) {
    const settings = normalizeCuaSettings(context?.settings ?? activeSettings);
    const mode = assertCoordinateMode(coordinateMode);
    const mw = Math.min(3840, Math.max(240, Math.round(Number(maxWidth) || settings.defaultMaxWidth || 1280)));
    const mh = Math.min(3840, Math.max(240, Math.round(Number(maxHeight) || 900)));

    const { target, ledger } = await resolveActiveTarget(targetId, { context, signal });

    if (target._provider) {
      const obs = await observeProviderTarget(target._provider, {
        targetId: target.id,
        maxWidth: mw,
        maxHeight: mh,
        zoom: zoom || undefined,
        coordinateMode: mode,
        includeAccessibility: Boolean(includeAccessibility),
      }, { signal });

      let imageBase64 = obs.imageBase64;
      let imageSize = obs.imageSize;
      if (overlay === 'grid' && imageBase64) {
        const gridded = applyGridOverlayToPng(Buffer.from(imageBase64, 'base64'));
        imageBase64 = gridded.toString('base64');
        const dim = parsePngDimensions(gridded);
        imageSize = { width: dim.width, height: dim.height };
      } else if (!imageSize && imageBase64) {
        const dim = parsePngDimensions(Buffer.from(imageBase64, 'base64'));
        imageSize = { width: dim.width, height: dim.height };
      }

      const logicalSize = obs.logicalSize || { width: target.dimensions.width, height: target.dimensions.height };
      const cropBounds = obs.cropBounds || null;
      if (obs.takeoverActive !== undefined) {
        ledger.takeoverActive = Boolean(obs.takeoverActive);
        ledger.controlledBy = ledger.takeoverActive ? 'human' : (obs.controlledBy || 'agent');
      }

      const capturedAtMs = obs.capturedAtMs || Date.now();
      if (recordObservation) {
        ledger.lastObservation = {
          capturedAtMs,
          imageBase64: imageBase64 || null,
          imageSize,
          logicalSize,
          targetOrigin: { x: 0, y: 0 },
          cropBounds,
          coordinateMode: mode,
        };
      }

      return {
        ok: true,
        targetId: target.id,
        providerId: target.providerId,
        capturedAtMs,
        mimeType: 'image/png',
        imageBase64,
        imageSize,
        logicalSize,
        targetOrigin: { x: 0, y: 0 },
        cropBounds,
        cursor: obs.cursor || null,
        foregroundWindow: obs.foregroundWindow || null,
        takeoverActive: ledger.takeoverActive,
        controlledBy: ledger.controlledBy,
        coordinateMode: mode,
        overlay,
        accessibility: Array.isArray(obs.accessibility) ? obs.accessibility : [],
      };
    }

    const logicalSize = {
      width: target.dimensions.width,
      height: target.dimensions.height,
    };
    const cropBounds = zoom
      ? resolveZoomCropBounds(zoom, {
          coordinateMode: mode,
          logicalSize,
          lastObservation: ledger.lastObservation,
        })
      : null;

    const rawShot = await getDriver().capture({
      hwnd: target.kind === 'local-window' ? target.hwnd : '',
      originX: target.bounds.x,
      originY: target.bounds.y,
      targetW: logicalSize.width,
      targetH: logicalSize.height,
      hasCrop: Boolean(cropBounds),
      cropX: cropBounds?.x || 0,
      cropY: cropBounds?.y || 0,
      cropW: cropBounds?.width || logicalSize.width,
      cropH: cropBounds?.height || logicalSize.height,
      maxWidth: mw,
      maxHeight: mh,
      overlay,
      includeAccessibility: Boolean(includeAccessibility),
    }, { signal });

    const capturedAtMs = Date.now();
    if (recordObservation) {
      ledger.lastObservation = {
        capturedAtMs,
        imageBase64: rawShot.imageBase64 || null,
        imageSize: rawShot.imageSize,
        logicalSize: rawShot.logicalSize,
        targetOrigin: rawShot.targetOrigin,
        cropBounds: rawShot.cropBounds || null,
        coordinateMode: mode,
      };
    }

    return {
      ok: true,
      targetId: target.id,
      providerId: 'local',
      capturedAtMs,
      mimeType: 'image/png',
      imageBase64: rawShot.imageBase64,
      imageSize: rawShot.imageSize,
      logicalSize: rawShot.logicalSize,
      targetOrigin: rawShot.targetOrigin,
      cropBounds: rawShot.cropBounds || null,
      cursor: rawShot.cursor,
      foregroundWindow: rawShot.foregroundWindow || null,
      takeoverActive: ledger.takeoverActive,
      controlledBy: ledger.controlledBy,
      coordinateMode: mode,
      overlay,
      accessibility: includeAccessibility || overlay === 'som' ? (rawShot.accessibility || []) : [],
    };
  }

  function formatObservationToolOutput(obs, extraFields = {}, imageIn = true) {
    const { imageBase64, ...summary } = obs;
    const textPayload = JSON.stringify({ ...extraFields, ...summary }, null, 2);
    if (imageIn === false || !imageBase64) {
      return { output: [{ type: 'text', text: textPayload }] };
    }
    return {
      output: [
        { type: 'text', text: textPayload },
        { type: 'image_url', imageUrl: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    };
  }

  async function executeObserveTool(args = {}, context = {}) {
    const obs = await captureTargetObservation({
      targetId: args?.targetId,
      maxWidth: args?.maxWidth,
      maxHeight: args?.maxHeight,
      zoom: args?.zoom || null,
      coordinateMode: args?.coordinateMode || 'normalized_1000',
      overlay: args?.overlay || 'none',
      includeAccessibility: Boolean(args?.includeAccessibility),
      context,
      signal: context?.signal,
      recordObservation: true,
    });
    return formatObservationToolOutput(obs, {}, context?.imageIn !== false);
  }

  async function maybeRefineWithGrounding(action, { target, settings, ledger, context, signal }) {
    if (!settings.groundingEndpoint || !action.label) return action;
    try {
      if (!ledger.lastObservation?.imageBase64 && target?.id) {
        await captureTargetObservation({
          targetId: target.id,
          context,
          signal,
          recordObservation: true,
        });
      }
      const frameBase64 = ledger.lastObservation?.imageBase64;
      if (!frameBase64) return action;

      const base = settings.groundingEndpoint.replace(/\/+$/, '');
      const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.groundingModel || 'grounding-default',
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Return JSON {"x": <0..1000>, "y": <0..1000>} in normalized_1000 image coordinates for UI target: ${action.label}`,
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${frameBase64}` },
                },
              ],
            },
          ],
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000),
      });
      if (!res.ok) return action;
      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content || '';
      const match = /\{[\s\S]*?"x"\s*:\s*(\d+(?:\.\d+)?)[\s\S]*?"y"\s*:\s*(\d+(?:\.\d+)?)[\s\S]*?\}/.exec(content);
      if (!match) return action;
      return {
        ...action,
        x: Number(match[1]),
        y: Number(match[2]),
        _groundingRefined: true,
        _coordinateModeOverride: 'normalized_1000',
        _zoomRelativeOverride: Boolean(ledger.lastObservation?.cropBounds),
      };
    } catch {
      return action;
    }
  }

  async function checkLocalTakeoverGuard({ target, ledger, settings, executedCount, signal }) {
    if (ledger.takeoverActive) {
      await getDriver().releaseAllInputs({ signal });
      return {
        tripped: true,
        payload: {
          ok: false,
          code: 'human_takeover_active',
          targetId: target.id,
          takeoverActive: true,
          controlledBy: 'human',
          reason: ledger.takeoverReason || 'Manual Human Takeover lock is active.',
          executed: executedCount,
          message: `Action aborted: target "${target.id}" is currently under Human Takeover control. Wait for the user or ask before passing overrideHumanTakeover=true.`,
        },
      };
    }

    if (ledger.lastSyntheticCursor && settings.takeoverThresholdPx > 0) {
      const cur = await getDriver().getCursorPos({ signal });
      const dist = Math.hypot(cur.x - ledger.lastSyntheticCursor.screenX, cur.y - ledger.lastSyntheticCursor.screenY);
      if (dist > settings.takeoverThresholdPx) {
        ledger.takeoverActive = true;
        ledger.controlledBy = 'human';
        ledger.takeoverReason = `Physical mouse moved ${Math.round(dist)}px (> ${settings.takeoverThresholdPx}px threshold)`;
        ledger.takeoverUpdatedAtMs = Date.now();
        fastSummaryCache.at = 0;
        await getDriver().releaseAllInputs({ signal });

        broadcastStreamEvent({
          type: 'takeover',
          targetId: target.id,
          takeoverActive: true,
          controlledBy: 'human',
          reason: ledger.takeoverReason,
        });

        return {
          tripped: true,
          payload: {
            ok: false,
            code: 'human_takeover_active',
            targetId: target.id,
            takeoverActive: true,
            controlledBy: 'human',
            displacementPx: Math.round(dist),
            thresholdPx: settings.takeoverThresholdPx,
            cursor: cur,
            lastSyntheticCursor: {
              x: ledger.lastSyntheticCursor.screenX,
              y: ledger.lastSyntheticCursor.screenY,
            },
            executed: executedCount,
            message: `Human Takeover automatically engaged: physical cursor moved ${Math.round(dist)}px away from the last agent cursor position (threshold ${settings.takeoverThresholdPx}px). Remaining actions were aborted.`,
          },
        };
      }
    }

    return { tripped: false };
  }

  async function executeActTool(args = {}, context = {}) {
    const signal = context?.signal;
    const settings = normalizeCuaSettings(context?.settings ?? activeSettings);
    const rawActions = Array.isArray(args?.actions) ? args.actions : [];
    if (rawActions.length === 0 || rawActions.length > 16) {
      return {
        isError: true,
        output: JSON.stringify({ ok: false, code: 'invalid_actions', message: 'cua_act requires 1..16 actions.' }),
      };
    }

    const coordinateMode = assertCoordinateMode(args?.coordinateMode || 'normalized_1000');
    const zoomRelative = Boolean(args?.zoomRelative);
    const observeAfter = args?.observeAfter !== undefined ? Boolean(args.observeAfter) : true;
    const settleMs = args?.settleMs !== undefined ? Math.min(5000, Math.max(0, Math.round(Number(args.settleMs)))) : 180;
    const overrideHumanTakeover = Boolean(args?.overrideHumanTakeover);

    const { target, ledger } = await resolveActiveTarget(args?.targetId, { context, signal });

    if (overrideHumanTakeover && ledger.takeoverActive) {
      ledger.takeoverActive = false;
      ledger.controlledBy = 'agent';
      ledger.takeoverReason = null;
      ledger.lastSyntheticCursor = null;
      fastSummaryCache.at = 0;
      if (target._provider) {
        await setProviderTakeover(target._provider, {
          targetId: target.id,
          active: false,
          holder: 'agent',
        }, { signal }).catch(() => {});
      }
      broadcastStreamEvent({
        type: 'takeover',
        targetId: target.id,
        takeoverActive: false,
        controlledBy: 'agent',
      });
    }

    if (!overrideHumanTakeover && ledger.takeoverActive) {
      return {
        isError: true,
        output: JSON.stringify({
          ok: false,
          code: 'human_takeover_active',
          targetId: target.id,
          takeoverActive: true,
          controlledBy: 'human',
          reason: ledger.takeoverReason || 'Human Takeover is active on this target.',
          executed: 0,
          message: `Action blocked: target "${target.id}" is locked under Human Takeover.`,
        }, null, 2),
      };
    }

    const logicalSize = ledger.lastObservation?.logicalSize || {
      width: target.dimensions.width,
      height: target.dimensions.height,
    };
    const targetOrigin = target._provider
      ? { x: 0, y: 0 }
      : (ledger.lastObservation?.targetOrigin || { x: target.bounds.x, y: target.bounds.y });

    const refinedActions = [];
    for (const item of rawActions) {
      refinedActions.push(await maybeRefineWithGrounding(item, { target, settings, ledger, context, signal }));
    }

    const anyGroundingRefined = refinedActions.some((a) => a._groundingRefined);
    const { actions: resolvedActions, lastPoint } = resolveActionsGeometry(refinedActions, {
      coordinateMode,
      zoomRelative,
      logicalSize,
      targetOrigin,
      lastObservation: ledger.lastObservation,
    });

    if (target._provider) {
      const remapToTargetPx = zoomRelative || coordinateMode === 'image_pixels' || anyGroundingRefined;
      const wireActions = resolvedActions.map((act) => {
        const { resolvedPoint, resolvedStart, resolvedEnd, _groundingRefined, _coordinateModeOverride, _zoomRelativeOverride, key, keys, ...rest } = act;
        const normalizedKeys = keys !== undefined ? keys : key;
        const out = { ...rest };
        if (act.kind === 'key') out.keys = normalizedKeys;
        if (act.kind === 'hold_key') out.key = typeof key === 'string' ? key : (Array.isArray(keys) ? keys[0] : '');
        if (remapToTargetPx) {
          if (resolvedPoint) {
            out.x = resolvedPoint.targetX;
            out.y = resolvedPoint.targetY;
          }
          if (resolvedStart && resolvedEnd) {
            out.startX = resolvedStart.targetX;
            out.startY = resolvedStart.targetY;
            out.endX = resolvedEnd.targetX;
            out.endY = resolvedEnd.targetY;
          }
        }
        return out;
      });

      const remoteActRes = await actProviderTarget(target._provider, {
        targetId: target.id,
        coordinateMode: remapToTargetPx ? 'target_pixels' : coordinateMode,
        actions: wireActions,
        overrideHumanTakeover,
      }, { signal });

      if (!remoteActRes?.ok && remoteActRes?.code === 'human_takeover_active') {
        ledger.takeoverActive = true;
        ledger.controlledBy = 'human';
        fastSummaryCache.at = 0;
        broadcastStreamEvent({
          type: 'takeover',
          targetId: target.id,
          takeoverActive: true,
          controlledBy: 'human',
        });
        return { isError: true, output: JSON.stringify(remoteActRes, null, 2) };
      }

      if (lastPoint) {
        ledger.lastAction = {
          kind: resolvedActions.at(-1)?.kind || 'act',
          normX: lastPoint.normX,
          normY: lastPoint.normY,
          startNormX: lastPoint.startNormX,
          startNormY: lastPoint.startNormY,
          atMs: Date.now(),
        };
        broadcastStreamEvent({ type: 'action', targetId: target.id, lastAction: ledger.lastAction });
      }

      if (!observeAfter) {
        return { output: JSON.stringify(remoteActRes, null, 2) };
      }

      await sleepMs(settleMs, signal);
      const postObs = await captureTargetObservation({
        targetId: target.id,
        maxWidth: settings.defaultMaxWidth,
        context,
        signal,
        recordObservation: true,
      });
      return formatObservationToolOutput(postObs, {
        actionResult: {
          executed: remoteActRes.executed ?? wireActions.length,
          results: remoteActRes.results ?? [],
          lastPoint: remoteActRes.lastPoint ?? lastPoint,
        },
      }, context?.imageIn !== false);
    }

    const drv = getDriver();
    const results = [];
    let executed = 0;

    for (const act of resolvedActions) {
      signal?.throwIfAborted?.();
      if (!overrideHumanTakeover) {
        const guard = await checkLocalTakeoverGuard({
          target,
          ledger,
          settings,
          executedCount: executed,
          signal,
        });
        if (guard.tripped) {
          return { isError: true, output: JSON.stringify(guard.payload, null, 2) };
        }
      }

      let stepRes = null;
      switch (act.kind) {
        case 'click': {
          const pt = act.resolvedPoint;
          stepRes = await drv.mouseClick({
            screenX: pt.screenX,
            screenY: pt.screenY,
            button: act.button || 'left',
            count: act.count || 1,
            modifiers: act.modifiers || [],
          }, { signal });
          break;
        }
        case 'move': {
          const pt = act.resolvedPoint;
          const cursor = await drv.mouseMove(pt.screenX, pt.screenY, { signal });
          stepRes = { blocked: false, cursor };
          break;
        }
        case 'mouse_down': {
          const pt = act.resolvedPoint;
          stepRes = await drv.mouseDown({
            hasCoords: Boolean(pt),
            screenX: pt?.screenX || 0,
            screenY: pt?.screenY || 0,
            button: act.button || 'left',
          }, { signal });
          break;
        }
        case 'mouse_up': {
          const pt = act.resolvedPoint;
          stepRes = await drv.mouseUp({
            hasCoords: Boolean(pt),
            screenX: pt?.screenX || 0,
            screenY: pt?.screenY || 0,
            button: act.button || 'left',
          }, { signal });
          break;
        }
        case 'drag': {
          stepRes = await drv.mouseDrag({
            startX: act.resolvedStart.screenX,
            startY: act.resolvedStart.screenY,
            endX: act.resolvedEnd.screenX,
            endY: act.resolvedEnd.screenY,
            button: act.button || 'left',
            durationMs: act.durationMs || 220,
          }, { signal });
          break;
        }
        case 'scroll': {
          const pt = act.resolvedPoint;
          stepRes = await drv.mouseScroll({
            screenX: pt.screenX,
            screenY: pt.screenY,
            deltaX: Number(act.deltaX) || 0,
            deltaY: Number(act.deltaY) || 0,
          }, { signal });
          break;
        }
        case 'type': {
          stepRes = await drv.typeText({
            text: act.text ?? '',
            mode: act.mode || 'auto',
            submit: Boolean(act.submit),
          }, { signal });
          break;
        }
        case 'key': {
          const chordInput = act.keys !== undefined ? act.keys : act.key;
          stepRes = await drv.keyChord(chordInput, { signal });
          break;
        }
        case 'hold_key': {
          const holdInput = act.key || (Array.isArray(act.keys) ? act.keys[0] : '');
          stepRes = await drv.holdKey(holdInput, act.durationMs || 250, { signal });
          break;
        }
        case 'wait': {
          const waitDur = Math.min(10000, Math.max(0, Number(act.durationMs) || 250));
          await sleepMs(waitDur, signal);
          stepRes = { blocked: false, waitedMs: waitDur };
          break;
        }
        case 'clipboard_get': {
          const clip = await drv.clipboardGet({ signal });
          stepRes = { blocked: false, text: clip?.text ?? '' };
          break;
        }
        case 'clipboard_set': {
          await drv.clipboardSet(act.text ?? '', { signal });
          stepRes = { blocked: false, length: String(act.text ?? '').length };
          break;
        }
        default:
          throw new Error(`Unsupported action kind: ${String(act.kind)}`);
      }

      if (stepRes?.blocked && stepRes?.code === 'uipi_elevated_window') {
        await drv.releaseAllInputs({ signal });
        return {
          isError: true,
          output: JSON.stringify({
            ok: false,
            code: 'uipi_elevated_window',
            targetId: target.id,
            executed,
            window: {
              hwnd: stepRes.hwnd,
              title: stepRes.title,
              processName: stepRes.processName,
              pid: stepRes.pid,
            },
            message: stepRes.message,
          }, null, 2),
        };
      }

      if (stepRes?.cursor && Number.isFinite(stepRes.cursor.x) && Number.isFinite(stepRes.cursor.y)) {
        ledger.lastSyntheticCursor = {
          screenX: stepRes.cursor.x,
          screenY: stepRes.cursor.y,
          atMs: Date.now(),
        };
      }

      executed += 1;
      results.push({
        kind: act.kind,
        ...(act.resolvedPoint ? { point: { x: act.resolvedPoint.targetX, y: act.resolvedPoint.targetY, screenX: act.resolvedPoint.screenX, screenY: act.resolvedPoint.screenY } } : {}),
        ...(act.kind === 'clipboard_get' ? { text: stepRes.text } : {}),
        ...(act.kind === 'type' ? { mode: stepRes.mode, length: stepRes.length } : {}),
      });
    }

    if (lastPoint) {
      ledger.lastAction = {
        kind: resolvedActions.at(-1)?.kind || 'act',
        normX: lastPoint.normX,
        normY: lastPoint.normY,
        startNormX: lastPoint.startNormX,
        startNormY: lastPoint.startNormY,
        atMs: Date.now(),
      };
      broadcastStreamEvent({ type: 'action', targetId: target.id, lastAction: ledger.lastAction });
    }

    const actSummary = {
      ok: true,
      targetId: target.id,
      executed,
      results,
      lastPoint,
      takeoverActive: ledger.takeoverActive,
    };

    if (!observeAfter) {
      return { output: JSON.stringify(actSummary, null, 2) };
    }

    await sleepMs(settleMs, signal);
    const postObs = await captureTargetObservation({
      targetId: target.id,
      maxWidth: settings.defaultMaxWidth,
      context,
      signal,
      recordObservation: true,
    });
    return formatObservationToolOutput(postObs, { actionResult: actSummary }, context?.imageIn !== false);
  }

  async function executeWindowsTool(args = {}, context = {}) {
    const action = args?.action || 'list';
    const signal = context?.signal;
    const drv = getDriver();

    if (action === 'list') {
      const res = await drv.listWindows(args?.query || '', { signal });
      return {
        output: JSON.stringify({
          ok: true,
          count: res.windows.length,
          windows: res.windows,
        }, null, 2),
      };
    }

    const rawHandle = args?.hwnd || args?.windowId;
    if (!rawHandle || typeof rawHandle !== 'string' || !rawHandle.trim()) {
      return {
        isError: true,
        output: JSON.stringify({ ok: false, code: 'missing_hwnd', message: `${action} requires hwnd or windowId.` }),
      };
    }

    const win = action === 'focus'
      ? await drv.focusWindow(rawHandle.trim(), { signal })
      : await drv.restoreWindow(rawHandle.trim(), { signal });

    let pinnedTargetId = null;
    if (args?.pinTarget && win?.hwnd) {
      pinnedTargetId = `local:window:${win.hwnd}`;
      pinnedWindows.set(pinnedTargetId, {
        hwnd: win.hwnd,
        title: win.title || win.hwnd,
        bounds: win.bounds,
        scaleFactor: win.scaleFactor || 1,
        dpi: win.dpi || 96,
      });
      fastSummaryCache.at = 0;
    }

    return {
      output: JSON.stringify({
        ok: true,
        action,
        window: win,
        ...(pinnedTargetId ? { pinnedTargetId } : {}),
      }, null, 2),
    };
  }

  async function performPanelHumanAction(body = {}, context = {}) {
    const { target, ledger } = await resolveActiveTarget(body.targetId, { context });

    if (!ledger.takeoverActive) {
      ledger.takeoverActive = true;
      ledger.controlledBy = 'human';
      ledger.takeoverReason = 'Interactive input from Computer Preview';
      ledger.takeoverUpdatedAtMs = Date.now();
      fastSummaryCache.at = 0;
      if (target._provider) {
        await setProviderTakeover(target._provider, {
          targetId: target.id,
          active: true,
          holder: 'human',
          reason: ledger.takeoverReason,
        }).catch(() => {});
      } else {
        await getDriver().releaseAllInputs();
      }
      broadcastStreamEvent({
        type: 'takeover',
        targetId: target.id,
        takeoverActive: true,
        controlledBy: 'human',
        reason: ledger.takeoverReason,
      });
    }

    const kind = body.kind || 'click';
    let actions = [];
    if (kind === 'click') {
      actions = [{
        kind: 'click',
        x: Number(body.normX) || 0,
        y: Number(body.normY) || 0,
        button: body.button || 'left',
        count: body.count || 1,
      }];
    } else if (kind === 'drag') {
      actions = [{
        kind: 'drag',
        startX: Number(body.startNormX) || 0,
        startY: Number(body.startNormY) || 0,
        endX: Number(body.endNormX) || 0,
        endY: Number(body.endNormY) || 0,
        button: body.button || 'left',
        durationMs: body.durationMs || 180,
      }];
    } else if (kind === 'scroll') {
      actions = [{
        kind: 'scroll',
        x: Number(body.normX) || 500,
        y: Number(body.normY) || 500,
        deltaX: Number(body.deltaX) || 0,
        deltaY: Number(body.deltaY) || 0,
      }];
    } else if (kind === 'key') {
      actions = [{ kind: 'key', key: String(body.key || '') }];
    } else if (kind === 'type') {
      actions = [{ kind: 'type', text: String(body.text || ''), submit: Boolean(body.submit) }];
    }

    const logicalSize = { width: target.dimensions.width, height: target.dimensions.height };
    const targetOrigin = target._provider ? { x: 0, y: 0 } : { x: target.bounds.x, y: target.bounds.y };
    const { actions: resolved, lastPoint } = resolveActionsGeometry(actions, {
      coordinateMode: 'normalized_1000',
      zoomRelative: false,
      logicalSize,
      targetOrigin,
    });

    if (target._provider) {
      await actProviderTarget(target._provider, {
        targetId: target.id,
        coordinateMode: 'normalized_1000',
        actions,
        overrideHumanTakeover: true,
      });
    } else {
      const drv = getDriver();
      for (const act of resolved) {
        if (act.kind === 'click') {
          await drv.mouseClick({
            screenX: act.resolvedPoint.screenX,
            screenY: act.resolvedPoint.screenY,
            button: act.button,
            count: act.count,
          });
        } else if (act.kind === 'drag') {
          await drv.mouseDrag({
            startX: act.resolvedStart.screenX,
            startY: act.resolvedStart.screenY,
            endX: act.resolvedEnd.screenX,
            endY: act.resolvedEnd.screenY,
            button: act.button,
            durationMs: act.durationMs,
          });
        } else if (act.kind === 'scroll') {
          await drv.mouseScroll({
            screenX: act.resolvedPoint.screenX,
            screenY: act.resolvedPoint.screenY,
            deltaX: act.deltaX,
            deltaY: act.deltaY,
          });
        } else if (act.kind === 'key') {
          await drv.keyChord(act.key);
        } else if (act.kind === 'type') {
          await drv.typeText({ text: act.text, submit: act.submit });
        }
      }
    }

    if (lastPoint) {
      ledger.lastAction = {
        kind,
        normX: lastPoint.normX,
        normY: lastPoint.normY,
        startNormX: lastPoint.startNormX,
        startNormY: lastPoint.startNormY,
        atMs: Date.now(),
      };
      broadcastStreamEvent({ type: 'action', targetId: target.id, lastAction: ledger.lastAction });
    }

    return {
      ok: true,
      targetId: target.id,
      takeoverActive: ledger.takeoverActive,
      controlledBy: ledger.controlledBy,
      lastAction: ledger.lastAction,
    };
  }

  async function handlePanelRequest(action, args = {}, context = {}) {
    const body = args && typeof args === 'object' ? args : {};
    if (context?.settings) {
      activeSettings = normalizeCuaSettings(context.settings);
    }

    if (action === 'state') {
      const inv = await collectAllTargets({ context, fast: Boolean(body.fast) });
      const activeTarget = inv.targets.find((t) => t.id === inv.selectedTargetId) || inv.targets[0];
      const ledger = activeTarget ? getLedgerEntry(canonicalLedgerKey(activeTarget.id, inv.primaryMonitorId)) : null;
      return {
        ok: true,
        selectedTargetId: inv.selectedTargetId,
        targets: inv.targets.map(stripInternalTargetFields),
        providers: inv.providers,
        virtualScreen: inv.virtualScreen,
        takeoverActive: Boolean(ledger?.takeoverActive),
        controlledBy: ledger?.controlledBy || 'agent',
        takeoverReason: ledger?.takeoverReason || null,
        lastAction: ledger?.lastAction || null,
      };
    }

    if (action === 'select') {
      const res = await executeTargetsTool({ action: 'select', targetId: body.targetId }, context);
      return JSON.parse(res.output);
    }

    if (action === 'takeover') {
      const res = await executeTargetsTool({
        action: 'takeover',
        targetId: body.targetId,
        takeoverActive: Boolean(body.active ?? body.takeoverActive),
        reason: body.reason || (body.active ? 'Locked from Computer Preview' : null),
      }, context);
      return JSON.parse(res.output);
    }

    if (action === 'frame') {
      const obs = await captureTargetObservation({
        targetId: body.targetId,
        maxWidth: body.maxWidth || 1280,
        maxHeight: body.maxHeight || 900,
        overlay: 'none',
        context,
        recordObservation: false,
      });
      const cursorNorm = obs.cursor && obs.logicalSize
        ? targetPixelsToNormalized1000(
            obs.cursor.x - (obs.targetOrigin?.x || 0),
            obs.cursor.y - (obs.targetOrigin?.y || 0),
            obs.logicalSize,
          )
        : null;
      const inv = fastSummaryCache.value || await collectAllTargets({ context, fast: true });
      const ledger = getLedgerEntry(canonicalLedgerKey(obs.targetId, inv.primaryMonitorId));
      return {
        ok: true,
        targetId: obs.targetId,
        dataUrl: `data:image/png;base64,${obs.imageBase64}`,
        imageSize: obs.imageSize,
        logicalSize: obs.logicalSize,
        cursorNorm,
        foregroundWindow: obs.foregroundWindow,
        takeoverActive: ledger.takeoverActive,
        controlledBy: ledger.controlledBy,
        lastAction: ledger.lastAction,
        capturedAtMs: obs.capturedAtMs,
      };
    }

    if (action === 'action') {
      return performPanelHumanAction(body, context);
    }

    if (action === 'windows') {
      const res = await executeWindowsTool(body, context);
      return JSON.parse(res.output);
    }

    return { ok: false, error: `Unsupported CUA panel action: ${String(action)}` };
  }

  async function openPanelStream(stream, args = {}, session, context = {}) {
    if (stream !== 'screen') {
      throw new Error(`Unsupported CUA panel stream: ${String(stream)}`);
    }
    const body = args && typeof args === 'object' ? args : {};
    let currentTargetId = body.targetId || selectedTargetId || 'local:primary';
    const maxWidth = Math.min(2560, Math.max(480, Math.round(Number(body.maxWidth) || 1280)));
    const intervalMs = Math.min(2000, Math.max(90, Math.round(1000 / (Number(body.fps) || 8))));

    const { target, ledger } = await resolveActiveTarget(currentTargetId, { context, signal: session.signal });
    currentTargetId = target.id;

    let closed = false;
    let seq = 0;
    let inFlight = false;
    let loopTimer = null;

    const subscriber = {
      sendMeta(meta) {
        if (closed) return;
        session.sendText(meta);
      },
    };
    liveStreamSubscribers.add(subscriber);

    async function pushFrameOnce() {
      if (closed || inFlight || session.signal?.aborted) return;
      if (typeof session.bufferedAmount === 'function' && session.bufferedAmount() > 1.5 * 1024 * 1024) {
        return;
      }
      inFlight = true;
      try {
        const obs = await captureTargetObservation({
          targetId: currentTargetId,
          maxWidth,
          maxHeight: 1080,
          overlay: 'none',
          context,
          signal: session.signal,
          recordObservation: false,
        });
        if (closed) return;
        const pngBytes = Buffer.from(obs.imageBase64, 'base64');
        const packet = packPngStreamFrame({
          width: obs.imageSize.width,
          height: obs.imageSize.height,
          seq: ++seq,
          timestampMs: obs.capturedAtMs,
          pngBytes,
        });
        session.sendBinary(packet);

        const cursorNorm = obs.cursor && obs.logicalSize
          ? targetPixelsToNormalized1000(
              obs.cursor.x - (obs.targetOrigin?.x || 0),
              obs.cursor.y - (obs.targetOrigin?.y || 0),
              obs.logicalSize,
            )
          : null;

        session.sendText({
          type: 'frameMeta',
          targetId: obs.targetId,
          logicalSize: obs.logicalSize,
          imageSize: obs.imageSize,
          cursorNorm,
          foregroundWindow: obs.foregroundWindow ? { title: obs.foregroundWindow.title, processName: obs.foregroundWindow.processName } : null,
          takeoverActive: ledger.takeoverActive,
          controlledBy: ledger.controlledBy,
        });
      } catch {} finally {
        inFlight = false;
        if (!closed && !session.signal?.aborted) {
          loopTimer = setTimeout(pushFrameOnce, intervalMs);
          loopTimer.unref?.();
        }
      }
    }

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
      }
      liveStreamSubscribers.delete(subscriber);
    };

    session.signal?.addEventListener?.('abort', cleanup, { once: true });

    setTimeout(() => { void pushFrameOnce(); }, 5);

    return {
      result: {
        protocol: 'kiki-cua-png-stream-v1',
        targetId: currentTargetId,
        width: target.dimensions.width,
        height: target.dimensions.height,
        scaleFactor: target.dimensions.scaleFactor || 1,
        takeoverActive: ledger.takeoverActive,
        controlledBy: ledger.controlledBy,
      },
      onText(rawText) {
        try {
          const msg = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
          if (msg?.type === 'selectTarget' && typeof msg.targetId === 'string') {
            currentTargetId = msg.targetId;
          } else if (msg?.type === 'humanAction') {
            void performPanelHumanAction({ ...msg, targetId: currentTargetId }, context).catch(() => {});
          }
        } catch {}
      },
      onClose() {
        cleanup();
      },
    };
  }

  async function activate(appContext = {}) {
    if (appContext.dataDir) activeDataDir = appContext.dataDir;
    if (appContext.settings) activeSettings = normalizeCuaSettings(appContext.settings);
    await ensureSelectionLoaded({ kikiHome: appContext.userHome ? path.join(appContext.userHome, '.kiki') : undefined });
    appContext.signal?.addEventListener?.('abort', () => {
      void dispose();
    }, { once: true });
    return { ok: true };
  }

  async function dispose() {
    for (const sub of liveStreamSubscribers) {
      try { sub.sendMeta({ type: 'closing' }); } catch {}
    }
    liveStreamSubscribers.clear();
    if (driver) {
      const d = driver;
      driver = null;
      await d.dispose();
    }
  }

  return {
    activate,
    dispose,
    collectAllTargets,
    captureTargetObservation,
    executeTool(name, args, context) {
      if (name === 'cua_targets') return executeTargetsTool(args, context);
      if (name === 'cua_observe') return executeObserveTool(args, context);
      if (name === 'cua_act') return executeActTool(args, context);
      if (name === 'cua_windows') return executeWindowsTool(args, context);
      return Promise.resolve({ isError: true, output: `Unknown CUA tool: ${String(name)}` });
    },
    handlePanelRequest,
    openPanelStream,
  };
}
