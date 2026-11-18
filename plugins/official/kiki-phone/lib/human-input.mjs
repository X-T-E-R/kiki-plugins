const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function sampleGaussian(mean = 0, std = 1, rng = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Truncated Gaussian sampling within the central safe core of a bounding box.
 * Default insetRatio=0.28 restricts points to the inner 44%x44% core to prevent edge mis-taps,
 * while maxOffsetPx=96 caps spread on wide full-row containers so side controls are never hit.
 */
export function samplePointInBox(bounds, { insetRatio = 0.28, sigmaRatio = 0.12, maxOffsetPx = 96, rng = Math.random } = {}) {
  const x = Number(bounds?.x ?? bounds?.left) || 0;
  const y = Number(bounds?.y ?? bounds?.top) || 0;
  const w = Math.max(0, Number(bounds?.width ?? (bounds?.right !== undefined ? Number(bounds.right) - x : 0)) || 0);
  const h = Math.max(0, Number(bounds?.height ?? (bounds?.bottom !== undefined ? Number(bounds.bottom) - y : 0)) || 0);
  const inset = clamp(insetRatio, 0, 0.45);
  const cx = x + w / 2;
  const cy = y + h / 2;
  let minX = Math.ceil(x + w * inset);
  let maxX = Math.floor(x + w * (1 - inset));
  let minY = Math.ceil(y + h * inset);
  let maxY = Math.floor(y + h * (1 - inset));
  const cap = Number(maxOffsetPx);
  const hasCap = Number.isFinite(cap) && cap > 0;
  if (hasCap) {
    minX = Math.max(minX, Math.ceil(cx - cap));
    maxX = Math.min(maxX, Math.floor(cx + cap));
    minY = Math.max(minY, Math.ceil(cy - cap));
    maxY = Math.min(maxY, Math.floor(cy + cap));
  }
  const stdX = hasCap ? Math.min(Math.max(1, w * sigmaRatio), Math.max(1, cap * 0.55)) : Math.max(1, w * sigmaRatio);
  const stdY = hasCap ? Math.min(Math.max(1, h * sigmaRatio), Math.max(1, cap * 0.55)) : Math.max(1, h * sigmaRatio);
  const px = minX <= maxX ? Math.round(clamp(sampleGaussian(cx, stdX, rng), minX, maxX)) : Math.round(cx);
  const py = minY <= maxY ? Math.round(clamp(sampleGaussian(cy, stdY, rng), minY, maxY)) : Math.round(cy);
  return { x: px, y: py };
}

/**
 * Build two-frame tap gesture: 55-125ms right-skewed log-normal dwell + <=1px fingertip micro-roll.
 */
export function buildHumanTapKeyframes(point, { holdMs, screenWidth = 1080, screenHeight = 2400, rng = Math.random } = {}) {
  const sw = Math.max(1, Math.round(Number(screenWidth) || 1080));
  const sh = Math.max(1, Math.round(Number(screenHeight) || 2400));
  const minX = sw > 2 ? 1 : 0;
  const minY = sh > 2 ? 1 : 0;
  const maxX = sw > 2 ? sw - 2 : sw - 1;
  const maxY = sh > 2 ? sh - 2 : sh - 1;
  const x0 = clamp(Math.round(Number(point?.x) || 0), minX, maxX);
  const y0 = clamp(Math.round(Number(point?.y) || 0), minY, maxY);
  const rawHold = holdMs ?? Math.exp(Math.log(80) + sampleGaussian(0, 0.19, rng));
  const duration = Math.round(clamp(rawHold, 55, 125));
  const x1 = clamp(x0 + Math.round(clamp(sampleGaussian(0, 0.76, rng), -1, 1)), minX, maxX);
  const y1 = clamp(y0 + Math.round(clamp(sampleGaussian(0, 0.76, rng), -1, 1)), minY, maxY);
  return {
    x: x0,
    y: y0,
    holdMs: duration,
    points: [
      { x: x0, y: y0, time: 0 },
      { x: x1, y: y1, time: duration },
    ],
  };
}

/**
 * Build curved swipe keyframes:
 * - Single-arch cubic Bezier (arch height 3.5%-8% of chord length, randomized control knots)
 * - Fast initial escape (~5% on frame 1) + ballistic-skewed S-curve + converging 2D tremor + inter-frame dt jitter
 */
export function buildHumanSwipeKeyframes(x1, y1, x2, y2, {
  durationMs,
  jitterPx = 6,
  screenWidth = 1080,
  screenHeight = 2400,
  rng = Math.random,
} = {}) {
  const sw = Math.max(1, Math.round(Number(screenWidth) || 1080));
  const sh = Math.max(1, Math.round(Number(screenHeight) || 2400));
  const marginX = Math.min(8, Math.max(0, Math.floor((sw - 1) / 4)));
  const marginY = Math.min(8, Math.max(0, Math.floor((sh - 1) / 4)));
  const clampX = v => clamp(Math.round(v), marginX, Math.max(marginX, sw - 1 - marginX));
  const clampY = v => clamp(Math.round(v), marginY, Math.max(marginY, sh - 1 - marginY));
  const sx = clampX(x1 + clamp(sampleGaussian(0, jitterPx * 0.45, rng), -jitterPx, jitterPx));
  const sy = clampY(y1 + clamp(sampleGaussian(0, jitterPx * 0.45, rng), -jitterPx, jitterPx));
  const ex = clampX(x2 + clamp(sampleGaussian(0, jitterPx * 0.45, rng), -jitterPx, jitterPx));
  const ey = clampY(y2 + clamp(sampleGaussian(0, jitterPx * 0.45, rng), -jitterPx, jitterPx));

  const dx = ex - sx;
  const dy = ey - sy;
  const dist = Math.hypot(dx, dy) || 1;
  const normDist = dist * (1080 / Math.max(320, screenWidth));
  const totalMs = Math.round(clamp(durationMs ?? (240 + normDist * 0.16 + sampleGaussian(0, 35, rng)), 180, 720));
  const steps = clamp(Math.round(totalMs / 48), 6, 12);

  const tx = dx / dist;
  const ty = dy / dist;
  const nx = -dy / dist;
  const ny = dx / dist;
  const archSign = rng() < 0.5 ? -1 : 1;
  const arch = dist * (0.035 + rng() * 0.045) * archSign;
  const k1 = 0.27 + rng() * 0.12;
  const k2 = 0.62 + rng() * 0.12;
  const a1 = 0.78 + rng() * 0.18;
  const a2 = 0.96 + rng() * 0.18;
  const p1x = sx + dx * k1 + nx * arch * a1;
  const p1y = sy + dy * k1 + ny * arch * a1;
  const p2x = sx + dx * k2 + nx * arch * a2;
  const p2y = sy + dy * k2 + ny * arch * a2;

  const skewExp = 0.80 + rng() * 0.16;
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const stepMs = totalMs / steps;
  const minGap = Math.max(1, Math.min(8, Math.floor(stepMs * 0.25)));
  const points = [{ x: sx, y: sy, time: 0 }];
  let lastTime = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const warpedT = Math.pow(t, skewExp);
    const u = i === 1 ? Math.max(0.05, easeInOutCubic(warpedT)) : (i === steps ? 1 : easeInOutCubic(warpedT));
    const mu = 1 - u;
    const bx = mu ** 3 * sx + 3 * mu ** 2 * u * p1x + 3 * mu * u ** 2 * p2x + u ** 3 * ex;
    const by = mu ** 3 * sy + 3 * mu ** 2 * u * p1y + 3 * mu * u ** 2 * p2y + u ** 3 * ey;
    const env = i === steps ? 0 : Math.sin(Math.PI * t);
    const tremorN = env * clamp(sampleGaussian(0, 1.35, rng), -3.5, 3.5);
    const tremorT = env * clamp(sampleGaussian(0, 0.75, rng), -2.0, 2.0);
    let time;
    if (i === steps) {
      time = totalMs;
    } else {
      const minNext = lastTime + minGap;
      const maxNext = Math.max(minNext, totalMs - (steps - i) * minGap);
      const jittered = i * stepMs + clamp(sampleGaussian(0, stepMs * 0.14, rng), -stepMs * 0.28, stepMs * 0.28);
      time = clamp(Math.round(jittered), minNext, maxNext);
    }
    lastTime = time;
    points.push({
      x: clampX(bx + nx * tremorN + tx * tremorT),
      y: clampY(by + ny * tremorN + ty * tremorT),
      time,
    });
  }
  return { x1: sx, y1: sy, x2: ex, y2: ey, durationMs: totalMs, points };
}

