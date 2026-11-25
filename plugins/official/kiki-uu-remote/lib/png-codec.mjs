import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(typeBytes, dataBytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < typeBytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ typeBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  for (let i = 0; i < dataBytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ dataBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(typeBuf, data), 8 + data.length);
  return out;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatChunks = [];

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + length;
    if (chunkEnd + 4 > bytes.length) {
      throw new Error(`Truncated PNG chunk: ${type}`);
    }
    const chunkData = bytes.subarray(chunkStart, chunkEnd);
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
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
    offset = chunkEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error('PNG missing valid IHDR dimensions.');
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG bitDepth=${bitDepth} interlace=${interlace}; expected 8-bit non-interlaced.`);
  }

  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) {
    throw new Error(`Unsupported PNG colorType=${colorType}.`);
  }
  if (colorType === 3 && (!palette || palette.length < 3)) {
    throw new Error('Indexed PNG missing PLTE chunk.');
  }

  const compressed = idatChunks.length === 1 ? idatChunks[0] : Buffer.concat(idatChunks);
  const inflated = inflateSync(compressed);
  const bpp = channels;
  const rowBytes = width * bpp;
  const expectedLength = height * (1 + rowBytes);
  if (inflated.length < expectedLength) {
    throw new Error(`Invalid inflated PNG payload (${inflated.length} < ${expectedLength}).`);
  }

  const prevRow = new Uint8Array(rowBytes);
  const curRow = new Uint8Array(rowBytes);
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const srcRowOffset = y * (1 + rowBytes);
    const filter = inflated[srcRowOffset];
    const src = srcRowOffset + 1;

    switch (filter) {
      case 0:
        for (let i = 0; i < rowBytes; i += 1) curRow[i] = inflated[src + i];
        break;
      case 1:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? curRow[i - bpp] : 0;
          curRow[i] = (inflated[src + i] + left) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < rowBytes; i += 1) {
          curRow[i] = (inflated[src + i] + prevRow[i]) & 0xff;
        }
        break;
      case 3:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? curRow[i - bpp] : 0;
          curRow[i] = (inflated[src + i] + ((left + prevRow[i]) >>> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? curRow[i - bpp] : 0;
          const up = prevRow[i];
          const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
          curRow[i] = (inflated[src + i] + paethPredictor(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`Unsupported PNG scanline filter=${filter} at row ${y}.`);
    }

    const dstRowOffset = y * width * 4;
    if (colorType === 6) {
      rgba.set(curRow, dstRowOffset);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x += 1) {
        const s = x * 3;
        const d = dstRowOffset + x * 4;
        rgba[d] = curRow[s];
        rgba[d + 1] = curRow[s + 1];
        rgba[d + 2] = curRow[s + 2];
        rgba[d + 3] = 255;
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x += 1) {
        const g = curRow[x];
        const d = dstRowOffset + x * 4;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x += 1) {
        const g = curRow[x * 2];
        const a = curRow[x * 2 + 1];
        const d = dstRowOffset + x * 4;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = a;
      }
    } else if (colorType === 3) {
      for (let x = 0; x < width; x += 1) {
        const idx = curRow[x];
        const p = idx * 3;
        const d = dstRowOffset + x * 4;
        rgba[d] = palette[p] ?? 0;
        rgba[d + 1] = palette[p + 1] ?? 0;
        rgba[d + 2] = palette[p + 2] ?? 0;
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }

    prevRow.set(curRow);
  }

  return { width, height, data: rgba };
}

export function encodePng(image, { level = 3 } = {}) {
  const width = Math.max(1, Math.floor(Number(image?.width) || 0));
  const height = Math.max(1, Math.floor(Number(image?.height) || 0));
  const data = image?.data;
  if (!(data instanceof Uint8Array) || data.length < width * height * 4) {
    throw new Error(`encodePng expected RGBA buffer of length ${width * height * 4}.`);
  }

  const rowBytes = width * 4;
  const filtered = Buffer.allocUnsafe(height * (1 + rowBytes));
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * rowBytes;
    const dstRow = y * (1 + rowBytes);
    filtered[dstRow] = 1; // Sub filter
    for (let i = 0; i < rowBytes; i += 1) {
      const left = i >= 4 ? data[srcRow + i - 4] : 0;
      filtered[dstRow + 1 + i] = (data[srcRow + i] - left) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(filtered, { level });
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function cropRgba(image, rect) {
  const srcW = image.width;
  const srcH = image.height;
  const x = Math.max(0, Math.min(srcW - 1, Math.round(Number(rect?.x) || 0)));
  const y = Math.max(0, Math.min(srcH - 1, Math.round(Number(rect?.y) || 0)));
  const width = Math.max(1, Math.min(srcW - x, Math.round(Number(rect?.width) || srcW)));
  const height = Math.max(1, Math.min(srcH - y, Math.round(Number(rect?.height) || srcH)));

  if (x === 0 && y === 0 && width === srcW && height === srcH) {
    return image;
  }

  const out = new Uint8Array(width * height * 4);
  const srcStride = srcW * 4;
  const dstStride = width * 4;
  for (let row = 0; row < height; row += 1) {
    const srcStart = (y + row) * srcStride + x * 4;
    out.set(image.data.subarray(srcStart, srcStart + dstStride), row * dstStride);
  }
  return { width, height, data: out };
}

export function resizeRgbaToFit(image, { maxWidth, maxHeight } = {}) {
  const srcW = image.width;
  const srcH = image.height;
  const limitW = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : srcW;
  const limitH = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : srcH;
  const scale = Math.min(1, limitW / srcW, limitH / srcH);
  if (scale >= 0.9999) {
    return image;
  }

  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const out = new Uint8Array(dstW * dstH * 4);
  const src = image.data;
  const xRatio = (srcW - 1) / Math.max(1, dstW - 1);
  const yRatio = (srcH - 1) / Math.max(1, dstH - 1);

  for (let dy = 0; dy < dstH; dy += 1) {
    const sy = dstH === 1 ? 0 : dy * yRatio;
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = sy - y0;
    const wyInv = 1 - wy;

    for (let dx = 0; dx < dstW; dx += 1) {
      const sx = dstW === 1 ? 0 : dx * xRatio;
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = sx - x0;
      const wxInv = 1 - wx;

      const p00 = (y0 * srcW + x0) * 4;
      const p10 = (y0 * srcW + x1) * 4;
      const p01 = (y1 * srcW + x0) * 4;
      const p11 = (y1 * srcW + x1) * 4;
      const d = (dy * dstW + dx) * 4;

      for (let c = 0; c < 4; c += 1) {
        const top = src[p00 + c] * wxInv + src[p10 + c] * wx;
        const bot = src[p01 + c] * wxInv + src[p11 + c] * wx;
        out[d + c] = Math.round(top * wyInv + bot * wy);
      }
    }
  }

  return { width: dstW, height: dstH, data: out };
}

const DIGIT_BITMAPS = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
};

function blendPixel(rgba, width, height, x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const off = (y * width + x) * 4;
  const inv = 1 - alpha;
  rgba[off] = Math.round(r * alpha + rgba[off] * inv);
  rgba[off + 1] = Math.round(g * alpha + rgba[off + 1] * inv);
  rgba[off + 2] = Math.round(b * alpha + rgba[off + 2] * inv);
  rgba[off + 3] = 255;
}

function drawTinyLabel(rgba, width, height, x, y, label) {
  const padX = 3;
  const padY = 2;
  const boxW = label.length * 4 - 1 + padX * 2;
  const boxH = 5 + padY * 2;
  for (let by = 0; by < boxH; by += 1) {
    for (let bx = 0; bx < boxW; bx += 1) {
      blendPixel(rgba, width, height, x + bx, y + by, 24, 24, 22, 0.78);
    }
  }
  for (let ci = 0; ci < label.length; ci += 1) {
    const rows = DIGIT_BITMAPS[label[ci]];
    if (!rows) continue;
    for (let ry = 0; ry < 5; ry += 1) {
      for (let rx = 0; rx < 3; rx += 1) {
        if ((rows[ry] >> (2 - rx)) & 1) {
          blendPixel(rgba, width, height, x + padX + ci * 4 + rx, y + padY + ry, 246, 244, 239, 1);
        }
      }
    }
  }
}

/**
 * Draw an opt-in 0..1000 coordinate grid (ticks every 100 units + 3x5 digit labels)
 * onto a copy of an RGBA image without mutating the source buffer.
 */
export function applyGridOverlay(rgbaImage) {
  const width = Math.max(1, Math.floor(Number(rgbaImage?.width) || 0));
  const height = Math.max(1, Math.floor(Number(rgbaImage?.height) || 0));
  const src = rgbaImage?.data;
  if (!(src instanceof Uint8Array) || src.length < width * height * 4) {
    throw new Error(`applyGridOverlay expected RGBA buffer of length ${width * height * 4}.`);
  }
  const rgba = new Uint8Array(src.subarray(0, width * height * 4));
  for (let step = 100; step <= 900; step += 100) {
    const gx = Math.round((step / 1000) * Math.max(0, width - 1));
    const gy = Math.round((step / 1000) * Math.max(0, height - 1));
    const alpha = step === 500 ? 0.55 : 0.34;
    for (let y = 0; y < height; y += 1) {
      blendPixel(rgba, width, height, gx, y, 44, 94, 79, alpha);
    }
    for (let x = 0; x < width; x += 1) {
      blendPixel(rgba, width, height, x, gy, 44, 94, 79, alpha);
    }
    drawTinyLabel(rgba, width, height, Math.max(0, Math.min(width - 20, gx + 2)), 3, String(step));
    drawTinyLabel(rgba, width, height, 3, Math.max(0, Math.min(height - 12, gy + 2)), String(step));
  }
  return { width, height, data: rgba };
}

/**
 * Stride-sampled RGB frame diff (< 2ms on 1080p) returning whether the screen changed,
 * the changed sample ratio [0..1], and the bounding box of changed pixels.
 */
export function computeSampledFrameDiff(prevRgba, nextRgba, {
  threshold = 6,
  maxSamplesX = 160,
  maxSamplesY = 120,
} = {}) {
  if (!nextRgba || !(nextRgba.data instanceof Uint8Array) || nextRgba.width <= 0 || nextRgba.height <= 0) {
    return { changed: false, changeRatio: 0, changedBounds: null };
  }
  const width = nextRgba.width;
  const height = nextRgba.height;
  if (
    !prevRgba ||
    !(prevRgba.data instanceof Uint8Array) ||
    prevRgba.width !== width ||
    prevRgba.height !== height
  ) {
    return {
      changed: true,
      changeRatio: 1,
      changedBounds: { x: 0, y: 0, width, height },
    };
  }

  const prev = prevRgba.data;
  const next = nextRgba.data;
  const stepX = Math.max(1, Math.floor(width / maxSamplesX));
  const stepY = Math.max(1, Math.floor(height / maxSamplesY));

  let total = 0;
  let diffCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += stepY) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += stepX) {
      const i = rowBase + x * 4;
      total += 1;
      if (
        Math.abs(prev[i] - next[i]) > threshold ||
        Math.abs(prev[i + 1] - next[i + 1]) > threshold ||
        Math.abs(prev[i + 2] - next[i + 2]) > threshold
      ) {
        diffCount += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (diffCount === 0) {
    return { changed: false, changeRatio: 0, changedBounds: null };
  }

  const bx = Math.max(0, minX - stepX);
  const by = Math.max(0, minY - stepY);
  const bx2 = Math.min(width - 1, maxX + stepX);
  const by2 = Math.min(height - 1, maxY + stepY);

  return {
    changed: true,
    changeRatio: Number((diffCount / Math.max(1, total)).toFixed(4)),
    changedBounds: {
      x: bx,
      y: by,
      width: Math.max(1, bx2 - bx + 1),
      height: Math.max(1, by2 - by + 1),
    },
  };
}

/**
 * Fast SHA-256 hash over an encoded PNG buffer, or over a stride-sampled subset of an RGBA image
 * (avoids hashing 3+ MiB raw RGBA buffers per frame).
 */
export function hashPngOrSample(pngBufferOrRgba) {
  const hash = createHash('sha256');
  if (Buffer.isBuffer(pngBufferOrRgba) || pngBufferOrRgba instanceof Uint8Array) {
    hash.update(pngBufferOrRgba);
    return hash.digest('hex');
  }
  if (pngBufferOrRgba && pngBufferOrRgba.data instanceof Uint8Array) {
    const { width, height, data } = pngBufferOrRgba;
    const head = Buffer.allocUnsafe(8);
    head.writeUInt32BE(width >>> 0, 0);
    head.writeUInt32BE(height >>> 0, 4);
    hash.update(head);
    const stepX = Math.max(1, Math.floor(width / 64));
    const stepY = Math.max(1, Math.floor(height / 48));
    const sampleBuf = Buffer.allocUnsafe(Math.ceil(width / stepX) * Math.ceil(height / stepY) * 3);
    let offset = 0;
    for (let y = 0; y < height; y += stepY) {
      const rowBase = y * width * 4;
      for (let x = 0; x < width; x += stepX) {
        const i = rowBase + x * 4;
        sampleBuf[offset] = data[i];
        sampleBuf[offset + 1] = data[i + 1];
        sampleBuf[offset + 2] = data[i + 2];
        offset += 3;
      }
    }
    hash.update(sampleBuf.subarray(0, offset));
    return hash.digest('hex');
  }
  throw new Error('hashPngOrSample expects a PNG Buffer/Uint8Array or an RGBA image object.');
}
