import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { clientMsgTypes, encodings as E, security as S } from './constants.js';
import { vncAuthResponse } from './des.js';
import { protocolError, RfbError } from './errors.js';
import * as msg from './messages.js';
import { bytesPerPixel, pixelFormats, pixelToRgb, readPixel, readPixelFormat, rgbToPixel, samePixelFormat, validatePixelFormat, writePixel, } from './pixel-format.js';
import { Transport } from './transport.js';
/**
 * The server side of one RFB connection: runs the handshake (None or VNC authentication), parses
 * the client's messages into events, and sends updates in the format the client asked for.
 */
export class RfbServerConnection extends EventEmitter {
    width;
    height;
    name;
    pixelFormat;
    /** The format the client wants pixels in. */
    clientPixelFormat;
    /** The client's encodings, most preferred first. */
    clientEncodings = [];
    version = '3.8';
    #options;
    #transport;
    #closed = false;
    constructor(stream, options) {
        super();
        this.#options = options;
        this.width = options.width;
        this.height = options.height;
        this.name = options.name ?? 'rfb2';
        this.pixelFormat = options.pixelFormat ?? pixelFormats.bgrx;
        validatePixelFormat(this.pixelFormat);
        this.clientPixelFormat = this.pixelFormat;
        this.#transport = new Transport(stream, true);
        void this.#run();
    }
    /** Sends one FramebufferUpdate with `rects`. */
    sendUpdate(rects) {
        const parts = [msg.framebufferUpdateHeader(rects.length)];
        const cbpp = bytesPerPixel(this.clientPixelFormat);
        for (const r of rects) {
            switch (r.type) {
                case 'pixels':
                    parts.push(msg.rectHeader(r.x, r.y, r.width, r.height, E.raw), this.#convert(r.data));
                    break;
                case 'copy': {
                    const src = Buffer.alloc(4);
                    src.writeUInt16BE(r.src.x, 0);
                    src.writeUInt16BE(r.src.y, 2);
                    parts.push(msg.rectHeader(r.x, r.y, r.width, r.height, E.copyRect), src);
                    break;
                }
                case 'desktopSize':
                    this.width = r.width;
                    this.height = r.height;
                    parts.push(msg.rectHeader(0, 0, r.width, r.height, E.pseudoDesktopSize));
                    break;
                case 'cursor': {
                    const pixels = this.#convert(r.data);
                    if (pixels.length !== r.width * r.height * cbpp)
                        throw new RfbError('INVALID_ARGUMENT', 'cursor data size');
                    parts.push(msg.rectHeader(r.x, r.y, r.width, r.height, E.pseudoCursor), pixels, Buffer.from(r.mask));
                    break;
                }
                case 'encoded':
                    parts.push(msg.rectHeader(r.x, r.y, r.width, r.height, r.encoding), Buffer.from(r.body));
                    break;
            }
        }
        this.#write(Buffer.concat(parts));
    }
    bell() {
        this.#write(msg.bell());
    }
    /** ServerCutText (Latin-1). */
    cutText(text) {
        this.#write(msg.serverCutText(text));
    }
    setColorMap(firstColor, colors) {
        this.#write(msg.setColourMapEntries(firstColor, colors));
    }
    /** Sends raw bytes (for messages this class doesn't build). */
    write(data) {
        this.#write(data);
    }
    end() {
        this.#transport.end();
    }
    destroy() {
        this.#transport.destroy();
    }
    #write(data) {
        if (!this.#closed)
            this.#transport.write(data);
    }
    /** Pixels in the server's format to the client's. */
    #convert(data) {
        const from = this.pixelFormat;
        const to = this.clientPixelFormat;
        if (samePixelFormat(from, to))
            return Buffer.from(data);
        const fb = bytesPerPixel(from);
        const tb = bytesPerPixel(to);
        const n = Math.floor(data.length / fb);
        const out = Buffer.alloc(n * tb);
        for (let i = 0; i < n; i++) {
            const [r, g, b] = pixelToRgb(from, readPixel(from, data, i * fb));
            writePixel(to, rgbToPixel(to, r, g, b), out, i * tb);
        }
        return out;
    }
    async #run() {
        try {
            await this.#handshake();
            await this.#loop();
            this.#finish(null);
        }
        catch (err) {
            this.#finish(err);
        }
    }
    #finish(err) {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#transport.destroy();
        const clean = err === null || (err instanceof RfbError && err.code === 'CONNECTION_CLOSED');
        try {
            if (!clean) {
                this.emit('error', err instanceof RfbError ? err : new RfbError('PROTOCOL_ERROR', String(err?.message ?? err)));
            }
        }
        finally {
            this.emit('close');
        }
    }
    async #handshake() {
        const t = this.#transport;
        const r = t.reader;
        const offered = this.#options.version ?? '3.8';
        t.write(Buffer.from(`RFB 003.00${offered[2]}\n`, 'latin1'));
        const reply = await r.string(12, 'latin1');
        const m = /^RFB 003\.00([378])\n$/.exec(reply);
        if (!m || m[1] === undefined || m[1] > offered[2]) {
            throw new RfbError('UNSUPPORTED_VERSION', `the client answered ${JSON.stringify(reply)}`);
        }
        this.version = `3.${m[1]}`;
        const type = this.#options.password !== undefined ? S.VNC : S.None;
        if (this.version === '3.3') {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(type);
            t.write(b);
        }
        else {
            t.write(Buffer.from([1, type]));
            const chosen = await r.u8();
            if (chosen !== type)
                throw new RfbError('UNSUPPORTED_SECURITY', `the client chose security type ${chosen}`);
        }
        if (type === S.VNC) {
            const challenge = randomBytes(16);
            t.write(challenge);
            const response = await r.read(16);
            const ok = timingSafeEqual(response, vncAuthResponse(challenge, this.#options.password ?? ''));
            if (!ok) {
                t.write(Buffer.from([0, 0, 0, 1]));
                if (this.version === '3.8')
                    t.write(msg.lengthPrefixed('authentication failed'));
                t.end();
                throw new RfbError('AUTH_FAILED', 'the client sent a wrong password');
            }
            t.write(Buffer.alloc(4));
        }
        else if (this.version === '3.8') {
            t.write(Buffer.alloc(4));
        }
        const shared = (await r.u8()) !== 0;
        t.write(msg.serverInit(this.width, this.height, this.pixelFormat, this.name));
        this.emit('ready', { shared, version: this.version });
    }
    async #loop() {
        const r = this.#transport.reader;
        for (;;) {
            let type;
            try {
                type = await r.u8();
            }
            catch (err) {
                if (err instanceof RfbError && err.code === 'CONNECTION_CLOSED' && r.available === 0)
                    return;
                throw err;
            }
            switch (type) {
                case clientMsgTypes.setPixelFormat: {
                    const pf = readPixelFormat(await r.read(19), 3);
                    validatePixelFormat(pf, true);
                    this.clientPixelFormat = pf;
                    this.emit('setPixelFormat', pf);
                    break;
                }
                case clientMsgTypes.setEncodings: {
                    const count = (await r.read(3)).readUInt16BE(1);
                    const data = await r.read(4 * count);
                    this.clientEncodings = Array.from({ length: count }, (_, i) => data.readInt32BE(4 * i));
                    this.emit('setEncodings', this.clientEncodings);
                    break;
                }
                case clientMsgTypes.fbUpdate: {
                    const b = await r.read(9);
                    this.emit('updateRequest', {
                        incremental: b[0] !== 0,
                        x: b.readUInt16BE(1),
                        y: b.readUInt16BE(3),
                        width: b.readUInt16BE(5),
                        height: b.readUInt16BE(7),
                    });
                    break;
                }
                case clientMsgTypes.keyEvent: {
                    const b = await r.read(7);
                    this.emit('key', { down: b[0] !== 0, keysym: b.readUInt32BE(3) });
                    break;
                }
                case clientMsgTypes.pointerEvent: {
                    const b = await r.read(5);
                    this.emit('pointer', { buttons: b[0], x: b.readUInt16BE(1), y: b.readUInt16BE(3) });
                    break;
                }
                case clientMsgTypes.cutText: {
                    const length = (await r.read(7)).readInt32BE(3);
                    if (length < 0 || length > 64 * 1024 * 1024)
                        throw protocolError(`a ClientCutText of length ${length}`);
                    this.emit('clipboard', await r.string(length, 'latin1'));
                    break;
                }
                default:
                    throw new RfbError('UNSUPPORTED_MESSAGE', `the client sent message type ${type}`);
            }
        }
    }
}
/** A TCP server that runs an RfbServerConnection for every client. */
export function createServer(options, onConnection) {
    return net.createServer((socket) => {
        socket.setNoDelay(true);
        const conn = new RfbServerConnection(socket, options);
        onConnection?.(conn);
    });
}
//# sourceMappingURL=server.js.map