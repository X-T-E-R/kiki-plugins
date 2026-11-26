import { hashPngOrSample } from './png-codec.mjs';
import { isPveTargetId } from './pve-qmp-driver.mjs';
import { isVncTargetId, packDirtyRectFrame } from './rfb-driver.mjs';

const STREAM_MAGIC_0 = 0x55; // 'U'
const STREAM_MAGIC_1 = 0x52; // 'R'
export const CLIENT_POINTER_MAGIC = 0x50; // 'P'
export const CLIENT_WHEEL_MAGIC = 0x57; // 'W'
export const CLIENT_RAW_KEY_MAGIC = 0x4b; // 'K'

const MAX_BUFFERED_BYTES = 1_500_000;
const DIRTY_COALESCE_BUFFERED_BYTES = 64 * 1024;
const PEEK_DEFAULT_MAX_AGE_MS = 15_000;
const PEEK_DEFAULT_WAIT_BUDGET_MS = 200;
const STREAM_TOPO_REFRESH_MS = 3_000;
const TELEMETRY_HEARTBEAT_MS = 2_000;

export function packStreamPngFrame({
  pngBuffer,
  imageSize,
  logicalSize,
  contentRect,
  contentTrimmed = false,
  takeoverActive = false,
}) {
  const header = Buffer.allocUnsafe(16);
  header[0] = STREAM_MAGIC_0;
  header[1] = STREAM_MAGIC_1;
  header[2] = (contentTrimmed ? 1 : 0) | (takeoverActive ? 2 : 0);
  header[3] = 0;
  header.writeUInt16BE(Math.min(65535, Math.max(1, imageSize.width)), 4);
  header.writeUInt16BE(Math.min(65535, Math.max(1, imageSize.height)), 6);
  header.writeUInt16BE(Math.min(65535, Math.max(1, logicalSize.width)), 8);
  header.writeUInt16BE(Math.min(65535, Math.max(1, logicalSize.height)), 10);
  header.writeUInt16BE(Math.min(65535, Math.max(0, contentRect?.x || 0)), 12);
  header.writeUInt16BE(Math.min(65535, Math.max(0, contentRect?.y || 0)), 14);
  return Buffer.concat([header, pngBuffer]);
}

export function decodeClientBinaryInput(rawBuf) {
  const b = Buffer.isBuffer(rawBuf)
    ? rawBuf
    : (rawBuf instanceof ArrayBuffer
      ? Buffer.from(rawBuf)
      : (ArrayBuffer.isView(rawBuf) ? Buffer.from(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength) : null));
  if (!b || b.length < 2) return null;

  if (b[0] === CLIENT_POINTER_MAGIC && b.length >= 8) {
    const op = b.readUInt8(1); // 0=move, 1=down, 2=up
    const buttonsMask = b.readUInt8(2);
    const clickCount = b.readUInt8(3) || 1;
    const norm1000X = b.readUInt16BE(4);
    const norm1000Y = b.readUInt16BE(6);
    return {
      type: 'pointer',
      op,
      buttonsMask,
      clickCount,
      norm1000X,
      norm1000Y,
      engageTakeover: op === 1,
    };
  }

  if (b[0] === CLIENT_WHEEL_MAGIC && b.length >= 10) {
    const norm1000X = b.readUInt16BE(2);
    const norm1000Y = b.readUInt16BE(4);
    const deltaX = b.readInt16BE(6);
    const deltaY = b.readInt16BE(8);
    return {
      type: 'wheel',
      norm1000X,
      norm1000Y,
      deltaX,
      deltaY,
      engageTakeover: true,
    };
  }

  if (b[0] === CLIENT_RAW_KEY_MAGIC && b.length >= 5) {
    const downFlag = b.readUInt8(1); // 1=down, 0=up, 2=tap
    const flags = b.readUInt8(2);
    const codeLen = b.readUInt8(3);
    if (4 + codeLen > b.length) return null;
    const code = b.subarray(4, 4 + codeLen).toString('utf8');
    let key = '';
    if (4 + codeLen < b.length) {
      const keyLen = b.readUInt8(4 + codeLen);
      if (5 + codeLen + keyLen <= b.length) {
        key = b.subarray(5 + codeLen, 5 + codeLen + keyLen).toString('utf8');
      }
    }
    return {
      type: 'key',
      down: downFlag === 2 ? 2 : Boolean(downFlag),
      shiftKey: Boolean(flags & 1),
      code,
      key,
      engageTakeover: downFlag !== 0,
    };
  }

  return null;
}

function isRemoteSessionId(sessionId) {
  return isPveTargetId(sessionId) || isVncTargetId(sessionId);
}

