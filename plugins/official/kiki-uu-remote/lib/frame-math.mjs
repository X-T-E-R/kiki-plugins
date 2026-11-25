import {
  applyGridOverlay,
  cropRgba,
  decodePng,
  encodePng,
  hashPngOrSample,
  resizeRgbaToFit,
} from './png-codec.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function parseAspectRatio(spec) {
  if (typeof spec === 'number' && Number.isFinite(spec) && spec > 0.1 && spec < 12) {
    return spec;
  }
  if (typeof spec !== 'string') return null;
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const ratioMatch = /^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (ratioMatch) {
    const w = Number(ratioMatch[1]);
    const h = Number(ratioMatch[2]);
    if (w > 0 && h > 0) {
      const r = w / h;
      return r > 0.1 && r < 12 ? r : null;
    }
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric > 0.1 && numeric < 12 ? numeric : null;
}

function fitInscribedAspect(width, height, aspect) {
  const canvasAspect = width / height;
  if (Math.abs(canvasAspect - aspect) <= 0.004) {
    return { x: 0, y: 0, width, height, trimmed: false, axis: 'none', mode: 'aspect_override' };
  }
  if (canvasAspect > aspect) {
    const contentWidth = Math.max(1, Math.min(width, Math.round(height * aspect)));
    const x = Math.floor((width - contentWidth) / 2);
    return {
      x,
      y: 0,
      width: contentWidth,
      height,
      trimmed: contentWidth < width,
      axis: contentWidth < width ? 'pillarbox' : 'none',
      mode: 'aspect_override',
    };
  }
  const contentHeight = Math.max(1, Math.min(height, Math.round(width / aspect)));
  const y = Math.floor((height - contentHeight) / 2);
  return {
    x: 0,
    y,
    width,
    height: contentHeight,
    trimmed: contentHeight < height,
    axis: contentHeight < height ? 'letterbox' : 'none',
    mode: 'aspect_override',
  };
}

function isUniformBlackRow(data, width, y, maxChannel, maxVariance, step) {
  const rowBase = y * width * 4;
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let x = 0; x < width; x += step) {
    const i = rowBase + x * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > maxChannel || g > maxChannel || b > maxChannel) return false;
    const lum = (r + g + b) / 3;
    count += 1;
    sum += lum;
    sumSq += lum * lum;
  }

  const lastIdx = rowBase + (width - 1) * 4;
  if (data[lastIdx] > maxChannel || data[lastIdx + 1] > maxChannel || data[lastIdx + 2] > maxChannel) {
    return false;
  }
  if (count <= 1) return true;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return variance < maxVariance;
}

function isUniformBlackColumn(data, width, height, x, maxChannel, maxVariance, step) {
  const colOffset = x * 4;
  const stride = width * 4;
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let y = 0; y < height; y += step) {
    const i = y * stride + colOffset;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > maxChannel || g > maxChannel || b > maxChannel) return false;
    const lum = (r + g + b) / 3;
    count += 1;
    sum += lum;
    sumSq += lum * lum;
  }

  const lastIdx = (height - 1) * stride + colOffset;
  if (data[lastIdx] > maxChannel || data[lastIdx + 1] > maxChannel || data[lastIdx + 2] > maxChannel) {
    return false;
  }
  if (count <= 1) return true;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return variance < maxVariance;
}

/**
 * Compute active remote stream content rectangle inside an inner canvas bitmap.
 * Enforces:
 * 1. All-black / dark-screen non-collapse guard (never returns 0x0).
 * 2. Symmetry guard (|top - bottom| <= symmetryTolerance, |left - right| <= symmetryTolerance).
 * 3. Mutual-exclusivity guard (Math.min(barX, barY) <= mutualExclusivityTolerance), because
 *    aspect-ratio fitting adds bars on either Y (letterbox) or X (pillarbox), never all 4 sides.
 */
