import { protocolError, RfbError } from '../errors.js';
import { checkZlibLength } from '../inflator.js';
import { bytesPerPixel, isTightRgb, readPixel, rgbToPixels, writePixel } from '../pixel-format.js';
import { decodePng } from '../png.js';
import { PixelBuffer } from './util.js';
const FILL = 0x08;
const JPEG = 0x09;
const PNG_OR_NO_ZLIB = 0x0a;
const NO_ZLIB_WITH_FILTER = 0x0e;
const COPY_FILTER = 0;
const PALETTE_FILTER = 1;
const GRADIENT_FILTER = 2;
/** Below this many bytes Tight sends filtered data uncompressed. */
const MIN_TO_COMPRESS = 12;
/**
 * Tight (`png` false) and TightPNG (`png` true). `streams` are the connection's four zlib streams.
 * JPEG rects become pixels with `decodeJpeg`, else they are returned as `{ jpeg }`.
 */
export async function decodeTight(reader, streams, w, h, pf, png, decodeJpeg) {
    const name = png ? 'TightPNG' : 'Tight';
    const control = await reader.u8();
    for (let i = 0; i < 4; i++)
        if (control & (1 << i))
            streams[i].reset();
    const bpp = bytesPerPixel(pf);
    const rgb = isTightRgb(pf);
    const tpixel = rgb ? 3 : bpp;
    const comp = control >> 4;
    if (comp === FILL) {
        const pixel = toPixels(pf, await reader.read(tpixel), 1, rgb);
        const out = new PixelBuffer(w, h, bpp);
        out.fill(0, 0, w, h, PixelBuffer.word(pixel, 0, bpp));
        return { data: out.data };
    }
    if (comp === JPEG) {
        const jpeg = await reader.read(await compactLength(reader));
        // A JPEG decoder allocates for the size in the JPEG's header, which a few hundred bytes can set
        // to gigapixels: only a JPEG of the rect's own size goes on.
        const size = jpegSize(jpeg);
        if (size === null)
            throw protocolError(`${name}: JPEG data without a frame header`);
        if (size.width !== w || size.height !== h) {
            throw protocolError(`${name}: a ${size.width}×${size.height} JPEG for a ${w}×${h} rect`);
        }
        if (!decodeJpeg)
            return { jpeg };
        return { data: fromRgb(pf, await decodeJpeg(jpeg, w, h), w, h, 'JPEG') };
    }
    // TightPNG is Tight plus PngCompression (high nibble 0xA). Fill, JPEG and basic
    // compression stay valid: QEMU sends basic compression for an 8-bit client, which
    // cannot carry a PNG. 0xA means "no zlib" only for plain Tight.
    if (png && comp === PNG_OR_NO_ZLIB) {
        const image = decodePng(await reader.read(await compactLength(reader)), { width: w, height: h });
        return { data: fromRgb(pf, image.rgba, w, h, 'PNG') };
    }
    let filter = COPY_FILTER;
    let compressed = true;
    if (comp & 0x08) {
        // BasicCompression Without Zlib.
        if (comp !== PNG_OR_NO_ZLIB && comp !== NO_ZLIB_WITH_FILTER) {
            throw protocolError(`${name}: invalid compression control 0x${control.toString(16)}`);
        }
        compressed = false;
        if (comp === NO_ZLIB_WITH_FILTER)
            filter = await reader.u8();
    }
    else if (comp & 0x04) {
        filter = await reader.u8();
    }
    const stream = streams[comp & 0x03];
    const readData = async (size) => {
        if (!compressed || size < MIN_TO_COMPRESS)
            return reader.read(size);
        const length = await compactLength(reader);
        checkZlibLength(length, size, name);
        return stream.inflate(await reader.read(length), size);
    };
    switch (filter) {
        case COPY_FILTER: {
            const data = await readData(w * h * tpixel);
            return { data: rgb ? toPixels(pf, data, w * h, true) : Buffer.from(data) };
        }
        case PALETTE_FILTER: {
            const colors = (await reader.u8()) + 1;
            const pixels = toPixels(pf, await reader.read(colors * tpixel), colors, rgb);
            const palette = new Uint32Array(colors);
            for (let i = 0; i < colors; i++)
                palette[i] = PixelBuffer.word(pixels, i * bpp, bpp);
            const out = new PixelBuffer(w, h, bpp);
            const words = out.words;
            if (colors === 2) {
                const rowBytes = (w + 7) >> 3;
                const bits = await readData(rowBytes * h);
                for (let y = 0, i = 0; y < h; y++) {
                    for (let x = 0; x < w; x++, i++) {
                        words[i] = palette[(bits[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1];
                    }
                }
            }
            else {
                const indices = await readData(w * h);
                for (let i = 0; i < w * h; i++) {
                    const index = indices[i];
                    if (index >= colors)
                        throw protocolError(`${name}: palette index ${index} of ${colors} colours`);
                    words[i] = palette[index];
                }
            }
            return { data: out.data };
        }
        case GRADIENT_FILTER: {
            if (pf.bitsPerPixel === 8)
                throw protocolError(`${name}: the gradient filter needs 16 or 32 bits per pixel`);
            const data = await readData(w * h * tpixel);
            return { data: rgb ? toPixels(pf, gradientRgb(data, w, h), w * h, true) : gradient(pf, data, w, h) };
        }
        default:
            throw protocolError(`${name}: unknown filter ${filter}`);
    }
}
/** Tight's compact length: 1 to 3 bytes, 7 bits each (the third byte 8), least significant first. */
async function compactLength(reader) {
    let b = await reader.u8();
    let length = b & 0x7f;
    if (b & 0x80) {
        b = await reader.u8();
        length |= (b & 0x7f) << 7;
        if (b & 0x80)
            length |= (await reader.u8()) << 14;
    }
    return length;
}
/**
 * The image size in a JPEG's frame header (SOFn), or null when the markers before the image data
 * hold none.
 */
export function jpegSize(jpeg) {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
        return null;
    let pos = 2;
    while (pos + 4 <= jpeg.length) {
        if (jpeg[pos] !== 0xff)
            return null;
        const marker = jpeg[pos + 1];
        if (marker === 0xff) {
            pos++; // a fill byte
            continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            pos += 2; // TEM, RSTn, SOI: no length
            continue;
        }
        // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC): length, precision, height, width.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (pos + 9 > jpeg.length)
                return null;
            return { width: jpeg.readUInt16BE(pos + 7), height: jpeg.readUInt16BE(pos + 5) };
        }
        if (marker === 0xda || marker === 0xd9)
            return null; // the scan (or the end) before a frame header
        pos += 2 + jpeg.readUInt16BE(pos + 2);
    }
    return null;
}
/** `count` TPIXELs as pixels: R, G, B triplets when `rgb`, else already pixels. */
function toPixels(pf, tpixels, count, rgb) {
    if (!rgb)
        return Buffer.from(tpixels);
    const out = Buffer.alloc(count * bytesPerPixel(pf));
    rgbToPixels(pf, tpixels, 3, count, out);
    return out;
}
/** RGB or RGBA (by length) image data as pixels. */
function fromRgb(pf, image, w, h, what) {
    const stride = image.length === w * h * 4 ? 4 : image.length === w * h * 3 ? 3 : 0;
    if (stride === 0) {
        throw new RfbError('PROTOCOL_ERROR', `the ${what} decoder returned ${image.length} bytes for a ${w}×${h} rect; it must return RGB or RGBA pixels`);
    }
    const out = Buffer.alloc(w * h * bytesPerPixel(pf));
    rgbToPixels(pf, image, stride, w * h, out);
    return out;
}
/** Undoes the gradient filter on R, G, B bytes (TPIXELs). */
function gradientRgb(data, w, h) {
    const out = Buffer.alloc(w * h * 3);
    const rowBytes = w * 3;
    for (let y = 0; y < h; y++) {
        const row = y * rowBytes;
        for (let x = 0; x < w; x++) {
            for (let c = 0; c < 3; c++) {
                const i = row + x * 3 + c;
                const up = y > 0 ? out[i - rowBytes] : 0;
                const left = x > 0 ? out[i - 3] : 0;
                const upLeft = x > 0 && y > 0 ? out[i - rowBytes - 3] : 0;
                const predicted = Math.min(255, Math.max(0, up + left - upLeft));
                out[i] = (predicted + data[i]) & 0xff;
            }
        }
    }
    return out;
}
/** Undoes the gradient filter on 16/32-bit pixels: per colour component, modulo the component's range. */
function gradient(pf, data, w, h) {
    const bpp = bytesPerPixel(pf);
    const max = [pf.redMax, pf.greenMax, pf.blueMax];
    const shift = [pf.redShift, pf.greenShift, pf.blueShift];
    const out = Buffer.alloc(w * h * bpp);
    // Reconstructed components of the previous and the current row.
    let prev = new Int32Array(w * 3);
    let cur = new Int32Array(w * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const diff = readPixel(pf, data, (y * w + x) * bpp);
            let value = 0;
            for (let c = 0; c < 3; c++) {
                const m = max[c];
                const up = prev[x * 3 + c];
                const left = x > 0 ? cur[(x - 1) * 3 + c] : 0;
                const upLeft = x > 0 ? prev[(x - 1) * 3 + c] : 0;
                const predicted = Math.min(m, Math.max(0, up + left - upLeft));
                const v = (predicted + ((diff >>> shift[c]) & m)) & m;
                cur[x * 3 + c] = v;
                value |= v << shift[c];
            }
            writePixel(pf, value >>> 0, out, (y * w + x) * bpp);
        }
        ;
        [prev, cur] = [cur, prev];
    }
    return out;
}
//# sourceMappingURL=tight.js.map