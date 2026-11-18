import { deflateSync, inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  const typeBytes = Buffer.from(type, 'latin1');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.allocUnsafe(4);
  tail.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([head, typeBytes, data, tail]);
}

export function isValidPngBuffer(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return false;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 33) return false;
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  return b.subarray(12, 16).toString('latin1') === 'IHDR';
}

export function parsePngDimensions(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!isValidPngBuffer(b)) {
    throw new Error('Buffer does not have a valid PNG signature and IHDR chunk');
  }
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bitDepth = b[24];
  const colorType = b[25];
  return { width, height, bitDepth, colorType };
}

export function encodeRgbaPng(width, height, rgbaBytes) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const rowBytes = w * 4;
  const stride = rowBytes + 1;
  const raw = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y += 1) {
    const dstOff = y * stride;
    const srcOff = y * rowBytes;
    raw[dstOff] = 0;
    rgbaBytes.copy(raw, dstOff + 1, srcOff, srcOff + rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(raw, { level: 6 })),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
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

export function decodePngToRgba(pngBuf) {
  const b = Buffer.isBuffer(pngBuf) ? pngBuf : Buffer.from(pngBuf);
  const { width, height, bitDepth, colorType } = parsePngDimensions(b);
  if (bitDepth !== 8 || ![2, 6, 0].includes(colorType)) {
    throw new Error(`Unsupported PNG format for pure-JS decode (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const idatParts = [];
  let offset = 8;
  while (offset + 8 <= b.length) {
    const len = b.readUInt32BE(offset);
    const type = b.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) break;
    if (type === 'IDAT') idatParts.push(b.subarray(dataStart, dataEnd));
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  const inflated = inflateSync(Buffer.concat(idatParts));
  const rowBytes = width * channels;
  const stride = rowBytes + 1;
  const unfilter = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[y * stride];
    const srcStart = y * stride + 1;
    const dstStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const raw = inflated[srcStart + i];
      const left = i >= channels ? unfilter[dstStart + i - channels] : 0;
      const up = y > 0 ? unfilter[prevStart + i] : 0;
      const upLeft = y > 0 && i >= channels ? unfilter[prevStart + i - channels] : 0;
      let recon = raw;
      if (filterType === 1) recon = (raw + left) & 0xff;
      else if (filterType === 2) recon = (raw + up) & 0xff;
      else if (filterType === 3) recon = (raw + ((left + up) >>> 1)) & 0xff;
      else if (filterType === 4) recon = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      unfilter[dstStart + i] = recon;
    }
  }

  if (channels === 4) return { width, height, rgba: unfilter };
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    if (channels === 3) {
      rgba[p * 4] = unfilter[p * 3];
      rgba[p * 4 + 1] = unfilter[p * 3 + 1];
      rgba[p * 4 + 2] = unfilter[p * 3 + 2];
      rgba[p * 4 + 3] = 255;
    } else {
      const g = unfilter[p];
      rgba[p * 4] = g;
      rgba[p * 4 + 1] = g;
      rgba[p * 4 + 2] = g;
      rgba[p * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export function cropAndScaleRgba(srcRgba, srcWidth, srcHeight, cropRect, dstWidth, dstHeight) {
  const cx = cropRect ? cropRect.x : 0;
  const cy = cropRect ? cropRect.y : 0;
  const cw = cropRect ? cropRect.width : srcWidth;
  const ch = cropRect ? cropRect.height : srcHeight;
  const dw = Math.max(1, Math.round(dstWidth));
  const dh = Math.max(1, Math.round(dstHeight));
  const out = Buffer.allocUnsafe(dw * dh * 4);

  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(srcHeight - 1, Math.max(0, cy + Math.floor(((y + 0.5) * ch) / dh)));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(srcWidth - 1, Math.max(0, cx + Math.floor(((x + 0.5) * cw) / dw)));
      const sOff = (sy * srcWidth + sx) * 4;
      const dOff = (y * dw + x) * 4;
      out[dOff] = srcRgba[sOff];
      out[dOff + 1] = srcRgba[sOff + 1];
      out[dOff + 2] = srcRgba[sOff + 2];
      out[dOff + 3] = srcRgba[sOff + 3];
    }
  }
  return out;
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

export function applyGridOverlayToPng(pngBuffer) {
  const { width, height, rgba } = decodePngToRgba(pngBuffer);
  for (let step = 100; step <= 900; step += 100) {
    const gx = Math.round((step / 1000) * (width - 1));
    const gy = Math.round((step / 1000) * (height - 1));
    const alpha = step === 500 ? 0.55 : 0.34;
    for (let y = 0; y < height; y += 1) {
      blendPixel(rgba, width, height, gx, y, 44, 94, 79, alpha);
    }
    for (let x = 0; x < width; x += 1) {
      blendPixel(rgba, width, height, x, gy, 44, 94, 79, alpha);
    }
    drawTinyLabel(rgba, width, height, Math.min(width - 20, gx + 2), 3, String(step));
    drawTinyLabel(rgba, width, height, 3, Math.min(height - 12, gy + 2), String(step));
  }
  return encodeRgbaPng(width, height, rgba);
}

/**
 * Create a deterministic synthetic desktop surface PNG (used by tests and sample provider servers).
 */
export function createSyntheticSurfacePng(width = 640, height = 360, marker = null) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const rgba = Buffer.allocUnsafe(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const off = (y * w + x) * 4;
      rgba[off] = 246 - ((x * 24) / w) | 0;
      rgba[off + 1] = 244 - ((y * 20) / h) | 0;
      rgba[off + 2] = 239;
      rgba[off + 3] = 255;
    }
  }
  if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
    const mx = Math.round(marker.x);
    const my = Math.round(marker.y);
    const mr = Math.max(2, Math.round(marker.radius || 8));
    const color = marker.color || [44, 94, 79];
    for (let y = Math.max(0, my - mr); y <= Math.min(h - 1, my + mr); y += 1) {
      for (let x = Math.max(0, mx - mr); x <= Math.min(w - 1, mx + mr); x += 1) {
        const off = (y * w + x) * 4;
        rgba[off] = color[0];
        rgba[off + 1] = color[1];
        rgba[off + 2] = color[2];
        rgba[off + 3] = 255;
      }
    }
  }
  return encodeRgbaPng(w, h, rgba);
}
