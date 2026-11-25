// Encoders for RFB messages. Every function returns one complete message as a Buffer.
import { clientMsgTypes, serverMsgTypes } from './constants.js';
import { RfbError } from './errors.js';
import { writePixelFormat } from './pixel-format.js';
// --- client to server ---
export function setPixelFormat(pf) {
    const b = Buffer.alloc(20);
    b[0] = clientMsgTypes.setPixelFormat;
    writePixelFormat(pf, b, 4);
    return b;
}
export function setEncodings(list) {
    const b = Buffer.alloc(4 + 4 * list.length);
    b[0] = clientMsgTypes.setEncodings;
    b.writeUInt16BE(list.length, 2);
    list.forEach((e, i) => {
        b.writeInt32BE(e | 0, 4 + 4 * i);
    });
    return b;
}
export function framebufferUpdateRequest(incremental, x, y, width, height) {
    const b = Buffer.alloc(10);
    b[0] = clientMsgTypes.fbUpdate;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(u16(x, 'x'), 2);
    b.writeUInt16BE(u16(y, 'y'), 4);
    b.writeUInt16BE(u16(width, 'width'), 6);
    b.writeUInt16BE(u16(height, 'height'), 8);
    return b;
}
export function keyEvent(down, keysym) {
    const b = Buffer.alloc(8);
    b[0] = clientMsgTypes.keyEvent;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    return b;
}
/**
 * PointerEvent. With `extendedButtons` (the server confirmed ExtendedMouseButtons), buttons 8+ go in
 * a second mask byte and the marker bit is set.
 */
