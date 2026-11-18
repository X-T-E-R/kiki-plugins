import { COORDINATE_MODES } from './definitions.mjs';

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function assertCoordinateMode(mode = 'normalized_1000') {
  const normalized = mode || 'normalized_1000';
  if (!COORDINATE_MODES.includes(normalized)) {
    throw new Error(`Unsupported coordinateMode: ${String(mode)}`);
  }
  return normalized;
}

export function computeScaledDimensions(sourceWidth, sourceHeight, maxWidth = 1280, maxHeight = 900) {
  const sw = Math.max(1, Math.round(Number(sourceWidth) || 1));
  const sh = Math.max(1, Math.round(Number(sourceHeight) || 1));
  const mw = maxWidth ? Math.max(1, Math.round(Number(maxWidth))) : sw;
  const mh = maxHeight ? Math.max(1, Math.round(Number(maxHeight))) : sh;

  const scale = Math.min(1, mw / sw, mh / sh);
  if (scale >= 1) {
    return { width: sw, height: sh, scale: 1 };
  }
  return {
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
    scale,
  };
}

/**
 * Resolve a zoom request in the given coordinateMode into integer target_pixels cropBounds
 * ({ x, y, width, height }) clamped inside logicalSize, BEFORE any downscaling occurs.
 */
export function resolveZoomCropBounds(zoom, {
  coordinateMode = 'normalized_1000',
  logicalSize,
  lastObservation = null,
} = {}) {
  if (!zoom || typeof zoom !== 'object') return null;
  const mode = assertCoordinateMode(coordinateMode);
  const targetW = Math.max(1, Math.round(Number(logicalSize?.width) || 1));
  const targetH = Math.max(1, Math.round(Number(logicalSize?.height) || 1));

  const rx = Number(zoom.x);
  const ry = Number(zoom.y);
  const rw = Number(zoom.width);
  const rh = Number(zoom.height);
  if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) {
    throw new Error('zoom requires finite positive width and height plus finite x and y');
  }

  let rawX;
  let rawY;
  let rawW;
  let rawH;

  if (mode === 'normalized_1000') {
    rawX = (rx / 1000) * targetW;
    rawY = (ry / 1000) * targetH;
    rawW = (rw / 1000) * targetW;
    rawH = (rh / 1000) * targetH;
  } else if (mode === 'normalized_01') {
    rawX = rx * targetW;
    rawY = ry * targetH;
    rawW = rw * targetW;
    rawH = rh * targetH;
  } else if (mode === 'target_pixels') {
    rawX = rx;
    rawY = ry;
    rawW = rw;
    rawH = rh;
  } else {
    const prevBase = lastObservation?.cropBounds || { x: 0, y: 0, width: targetW, height: targetH };
    const imgW = Math.max(1, Number(lastObservation?.imageSize?.width) || prevBase.width);
    const imgH = Math.max(1, Number(lastObservation?.imageSize?.height) || prevBase.height);
    rawX = prevBase.x + (rx / imgW) * prevBase.width;
    rawY = prevBase.y + (ry / imgH) * prevBase.height;
    rawW = (rw / imgW) * prevBase.width;
    rawH = (rh / imgH) * prevBase.height;
  }

  const x = clamp(Math.round(rawX), 0, Math.max(0, targetW - 1));
  const y = clamp(Math.round(rawY), 0, Math.max(0, targetH - 1));
  const width = clamp(Math.round(rawW), 1, Math.max(1, targetW - x));
  const height = clamp(Math.round(rawH), 1, Math.max(1, targetH - y));

  return { x, y, width, height };
}

/**
 * Convert an input coordinate (x, y) in `coordinateMode` (with optional `zoomRelative`)
 * into:
 * - targetX, targetY: 0-based integer pixel coordinates inside logicalSize
 * - screenX, screenY: physical virtual-desktop pixel coordinates (targetOrigin + targetXY, supporting negative X/Y)
 * - normX, normY: full-target normalized_1000 coordinates (0..1000)
 */
