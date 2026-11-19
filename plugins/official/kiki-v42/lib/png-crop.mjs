import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function readPngDimensions(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }
  const chunkType = buf.subarray(12, 16).toString('latin1');
  if (chunkType !== 'IHDR') {
    throw new Error('PNG missing leading IHDR chunk');
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

export function decodePngToRgba(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG buffer');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatParts = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    const chunkData = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (type === 'PLTE') {
      palette = chunkData;
    } else if (type === 'tRNS') {
      trns = chunkData;
    } else if (type === 'IDAT') {
      idatParts.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height) throw new Error('PNG missing valid dimensions');
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample;
  const rowBytes = width * bpp;
  const raw = inflateSync(Buffer.concat(idatParts));
  if (raw.length < height * (1 + rowBytes)) {
    throw new Error('Truncated PNG image data');
  }

  const unfiltered = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (1 + rowBytes)];
    const srcRowStart = y * (1 + rowBytes) + 1;
    const dstRowStart = y * rowBytes;
    const prevRowStart = (y - 1) * rowBytes;

    for (let i = 0; i < rowBytes; i += 1) {
      const x = raw[srcRowStart + i];
      const left = i >= bpp ? unfiltered[dstRowStart + i - bpp] : 0;
      const up = y > 0 ? unfiltered[prevRowStart + i] : 0;
      const upLeft = y > 0 && i >= bpp ? unfiltered[prevRowStart + i - bpp] : 0;

      let val = x;
      if (filterType === 1) val = (x + left) & 0xff;
      else if (filterType === 2) val = (x + up) & 0xff;
      else if (filterType === 3) val = (x + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) val = (x + paethPredictor(left, up, upLeft)) & 0xff;
      else if (filterType !== 0) throw new Error(`Unsupported PNG scanline filter: ${filterType}`);

      unfiltered[dstRowStart + i] = val;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pxOffset = y * rowBytes + x * bpp;
      const dstOffset = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[dstOffset] = unfiltered[pxOffset];
        rgba[dstOffset + 1] = unfiltered[pxOffset + bytesPerSample];
        rgba[dstOffset + 2] = unfiltered[pxOffset + 2 * bytesPerSample];
        rgba[dstOffset + 3] = unfiltered[pxOffset + 3 * bytesPerSample];
      } else if (colorType === 2) {
        rgba[dstOffset] = unfiltered[pxOffset];
        rgba[dstOffset + 1] = unfiltered[pxOffset + bytesPerSample];
        rgba[dstOffset + 2] = unfiltered[pxOffset + 2 * bytesPerSample];
        rgba[dstOffset + 3] = 255;
      } else if (colorType === 0) {
        const g = unfiltered[pxOffset];
        rgba[dstOffset] = g;
        rgba[dstOffset + 1] = g;
        rgba[dstOffset + 2] = g;
        rgba[dstOffset + 3] = 255;
      } else if (colorType === 4) {
        const g = unfiltered[pxOffset];
        rgba[dstOffset] = g;
        rgba[dstOffset + 1] = g;
        rgba[dstOffset + 2] = g;
        rgba[dstOffset + 3] = unfiltered[pxOffset + bytesPerSample];
      } else if (colorType === 3) {
        if (!palette) throw new Error('Indexed PNG missing PLTE chunk');
        const idx = unfiltered[pxOffset];
        const palIdx = idx * 3;
        rgba[dstOffset] = palette[palIdx] ?? 0;
        rgba[dstOffset + 1] = palette[palIdx + 1] ?? 0;
        rgba[dstOffset + 2] = palette[palIdx + 2] ?? 0;
        rgba[dstOffset + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }

  return { width, height, rgba };
}

export function encodeRgbaToPng(width, height, rgba) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const rowStride = 1 + w * 4;
  const raw = Buffer.alloc(h * rowStride);
  for (let y = 0; y < h; y += 1) {
    raw[y * rowStride] = 0;
    const srcStart = y * w * 4;
    rgba.copy(raw, y * rowStride + 1, srcStart, srcStart + w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(raw)),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function createTestPng(width = 64, height = 40, seed = 7) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      rgba[idx] = (x * 5 + seed * 13) & 0xff;
      rgba[idx + 1] = (y * 7 + seed * 17) & 0xff;
      rgba[idx + 2] = ((x + y) * 3 + seed * 29) & 0xff;
      rgba[idx + 3] = 255;
    }
  }
  return encodeRgbaToPng(width, height, rgba);
}

