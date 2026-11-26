/**
 * Unified normalized pointer engine for Kiki remote panels.
 * - Zero artificial single-click timer delay (immediate pointerdown clickCount with 500ms / 4px slop)
 * - <= 60 Hz requestAnimationFrame coalescing for pointermove & wheel
 * - Never drops discrete pointerdown / pointerup state transitions
 * - Optional Ctrl/Alt + Left-Drag two-finger virtual pinch-zoom reflected across screen center
 */

export function computeRemoteContainedRect(boxWidth, boxHeight, contentWidth, contentHeight, zoom = 1, panX = 0, panY = 0) {
  const cw = Math.max(1, Number(boxWidth) || 1);
  const ch = Math.max(1, Number(boxHeight) || 1);
  const iw = Math.max(1, Number(contentWidth) || cw);
  const ih = Math.max(1, Number(contentHeight) || ch);
  const z = Math.min(8, Math.max(1, Number(zoom) || 1));
  const baseScale = Math.min(cw / iw, ch / ih);
  const width = Math.max(1, iw * baseScale * z);
  const height = Math.max(1, ih * baseScale * z);
  return {
    x: (cw - width) / 2 + (Number(panX) || 0),
    y: (ch - height) / 2 + (Number(panY) || 0),
    width,
    height,
    scale: baseScale * z,
    zoom: z,
  };
}

export function projectRemotePoint(clientX, clientY, surfaceRect, logicalSize, viewport = {}) {
  const cw = Math.max(1, Number(surfaceRect?.width) || 1);
  const ch = Math.max(1, Number(surfaceRect?.height) || 1);
  const lw = Math.max(1, Math.round(Number(logicalSize?.width) || 1080));
  const lh = Math.max(1, Math.round(Number(logicalSize?.height) || 1920));
  const box = computeRemoteContainedRect(
    cw,
    ch,
    lw,
    lh,
    viewport.zoom || 1,
    viewport.panX || 0,
    viewport.panY || 0,
  );
  const offX = (Number(clientX) || 0) - (Number(surfaceRect?.left) || 0);
  const offY = (Number(clientY) || 0) - (Number(surfaceRect?.top) || 0);
  const inside = offX >= box.x - 1.5
    && offX <= box.x + box.width + 1.5
    && offY >= box.y - 1.5
    && offY <= box.y + box.height + 1.5;
  const normX = Math.min(1, Math.max(0, (offX - box.x) / Math.max(1e-6, box.width)));
  const normY = Math.min(1, Math.max(0, (offY - box.y) / Math.max(1e-6, box.height)));
  const targetX = lw <= 1 ? 0 : Math.min(lw - 1, Math.max(0, Math.round(normX * (lw - 1))));
  const targetY = lh <= 1 ? 0 : Math.min(lh - 1, Math.max(0, Math.round(normY * (lh - 1))));
  const clampedOffX = Math.max(box.x, Math.min(box.x + box.width, offX));
  const clampedOffY = Math.max(box.y, Math.min(box.y + box.height, offY));

  return {
    inside,
    normX,
    normY,
    norm1000X: Math.round(normX * 1000),
    norm1000Y: Math.round(normY * 1000),
    targetX,
    targetY,
    localX: clampedOffX,
    localY: clampedOffY,
    pctX: (clampedOffX / cw) * 100,
    pctY: (clampedOffY / ch) * 100,
    svgX: (clampedOffX / cw) * 1000,
    svgY: (clampedOffY / ch) * 1000,
    pxX: offX,
    pxY: offY,
    box,
  };
}

export function computeVirtualPinchPair(normX, normY, anchorX = 0.5, anchorY = 0.5) {
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const px = clamp01(normX);
  const py = clamp01(normY);
  const ax = clamp01(anchorX);
  const ay = clamp01(anchorY);
  return {
    primary: { normX: px, normY: py, slot: 0 },
    secondary: {
      normX: clamp01(2 * ax - px),
      normY: clamp01(2 * ay - py),
      slot: 1,
    },
    anchor: { normX: ax, normY: ay },
  };
}