export function resolveTargetPoint(x, y, {
  coordinateMode = 'normalized_1000',
  zoomRelative = false,
  logicalSize,
  targetOrigin = { x: 0, y: 0 },
  lastObservation = null,
} = {}) {
  const mode = assertCoordinateMode(coordinateMode);
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    throw new Error(`Invalid action coordinates: (${String(x)}, ${String(y)})`);
  }

  const targetW = Math.max(1, Math.round(Number(logicalSize?.width) || 1));
  const targetH = Math.max(1, Math.round(Number(logicalSize?.height) || 1));

  const cropBounds = lastObservation?.cropBounds || null;
  if (zoomRelative && !cropBounds) {
    throw new Error('zoomRelative=true requires a prior zoomed cua_observe on this target');
  }

  const refRect = zoomRelative && cropBounds
    ? cropBounds
    : { x: 0, y: 0, width: targetW, height: targetH };

  let localX;
  let localY;

  if (mode === 'normalized_1000') {
    const u = clamp(px / 1000, 0, 1);
    const v = clamp(py / 1000, 0, 1);
    localX = refRect.x + Math.round(u * Math.max(0, refRect.width - 1));
    localY = refRect.y + Math.round(v * Math.max(0, refRect.height - 1));
  } else if (mode === 'normalized_01') {
    const u = clamp(px, 0, 1);
    const v = clamp(py, 0, 1);
    localX = refRect.x + Math.round(u * Math.max(0, refRect.width - 1));
    localY = refRect.y + Math.round(v * Math.max(0, refRect.height - 1));
  } else if (mode === 'target_pixels') {
    localX = clamp(refRect.x + Math.round(px), refRect.x, refRect.x + Math.max(0, refRect.width - 1));
    localY = clamp(refRect.y + Math.round(py), refRect.y, refRect.y + Math.max(0, refRect.height - 1));
  } else {
    const activeObsBase = (!zoomRelative && cropBounds)
      ? { x: 0, y: 0, width: targetW, height: targetH }
      : refRect;
    const imgW = (zoomRelative || !cropBounds) && lastObservation?.imageSize?.width
      ? Math.max(1, Number(lastObservation.imageSize.width))
      : activeObsBase.width;
    const imgH = (zoomRelative || !cropBounds) && lastObservation?.imageSize?.height
      ? Math.max(1, Number(lastObservation.imageSize.height))
      : activeObsBase.height;
    const u = clamp(px / Math.max(1, imgW - 1), 0, 1);
    const v = clamp(py / Math.max(1, imgH - 1), 0, 1);
    localX = activeObsBase.x + Math.round(u * Math.max(0, activeObsBase.width - 1));
    localY = activeObsBase.y + Math.round(v * Math.max(0, activeObsBase.height - 1));
  }

  const targetX = clamp(localX, 0, Math.max(0, targetW - 1));
  const targetY = clamp(localY, 0, Math.max(0, targetH - 1));
  const originX = Math.round(Number(targetOrigin?.x) || 0);
  const originY = Math.round(Number(targetOrigin?.y) || 0);
  const screenX = originX + targetX;
  const screenY = originY + targetY;
  const normX = targetW <= 1 ? 0 : Math.round((targetX / (targetW - 1)) * 1000);
  const normY = targetH <= 1 ? 0 : Math.round((targetY / (targetH - 1)) * 1000);

  return {
    targetX,
    targetY,
    screenX,
    screenY,
    normX,
    normY,
  };
}

export function targetPixelsToNormalized1000(targetX, targetY, logicalSize) {
  const targetW = Math.max(1, Math.round(Number(logicalSize?.width) || 1));
  const targetH = Math.max(1, Math.round(Number(logicalSize?.height) || 1));
  return {
    normX: targetW <= 1 ? 0 : clamp(Math.round((targetX / (targetW - 1)) * 1000), 0, 1000),
    normY: targetH <= 1 ? 0 : clamp(Math.round((targetY / (targetH - 1)) * 1000), 0, 1000),
  };
}

/**
 * Exact Win32 SendInput MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK normalization
 * using Int64 (BigInt) arithmetic and (vw - 1) / (vh - 1) fence-post denominator with
 * half-divisor rounding so negative multi-monitor coordinates never drift by 1px across seams.
 */
