import { blit, fill } from './encodings/util.js';
import { RfbError } from './errors.js';
import { bytesPerPixel, pixelFormats, toRgba } from './pixel-format.js';
/**
 * A client-side copy of the remote screen: apply every rect of every update in order and `data`
 * holds the screen in `pixelFormat`. `toRgba()` converts it for PNG encoders and canvases.
 */
export class Framebuffer {
    width;
    height;
    pixelFormat;
    bytesPerPixel;
    data;
    constructor(width, height, pixelFormat = pixelFormats.bgrx) {
        this.width = width;
        this.height = height;
        this.pixelFormat = pixelFormat;
        this.bytesPerPixel = bytesPerPixel(pixelFormat);
        this.data = Buffer.alloc(width * height * this.bytesPerPixel);
    }
    /** A framebuffer that follows `client`: sized and formatted like it, with every rect applied. */
    static attach(client) {
        const fb = new Framebuffer(client.width, client.height, client.pixelFormat);
        client.on('rect', (rect) => fb.apply(rect));
        return fb;
    }
    get stride() {
        return this.width * this.bytesPerPixel;
    }
    /**
     * Applies a rect: pixels are drawn, CopyRect copies, DesktopSize/ExtendedDesktopSize resize.
     * Returns false for rects that don't change the framebuffer (cursor, JPEG without a decoder, ...).
     */
    apply(rect) {
        switch (rect.type) {
            case 'pixels':
                this.put(rect.x, rect.y, rect.width, rect.height, rect.data);
                return true;
            case 'copy':
                this.copy(rect.src.x, rect.src.y, rect.x, rect.y, rect.width, rect.height);
                return true;
            case 'desktopSize':
                this.resize(rect.width, rect.height);
                return true;
            case 'extendedDesktopSize':
                if (rect.reason === 1 && rect.status !== 0)
                    return false;
                this.resize(rect.width, rect.height);
                return true;
            default:
                return false;
        }
    }
    /** Draws `w`×`h` tightly packed pixels at `x`, `y`. */
    put(x, y, w, h, pixels) {
        this.#check(x, y, w, h);
        blit(this.data, this.stride, this.bytesPerPixel, x, y, w, h, pixels);
    }
    /** Fills an area with one pixel value (`bytesPerPixel` bytes). */
    fill(x, y, w, h, pixel) {
        this.#check(x, y, w, h);
        fill(this.data, this.stride, this.bytesPerPixel, x, y, w, h, pixel);
    }
    /** Copies an area within the framebuffer; overlapping areas copy correctly. */
    copy(srcX, srcY, x, y, w, h) {
        this.#check(srcX, srcY, w, h);
        this.#check(x, y, w, h);
        const stride = this.stride;
        const rowBytes = w * this.bytesPerPixel;
        // Moving down: copy the bottom row first so no source row is overwritten before it's read.
        const down = y > srcY;
        for (let i = 0; i < h; i++) {
            const r = down ? h - 1 - i : i;
            const from = (srcY + r) * stride + srcX * this.bytesPerPixel;
            this.data.copy(this.data, (y + r) * stride + x * this.bytesPerPixel, from, from + rowBytes);
        }
    }
    /** Changes the size, keeping the top-left content. */
    resize(width, height) {
        if (width === this.width && height === this.height)
            return;
        const next = Buffer.alloc(width * height * this.bytesPerPixel);
        const w = Math.min(width, this.width);
        for (let y = 0; y < Math.min(height, this.height); y++) {
            this.data.copy(next, y * width * this.bytesPerPixel, y * this.stride, y * this.stride + w * this.bytesPerPixel);
        }
        this.data = next;
        this.width = width;
        this.height = height;
    }
    /** The framebuffer (or an area of it) as RGBA, alpha 255. Colour-map formats need the client's `colorMap`. */
    toRgba(colorMap, area = { x: 0, y: 0, width: this.width, height: this.height }) {
        const { x, y, width, height } = area;
        this.#check(x, y, width, height);
        if (x === 0 && width === this.width) {
            return toRgba(this.pixelFormat, this.data.subarray(y * this.stride, (y + height) * this.stride), colorMap);
        }
        const rows = Buffer.alloc(width * height * this.bytesPerPixel);
        for (let r = 0; r < height; r++) {
            const from = (y + r) * this.stride + x * this.bytesPerPixel;
            this.data.copy(rows, r * width * this.bytesPerPixel, from, from + width * this.bytesPerPixel);
        }
        return toRgba(this.pixelFormat, rows, colorMap);
    }
    #check(x, y, w, h) {
        if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > this.width || y + h > this.height) {
            throw new RfbError('INVALID_ARGUMENT', `${w}×${h} at ${x},${y} is outside the ${this.width}×${this.height} framebuffer`);
        }
    }
}
//# sourceMappingURL=framebuffer.js.map