export function resolveDirectionEndpoints(direction, {
  width = 1080,
  height = 2400,
  startX,
  startY,
  distance,
  distanceRatio,
  rng = Math.random,
} = {}) {
  const u = (a, b) => a + (b - a) * rng();
  const hasStart = Number.isFinite(Number(startX)) && Number.isFinite(Number(startY));
  const explicitDist = Number(distance);
  const hasDist = Number.isFinite(explicitDist) && explicitDist > 0;
  const vRatio = clamp(distanceRatio ?? u(0.36, 0.50), 0.15, 0.78);
  const hRatio = clamp(distanceRatio ?? u(0.45, 0.62), 0.15, 0.80);
  if (direction === 'up') {
    const x1 = hasStart ? Number(startX) : u(0.44, 0.64) * width;
    const y1 = hasStart ? Number(startY) : u(0.70, 0.80) * height;
    const dy = hasDist ? explicitDist : vRatio * height;
    return { x1, y1, x2: x1 + u(-0.05, 0.05) * width, y2: y1 - dy };
  }
  if (direction === 'down') {
    const x1 = hasStart ? Number(startX) : u(0.44, 0.64) * width;
    const y1 = hasStart ? Number(startY) : u(0.24, 0.34) * height;
    const dy = hasDist ? explicitDist : vRatio * height;
    return { x1, y1, x2: x1 + u(-0.05, 0.05) * width, y2: y1 + dy };
  }
  if (direction === 'left') {
    const x1 = hasStart ? Number(startX) : u(0.76, 0.86) * width;
    const y1 = hasStart ? Number(startY) : u(0.44, 0.58) * height;
    const dx = hasDist ? explicitDist : hRatio * width;
    return { x1, y1, x2: x1 - dx, y2: y1 + u(-0.04, 0.04) * height };
  }
  if (direction === 'right') {
    const x1 = hasStart ? Number(startX) : u(0.14, 0.24) * width;
    const y1 = hasStart ? Number(startY) : u(0.44, 0.58) * height;
    const dx = hasDist ? explicitDist : hRatio * width;
    return { x1, y1, x2: x1 + dx, y2: y1 + u(-0.04, 0.04) * height };
  }
  throw new Error(`Unsupported swipe direction: ${String(direction)}`);
}

export function sampleHumanDelayMs(minMs = 450, maxMs = 1350, rng = Math.random) {
  const a = Math.max(0, Number(minMs) || 0);
  const b = Math.max(0, Number(maxMs) || 0);
  const lo = Math.round(Math.min(a, b));
  const hi = Math.round(Math.max(a, b));
  return lo + Math.round((hi - lo) * Math.pow(rng(), 1.4));
}