export function resolveCropRect(zoom, coordinateMode, logicalSize, nativeImageSize) {
  if (!zoom || typeof zoom !== 'object') return null;
  const mode = coordinateMode || 'normalized_1000';
  const lw = Math.max(1, Number(logicalSize?.width) || nativeImageSize.width);
  const lh = Math.max(1, Number(logicalSize?.height) || nativeImageSize.height);
  const iw = Math.max(1, nativeImageSize.width);
  const ih = Math.max(1, nativeImageSize.height);

  let targetX;
  let targetY;
  let targetW;
  let targetH;

  if (mode === 'normalized_1000') {
    targetX = (Number(zoom.x) / 1000) * lw;
    targetY = (Number(zoom.y) / 1000) * lh;
    targetW = (Number(zoom.width) / 1000) * lw;
    targetH = (Number(zoom.height) / 1000) * lh;
  } else if (mode === 'normalized_01') {
    targetX = Number(zoom.x) * lw;
    targetY = Number(zoom.y) * lh;
    targetW = Number(zoom.width) * lw;
    targetH = Number(zoom.height) * lh;
  } else if (mode === 'image_pixels') {
    targetX = (Number(zoom.x) / iw) * lw;
    targetY = (Number(zoom.y) / ih) * lh;
    targetW = (Number(zoom.width) / iw) * lw;
    targetH = (Number(zoom.height) / ih) * lh;
  } else {
    targetX = Number(zoom.x);
    targetY = Number(zoom.y);
    targetW = Number(zoom.width);
    targetH = Number(zoom.height);
  }

  const clampedTargetX = Math.max(0, Math.min(lw - 1, Math.round(targetX || 0)));
  const clampedTargetY = Math.max(0, Math.min(lh - 1, Math.round(targetY || 0)));
  const clampedTargetW = Math.max(1, Math.min(lw - clampedTargetX, Math.round(targetW || lw)));
  const clampedTargetH = Math.max(1, Math.min(lh - clampedTargetY, Math.round(targetH || lh)));

  const imgX = Math.max(0, Math.min(iw - 1, Math.round((clampedTargetX / lw) * iw)));
  const imgY = Math.max(0, Math.min(ih - 1, Math.round((clampedTargetY / lh) * ih)));
  const imgW = Math.max(1, Math.min(iw - imgX, Math.round((clampedTargetW / lw) * iw)));
  const imgH = Math.max(1, Math.min(ih - imgY, Math.round((clampedTargetH / lh) * ih)));

  return {
    cropBounds: {
      x: clampedTargetX,
      y: clampedTargetY,
      width: clampedTargetW,
      height: clampedTargetH,
    },
    imageRect: {
      x: imgX,
      y: imgY,
      width: imgW,
      height: imgH,
    },
  };
}

export function cropAndScalePng(pngBuffer, {
  zoom = null,
  coordinateMode = 'normalized_1000',
  logicalSize = null,
  maxWidth = 0,
  maxHeight = 0,
} = {}) {
  const buf = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer);
  const nativeDims = readPngDimensions(buf);
  const effectiveLogical = logicalSize?.width && logicalSize?.height ? logicalSize : nativeDims;

  const resolvedZoom = resolveCropRect(zoom, coordinateMode, effectiveLogical, nativeDims);
  const srcRect = resolvedZoom
    ? resolvedZoom.imageRect
    : { x: 0, y: 0, width: nativeDims.width, height: nativeDims.height };

  let outW = srcRect.width;
  let outH = srcRect.height;
  if (maxWidth > 0 && outW > maxWidth) {
    const ratio = maxWidth / outW;
    outW = Math.max(1, Math.round(outW * ratio));
    outH = Math.max(1, Math.round(outH * ratio));
  }
  if (maxHeight > 0 && outH > maxHeight) {
    const ratio = maxHeight / outH;
    outW = Math.max(1, Math.round(outW * ratio));
    outH = Math.max(1, Math.round(outH * ratio));
  }

  if (!resolvedZoom && outW === nativeDims.width && outH === nativeDims.height) {
    return {
      pngBuffer: buf,
      imageSize: { width: nativeDims.width, height: nativeDims.height },
      nativeSize: nativeDims,
      logicalSize: effectiveLogical,
      cropBounds: null,
    };
  }

  const decoded = decodePngToRgba(buf);
  const dstRgba = Buffer.alloc(outW * outH * 4);
  for (let dy = 0; dy < outH; dy += 1) {
    const sy = Math.min(
      decoded.height - 1,
      srcRect.y + Math.floor(((dy + 0.5) * srcRect.height) / outH),
    );
    for (let dx = 0; dx < outW; dx += 1) {
      const sx = Math.min(
        decoded.width - 1,
        srcRect.x + Math.floor(((dx + 0.5) * srcRect.width) / outW),
      );
      const srcIdx = (sy * decoded.width + sx) * 4;
      const dstIdx = (dy * outW + dx) * 4;
      dstRgba[dstIdx] = decoded.rgba[srcIdx];
      dstRgba[dstIdx + 1] = decoded.rgba[srcIdx + 1];
      dstRgba[dstIdx + 2] = decoded.rgba[srcIdx + 2];
      dstRgba[dstIdx + 3] = decoded.rgba[srcIdx + 3];
    }
  }

  const encoded = encodeRgbaToPng(outW, outH, dstRgba);
  return {
    pngBuffer: encoded,
    imageSize: { width: outW, height: outH },
    nativeSize: nativeDims,
    logicalSize: effectiveLogical,
    cropBounds: resolvedZoom ? resolvedZoom.cropBounds : null,
  };
}
