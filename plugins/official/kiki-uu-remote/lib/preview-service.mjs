const STREAM_MAGIC_0 = 0x55; // 'U'
const STREAM_MAGIC_1 = 0x52; // 'R'
const MAX_BUFFERED_BYTES = 1_500_000;

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

export function createUuPreviewService({ uuService, ensureProviderBus = async () => null } = {}) {
  const activeStreams = new Set();

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

    return {
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
  }

  async function captureFrame(args = {}, context = {}) {
    await ensureProviderBus(context);
    try {
      const shot = await uuService.controlSession(
        {
          sessionId: args.sessionId,
          action: 'screenshot',
          maxWidth: args.maxWidth ?? 1280,
          maxHeight: args.maxHeight ?? 800,
          autoTrimBlackBars: args.autoTrimBlackBars,
          remoteAspect: args.remoteAspect,
        },
        context,
      );
      return {
        ok: true,
        sessionId: shot.sessionId,
        label: shot.label,
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
    let fps = Math.max(1, Math.min(20, Number(args?.fps) || 10));
    let paused = false;
    let forceSingleFrame = false;
    let closed = false;
    let timer = null;
    let inFlight = false;

    const topo = await uuService.inspectTopology(context?.settings ?? {});
    const initialSession = await uuService.resolveTargetSession(targetSessionId, topo, context);
    targetSessionId = initialSession.id;

    const scheduleNext = (delayMs) => {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(pumpFrame, delayMs);
      timer.unref?.();
    };

    const subscriber = {
      stop() {
        if (closed) return;
        closed = true;
        activeStreams.delete(subscriber);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      nudge(sessionId = null, delayMs = 35) {
        if (closed) return;
        if (sessionId && targetSessionId && sessionId !== targetSessionId) return;
        forceSingleFrame = true;
        if (!inFlight) {
          scheduleNext(Math.max(10, delayMs));
        }
      },
    };
    activeStreams.add(subscriber);

    streamSession.onClose?.(subscriber.stop);
    streamSession.signal?.addEventListener?.('abort', subscriber.stop, { once: true });

    streamSession.onText?.((rawText) => {
      let msg;
      try {
        msg = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'configure') {
        if (msg.sessionId) targetSessionId = String(msg.sessionId);
        if (Number.isFinite(msg.maxWidth)) maxWidth = Math.max(320, Math.min(2560, msg.maxWidth));
        if (Number.isFinite(msg.maxHeight)) maxHeight = Math.max(240, Math.min(1600, msg.maxHeight));
        if (Number.isFinite(msg.fps)) fps = Math.max(1, Math.min(20, msg.fps));
        if (typeof msg.paused === 'boolean') {
          paused = msg.paused;
          if (!paused && !inFlight) scheduleNext(15);
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
      const runForced = forceSingleFrame;
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
      const started = Date.now();
      try {
        const curTopo = await uuService.inspectTopology(context?.settings ?? {});
        const session = await uuService.resolveTargetSession(targetSessionId, curTopo, context);
        if (session.state === 'active') {
          const obs = await uuService.observeSession(
            session,
            { maxWidth, maxHeight, pngCompressionLevel: 1 },
            context,
          );
          if (!closed) {
            const packet = packStreamPngFrame(obs);
            const sent = streamSession.sendBinary(packet);
            if (sent === false) {
              // Backpressure signaled by host; yield an extra frame interval.
              inFlight = false;
              scheduleNext(intervalMs * 2);
              return;
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

      const elapsed = Date.now() - started;
      scheduleNext(Math.max(25, intervalMs - elapsed));
    };

    scheduleNext(10);

    return {
      protocol: 'uu-png-stream-v1',
      sessionId: initialSession.id,
      label: initialSession.label,
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
    listState,
    captureFrame,
    performAction,
    openPanelStream,
    handlePanelRequest,
    dispose,
  };
}