export function computeStreamContentRect(imageOrPng, options = {}) {
  const image = Buffer.isBuffer(imageOrPng) || (imageOrPng instanceof Uint8Array && !imageOrPng.width)
    ? decodePng(imageOrPng)
    : imageOrPng;

  const width = Math.max(1, Math.floor(Number(image?.width) || 0));
  const height = Math.max(1, Math.floor(Number(image?.height) || 0));

  const explicitAspect = parseAspectRatio(options.remoteAspect);
  if (explicitAspect) {
    return fitInscribedAspect(width, height, explicitAspect);
  }

  if (options.autoTrimBlackBars === false) {
    return { x: 0, y: 0, width, height, trimmed: false, axis: 'none', mode: 'disabled' };
  }

  const data = image?.data;
  if (!(data instanceof Uint8Array) || data.length < width * height * 4) {
    return { x: 0, y: 0, width, height, trimmed: false, axis: 'none', reason: 'no_pixel_data' };
  }

  const maxChannel = Number.isFinite(options.maxChannel) ? options.maxChannel : 6;
  const maxVariance = Number.isFinite(options.maxVariance) ? options.maxVariance : 2;
  const symmetryTolerance = Number.isFinite(options.symmetryTolerance) ? options.symmetryTolerance : 3;
  const mutualExclusivityTolerance = Number.isFinite(options.mutualExclusivityTolerance)
    ? options.mutualExclusivityTolerance
    : 3;
  const minBarPx = Number.isFinite(options.minBarPx) ? options.minBarPx : 2;
  const minContentRatio = Number.isFinite(options.minContentRatio) ? options.minContentRatio : 0.25;

  const rowStep = Math.max(1, Math.floor(width / 512));
  const colStep = Math.max(1, Math.floor(height / 512));

  let top = 0;
  while (top < height && isUniformBlackRow(data, width, top, maxChannel, maxVariance, rowStep)) {
    top += 1;
  }
  if (top >= height) {
    return { x: 0, y: 0, width, height, trimmed: false, axis: 'none', reason: 'all_black' };
  }

  let bottom = 0;
  while (
    bottom < height - top &&
    isUniformBlackRow(data, width, height - 1 - bottom, maxChannel, maxVariance, rowStep)
  ) {
    bottom += 1;
  }

  let left = 0;
  while (left < width && isUniformBlackColumn(data, width, height, left, maxChannel, maxVariance, colStep)) {
    left += 1;
  }
  if (left >= width) {
    return { x: 0, y: 0, width, height, trimmed: false, axis: 'none', reason: 'all_black' };
  }

  let right = 0;
  while (
    right < width - left &&
    isUniformBlackColumn(data, width, height, width - 1 - right, maxChannel, maxVariance, colStep)
  ) {
    right += 1;
  }

  const barX = Math.min(left, right);
  const barY = Math.min(top, bottom);

  // Mutual exclusivity: a single aspect-ratio fit never adds thick black bars on all 4 sides.
  if (Math.min(barX, barY) > mutualExclusivityTolerance) {
    return {
      x: 0,
      y: 0,
      width,
      height,
      trimmed: false,
      axis: 'none',
      reason: 'four_sided_margin_rejected',
      margins: { top, bottom, left, right },
    };
  }

  const validLetterbox =
    (top >= minBarPx || bottom >= minBarPx) &&
    Math.abs(top - bottom) <= symmetryTolerance &&
    barX <= mutualExclusivityTolerance;

  const validPillarbox =
    (left >= minBarPx || right >= minBarPx) &&
    Math.abs(left - right) <= symmetryTolerance &&
    barY <= mutualExclusivityTolerance;

  const trimTop = validLetterbox ? top : 0;
  const trimBottom = validLetterbox ? bottom : 0;
  const trimLeft = validPillarbox && !validLetterbox ? left : 0;
  const trimRight = validPillarbox && !validLetterbox ? right : 0;

  const contentWidth = width - trimLeft - trimRight;
  const contentHeight = height - trimTop - trimBottom;
  const minW = Math.min(width, Math.max(8, Math.ceil(width * minContentRatio)));
  const minH = Math.min(height, Math.max(8, Math.ceil(height * minContentRatio)));

  if (contentWidth < minW || contentHeight < minH) {
    return {
      x: 0,
      y: 0,
      width,
      height,
      trimmed: false,
      axis: 'none',
      reason: 'insufficient_content',
      margins: { top, bottom, left, right },
    };
  }

  const trimmed = trimTop > 0 || trimBottom > 0 || trimLeft > 0 || trimRight > 0;
  return {
    x: trimLeft,
    y: trimTop,
    width: contentWidth,
    height: contentHeight,
    trimmed,
    axis: !trimmed ? 'none' : trimTop > 0 || trimBottom > 0 ? 'letterbox' : 'pillarbox',
    mode: 'auto_scan',
    margins: { top, bottom, left, right },
  };
}

