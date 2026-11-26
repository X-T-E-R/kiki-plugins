/**
 * Crisp nearest-neighbor pixel magnifier (2x-4x, default 3x) for dense 1024x768
 * CAD/PDM and desktop UIs inside narrow Kiki workspace side panels.
 * Activated via toolbar toggle button OR while holding `Alt` / Backquote (`).
 */

export function attachRemoteMagnifier(options = {}) {
  const stageEl = options.stageEl;
  const sourceCanvas = options.sourceCanvas;
  if (!stageEl || !sourceCanvas) {
    throw new Error('attachRemoteMagnifier requires stageEl and sourceCanvas');
  }

  const win = options.windowObj || (typeof window !== 'undefined' ? window : null);
  const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
  const zoomFactor = Math.min(4, Math.max(2, Number(options.zoomFactor) || 3));
  const lensSize = Number.isFinite(options.lensSize) ? options.lensSize : 168;
  const toggleBtn = options.toggleBtn || null;
  const enableAltHold = options.enableAltHold !== false;
  const enableBackquoteHold = options.enableBackquoteHold !== false;

  let pinned = false;
  let holdActive = false;
  let lastPointer = null;
  let disposed = false;

  let lensEl = options.lensEl || null;
  let lensCanvas = null;
  let lensCtx = null;
  let coordEl = null;
  let createdDom = false;

  if (!lensEl && doc && typeof doc.createElement === 'function') {
    lensEl = doc.createElement('div');
    lensEl.className = 'kiki-remote-magnifier';
    lensEl.hidden = true;
    if (lensEl.style) {
      lensEl.style.width = `${lensSize}px`;
      lensEl.style.height = `${lensSize}px`;
    }

    lensCanvas = doc.createElement('canvas');
    lensCanvas.width = lensSize;
    lensCanvas.height = lensSize;
    lensCanvas.className = 'kiki-remote-magnifier-canvas';
    lensCtx = lensCanvas.getContext?.('2d', { alpha: false }) || null;

    coordEl = doc.createElement('div');
    coordEl.className = 'kiki-remote-magnifier-meta';

    lensEl.append(lensCanvas, coordEl);
    stageEl.appendChild(lensEl);
    createdDom = true;
  }

  function isActive() {
    return pinned || holdActive;
  }

  function syncButtonState() {
    if (!toggleBtn) return;
    const on = isActive();
    toggleBtn.classList?.toggle?.('active', on);
    toggleBtn.setAttribute?.('aria-pressed', on ? 'true' : 'false');
  }

  function hideLens() {
    if (lensEl) lensEl.hidden = true;
  }

  function renderAt(projectedPt, clientEvent) {
    if (!lensEl || !lensCtx || !isActive() || !projectedPt || !projectedPt.inside) {
      hideLens();
      return;
    }
    const srcW = Number(sourceCanvas.width) || 0;
    const srcH = Number(sourceCanvas.height) || 0;
    if (srcW <= 0 || srcH <= 0) {
      hideLens();
      return;
    }

    const stageRect = stageEl.getBoundingClientRect();
    const cx = (Number(clientEvent?.clientX) || 0) - (Number(stageRect?.left) || 0);
    const cy = (Number(clientEvent?.clientY) || 0) - (Number(stageRect?.top) || 0);
    const margin = 10;
    const offset = 22;

    let left = cx + offset;
    let top = cy - lensSize - offset;
    if (left + lensSize + margin > stageRect.width) {
      left = Math.max(margin, cx - lensSize - offset);
    }
    if (top < margin) {
      top = Math.min(Math.max(margin, stageRect.height - lensSize - margin), cy + offset);
    }

    lensEl.hidden = false;
    if (lensEl.style) {
      lensEl.style.left = `${Math.round(left)}px`;
      lensEl.style.top = `${Math.round(top)}px`;
    }

    const sampleW = Math.max(8, Math.round(lensSize / zoomFactor));
    const sampleH = Math.max(8, Math.round(lensSize / zoomFactor));
    const centerSrcX = Math.round(projectedPt.normX * (srcW - 1));
    const centerSrcY = Math.round(projectedPt.normY * (srcH - 1));
    const sx = centerSrcX - Math.floor(sampleW / 2);
    const sy = centerSrcY - Math.floor(sampleH / 2);

    lensCtx.imageSmoothingEnabled = false;
    lensCtx.fillStyle = '#141413';
    lensCtx.fillRect(0, 0, lensSize, lensSize);

    const clampSx = Math.max(0, sx);
    const clampSy = Math.max(0, sy);
    const clampSw = Math.min(srcW - clampSx, sampleW - (clampSx - sx));
    const clampSh = Math.min(srcH - clampSy, sampleH - (clampSy - sy));
    if (clampSw > 0 && clampSh > 0) {
      const dx = (clampSx - sx) * zoomFactor;
      const dy = (clampSy - sy) * zoomFactor;
      const dw = clampSw * zoomFactor;
      const dh = clampSh * zoomFactor;
      lensCtx.drawImage(sourceCanvas, clampSx, clampSy, clampSw, clampSh, dx, dy, dw, dh);
    }

    // Crisp 1px center reticle
    const mid = Math.floor(lensSize / 2) + 0.5;
    lensCtx.strokeStyle = 'rgba(44, 94, 79, 0.92)';
    lensCtx.lineWidth = 1;
    lensCtx.beginPath();
    lensCtx.moveTo(mid - 12, mid);
    lensCtx.lineTo(mid - 3, mid);
    lensCtx.moveTo(mid + 3, mid);
    lensCtx.lineTo(mid + 12, mid);
    lensCtx.moveTo(mid, mid - 12);
    lensCtx.lineTo(mid, mid - 3);
    lensCtx.moveTo(mid, mid + 3);
    lensCtx.lineTo(mid, mid + 12);
    lensCtx.stroke();

    if (coordEl) {
      coordEl.textContent = `${zoomFactor}x · ${projectedPt.targetX}, ${projectedPt.targetY}`;
    }
  }

  function updateFromPointer(projectedPt, ev) {
    if (!projectedPt) {
      lastPointer = null;
      hideLens();
      return;
    }
    lastPointer = { projectedPt, ev };
    renderAt(projectedPt, ev);
  }

  function refresh() {
    if (lastPointer && isActive()) {
      renderAt(lastPointer.projectedPt, lastPointer.ev);
    }
  }

  function setPinned(next) {
    pinned = Boolean(next);
    syncButtonState();
    if (!isActive()) hideLens();
    else refresh();
    options.onToggle?.(isActive());
    return pinned;
  }

  const onToggleClick = () => {
    setPinned(!pinned);
  };

  const isEditable = () => {
    const tag = String(doc?.activeElement?.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const onKeyDown = (ev) => {
    if (disposed || !ev || isEditable()) return;
    if (enableAltHold && ev.key === 'Alt' && !ev.ctrlKey && !ev.metaKey && !holdActive) {
      holdActive = true;
      syncButtonState();
      refresh();
      return;
    }
    if (enableBackquoteHold && ev.code === 'Backquote' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !holdActive) {
      if (typeof options.allowBackquoteHold === 'function' && !options.allowBackquoteHold()) return;
      holdActive = true;
      syncButtonState();
      refresh();
    }
  };

  const onKeyUp = (ev) => {
    if (disposed || !ev || !holdActive) return;
    if ((enableAltHold && ev.key === 'Alt') || (enableBackquoteHold && ev.code === 'Backquote')) {
      holdActive = false;
      syncButtonState();
      if (!isActive()) hideLens();
    }
  };

  const onBlur = () => {
    if (holdActive) {
      holdActive = false;
      syncButtonState();
      if (!isActive()) hideLens();
    }
  };

  toggleBtn?.addEventListener?.('click', onToggleClick);
  win?.addEventListener?.('keydown', onKeyDown);
  win?.addEventListener?.('keyup', onKeyUp);
  win?.addEventListener?.('blur', onBlur);

  return {
    isActive,
    isPinned: () => pinned,
    setPinned,
    toggle: () => setPinned(!pinned),
    updateFromPointer,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      toggleBtn?.removeEventListener?.('click', onToggleClick);
      win?.removeEventListener?.('keydown', onKeyDown);
      win?.removeEventListener?.('keyup', onKeyUp);
      win?.removeEventListener?.('blur', onBlur);
      if (createdDom) lensEl?.remove?.();
    },
  };
}