export function pointerEvent(buttonMask, x, y, extendedButtons = false) {
    if (extendedButtons && buttonMask > 0x7f) {
        const b = Buffer.alloc(7);
        b[0] = clientMsgTypes.pointerEvent;
        b[1] = (buttonMask & 0x7f) | 0x80;
        b.writeUInt16BE(u16(x, 'x'), 2);
        b.writeUInt16BE(u16(y, 'y'), 4);
        b[6] = (buttonMask >>> 7) & 0xff;
        return b;
    }
    const b = Buffer.alloc(6);
    b[0] = clientMsgTypes.pointerEvent;
    b[1] = buttonMask & 0xff;
    b.writeUInt16BE(u16(x, 'x'), 2);
    b.writeUInt16BE(u16(y, 'y'), 4);
    return b;
}
/** ClientCutText with Latin-1 text (characters outside Latin-1 become '?'). */
export function clientCutText(text) {
    const data = latin1(text);
    const b = Buffer.alloc(8 + data.length);
    b[0] = clientMsgTypes.cutText;
    b.writeUInt32BE(data.length, 4);
    data.copy(b, 8);
    return b;
}
/** ClientCutText carrying an Extended Clipboard payload (negative length). */
export function clientCutTextExtended(payload) {
    const b = Buffer.alloc(8 + payload.length);
    b[0] = clientMsgTypes.cutText;
    b.writeInt32BE(-payload.length, 4);
    payload.copy(b, 8);
    return b;
}
export function enableContinuousUpdates(enable, x, y, width, height) {
    const b = Buffer.alloc(10);
    b[0] = clientMsgTypes.enableContinuousUpdates;
    b[1] = enable ? 1 : 0;
    b.writeUInt16BE(u16(x, 'x'), 2);
    b.writeUInt16BE(u16(y, 'y'), 4);
    b.writeUInt16BE(u16(width, 'width'), 6);
    b.writeUInt16BE(u16(height, 'height'), 8);
    return b;
}
export function clientFence(flags, payload = Buffer.alloc(0)) {
    if (payload.length > 64)
        throw new RfbError('INVALID_ARGUMENT', 'a fence payload is at most 64 bytes');
    const b = Buffer.alloc(9 + payload.length);
    b[0] = clientMsgTypes.fence;
    b.writeUInt32BE(flags >>> 0, 4);
    b[8] = payload.length;
    b.set(payload, 9);
    return b;
}
export function xvp(version, code) {
    return Buffer.from([clientMsgTypes.xvp, 0, version, code]);
}
export function setDesktopSize(width, height, screens) {
    if (screens.length > 255)
        throw new RfbError('INVALID_ARGUMENT', 'at most 255 screens');
    const b = Buffer.alloc(8 + 16 * screens.length);
    b[0] = clientMsgTypes.setDesktopSize;
    b.writeUInt16BE(u16(width, 'width'), 2);
    b.writeUInt16BE(u16(height, 'height'), 4);
    b[6] = screens.length;
    screens.forEach((s, i) => {
        writeScreen(s, b, 8 + 16 * i);
    });
    return b;
}
export function qemuExtendedKeyEvent(down, keysym, keycode) {
    const b = Buffer.alloc(12);
    b[0] = clientMsgTypes.qemu;
    b[1] = 0;
    b.writeUInt16BE(down ? 1 : 0, 2);
    b.writeUInt32BE(keysym >>> 0, 4);
    b.writeUInt32BE(keycode >>> 0, 8);
    return b;
}
/** QEMU audio operations: 0 enable, 1 disable. */
export function qemuAudio(operation) {
    return Buffer.from([clientMsgTypes.qemu, 1, 0, operation]);
}
export function qemuAudioSetFormat(sampleFormat, channels, frequency) {
    const b = Buffer.alloc(10);
    b[0] = clientMsgTypes.qemu;
    b[1] = 1;
    b.writeUInt16BE(2, 2);
    b[4] = sampleFormat;
    b[5] = channels;
    b.writeUInt32BE(frequency >>> 0, 6);
    return b;
}
// --- server to client ---
export function serverInit(width, height, pf, name) {
    const nameBytes = Buffer.from(name, 'utf8');
    const b = Buffer.alloc(24 + nameBytes.length);
    b.writeUInt16BE(width, 0);
    b.writeUInt16BE(height, 2);
    writePixelFormat(pf, b, 4);
    b.writeUInt32BE(nameBytes.length, 20);
    nameBytes.copy(b, 24);
    return b;
}
export function framebufferUpdateHeader(rectCount) {
    const b = Buffer.alloc(4);
    b[0] = serverMsgTypes.fbUpdate;
    b.writeUInt16BE(rectCount, 2);
    return b;
}
export function rectHeader(x, y, width, height, encoding) {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(x, 0);
    b.writeUInt16BE(y, 2);
    b.writeUInt16BE(width, 4);
    b.writeUInt16BE(height, 6);
    b.writeInt32BE(encoding | 0, 8);
    return b;
}
export function setColourMapEntries(firstColor, colors) {
    const b = Buffer.alloc(6 + 6 * colors.length);
    b[0] = serverMsgTypes.setColorMap;
    b.writeUInt16BE(firstColor, 2);
    b.writeUInt16BE(colors.length, 4);
    colors.forEach((c, i) => {
        b.writeUInt16BE(c.r, 6 + 6 * i);
        b.writeUInt16BE(c.g, 8 + 6 * i);
        b.writeUInt16BE(c.b, 10 + 6 * i);
    });
    return b;
}
export function bell() {
    return Buffer.from([serverMsgTypes.bell]);
}
export function serverCutText(text) {
    const data = latin1(text);
    const b = Buffer.alloc(8 + data.length);
    b[0] = serverMsgTypes.cutText;
    b.writeUInt32BE(data.length, 4);
    data.copy(b, 8);
    return b;
}
export function writeScreen(s, b, offset) {
    b.writeUInt32BE(s.id >>> 0, offset);
    b.writeUInt16BE(s.x, offset + 4);
    b.writeUInt16BE(s.y, offset + 6);
    b.writeUInt16BE(s.width, offset + 8);
    b.writeUInt16BE(s.height, offset + 10);
    b.writeUInt32BE(s.flags >>> 0, offset + 12);
}
/** A length-prefixed (U32) string, as used for reasons and names. */
export function lengthPrefixed(text, encoding = 'utf8') {
    const data = Buffer.from(text, encoding);
    const b = Buffer.alloc(4 + data.length);
    b.writeUInt32BE(data.length, 0);
    data.copy(b, 4);
    return b;
}
/** Latin-1 bytes of `text`; characters outside Latin-1 become '?'. */
export function latin1(text) {
    let safe = '';
    for (const ch of text)
        safe += ch.codePointAt(0) > 0xff ? '?' : ch;
    return Buffer.from(safe, 'latin1');
}
function u16(v, what) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
        throw new RfbError('INVALID_ARGUMENT', `${what} must be an integer 0..65535, not ${v}`);
    }
    return v;
}
//# sourceMappingURL=messages.js.map