export function mapPointToTarget({
  x,
  y,
  coordinateMode = 'normalized_1000',
  zoomRelative = false,
  stageBounds = { x: 0, y: 0, width: 1920, height: 1080 },
  contentRect,
  lastObservation = null,
}) {
  const cr = contentRect && contentRect.width > 0 && contentRect.height > 0
    ? contentRect
    : { x: 0, y: 0, width: Math.max(1, stageBounds.width), height: Math.max(1, stageBounds.height) };

  const numX = Number(x);
  const numY = Number(y);
  if (!Number.isFinite(numX) || !Number.isFinite(numY)) {
    throw new Error(`Invalid coordinates: x=${String(x)}, y=${String(y)}`);
  }

  const cropBounds = lastObservation?.cropBounds || null;
  if (zoomRelative && !cropBounds) {
    throw new Error('zoomRelative=true requires a prior zoomed screenshot on this session.');
  }
  const refRect = zoomRelative && cropBounds
    ? cropBounds
    : { x: 0, y: 0, width: cr.width, height: cr.height };

  let floatTargetX;
  let floatTargetY;
  let norm01X;
  let norm01Y;

  switch (coordinateMode) {
    case 'normalized_1000': {
      const u = clamp(numX, 0, 1000) / 1000;
      const v = clamp(numY, 0, 1000) / 1000;
      if (zoomRelative && cropBounds) {
        floatTargetX = refRect.x + (refRect.width > 1 ? u * (refRect.width - 1) : 0);
        floatTargetY = refRect.y + (refRect.height > 1 ? v * (refRect.height - 1) : 0);
        norm01X = cr.width > 1 ? clamp(floatTargetX, 0, cr.width - 1) / (cr.width - 1) : 0;
        norm01Y = cr.height > 1 ? clamp(floatTargetY, 0, cr.height - 1) / (cr.height - 1) : 0;
      } else {
        norm01X = u;
        norm01Y = v;
        floatTargetX = cr.width > 1 ? u * (cr.width - 1) : 0;
        floatTargetY = cr.height > 1 ? v * (cr.height - 1) : 0;
      }
      break;
    }
    case 'normalized_01': {
      const u = clamp(numX, 0, 1);
      const v = clamp(numY, 0, 1);
      if (zoomRelative && cropBounds) {
        floatTargetX = refRect.x + (refRect.width > 1 ? u * (refRect.width - 1) : 0);
        floatTargetY = refRect.y + (refRect.height > 1 ? v * (refRect.height - 1) : 0);
        norm01X = cr.width > 1 ? clamp(floatTargetX, 0, cr.width - 1) / (cr.width - 1) : 0;
        norm01Y = cr.height > 1 ? clamp(floatTargetY, 0, cr.height - 1) / (cr.height - 1) : 0;
      } else {
        norm01X = u;
        norm01Y = v;
        floatTargetX = cr.width > 1 ? u * (cr.width - 1) : 0;
        floatTargetY = cr.height > 1 ? v * (cr.height - 1) : 0;
      }
      break;
    }
    case 'image_pixels': {
      const base = cropBounds || { x: 0, y: 0, width: cr.width, height: cr.height };
      const imgW = lastObservation?.imageSize?.width > 0 ? lastObservation.imageSize.width : base.width;
      const imgH = lastObservation?.imageSize?.height > 0 ? lastObservation.imageSize.height : base.height;
      const rx = imgW > 1 ? clamp(numX / (imgW - 1), 0, 1) : 0;
      const ry = imgH > 1 ? clamp(numY / (imgH - 1), 0, 1) : 0;
      floatTargetX = base.x + (base.width > 1 ? rx * (base.width - 1) : 0);
      floatTargetY = base.y + (base.height > 1 ? ry * (base.height - 1) : 0);
      norm01X = cr.width > 1 ? clamp(floatTargetX, 0, cr.width - 1) / (cr.width - 1) : 0;
      norm01Y = cr.height > 1 ? clamp(floatTargetY, 0, cr.height - 1) / (cr.height - 1) : 0;
      break;
    }
    case 'target_pixels':
    default: {
      floatTargetX = zoomRelative && cropBounds
        ? clamp(refRect.x + numX, refRect.x, refRect.x + Math.max(0, refRect.width - 1))
        : clamp(numX, 0, Math.max(0, cr.width - 1));
      floatTargetY = zoomRelative && cropBounds
        ? clamp(refRect.y + numY, refRect.y, refRect.y + Math.max(0, refRect.height - 1))
        : clamp(numY, 0, Math.max(0, cr.height - 1));
      norm01X = cr.width > 1 ? floatTargetX / (cr.width - 1) : 0;
      norm01Y = cr.height > 1 ? floatTargetY / (cr.height - 1) : 0;
      break;
    }
  }

  const targetX = cr.width <= 1 ? 0 : clamp(Math.round(floatTargetX), 0, cr.width - 1);
  const targetY = cr.height <= 1 ? 0 : clamp(Math.round(floatTargetY), 0, cr.height - 1);
  const screenX = Math.round(stageBounds.x + cr.x + targetX);
  const screenY = Math.round(stageBounds.y + cr.y + targetY);
  const normX = cr.width > 1 ? clamp(Math.round(norm01X * 1000), 0, 1000) : 0;
  const normY = cr.height > 1 ? clamp(Math.round(norm01Y * 1000), 0, 1000) : 0;

  return {
    x: targetX,
    y: targetY,
    normX,
    normY,
    norm01X,
    norm01Y,
    screenX,
    screenY,
  };
}

