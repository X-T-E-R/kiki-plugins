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