export function attachRemotePointer(surfaceEl, options = {}) {
  if (!surfaceEl || typeof surfaceEl.addEventListener !== 'function') {
    throw new Error('attachRemotePointer requires a valid DOM element');
  }

  const win = options.windowObj || (typeof window !== 'undefined' ? window : null);
  const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
  const raf = (win && typeof win.requestAnimationFrame === 'function')
    ? win.requestAnimationFrame.bind(win)
    : (fn) => setTimeout(fn, 16);
  const caf = (win && typeof win.cancelAnimationFrame === 'function')
    ? win.cancelAnimationFrame.bind(win)
    : (id) => clearTimeout(id);
  const nowFn = options.nowFn || (() => Date.now());

  const multiClickMs = Number.isFinite(options.multiClickMs) ? options.multiClickMs : 500;
  const multiClickSlopPx = Number.isFinite(options.multiClickSlopPx) ? options.multiClickSlopPx : 4;
  const enableVirtualPinch = Boolean(options.enableVirtualPinch);
  const pinchAllowAlt = Boolean(options.pinchAllowAlt);
  const emitHoverMove = options.emitHoverMove !== false;

  let activePointer = null;
  let lastClick = { time: 0, x: -999, y: -999, button: -1, count: 0 };
  let moveRafId = 0;
  let pendingMovePayload = null;
  let wheelRafId = 0;
  let wheelAccX = 0;
  let wheelAccY = 0;
  let wheelAnchor = null;
  let disposed = false;

  const getLogicalSize = () => (typeof options.getLogicalSize === 'function'
    ? options.getLogicalSize()
    : { width: 1080, height: 1920 });
  const getViewport = () => (typeof options.getViewport === 'function'
    ? options.getViewport()
    : { zoom: 1, panX: 0, panY: 0 });
  const isInteractive = () => (typeof options.isInteractive === 'function' ? Boolean(options.isInteractive()) : true);
  const isDisabled = () => (typeof options.isDisabled === 'function' ? Boolean(options.isDisabled()) : false);

  function mapEvent(ev) {
    const rect = surfaceEl.getBoundingClientRect();
    return projectRemotePoint(ev.clientX, ev.clientY, rect, getLogicalSize(), getViewport());
  }

  function buttonMaskFromEvent(ev, fallbackButton) {
    if (typeof ev.buttons === 'number' && ev.buttons > 0) {
      let mask = 0;
      if (ev.buttons & 1) mask |= 1; // Left
      if (ev.buttons & 4) mask |= 2; // Middle -> RFB bit 1 / standard bitmask
      if (ev.buttons & 2) mask |= 4; // Right -> RFB bit 2
      return mask;
    }
    if (fallbackButton === 2) return 4;
    if (fallbackButton === 1) return 2;
    if (fallbackButton === 0) return 1;
    return 0;
  }

  function buttonName(btn) {
    if (btn === 2) return 'right';
    if (btn === 1) return 'middle';
    return 'left';
  }

  function flushMoveNow() {
    if (moveRafId) {
      caf(moveRafId);
      moveRafId = 0;
    }
    const payload = pendingMovePayload;
    pendingMovePayload = null;
    if (!payload) return;
    if (payload.pinch) {
      options.onPinch?.(payload.pinch);
    } else {
      options.onPointerMove?.(payload.point, payload.meta);
    }
  }

  function flushWheelNow() {
    if (wheelRafId) {
      caf(wheelRafId);
      wheelRafId = 0;
    }
    const dx = wheelAccX;
    const dy = wheelAccY;
    const pt = wheelAnchor;
    wheelAccX = 0;
    wheelAccY = 0;
    wheelAnchor = null;
    if (!pt || (dx === 0 && dy === 0)) return;
    options.onWheel?.(pt, { deltaX: dx, deltaY: dy });
  }

  const onContextMenu = (ev) => {
    ev.preventDefault?.();
  };

  const onPointerDown = (ev) => {
    if (disposed || isDisabled()) return;
    if (!isInteractive()) {
      options.onReadOnlyAttempt?.(ev);
      return;
    }
    const pt = mapEvent(ev);
    if (!pt.inside) return;

    try {
      if (typeof options.focusTarget === 'function') options.focusTarget();
      else surfaceEl.focus?.({ preventScroll: true });
    } catch {}
    try {
      surfaceEl.setPointerCapture?.(ev.pointerId);
    } catch {}

    const now = nowFn();
    const dist = Math.hypot((ev.clientX || 0) - lastClick.x, (ev.clientY || 0) - lastClick.y);
    const clickCount = (ev.button === lastClick.button && now - lastClick.time <= multiClickMs && dist <= multiClickSlopPx)
      ? Math.min(3, lastClick.count + 1)
      : 1;
    lastClick = { time: now, x: ev.clientX || 0, y: ev.clientY || 0, button: ev.button, count: clickCount };

    const isPinch = enableVirtualPinch
      && ev.button === 0
      && Boolean(ev.ctrlKey || (pinchAllowAlt && ev.altKey));

    const mask = buttonMaskFromEvent(ev, ev.button);
    activePointer = {
      pointerId: ev.pointerId,
      button: ev.button,
      buttonName: buttonName(ev.button),
      buttonsMask: mask,
      clickCount,
      startPt: pt,
      lastPt: pt,
      startedAt: now,
      moved: false,
      isPinch,
      pinchAnchor: { normX: 0.5, normY: 0.5 },
    };

    options.onCursorLocal?.(pt, { active: true, isPinch });

    if (isPinch) {
      const pair = computeVirtualPinchPair(pt.normX, pt.normY, 0.5, 0.5);
      options.onPinch?.({ phase: 'down', ...pair, point: pt });
      return;
    }

    options.onPointerDown?.(pt, {
      button: activePointer.buttonName,
      buttonsMask: mask,
      clickCount,
      ctrlKey: Boolean(ev.ctrlKey),
      shiftKey: Boolean(ev.shiftKey),
      altKey: Boolean(ev.altKey),
      metaKey: Boolean(ev.metaKey),
      originalEvent: ev,
    });
  };

  const onPointerMove = (ev) => {
    if (disposed || isDisabled()) return;
    const pt = mapEvent(ev);
    options.onMagnifierMove?.(pt, ev);

    if (!isInteractive()) return;
    if (pt.inside || activePointer) {
      options.onCursorLocal?.(pt, { active: Boolean(activePointer), isPinch: Boolean(activePointer?.isPinch) });
    } else {
      options.onCursorLocal?.(null, { active: false, isPinch: false });
    }

    if (activePointer && activePointer.pointerId === ev.pointerId) {
      activePointer.lastPt = pt;
      const movedDist = Math.hypot(pt.pxX - activePointer.startPt.pxX, pt.pxY - activePointer.startPt.pxY);
      if (movedDist >= 5) {
        activePointer.moved = true;
      }
      if (activePointer.isPinch) {
        const pair = computeVirtualPinchPair(pt.normX, pt.normY, activePointer.pinchAnchor.normX, activePointer.pinchAnchor.normY);
        pendingMovePayload = { pinch: { phase: 'move', ...pair, point: pt } };
      } else {
        const mask = buttonMaskFromEvent(ev, activePointer.button) || activePointer.buttonsMask;
        pendingMovePayload = {
          point: pt,
          meta: {
            dragging: true,
            moved: activePointer.moved,
            button: activePointer.buttonName,
            buttonsMask: mask,
            startPt: activePointer.startPt,
          },
        };
      }
      if (!moveRafId) {
        moveRafId = raf(flushMoveNow);
      }
      return;
    }

    if (!activePointer && emitHoverMove && pt.inside) {
      pendingMovePayload = {
        point: pt,
        meta: {
          dragging: false,
          moved: false,
          button: 'none',
          buttonsMask: 0,
          startPt: null,
        },
      };
      if (!moveRafId) {
        moveRafId = raf(flushMoveNow);
      }
    }
  };

  const finishPointer = (ev, cancelled) => {
    if (!activePointer || (ev && activePointer.pointerId !== ev.pointerId)) return;
    const stateSnapshot = activePointer;
    activePointer = null;

    if (!cancelled) {
      flushMoveNow();
    } else if (moveRafId) {
      caf(moveRafId);
      moveRafId = 0;
      pendingMovePayload = null;
    }

    const pt = ev ? mapEvent(ev) : stateSnapshot.lastPt;
    if (stateSnapshot.moved) {
      lastClick = { time: 0, x: -999, y: -999, button: -1, count: 0 };
    }
    if (stateSnapshot.isPinch) {
      const pair = computeVirtualPinchPair(pt.normX, pt.normY, stateSnapshot.pinchAnchor.normX, stateSnapshot.pinchAnchor.normY);
      options.onPinch?.({ phase: cancelled ? 'cancel' : 'up', ...pair, point: pt });
      return;
    }

    const remainingMask = (!cancelled && ev && typeof ev.buttons === 'number')
      ? buttonMaskFromEvent(ev, -1)
      : 0;

    options.onPointerUp?.(pt, {
      cancelled: Boolean(cancelled),
      moved: stateSnapshot.moved,
      button: stateSnapshot.buttonName,
      buttonsMask: remainingMask,
      clickCount: stateSnapshot.clickCount,
      startPt: stateSnapshot.startPt,
      elapsedMs: Math.max(0, nowFn() - stateSnapshot.startedAt),
      ctrlKey: Boolean(ev?.ctrlKey),
      shiftKey: Boolean(ev?.shiftKey),
      altKey: Boolean(ev?.altKey),
      metaKey: Boolean(ev?.metaKey),
      originalEvent: ev,
    });
  };

  const onPointerUp = (ev) => finishPointer(ev, false);
  const onPointerCancel = (ev) => finishPointer(ev, true);
  const onPointerLeave = (ev) => {
    options.onMagnifierMove?.(null, ev);
    if (!activePointer) {
      options.onCursorLocal?.(null, { active: false, isPinch: false });
    }
  };

  const onWheel = (ev) => {
    if (disposed || isDisabled()) return;
    if (!isInteractive()) {
      ev.preventDefault?.();
      options.onReadOnlyAttempt?.(ev);
      return;
    }
    const pt = mapEvent(ev);
    if (!pt.inside) return;
    ev.preventDefault?.();
    wheelAccX += Number(ev.deltaX) || 0;
    wheelAccY += Number(ev.deltaY) || 0;
    wheelAnchor = pt;
    if (!wheelRafId) {
      wheelRafId = raf(flushWheelNow);
    }
  };

  const releaseActive = () => {
    if (activePointer) {
      finishPointer(null, true);
    }
    options.onReleaseAll?.();
  };

  const onVisibility = () => {
    if (doc && doc.hidden) releaseActive();
  };

  surfaceEl.addEventListener('contextmenu', onContextMenu);
  surfaceEl.addEventListener('pointerdown', onPointerDown);
  surfaceEl.addEventListener('pointermove', onPointerMove);
  surfaceEl.addEventListener('pointerup', onPointerUp);
  surfaceEl.addEventListener('pointercancel', onPointerCancel);
  surfaceEl.addEventListener('pointerleave', onPointerLeave);
  surfaceEl.addEventListener('wheel', onWheel, { passive: false });
  win?.addEventListener?.('blur', releaseActive);
  doc?.addEventListener?.('visibilitychange', onVisibility);

  return {
    mapEvent,
    releaseActive,
    isPinching: () => Boolean(activePointer?.isPinch),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (moveRafId) caf(moveRafId);
      if (wheelRafId) caf(wheelRafId);
      surfaceEl.removeEventListener('contextmenu', onContextMenu);
      surfaceEl.removeEventListener('pointerdown', onPointerDown);
      surfaceEl.removeEventListener('pointermove', onPointerMove);
      surfaceEl.removeEventListener('pointerup', onPointerUp);
      surfaceEl.removeEventListener('pointercancel', onPointerCancel);
      surfaceEl.removeEventListener('pointerleave', onPointerLeave);
      surfaceEl.removeEventListener('wheel', onWheel);
      win?.removeEventListener?.('blur', releaseActive);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
    },
  };
}