export function resolveZoomCropBounds(zoom, coordinateMode = 'normalized_1000', logicalSize, lastObservation = null) {
  if (!zoom || typeof zoom !== 'object') return null;
  const lw = Math.max(1, Math.round(Number(logicalSize?.width) || 1));
  const lh = Math.max(1, Math.round(Number(logicalSize?.height) || 1));
  const zx = Number(zoom.x);
  const zy = Number(zoom.y);
  const zw = Number(zoom.width);
  const zh = Number(zoom.height);
  if (![zx, zy, zw, zh].every(Number.isFinite) || zw <= 0 || zh <= 0) {
    throw new Error('Invalid zoom rectangle: expected finite positive width and height.');
  }

  let rx;
  let ry;
  let rw;
  let rh;

  if (coordinateMode === 'normalized_1000') {
    rx = Math.round((zx / 1000) * lw);
    ry = Math.round((zy / 1000) * lh);
    rw = Math.round((zw / 1000) * lw);
    rh = Math.round((zh / 1000) * lh);
  } else if (coordinateMode === 'normalized_01') {
    rx = Math.round(zx * lw);
    ry = Math.round(zy * lh);
    rw = Math.round(zw * lw);
    rh = Math.round(zh * lh);
  } else if (coordinateMode === 'image_pixels' && lastObservation?.imageSize?.width > 0 && lastObservation?.imageSize?.height > 0) {
    const base = lastObservation.cropBounds || { x: 0, y: 0, width: lw, height: lh };
    rx = Math.round(base.x + (zx / lastObservation.imageSize.width) * base.width);
    ry = Math.round(base.y + (zy / lastObservation.imageSize.height) * base.height);
    rw = Math.round((zw / lastObservation.imageSize.width) * base.width);
    rh = Math.round((zh / lastObservation.imageSize.height) * base.height);
  } else {
    rx = Math.round(zx);
    ry = Math.round(zy);
    rw = Math.round(zw);
    rh = Math.round(zh);
  }

  const clampedX = clamp(rx, 0, lw - 1);
  const clampedY = clamp(ry, 0, lh - 1);
  const clampedW = clamp(rw, 1, lw - clampedX);
  const clampedH = clamp(rh, 1, lh - clampedY);

  return { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
}

export function processCapturedStagePng(pngBytesOrImage, {
  autoTrimBlackBars = true,
  remoteAspect,
  zoom = null,
  coordinateMode = 'normalized_1000',
  maxWidth = 1440,
  maxHeight = 1080,
  lastObservation = null,
  pngCompressionLevel = 3,
  overlay = 'none',
} = {}) {
  const stageImage = Buffer.isBuffer(pngBytesOrImage) || (pngBytesOrImage instanceof Uint8Array && !pngBytesOrImage.width)
    ? decodePng(pngBytesOrImage)
    : pngBytesOrImage;
  const stageSize = { width: stageImage.width, height: stageImage.height };

  const contentRect = computeStreamContentRect(stageImage, {
    autoTrimBlackBars,
    remoteAspect,
  });

  const nativeStreamImage = cropRgba(stageImage, contentRect);
  const logicalSize = { width: nativeStreamImage.width, height: nativeStreamImage.height };

  const cropBounds = zoom
    ? resolveZoomCropBounds(zoom, coordinateMode, logicalSize, lastObservation)
    : null;

  const croppedView = cropBounds ? cropRgba(nativeStreamImage, cropBounds) : nativeStreamImage;
  const resizedImage = resizeRgbaToFit(croppedView, { maxWidth, maxHeight });
  const encodedImage = overlay === 'grid' ? applyGridOverlay(resizedImage) : resizedImage;
  const pngBuffer = encodePng(encodedImage, { level: pngCompressionLevel });
  const frameHash = hashPngOrSample(pngBuffer);

  return {
    mimeType: 'image/png',
    pngBuffer,
    imageBase64: pngBuffer.toString('base64'),
    frameHash,
    rgbaImage: resizedImage,
    overlay: overlay === 'grid' ? 'grid' : 'none',
    stageSize,
    contentRect: {
      x: contentRect.x,
      y: contentRect.y,
      width: contentRect.width,
      height: contentRect.height,
    },
    contentTrimmed: Boolean(contentRect.trimmed),
    contentAxis: contentRect.axis || 'none',
    logicalSize,
    cropBounds,
    imageSize: { width: encodedImage.width, height: encodedImage.height },
  };
}

export function computeContainedRect(containerWidth, containerHeight, contentWidth, contentHeight) {
  const cw = Math.max(1, Number(containerWidth) || 1);
  const ch = Math.max(1, Number(containerHeight) || 1);
  const iw = Math.max(1, Number(contentWidth) || 1);
  const ih = Math.max(1, Number(contentHeight) || 1);
  const scale = Math.min(cw / iw, ch / ih);
  const width = iw * scale;
  const height = ih * scale;
  const x = (cw - width) / 2;
  const y = (ch - height) / 2;
  return { x, y, width, height, scale };
}

export function mapContainedClientToRemote(
  offsetX,
  offsetY,
  containerWidth,
  containerHeight,
  logicalSize = { width: 1920, height: 1080 },
) {
  const lw = Math.max(1, Math.round(Number(logicalSize?.width) || 1920));
  const lh = Math.max(1, Math.round(Number(logicalSize?.height) || 1080));
  const rect = computeContainedRect(containerWidth, containerHeight, lw, lh);
  const rawX = Number(offsetX) || 0;
  const rawY = Number(offsetY) || 0;
  const inside =
    rawX >= rect.x - 0.5 &&
    rawX <= rect.x + rect.width + 0.5 &&
    rawY >= rect.y - 0.5 &&
    rawY <= rect.y + rect.height + 0.5;
  const relX = clamp((rawX - rect.x) / Math.max(1e-6, rect.width), 0, 1);
  const relY = clamp((rawY - rect.y) / Math.max(1e-6, rect.height), 0, 1);
  const targetX = lw <= 1 ? 0 : Math.round(relX * (lw - 1));
  const targetY = lh <= 1 ? 0 : Math.round(relY * (lh - 1));
  const normX = Math.round(relX * 1000);
  const normY = Math.round(relY * 1000);
  return {
    inside,
    localX: clamp(rawX, rect.x, rect.x + rect.width),
    localY: clamp(rawY, rect.y, rect.y + rect.height),
    targetX,
    targetY,
    normX,
    normY,
    rect,
  };
}