function mergeRectBounds(a, b) {
  if (!b) return a;
  if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function createUuPreviewService({ uuService, ensureProviderBus = async () => null, nowFn = Date.now } = {}) {
  const activeStreams = new Set();
  let cachedPeekState = { key: '', at: 0, value: null };
  const peekFlights = new Map();

  function emptyPeekSnapshot() {
    return {
      ok: true,
      selectedSessionId: null,
      sessions: [],
      offscreenCount: 0,
      pairedDevices: [],
    };
  }

  function peekCacheKey(context = {}) {
    const settings = context?.settings ?? {};
    return `${String(settings.executablePath ?? '')}|${String(settings.cliPath ?? '')}`;
  }

  function raceTimeout(promise, ms, message) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  function triggerBackgroundPeekRefresh(context = {}) {
    const key = peekCacheKey(context);
    let flight = peekFlights.get(key);
    if (!flight) {
      flight = uuService.manageSessions(
        {
          action: 'list',
          includeDevices: false,
          probeContentRect: false,
        },
        context,
      )
        .then((sessionSummary) => {
          const snapshot = {
            ok: true,
            selectedSessionId: sessionSummary.selectedSessionId ?? null,
            sessions: Array.isArray(sessionSummary.sessions) ? sessionSummary.sessions : [],
            offscreenCount: Number(sessionSummary.offscreenCount) || 0,
            pairedDevices: [],
          };
          cachedPeekState = { key, at: nowFn(), value: snapshot };
          return snapshot;
        })
        .finally(() => {
          if (peekFlights.get(key) === flight) peekFlights.delete(key);
        });
      flight.catch(() => {});
      peekFlights.set(key, flight);
    }
    return flight;
  }

  async function peekState(
    { maxAgeMs = PEEK_DEFAULT_MAX_AGE_MS, waitBudgetMs = PEEK_DEFAULT_WAIT_BUDGET_MS } = {},
    context = {},
  ) {
    const key = peekCacheKey(context);
    const hasCached = cachedPeekState.value !== null && cachedPeekState.key === key;
    if (hasCached && nowFn() - cachedPeekState.at < maxAgeMs) {
      return cachedPeekState.value;
    }
    const flight = triggerBackgroundPeekRefresh(context);
    if (hasCached || waitBudgetMs <= 0) {
      return hasCached ? cachedPeekState.value : emptyPeekSnapshot();
    }
    try {
      return await raceTimeout(flight, waitBudgetMs, 'uu-remote peek budget elapsed');
    } catch {
      return cachedPeekState.key === key && cachedPeekState.value !== null
        ? cachedPeekState.value
        : emptyPeekSnapshot();
    }
  }

  function nudgeStreams(sessionId = null, delayMs = 35) {
    for (const subscriber of activeStreams) {
      subscriber.nudge(sessionId, delayMs);
    }
  }

  async function listState(args = {}, context = {}) {
    await ensureProviderBus(context);
    const [sessionSummary, statusSummary] = await Promise.all([
      uuService.manageSessions(
        {
          action: 'list',
          includeDevices: args.includeDevices !== false,
          probeContentRect: Boolean(args.probeContentRect),
        },
        context,
      ),
      uuService.getStatus({ includeCliStatus: false }, context),
    ]);

    const result = {
      ok: true,
      selectedSessionId: sessionSummary.selectedSessionId,
      sessions: sessionSummary.sessions,
      offscreenCount: sessionSummary.offscreenCount,
      pairedDevices: sessionSummary.pairedDevices,
      installation: statusSummary.installation,
      cli: statusSummary.cli,
      runtime: statusSummary.runtime,
      providerBus: statusSummary.providerBus,
    };
    cachedPeekState = {
      key: peekCacheKey(context),
      at: nowFn(),
      value: {
        ok: true,
        selectedSessionId: result.selectedSessionId,
        sessions: result.sessions,
        offscreenCount: result.offscreenCount,
        pairedDevices: result.pairedDevices,
      },
    };
    return result;
  }

  async function captureFrame(args = {}, context = {}) {
    await ensureProviderBus(context);
    const started = nowFn();
    try {
      const shot = await uuService.controlSession(
        {
          sessionId: args.sessionId,
          action: 'screenshot',
          maxWidth: args.maxWidth ?? 1280,
          maxHeight: args.maxHeight ?? 800,
          autoTrimBlackBars: args.autoTrimBlackBars,
          remoteAspect: args.remoteAspect,
          overlay: args.overlay,
        },
        context,
      );
      const capInfo = typeof uuService.getSessionTransportAndCapabilities === 'function'
        ? await uuService.getSessionTransportAndCapabilities(shot.sessionId).catch(() => null)
        : null;
      return {
        ok: true,
        sessionId: shot.sessionId,
        label: shot.label,
        transport: shot.transport || capInfo?.transport || 'uu-win32',
        capabilities: capInfo?.capabilities || undefined,
        captureMs: Math.max(0, Math.round(nowFn() - started)),
        screenshotId: shot.screenshotId,
        frameHash: shot.frameHash,
        mimeType: shot.mimeType,
        dataUrl: `data:${shot.mimeType};base64,${shot.imageBase64}`,
        imageSize: shot.imageSize,
        logicalSize: shot.logicalSize,
        contentRect: shot.contentRect,
        contentTrimmed: shot.contentTrimmed,
        takeoverActive: shot.takeoverActive,
        controlledBy: shot.controlledBy,
      };
    } catch (error) {
      return {
        ok: false,
        sessionId: args.sessionId || null,
        error: error.message || String(error),
      };
    }
  }

  async function performAction(input = {}, context = {}) {
    await ensureProviderBus(context);
    const kind = input.action;
    try {
      if (kind === 'select') {
        return await uuService.manageSessions({ action: 'select', sessionId: input.sessionId }, context);
      }
      if (kind === 'takeover') {
        const res = await uuService.manageSessions(
          {
            action: 'takeover',
            sessionId: input.sessionId,
            active: Boolean(input.active),
            reason: input.reason || (input.active ? 'Locked from UU Remote workspace panel' : undefined),
          },
          context,
        );
        nudgeStreams(res.sessionId || input.sessionId, 20);
        return res;
      }
      if (kind === 'rescueOffscreen') {
        const res = await uuService.launchAction(
          { action: 'recover_offscreen', sessionId: input.sessionId },
          context,
        );
        nudgeStreams(input.sessionId || null, 45);
        return res;
      }
      if (kind === 'openClient') {
        return await uuService.launchAction({ action: 'open_client', waitForWindowMs: 1500 }, context);
      }
      if (kind === 'connectDevice') {
        return await uuService.launchAction(
          { action: 'connect_device', deviceId: input.deviceId, waitForWindowMs: 4000 },
          context,
        );
      }
      if (kind === 'disconnectDevice') {
        return await uuService.launchAction(
          { action: 'disconnect_device', deviceId: input.deviceId },
          context,
        );
      }
      if (kind === 'connectPve') {
        const res = await uuService.launchAction(
          {
            action: 'connect',
            pveHost: input.pveHost,
            vmid: input.vmid,
            label: input.label,
          },
          context,
        );
        nudgeStreams(res.sessionId || null, 25);
        return res;
      }
      if (kind === 'connectVnc') {
        const res = await uuService.launchAction(
          {
            action: 'connect',
            vncHost: input.vncHost,
            vncPort: input.vncPort,
            vncPassword: input.vncPassword,
            sshHost: input.sshHost,
            label: input.label,
          },
          context,
        );
        nudgeStreams(res.sessionId || null, 25);
        return res;
      }
      if (kind === 'disconnectTarget') {
        const targetId = input.sessionId || input.deviceId;
        const res = await uuService.launchAction(
          { action: 'disconnect', deviceId: targetId },
          context,
        );
        return res;
      }
      if (kind === 'clipboardGet') {
        return await uuService.controlSession(
          {
            sessionId: input.sessionId,
            action: 'clipboard_get',
            observeAfter: false,
            overrideHumanTakeover: true,
          },
          context,
        );
      }
      if (kind === 'clipboardSet') {
        return await uuService.controlSession(
          {
            sessionId: input.sessionId,
            action: 'clipboard_set',
            text: input.text,
            observeAfter: false,
            overrideHumanTakeover: true,
          },
          context,
        );
      }
      if (kind === 'restore' || kind === 'focus') {
        const res = await uuService.controlSession(
          {
            sessionId: input.sessionId,
            action: kind,
            observeAfter: false,
            overrideHumanTakeover: true,
          },
          context,
        );
        nudgeStreams(res.sessionId || input.sessionId, 45);
        return res;
      }
      if (kind === 'input') {
        const fromHumanPanel = input.fromHumanPanel !== false;
        if (fromHumanPanel) {
          const alreadyLocked = typeof uuService.getTakeoverEntry === 'function'
            ? uuService.getTakeoverEntry(input.sessionId)?.active === true
            : false;
          if (!alreadyLocked) {
            await uuService
              .setTakeover(
                {
                  sessionId: input.sessionId,
                  active: true,
                  holder: 'human',
                  reason: 'Interactive input from UU Remote workspace panel',
                },
                context,
              )
              .catch(() => {});
          }
        }
        const normalizedSubAction = input.subAction === 'paste' ? 'type' : input.subAction;
        const normalizedMode = input.subAction === 'paste' ? 'clipboard' : input.mode;
        const res = await uuService.controlSession(
          {
            sessionId: input.sessionId,
            action: normalizedSubAction,
            actions: input.actions,
            coordinateMode: input.coordinateMode || 'normalized_1000',
            x: input.x,
            y: input.y,
            startX: input.startX,
            startY: input.startY,
            endX: input.endX,
            endY: input.endY,
            button: input.button,
            count: input.count,
            modifiers: input.modifiers,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            durationMs: input.durationMs,
            text: input.text,
            submit: input.submit,
            mode: normalizedMode,
            key: input.key,
            keys: input.keys,
            observeAfter: false,
            overrideHumanTakeover: fromHumanPanel,
          },
          context,
        );
        if (fromHumanPanel && typeof uuService.recordHumanPanelAction === 'function') {
          uuService.recordHumanPanelAction(res.sessionId || input.sessionId, {
            kind: input.subAction === 'paste' ? 'paste' : normalizedSubAction,
            x: input.x,
            y: input.y,
            startX: input.startX,
            startY: input.startY,
            endX: input.endX,
            endY: input.endY,
            button: input.button,
            count: input.count,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            text: input.text,
            submit: input.submit,
            key: input.key,
            keys: input.keys,
          });
        }
        nudgeStreams(res.sessionId || input.sessionId, 35);
        return res;
      }
      return { ok: false, error: `Unsupported UU Remote panel action: ${String(kind)}` };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  async function openPanelStream(stream, args = {}, streamSession, context = {}) {
    if (stream !== 'screen') {
      throw new Error(`Unsupported UU Remote stream "${String(stream)}"; expected "screen".`);
    }
    await ensureProviderBus(context);

    let targetSessionId = args?.sessionId || null;
    let maxWidth = Math.max(320, Math.min(2560, Number(args?.maxWidth) || 1280));
    let maxHeight = Math.max(240, Math.min(1600, Number(args?.maxHeight) || 900));
    let fps = Math.max(1, Math.min(30, Number(args?.fps) || 24));
    const allowDirtyRects = args?.protocol !== 'uu-png-stream-v1';
    let paused = false;
    let forceSingleFrame = false;
    let needFullKeyframe = false;
    let dirtySinceLastFrame = true;
    let closed = false;
    let timer = null;
    let dirtyFlushTimer = null;
    let inFlight = false;

    let lastSentFrameHash = null;
    let lastFrameSentAtMs = 0;
    let lastTelemetryAtMs = 0;
    let usingDirtyRectStream = false;
    let coalescedBounds = null;
    let outboundSeq = 0;

    const sendDirtyPacket = (buf) => {
      outboundSeq = (outboundSeq + 1) >>> 0;
      const out = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(buf);
      if (out.length >= 6) {
        out.writeUInt32BE(outboundSeq, 2);
      }
      return streamSession.sendBinary(out);
    };
    let lastMeta = {
      transport: 'uu-win32',
      width: 0,
      height: 0,
      takeoverActive: false,
      capabilities: null,
    };

    const topo = await uuService.inspectTopology(context?.settings ?? {}, context);
    const initialSession = await uuService.resolveTargetSession(targetSessionId, topo, context);
    targetSessionId = initialSession.id;
    let cachedSession = initialSession;
    let lastTopoAt = nowFn();
    let unsubscribeRfb = null;
    let unsubscribeClipboard = null;

    const scheduleNext = (delayMs) => {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(pumpFrame, Math.max(5, Math.round(delayMs)));
      timer.unref?.();
    };

    const emitTelemetry = (payload) => {
      if (closed) return;
      lastTelemetryAtMs = nowFn();
      streamSession.sendText?.(JSON.stringify({ type: 'telemetry', ...payload }));
    };

    const flushCoalescedDirtyBounds = () => {
      dirtyFlushTimer = null;
      if (closed || paused || !usingDirtyRectStream || !coalescedBounds) return;
      const buffered = streamSession.bufferedAmount?.() ?? 0;
      if (buffered > DIRTY_COALESCE_BUFFERED_BYTES) {
        dirtyFlushTimer = setTimeout(flushCoalescedDirtyBounds, Math.max(16, Math.round(1000 / Math.max(1, fps))));
        dirtyFlushTimer.unref?.();
        return;
      }
      const bounds = coalescedBounds;
      coalescedBounds = null;
      const pkt = uuService.buildRfbCoalescedBoundsPacket?.(targetSessionId, bounds);
      if (pkt) {
        const ok = sendDirtyPacket(pkt);
        if (ok !== false) {
          lastFrameSentAtMs = nowFn();
        } else {
          needFullKeyframe = true;
        }
      }
    };

    const bindRfbSubscription = (sid) => {
      if (unsubscribeRfb) {
        try { unsubscribeRfb(); } catch {}
        unsubscribeRfb = null;
      }
      if (unsubscribeClipboard) {
        try { unsubscribeClipboard(); } catch {}
        unsubscribeClipboard = null;
      }
      if (!sid) return;

      if (typeof uuService.subscribeSessionClipboard === 'function') {
        unsubscribeClipboard = uuService.subscribeSessionClipboard(sid, (clipEvt) => {
          if (closed || !clipEvt?.text) return;
          streamSession.sendText?.(JSON.stringify({
            type: 'remoteClipboard',
            sessionId: sid,
            text: clipEvt.text,
            updatedAtMs: clipEvt.updatedAtMs || nowFn(),
          }));
        });
      }

      if (typeof uuService.subscribeSessionUpdates !== 'function') return;
      unsubscribeRfb = uuService.subscribeSessionUpdates(sid, (evt) => {
        if (closed) return;
        if (usingDirtyRectStream && Array.isArray(evt?.rects) && evt.rects.length > 0 && !needFullKeyframe) {
          if (paused) {
            coalescedBounds = mergeRectBounds(coalescedBounds, evt.dirtyBounds || { x: 0, y: 0, width: evt.width || 1024, height: evt.height || 768 });
            return;
          }
          const minIntervalMs = Math.round(1000 / Math.max(1, fps));
          const now = nowFn();
          const buffered = streamSession.bufferedAmount?.() ?? 0;
          if (buffered > DIRTY_COALESCE_BUFFERED_BYTES || coalescedBounds || (now - lastFrameSentAtMs < minIntervalMs - 2)) {
            coalescedBounds = mergeRectBounds(coalescedBounds, evt.dirtyBounds || { x: 0, y: 0, width: evt.width || 1024, height: evt.height || 768 });
            if (!dirtyFlushTimer) {
              const waitMs = Math.max(8, minIntervalMs - (now - lastFrameSentAtMs));
              dirtyFlushTimer = setTimeout(flushCoalescedDirtyBounds, waitMs);
              dirtyFlushTimer.unref?.();
            }
            return;
          }
          const tkActive = typeof uuService.getTakeoverEntry === 'function'
            ? Boolean(uuService.getTakeoverEntry(sid)?.active)
            : lastMeta.takeoverActive;
          const pkt = packDirtyRectFrame({
            frameSeq: 0,
            fbWidth: evt.width || lastMeta.width || 1024,
            fbHeight: evt.height || lastMeta.height || 768,
            keyFrame: false,
            takeoverActive: tkActive,
            rects: evt.rects,
          });
          const ok = sendDirtyPacket(pkt);
          if (ok === false) {
            needFullKeyframe = true;
            scheduleNext(40);
          } else {
            lastFrameSentAtMs = now;
            lastMeta.width = evt.width || lastMeta.width;
            lastMeta.height = evt.height || lastMeta.height;
            lastMeta.takeoverActive = tkActive;
            if (now - lastTelemetryAtMs >= TELEMETRY_HEARTBEAT_MS) {
              emitTelemetry({
                unchanged: false,
                sessionId: sid,
                transport: lastMeta.transport,
                captureMs: 0,
                width: lastMeta.width,
                height: lastMeta.height,
                capabilities: lastMeta.capabilities,
                takeoverActive: tkActive,
              });
            }
          }
          return;
        }

        dirtySinceLastFrame = true;
        if (!paused && !inFlight) {
          const intervalMs = Math.round(1000 / Math.max(1, fps));
          const elapsed = nowFn() - lastFrameSentAtMs;
          scheduleNext(Math.max(5, intervalMs - elapsed));
        }
      });
    };

    const subscriber = {
      stop() {
        if (closed) return;
        closed = true;
        activeStreams.delete(subscriber);
        if (unsubscribeRfb) {
          try { unsubscribeRfb(); } catch {}
          unsubscribeRfb = null;
        }
        if (unsubscribeClipboard) {
          try { unsubscribeClipboard(); } catch {}
          unsubscribeClipboard = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (dirtyFlushTimer) {
          clearTimeout(dirtyFlushTimer);
          dirtyFlushTimer = null;
        }
      },
      nudge(sessionId = null, delayMs = 35) {
        if (closed) return;
        if (sessionId && targetSessionId && sessionId !== targetSessionId) return;
        if (usingDirtyRectStream) {
          const tk = typeof uuService.getTakeoverEntry === 'function'
            ? Boolean(uuService.getTakeoverEntry(targetSessionId)?.active)
            : lastMeta.takeoverActive;
          lastMeta.takeoverActive = tk;
          emitTelemetry({
            unchanged: true,
            sessionId: targetSessionId,
            transport: lastMeta.transport,
            captureMs: 0,
            width: lastMeta.width,
            height: lastMeta.height,
            capabilities: lastMeta.capabilities,
            takeoverActive: tk,
          });
          return;
        }
        forceSingleFrame = true;
        dirtySinceLastFrame = true;
        if (!inFlight) {
          scheduleNext(Math.max(10, delayMs));
        }
      },
    };
    activeStreams.add(subscriber);
    bindRfbSubscription(targetSessionId);

    streamSession.onClose?.(subscriber.stop);
    streamSession.signal?.addEventListener?.('abort', subscriber.stop, { once: true });

    let winDragStart = null;
    streamSession.onBinary?.((rawBuf) => {
      if (closed || !targetSessionId) return;
      const decoded = decodeClientBinaryInput(rawBuf);
      if (!decoded) return;
      if (typeof uuService.sendLiveRfbInput === 'function') {
        const handled = uuService.sendLiveRfbInput(targetSessionId, decoded, context);
        if (handled !== false) return;
      }
      // Fallback for non-RFB sessions (uu:<hwnd> / pve-qmp): map discrete down/up/wheel/key cleanly
      if (decoded.type === 'pointer') {
        if (decoded.op === 1) {
          winDragStart = { x: decoded.norm1000X, y: decoded.norm1000Y, buttonsMask: decoded.buttonsMask, clickCount: decoded.clickCount };
        } else if (decoded.op === 2 && winDragStart) {
          const start = winDragStart;
          winDragStart = null;
          const dist = Math.hypot(decoded.norm1000X - start.x, decoded.norm1000Y - start.y);
          const button = (start.buttonsMask & 4) ? 'right' : ((start.buttonsMask & 2) ? 'middle' : 'left');
          if (dist >= 12) {
            void performAction({
              action: 'input',
              sessionId: targetSessionId,
              subAction: 'drag',
              startX: start.x,
              startY: start.y,
              endX: decoded.norm1000X,
              endY: decoded.norm1000Y,
              button,
              fromHumanPanel: true,
            }, context).catch(() => {});
          } else {
            const subAction = button === 'right' ? 'right_click' : (start.clickCount >= 2 ? 'double_click' : 'click');
            void performAction({
              action: 'input',
              sessionId: targetSessionId,
              subAction,
              x: decoded.norm1000X,
              y: decoded.norm1000Y,
              button,
              count: start.clickCount,
              fromHumanPanel: true,
            }, context).catch(() => {});
          }
        }
      } else if (decoded.type === 'wheel') {
        void performAction({
          action: 'input',
          sessionId: targetSessionId,
          subAction: 'scroll',
          x: decoded.norm1000X,
          y: decoded.norm1000Y,
          deltaX: decoded.deltaX,
          deltaY: decoded.deltaY,
          fromHumanPanel: true,
        }, context).catch(() => {});
      } else if (decoded.type === 'key' && decoded.down) {
        const keyToken = decoded.key || decoded.code;
        if (keyToken) {
          void performAction({
            action: 'input',
            sessionId: targetSessionId,
            subAction: 'key',
            keys: [keyToken],
            fromHumanPanel: true,
          }, context).catch(() => {});
        }
      }
    });

    streamSession.onText?.((rawText) => {
      let msg;
      try {
        msg = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'requestKeyframe') {
        needFullKeyframe = true;
        coalescedBounds = null;
        if (!inFlight) scheduleNext(5);
        return;
      }
      if (msg.type === 'configure') {
        if (msg.sessionId && String(msg.sessionId) !== targetSessionId) {
          targetSessionId = String(msg.sessionId);
          cachedSession = null;
          lastTopoAt = 0;
          lastSentFrameHash = null;
          usingDirtyRectStream = false;
          needFullKeyframe = true;
          coalescedBounds = null;
          dirtySinceLastFrame = true;
          bindRfbSubscription(targetSessionId);
          if (!paused && !inFlight) scheduleNext(10);
        }
        if (Number.isFinite(msg.maxWidth)) maxWidth = Math.max(320, Math.min(2560, msg.maxWidth));
        if (Number.isFinite(msg.maxHeight)) maxHeight = Math.max(240, Math.min(1600, msg.maxHeight));
        if (Number.isFinite(msg.fps)) fps = Math.max(1, Math.min(30, msg.fps));
        if (typeof msg.paused === 'boolean') {
          paused = msg.paused;
          if (!paused && !inFlight) {
            if (usingDirtyRectStream && coalescedBounds) flushCoalescedDirtyBounds();
            else scheduleNext(15);
          }
        }
        return;
      }
      if (msg.type === 'nudge') {
        subscriber.nudge(msg.sessionId || targetSessionId, 20);
        return;
      }
      if (msg.type === 'input') {
        void performAction(
          {
            action: 'input',
            sessionId: msg.sessionId || targetSessionId,
            ...msg.payload,
            fromHumanPanel: true,
          },
          context,
        ).catch(() => {});
      }
    });

    const pumpFrame = async () => {
      if (closed) return;
      const intervalMs = Math.round(1000 / Math.max(1, fps));
      const runForced = forceSingleFrame || needFullKeyframe;
      if ((paused && !runForced) || inFlight) {
        scheduleNext(intervalMs);
        return;
      }
      forceSingleFrame = false;
      if (typeof streamSession.bufferedAmount === 'function' && streamSession.bufferedAmount() > MAX_BUFFERED_BYTES) {
        scheduleNext(intervalMs);
        return;
      }

      inFlight = true;
      const started = nowFn();
      const isRemote = isRemoteSessionId(targetSessionId);

      // Fast dirty-rect heartbeat & keyframe recovery path once active on RFB
      if (usingDirtyRectStream && !needFullKeyframe) {
        inFlight = false;
        if (coalescedBounds) {
          flushCoalescedDirtyBounds();
        }
        if (nowFn() - lastTelemetryAtMs >= TELEMETRY_HEARTBEAT_MS) {
          const capInfo = typeof uuService.getSessionTransportAndCapabilities === 'function'
            ? await uuService.getSessionTransportAndCapabilities(targetSessionId).catch(() => null)
            : null;
          const tk = typeof uuService.getTakeoverEntry === 'function'
            ? Boolean(uuService.getTakeoverEntry(targetSessionId)?.active)
            : lastMeta.takeoverActive;
          lastMeta.capabilities = capInfo?.capabilities || lastMeta.capabilities;
          lastMeta.takeoverActive = tk;
          emitTelemetry({
            unchanged: true,
            sessionId: targetSessionId,
            transport: capInfo?.transport || lastMeta.transport,
            captureMs: 0,
            width: lastMeta.width,
            height: lastMeta.height,
            capabilities: lastMeta.capabilities,
            takeoverActive: tk,
          });
        }
        scheduleNext(TELEMETRY_HEARTBEAT_MS);
        return;
      }

      const usingRfbPush = Boolean(
        cachedSession &&
        (cachedSession.transport === 'pve-rfb' || cachedSession.transport === 'rfb') &&
        lastSentFrameHash !== null &&
        !needFullKeyframe,
      );

      if (usingRfbPush && !dirtySinceLastFrame && !runForced) {
        inFlight = false;
        if (nowFn() - lastTelemetryAtMs >= TELEMETRY_HEARTBEAT_MS) {
          const capInfo = typeof uuService.getSessionTransportAndCapabilities === 'function'
            ? await uuService.getSessionTransportAndCapabilities(targetSessionId).catch(() => null)
            : null;
          emitTelemetry({
            unchanged: true,
            sessionId: targetSessionId,
            transport: capInfo?.transport || lastMeta.transport,
            captureMs: 0,
            width: lastMeta.width,
            height: lastMeta.height,
            capabilities: capInfo?.capabilities || lastMeta.capabilities,
            takeoverActive: lastMeta.takeoverActive,
          });
        }
        scheduleNext(Math.min(TELEMETRY_HEARTBEAT_MS, Math.max(250, TELEMETRY_HEARTBEAT_MS - (nowFn() - lastTelemetryAtMs))));
        return;
      }

      dirtySinceLastFrame = false;

      try {
        let session = cachedSession;
        const needTopoRefresh = !session
          || session.id !== targetSessionId
          || session.state !== 'active'
          || (!isRemote && started - lastTopoAt >= STREAM_TOPO_REFRESH_MS);
        if (needTopoRefresh) {
          const curTopo = await uuService.inspectTopology(context?.settings ?? {}, context);
          session = await uuService.resolveTargetSession(targetSessionId, curTopo, context);
          cachedSession = session;
          lastTopoAt = nowFn();
          bindRfbSubscription(session.id);
        }

        if (session.state === 'active') {
          // Try native RFB 0x02 dirty-rect keyframe stream first when supported
          if (
            allowDirtyRects &&
            (session.transport === 'pve-rfb' || session.transport === 'rfb') &&
            typeof uuService.buildRfbKeyframePacket === 'function'
          ) {
            const kf = await uuService.buildRfbKeyframePacket(session.id, { signal: streamSession.signal }).catch(() => null);
            if (kf?.packet) {
              const captureMs = Math.max(0, Math.round(nowFn() - started));
              const capInfo = typeof uuService.getSessionTransportAndCapabilities === 'function'
                ? await uuService.getSessionTransportAndCapabilities(session.id).catch(() => null)
                : null;
              const tkActive = typeof uuService.getTakeoverEntry === 'function'
                ? Boolean(uuService.getTakeoverEntry(session.id)?.active)
                : false;
              const sent = sendDirtyPacket(kf.packet);
              if (sent !== false) {
                usingDirtyRectStream = true;
                needFullKeyframe = false;
                coalescedBounds = null;
                lastFrameSentAtMs = nowFn();
                lastMeta = {
                  transport: capInfo?.transport || session.transport,
                  width: kf.width,
                  height: kf.height,
                  takeoverActive: tkActive,
                  capabilities: capInfo?.capabilities || kf.capabilities || null,
                };
                bindRfbSubscription(session.id);
                emitTelemetry({
                  unchanged: false,
                  sessionId: session.id,
                  transport: lastMeta.transport,
                  captureMs,
                  width: kf.width,
                  height: kf.height,
                  capabilities: lastMeta.capabilities,
                  takeoverActive: tkActive,
                });
                inFlight = false;
                scheduleNext(TELEMETRY_HEARTBEAT_MS);
                return;
              }
            }
          }

          usingDirtyRectStream = false;
          needFullKeyframe = false;

          const obs = await uuService.observeSession(
            session,
            { maxWidth, maxHeight, pngCompressionLevel: 1 },
            context,
          );
          const captureMs = Math.max(0, Math.round(nowFn() - started));
          const frameHash = obs.frameHash || hashPngOrSample(obs.pngBuffer);
          const transport = obs.transport || session.transport || 'uu-win32';
          if (cachedSession && cachedSession.transport !== transport) {
            cachedSession = { ...cachedSession, transport };
            bindRfbSubscription(session.id);
          }

          const capInfo = typeof uuService.getSessionTransportAndCapabilities === 'function'
            ? await uuService.getSessionTransportAndCapabilities(session.id).catch(() => null)
            : null;
          const capabilities = capInfo?.capabilities || null;

          lastMeta = {
            transport,
            width: obs.logicalSize.width,
            height: obs.logicalSize.height,
            takeoverActive: Boolean(obs.takeoverActive),
            capabilities,
          };

          if (!closed) {
            if (lastSentFrameHash && frameHash === lastSentFrameHash) {
              if (nowFn() - lastTelemetryAtMs >= TELEMETRY_HEARTBEAT_MS) {
                emitTelemetry({
                  unchanged: true,
                  sessionId: session.id,
                  transport,
                  captureMs,
                  width: obs.logicalSize.width,
                  height: obs.logicalSize.height,
                  capabilities,
                  takeoverActive: Boolean(obs.takeoverActive),
                });
              }
            } else {
              const packet = packStreamPngFrame(obs);
              const sent = streamSession.sendBinary(packet);
              if (sent === false) {
                inFlight = false;
                dirtySinceLastFrame = true;
                scheduleNext(intervalMs * 2);
                return;
              }
              lastSentFrameHash = frameHash;
              lastFrameSentAtMs = nowFn();
              emitTelemetry({
                unchanged: false,
                sessionId: session.id,
                transport,
                captureMs,
                width: obs.logicalSize.width,
                height: obs.logicalSize.height,
                capabilities,
                takeoverActive: Boolean(obs.takeoverActive),
              });
            }
          }
        } else if (!closed) {
          streamSession.sendText?.(
            JSON.stringify({
              type: 'sessionState',
              sessionId: session.id,
              state: session.state,
            }),
          );
        }
      } catch (error) {
        cachedSession = null;
        usingDirtyRectStream = false;
        lastTopoAt = 0;
        dirtySinceLastFrame = true;
        if (!closed) {
          streamSession.sendText?.(
            JSON.stringify({
              type: 'streamWarning',
              message: error?.message || String(error),
            }),
          );
        }
      } finally {
        inFlight = false;
      }

      const elapsed = nowFn() - started;
      const isActiveRfbPush = cachedSession && (cachedSession.transport === 'pve-rfb' || cachedSession.transport === 'rfb');
      if ((usingDirtyRectStream || isActiveRfbPush) && !dirtySinceLastFrame && !needFullKeyframe) {
        scheduleNext(TELEMETRY_HEARTBEAT_MS);
      } else {
        scheduleNext(Math.max(25, intervalMs - elapsed));
      }
    };

    scheduleNext(10);

    return {
      protocol: 'uu-png-stream-v1',
      dirtyRectSupported: allowDirtyRects,
      sessionId: initialSession.id,
      label: initialSession.label,
      transport: initialSession.transport || 'uu-win32',
      width: initialSession.canvasBounds.width,
      height: initialSession.canvasBounds.height,
    };
  }

  async function handlePanelRequest(action, args = {}, context = {}) {
    const body = args && typeof args === 'object' ? args : {};
    switch (action) {
      case 'state':
        return listState(body, context);
      case 'frame':
        return captureFrame(body, context);
      case 'action':
        return performAction(body, context);
      default:
        return { ok: false, error: `Unsupported panel action: ${String(action)}` };
    }
  }

  async function dispose() {
    for (const subscriber of [...activeStreams]) {
      subscriber.stop();
    }
    activeStreams.clear();
  }

  return {
    peekState,
    listState,
    captureFrame,
    performAction,
    openPanelStream,
    handlePanelRequest,
    dispose,
  };
}