export function computeWin32VirtualDeskCoords(screenX, screenY, virtualScreen) {
  const vx = BigInt(Math.round(Number(virtualScreen?.x) || 0));
  const vy = BigInt(Math.round(Number(virtualScreen?.y) || 0));
  const vw = BigInt(Math.max(1, Math.round(Number(virtualScreen?.width) || 1)));
  const vh = BigInt(Math.max(1, Math.round(Number(virtualScreen?.height) || 1)));

  const sx = BigInt(Math.round(Number(screenX) || 0));
  const sy = BigInt(Math.round(Number(screenY) || 0));

  const denomX = vw > 1n ? vw - 1n : 1n;
  const denomY = vh > 1n ? vh - 1n : 1n;

  const rawDx = ((sx - vx) * 65535n + denomX / 2n) / denomX;
  const rawDy = ((sy - vy) * 65535n + denomY / 2n) / denomY;

  const clampedDx = rawDx < 0n ? 0n : (rawDx > 65535n ? 65535n : rawDx);
  const clampedDy = rawDy < 0n ? 0n : (rawDy > 65535n ? 65535n : rawDy);

  return {
    dx: Number(clampedDx),
    dy: Number(clampedDy),
  };
}

/**
 * Inverse mapping reproducing how Windows kernel maps SendInput (dx, dy) in 0..65535
 * back onto the virtual desktop pixel grid [vx .. vx + vw - 1] x [vy .. vy + vh - 1].
 */
export function invertWin32VirtualDeskCoords(dx, dy, virtualScreen) {
  const vx = BigInt(Math.round(Number(virtualScreen?.x) || 0));
  const vy = BigInt(Math.round(Number(virtualScreen?.y) || 0));
  const vw = BigInt(Math.max(1, Math.round(Number(virtualScreen?.width) || 1)));
  const vh = BigInt(Math.max(1, Math.round(Number(virtualScreen?.height) || 1)));

  const denomX = vw > 1n ? vw - 1n : 1n;
  const denomY = vh > 1n ? vh - 1n : 1n;

  const sx = vx + (BigInt(Math.round(dx)) * denomX + 32767n) / 65535n;
  const sy = vy + (BigInt(Math.round(dy)) * denomY + 32767n) / 65535n;

  return {
    screenX: Number(sx),
    screenY: Number(sy),
  };
}

/**
 * Map a batch of CUA actions into resolved target_pixels & physical screen_pixels.
 */
export function resolveActionsGeometry(actions, geometryContext) {
  let lastPoint = null;
  const resolved = actions.map((raw) => {
    const item = { ...raw };
    const itemContext = (item._coordinateModeOverride || item._zoomRelativeOverride !== undefined)
      ? {
          ...geometryContext,
          ...(item._coordinateModeOverride ? { coordinateMode: item._coordinateModeOverride } : {}),
          ...(item._zoomRelativeOverride !== undefined ? { zoomRelative: item._zoomRelativeOverride } : {}),
        }
      : geometryContext;
    if (['click', 'move', 'scroll'].includes(item.kind) || ((item.kind === 'mouse_down' || item.kind === 'mouse_up') && item.x !== undefined && item.y !== undefined)) {
      const pt = resolveTargetPoint(item.x, item.y, itemContext);
      item.resolvedPoint = pt;
      lastPoint = { x: pt.targetX, y: pt.targetY, screenX: pt.screenX, screenY: pt.screenY, normX: pt.normX, normY: pt.normY };
    } else if (item.kind === 'drag') {
      const start = resolveTargetPoint(item.startX, item.startY, itemContext);
      const end = resolveTargetPoint(item.endX, item.endY, itemContext);
      item.resolvedStart = start;
      item.resolvedEnd = end;
      lastPoint = {
        x: end.targetX,
        y: end.targetY,
        screenX: end.screenX,
        screenY: end.screenY,
        normX: end.normX,
        normY: end.normY,
        startNormX: start.normX,
        startNormY: start.normY,
      };
    }
    return item;
  });
  return { actions: resolved, lastPoint };
}
