import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execAdb } from './adb.mjs';

const defaultExecFile = execAdb;

export const SCRCPY_SERVER_VERSION = '4.0';
export const SCRCPY_SERVER_URL = 'https://github.com/Genymobile/scrcpy/releases/download/v4.0/scrcpy-server-v4.0';
export const SCRCPY_SERVER_SHA256 = '84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a';
export const SCRCPY_DEVICE_JAR_PATH = '/data/local/tmp/kiki-scrcpy-server-v4.0.jar';
export const SCRCPY_STREAM_PROTOCOL = 'h264-scrcpy-v1';

export const FRAME_PACKET_MAGIC = 0x4b; // 'K'
export const CLIENT_TOUCH_MAGIC = 0x54; // 'T'
export const CLIENT_SCROLL_MAGIC = 0x53; // 'S'

const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;

export const CONTROL_MSG = Object.freeze({
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  RESET_VIDEO: 17,
});

export const ANDROID_KEYCODE = Object.freeze({
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  UP: 19,
  DPAD_DOWN: 20,
  DOWN: 20,
  DPAD_LEFT: 21,
  LEFT: 21,
  DPAD_RIGHT: 22,
  RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  BACKSPACE: 67,
  MENU: 82,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  ESC: 111,
  FORWARD_DEL: 112,
  DELETE: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  APP_SWITCH: 187,
  RECENTS: 187,
  WAKEUP: 224,
  SLEEP: 223,
});

const POINTER_ID_GENERIC_FINGER = -2n;
const CONTROL_IDLE_TTL_MS = 90_000;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function extractAvcCodecFromAnnexB(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
  const len = bytes.length;
  for (let i = 0; i + 6 < len; i++) {
    let nalOffset = -1;
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      nalOffset = i + 3;
    } else if (i + 7 < len && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      nalOffset = i + 4;
    }
    if (nalOffset !== -1 && nalOffset + 3 < len) {
      const nalType = bytes[nalOffset] & 0x1f;
      if (nalType === 7) {
        const p = bytes[nalOffset + 1].toString(16).padStart(2, '0');
        const c = bytes[nalOffset + 2].toString(16).padStart(2, '0');
        const l = bytes[nalOffset + 3].toString(16).padStart(2, '0');
        return `avc1.${p}${c}${l}`;
      }
      i = nalOffset;
    }
  }
  return 'avc1.42e01f';
}

export function hasSpsNalu(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
  const limit = Math.min(bytes.length, 128);
  for (let i = 0; i + 4 < limit; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      if (bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 7) return true;
      if (bytes[i + 2] === 0 && bytes[i + 3] === 1 && i + 4 < limit && (bytes[i + 4] & 0x1f) === 7) return true;
    }
  }
  return false;
}

export function packVideoFrame({ keyFrame, width, height, seq = 0, ptsUs = 0, data }) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = Buffer.allocUnsafe(16 + payload.length);
  out[0] = FRAME_PACKET_MAGIC;
  out[1] = keyFrame ? 1 : 0;
  out.writeUInt16BE(clamp(Math.round(width) || 0, 0, 65535), 2);
  out.writeUInt16BE(clamp(Math.round(height) || 0, 0, 65535), 4);
  out.writeUInt16BE(seq & 0xffff, 6);
  out.writeDoubleBE(Number(ptsUs) || 0, 8);
  payload.copy(out, 16);
  return out;
}

export class ScrcpyVideoStreamParser {
  constructor({ expectDummyByte = true } = {}) {
    this.expectDummyByte = expectDummyByte;
    this.stage = expectDummyByte ? 'dummy' : 'meta';
    this.buffer = Buffer.alloc(0);
    this.deviceName = '';
    this.codecId = '';
    this.codecProfile = 'avc1.42e01f';
    this.width = 0;
    this.height = 0;
    this.latestConfig = null;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return [];
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    const events = [];

    if (this.stage === 'dummy') {
      if (this.buffer.length < 1) return events;
      this.buffer = this.buffer.subarray(1);
      this.stage = 'meta';
    }

    if (this.stage === 'meta') {
      if (this.buffer.length < 68) return events;
      const rawName = this.buffer.subarray(0, 64);
      const nul = rawName.indexOf(0);
      this.deviceName = rawName.subarray(0, nul === -1 ? 64 : nul).toString('utf8');
      const codecCode = this.buffer.readUInt32BE(64);
      if (codecCode === 0 || codecCode === 1) {
        this.buffer = this.buffer.subarray(68);
        this.stage = 'failed';
        events.push({ kind: 'error', message: `scrcpy device video stream disabled (code=${codecCode})` });
        return events;
      }
      this.codecId = this.buffer.subarray(64, 68).toString('ascii').replace(/\0+$/, '');
      this.buffer = this.buffer.subarray(68);
      this.stage = 'packets';
      events.push({ kind: 'header', deviceName: this.deviceName, codecId: this.codecId });
    }

    if (this.stage !== 'packets') return events;

    while (this.buffer.length >= 12) {
      const ptsFlags = this.buffer.readBigUInt64BE(0);
      const thirdWord = this.buffer.readUInt32BE(8);

      if ((ptsFlags & PACKET_FLAG_SESSION) !== 0n) {
        const flagsHi = this.buffer.readUInt32BE(0);
        const width = this.buffer.readUInt32BE(4);
        const height = thirdWord;
        this.buffer = this.buffer.subarray(12);
        this.width = width;
        this.height = height;
        events.push({
          kind: 'session',
          width,
          height,
          isClientResize: Boolean(flagsHi & 1),
        });
        continue;
      }

      const packetSize = thirdWord;
      if (packetSize > 16 * 1024 * 1024) {
        this.stage = 'failed';
        events.push({ kind: 'error', message: `scrcpy frame exceeded 16 MiB sanity limit (${packetSize})` });
        return events;
      }
      if (this.buffer.length < 12 + packetSize) break;

      const payload = Buffer.from(this.buffer.subarray(12, 12 + packetSize));
      this.buffer = this.buffer.subarray(12 + packetSize);

      const isConfig = (ptsFlags & PACKET_FLAG_CONFIG) !== 0n;
      const isKeyFrame = (ptsFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
      const ptsUs = Number(ptsFlags & PTS_MASK);

      if (isConfig) {
        this.latestConfig = payload;
        this.codecProfile = extractAvcCodecFromAnnexB(payload);
        events.push({
          kind: 'config',
          codecProfile: this.codecProfile,
          data: payload,
        });
        continue;
      }

      const accessUnit = isKeyFrame && this.latestConfig && !hasSpsNalu(payload)
        ? Buffer.concat([this.latestConfig, payload])
        : payload;

      events.push({
        kind: 'frame',
        keyFrame: isKeyFrame,
        ptsUs,
        width: this.width,
        height: this.height,
        codecProfile: this.codecProfile,
        data: accessUnit,
      });
    }

    return events;
  }
}

export function encodeTouchEvent({ action, x, y, screenWidth, screenHeight, pointerSlot = 0, buttons = 1 }) {
  const sw = clamp(Math.round(screenWidth) || 1080, 1, 65535);
  const sh = clamp(Math.round(screenHeight) || 2400, 1, 65535);
  const px = clamp(Math.round(x) || 0, 0, sw - 1);
  const py = clamp(Math.round(y) || 0, 0, sh - 1);
  const isRelease = action === 1 || action === 3;
  const buf = Buffer.allocUnsafe(32);
  buf.writeUInt8(CONTROL_MSG.INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(action & 0xff, 1);
  buf.writeBigInt64BE(pointerSlot === 0 ? POINTER_ID_GENERIC_FINGER : BigInt(pointerSlot), 2);
  buf.writeInt32BE(px, 10);
  buf.writeInt32BE(py, 14);
  buf.writeUInt16BE(sw, 18);
  buf.writeUInt16BE(sh, 20);
  buf.writeUInt16BE(isRelease ? 0 : 0xffff, 22);
  buf.writeInt32BE(action === 0 || action === 1 ? 1 : 0, 24);
  buf.writeInt32BE(isRelease ? 0 : (buttons || 1), 28);
  return buf;
}

export function encodeScrollEvent({ x, y, screenWidth, screenHeight, hScroll = 0, vScroll = 0, buttons = 0 }) {
  const sw = clamp(Math.round(screenWidth) || 1080, 1, 65535);
  const sh = clamp(Math.round(screenHeight) || 2400, 1, 65535);
  const px = clamp(Math.round(x) || 0, 0, sw - 1);
  const py = clamp(Math.round(y) || 0, 0, sh - 1);
  const toFixed16 = (v) => clamp(Math.round(clamp(v / 16, -1, 1) * 32767), -32768, 32767);
  const buf = Buffer.allocUnsafe(21);
  buf.writeUInt8(CONTROL_MSG.INJECT_SCROLL_EVENT, 0);
  buf.writeInt32BE(px, 1);
  buf.writeInt32BE(py, 5);
  buf.writeUInt16BE(sw, 9);
  buf.writeUInt16BE(sh, 11);
  buf.writeInt16BE(toFixed16(hScroll), 13);
  buf.writeInt16BE(toFixed16(vScroll), 15);
  buf.writeInt32BE(buttons | 0, 17);
  return buf;
}

export function encodeKeycodeEvent({ action, keycode, repeat = 0, metaState = 0 }) {
  const buf = Buffer.allocUnsafe(14);
  buf.writeUInt8(CONTROL_MSG.INJECT_KEYCODE, 0);
  buf.writeUInt8(action & 0xff, 1);
  buf.writeInt32BE(keycode | 0, 2);
  buf.writeInt32BE(repeat | 0, 6);
  buf.writeInt32BE(metaState | 0, 10);
  return buf;
}

export function encodeBackOrScreenOn(action) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_MSG.BACK_OR_SCREEN_ON, 0);
  buf.writeUInt8(action & 0xff, 1);
  return buf;
}

export function encodeSetDisplayPower(on) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_MSG.SET_DISPLAY_POWER, 0);
  buf.writeUInt8(on ? 1 : 0, 1);
  return buf;
}

export function encodeEmptyControl(type) {
  const buf = Buffer.allocUnsafe(1);
  buf.writeUInt8(type & 0xff, 0);
  return buf;
}

export function encodeInjectTextPackets(text) {
  const str = String(text ?? '');
  if (!str) return [];
  const packets = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const ch of str) {
    const bLen = Buffer.byteLength(ch, 'utf8');
    if (chunkBytes + bLen > 290 && chunk) {
      const body = Buffer.from(chunk, 'utf8');
      const pkt = Buffer.allocUnsafe(5 + body.length);
      pkt.writeUInt8(CONTROL_MSG.INJECT_TEXT, 0);
      pkt.writeUInt32BE(body.length, 1);
      body.copy(pkt, 5);
      packets.push(pkt);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += bLen;
  }
  if (chunk) {
    const body = Buffer.from(chunk, 'utf8');
    const pkt = Buffer.allocUnsafe(5 + body.length);
    pkt.writeUInt8(CONTROL_MSG.INJECT_TEXT, 0);
    pkt.writeUInt32BE(body.length, 1);
    body.copy(pkt, 5);
    packets.push(pkt);
  }
  return packets;
}

export function encodeSetClipboard({ text, paste = true, sequence = 1n }) {
  const raw = Buffer.from(String(text ?? ''), 'utf8');
  const capped = raw.length > 260_000 ? raw.subarray(0, 260_000) : raw;
  const pkt = Buffer.allocUnsafe(14 + capped.length);
  pkt.writeUInt8(CONTROL_MSG.SET_CLIPBOARD, 0);
  pkt.writeBigInt64BE(BigInt(sequence), 1);
  pkt.writeUInt8(paste ? 1 : 0, 9);
  pkt.writeUInt32BE(capped.length, 10);
  capped.copy(pkt, 14);
  return pkt;
}

export function parseClientBinaryControl(buf, screenWidth, screenHeight) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 12 && b[0] === CLIENT_TOUCH_MAGIC) {
    const action = b[1];
    const buttons = b[2];
    const pointerSlot = b[3];
    const normX = clamp(b.readFloatBE(4) || 0, 0, 1);
    const normY = clamp(b.readFloatBE(8) || 0, 0, 1);
    const sw = Math.max(1, Math.round(screenWidth) || 1080);
    const sh = Math.max(1, Math.round(screenHeight) || 2400);
    return encodeTouchEvent({
      action,
      buttons,
      pointerSlot,
      x: Math.min(sw - 1, Math.round(normX * sw)),
      y: Math.min(sh - 1, Math.round(normY * sh)),
      screenWidth: sw,
      screenHeight: sh,
    });
  }
  if (b.length >= 16 && b[0] === CLIENT_SCROLL_MAGIC) {
    const normX = clamp(b.readFloatBE(4) || 0, 0, 1);
    const normY = clamp(b.readFloatBE(8) || 0, 0, 1);
    const hScroll = b.readInt16BE(12) / 2048;
    const vScroll = b.readInt16BE(14) / 2048;
    const sw = Math.max(1, Math.round(screenWidth) || 1080);
    const sh = Math.max(1, Math.round(screenHeight) || 2400);
    return encodeScrollEvent({
      x: Math.min(sw - 1, Math.round(normX * sw)),
      y: Math.min(sh - 1, Math.round(normY * sh)),
      screenWidth: sw,
      screenHeight: sh,
      hScroll,
      vScroll,
    });
  }
  return null;
}

async function verifyJarSha256(filePath) {
  try {
    const bytes = await readFile(filePath);
    return sha256Hex(bytes) === SCRCPY_SERVER_SHA256 ? bytes : null;
  } catch {
    return null;
  }
}

async function extractShimTargetDir(shimFile) {
  try {
    await access(shimFile, fsConstants.R_OK);
    const text = (await readFile(shimFile, 'utf8')).slice(0, 4096);
    const quoted = text.match(/"([^"\r\n]*scrcpy(?:\.exe)?)"/i);
    if (quoted?.[1]) return path.dirname(quoted[1]);
    const plain = text.match(/([A-Za-z]:[\\/][^\s"\r\n]*scrcpy(?:\.exe)?)/i);
    if (plain?.[1]) return path.dirname(plain[1]);
  } catch {}
  return null;
}

const verifiedJarCache = new Map();

export async function ensureScrcpyServer({
  dataDir,
  env = process.env,
  platform = process.platform,
  fetchImpl = fetch,
  allowDownload = true,
  signal,
} = {}) {
  const targetDir = path.join(dataDir, 'scrcpy');
  const cachedJar = path.join(targetDir, `scrcpy-server-v${SCRCPY_SERVER_VERSION}.jar`);

  if (verifiedJarCache.get(cachedJar) === SCRCPY_SERVER_SHA256) {
    try {
      await access(cachedJar, fsConstants.R_OK);
      return { jarPath: cachedJar, version: SCRCPY_SERVER_VERSION, source: 'cache' };
    } catch {
      verifiedJarCache.delete(cachedJar);
    }
  }

  if (await verifyJarSha256(cachedJar)) {
    verifiedJarCache.set(cachedJar, SCRCPY_SERVER_SHA256);
    return { jarPath: cachedJar, version: SCRCPY_SERVER_VERSION, source: 'cache' };
  }

  const candidates = new Set();
  if (env.SCRCPY_SERVER_PATH) candidates.add(path.resolve(env.SCRCPY_SERVER_PATH));

  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    candidates.add(path.join(dir, 'scrcpy-server'));
    candidates.add(path.join(dir, 'scrcpy-server.jar'));
    candidates.add(path.join(dir, '..', 'share', 'scrcpy', 'scrcpy-server'));
    if (platform === 'win32') {
      for (const ext of ['scrcpy.cmd', 'scrcpy.bat']) {
        const shimTargetDir = await extractShimTargetDir(path.join(dir, ext));
        if (shimTargetDir) {
          candidates.add(path.join(shimTargetDir, 'scrcpy-server'));
          candidates.add(path.join(shimTargetDir, 'scrcpy-server.jar'));
        }
      }
    }
  }

  if (platform !== 'win32') {
    candidates.add('/opt/homebrew/share/scrcpy/scrcpy-server');
    candidates.add('/usr/local/share/scrcpy/scrcpy-server');
    candidates.add('/usr/share/scrcpy/scrcpy-server');
  }

  for (const candidate of candidates) {
    const validBytes = await verifyJarSha256(candidate);
    if (validBytes) {
      await mkdir(targetDir, { recursive: true });
      const tmp = `${cachedJar}.${process.pid}.${Date.now()}.tmp`;
      await copyFile(candidate, tmp);
      await rename(tmp, cachedJar).catch(async () => {
        await writeFile(cachedJar, validBytes);
        await rm(tmp, { force: true }).catch(() => {});
      });
      verifiedJarCache.set(cachedJar, SCRCPY_SERVER_SHA256);
      return { jarPath: cachedJar, version: SCRCPY_SERVER_VERSION, source: 'local' };
    }
  }

  if (!allowDownload) {
    throw new Error(`scrcpy-server v${SCRCPY_SERVER_VERSION} is not cached locally and download is disabled.`);
  }

  const dlSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    : AbortSignal.timeout(45_000);
  const response = await fetchImpl(SCRCPY_SERVER_URL, { signal: dlSignal });
  if (!response.ok) {
    throw new Error(`scrcpy-server download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256Hex(bytes);
  if (actualHash !== SCRCPY_SERVER_SHA256) {
    throw new Error(`scrcpy-server SHA-256 mismatch: expected ${SCRCPY_SERVER_SHA256}, got ${actualHash}`);
  }

  await mkdir(targetDir, { recursive: true });
  const tmp = `${cachedJar}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, cachedJar).catch(async () => {
    await writeFile(cachedJar, bytes);
    await rm(tmp, { force: true }).catch(() => {});
  });
  verifiedJarCache.set(cachedJar, SCRCPY_SERVER_SHA256);
  return { jarPath: cachedJar, version: SCRCPY_SERVER_VERSION, source: 'downloaded' };
}

async function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function connectFirstSocketWithDummyByte(createSocket, port, { timeoutMs = 4_000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    signal?.throwIfAborted?.();
    try {
      const result = await new Promise((resolve, reject) => {
        const sock = createSocket({ host: '127.0.0.1', port });
        sock.setNoDelay?.(true);
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            sock.destroy();
            reject(new Error('scrcpy first socket dummy byte timed out'));
          }
        }, 450);
        timer.unref?.();

        const finish = (fn, val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.removeListener('connect', onConnect);
          sock.removeListener('data', onData);
          sock.removeListener('error', onErr);
          sock.removeListener('close', onClose);
          sock.removeListener('end', onClose);
          fn(val);
        };
        const onConnect = () => {
          sock.setNoDelay?.(true);
        };
        const onData = (chunk) => {
          sock.setNoDelay?.(true);
          finish(resolve, { socket: sock, initialChunk: chunk });
        };
        const onErr = (err) => {
          sock.destroy();
          finish(reject, err);
        };
        const onClose = () => {
          sock.destroy();
          finish(reject, new Error('scrcpy socket closed before dummy byte'));
        };
        sock.once('connect', onConnect);
        sock.once('data', onData);
        sock.once('error', onErr);
        sock.once('close', onClose);
        sock.once('end', onClose);
      });
      return result;
    } catch (err) {
      lastErr = err;
      await sleep(35, signal);
    }
  }
  throw lastErr || new Error('Timed out connecting to scrcpy-server socket');
}

async function connectSecondarySocket(createSocket, port, { timeoutMs = 1_500 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createSocket({ host: '127.0.0.1', port });
    sock.setNoDelay?.(true);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('scrcpy control socket connection timed out'));
    }, timeoutMs);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setNoDelay?.(true);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

function createControlActions(writePacket, getDimensions) {
  const writeRaw = (buf) => {
    if (!buf) return false;
    return writePacket(buf);
  };

  return {
    writeRaw,
    async tap(x, y, fallbackSize) {
      const { width, height } = getDimensions(fallbackSize);
      writeRaw(encodeTouchEvent({ action: 0, x, y, screenWidth: width, screenHeight: height }));
      await sleep(8);
      writeRaw(encodeTouchEvent({ action: 1, x, y, screenWidth: width, screenHeight: height }));
    },
    async doubleTap(x, y, fallbackSize) {
      await this.tap(x, y, fallbackSize);
      await sleep(42);
      await this.tap(x, y, fallbackSize);
    },
    async longPress(x, y, durationMs, fallbackSize) {
      const { width, height } = getDimensions(fallbackSize);
      writeRaw(encodeTouchEvent({ action: 0, x, y, screenWidth: width, screenHeight: height }));
      await sleep(clamp(Math.round(durationMs) || 650, 200, 5000));
      writeRaw(encodeTouchEvent({ action: 1, x, y, screenWidth: width, screenHeight: height }));
    },
    async swipe(x1, y1, x2, y2, durationMs, fallbackSize) {
      const { width, height } = getDimensions(fallbackSize);
      const totalMs = clamp(Math.round(durationMs) || 240, 60, 3000);
      const steps = clamp(Math.round(totalMs / 14), 4, 90);
      const stepDelay = totalMs / steps;
      writeRaw(encodeTouchEvent({ action: 0, x: x1, y: y1, screenWidth: width, screenHeight: height }));
      for (let i = 1; i < steps; i++) {
        await sleep(stepDelay);
        const t = i / steps;
        const ease = 1 - Math.pow(1 - t, 2);
        writeRaw(encodeTouchEvent({
          action: 2,
          x: x1 + (x2 - x1) * ease,
          y: y1 + (y2 - y1) * ease,
          screenWidth: width,
          screenHeight: height,
        }));
      }
      await sleep(Math.max(4, stepDelay));
      writeRaw(encodeTouchEvent({ action: 1, x: x2, y: y2, screenWidth: width, screenHeight: height }));
    },
    async scroll(x, y, hScroll, vScroll, fallbackSize) {
      const { width, height } = getDimensions(fallbackSize);
      writeRaw(encodeScrollEvent({ x, y, screenWidth: width, screenHeight: height, hScroll, vScroll }));
    },
    async pressKeycode(keycode) {
      writeRaw(encodeKeycodeEvent({ action: 0, keycode }));
      writeRaw(encodeKeycodeEvent({ action: 1, keycode }));
    },
    async pressButton(buttonName) {
      const upper = String(buttonName || 'HOME').toUpperCase();
      if (upper === 'BACK') {
        writeRaw(encodeBackOrScreenOn(0));
        writeRaw(encodeBackOrScreenOn(1));
        return true;
      }
      const code = ANDROID_KEYCODE[upper];
      if (!code) return false;
      await this.pressKeycode(code);
      return true;
    },
    async injectText(text, { pasteUnicode = false } = {}) {
      const str = String(text ?? '');
      if (!str) return true;
      const isAsciiPrintable = /^[\x20-\x7e\r\n\t]+$/.test(str);
      if (isAsciiPrintable) {
        for (const pkt of encodeInjectTextPackets(str)) writeRaw(pkt);
        return true;
      }
      if (pasteUnicode) {
        writeRaw(encodeSetClipboard({ text: str, paste: true, sequence: BigInt(Date.now()) }));
        return true;
      }
      return false;
    },
    setDisplayPower(on) {
      writeRaw(encodeSetDisplayPower(Boolean(on)));
    },
    rotateDevice() {
      writeRaw(encodeEmptyControl(CONTROL_MSG.ROTATE_DEVICE));
    },
    resetVideo() {
      writeRaw(encodeEmptyControl(CONTROL_MSG.RESET_VIDEO));
    },
  };
}

export function createScrcpyManager({
  resolveDataDir,
  executeFile = defaultExecFile,
  spawnProcess = spawn,
  createSocket = (opts) => net.createConnection(opts),
  allocatePort = allocateEphemeralPort,
  ensureServer = ensureScrcpyServer,
  fetchImpl = fetch,
  allowDownload = true,
  env = process.env,
  platform = process.platform,
} = {}) {
  const pushedSerials = new Set();
  const pushFlights = new Map();
  const controlSessions = new Map();
  const controlFlights = new Map();
  const activeVideoStreams = new Map();

  async function ensureDeviceJar(adbBinary, serial, signal) {
    const key = `${adbBinary}:${serial}`;
    if (pushedSerials.has(key)) return SCRCPY_DEVICE_JAR_PATH;
    if (pushFlights.has(key)) return pushFlights.get(key);

    const flight = (async () => {
      const { jarPath } = await ensureServer({
        dataDir: resolveDataDir(),
        env,
        platform,
        fetchImpl,
        allowDownload,
        signal,
      });
      const localSize = await stat(jarPath).then((s) => s.size, () => 0);
      if (localSize > 0) {
        const remoteStat = await executeFile(adbBinary, ['-s', serial, 'shell', 'stat', '-c', '%s', SCRCPY_DEVICE_JAR_PATH], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3_000,
          signal,
        }).then((res) => Number(String(res?.stdout ?? '').trim().split(/\s+/)[0]), () => 0);
        if (remoteStat === localSize) {
          pushedSerials.add(key);
          return SCRCPY_DEVICE_JAR_PATH;
        }
      }
      await executeFile(adbBinary, ['-s', serial, 'push', jarPath, SCRCPY_DEVICE_JAR_PATH], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000,
        signal,
      });
      pushedSerials.add(key);
      return SCRCPY_DEVICE_JAR_PATH;
    })().finally(() => {
      pushFlights.delete(key);
    });

    pushFlights.set(key, flight);
    return flight;
  }

  async function closeControlSession(serial) {
    const entry = controlSessions.get(serial);
    if (!entry) return;
    controlSessions.delete(serial);
    clearTimeout(entry.idleTimer);
    try { entry.socket.destroy(); } catch {}
    try { entry.proc.kill(); } catch {}
    await executeFile(entry.adbBinary, ['-s', serial, 'forward', '--remove', `tcp:${entry.port}`], {
      encoding: 'utf8', windowsHide: true, timeout: 4_000,
    }).catch(() => {});
  }

  function touchControlIdle(serial, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { void closeControlSession(serial); }, CONTROL_IDLE_TTL_MS);
    entry.idleTimer.unref?.();
  }

  async function acquireControl({ adbBinary, serial, fallbackSize }) {
    if (!adbBinary || !serial) return null;

    const liveStreamSet = activeVideoStreams.get(serial);
    if (liveStreamSet && liveStreamSet.size > 0) {
      const liveEntry = liveStreamSet.values().next().value;
      if (liveEntry?.control && !liveEntry.closed) {
        return liveEntry.control;
      }
    }

    const existing = controlSessions.get(serial);
    if (existing && !existing.closed) {
      if (fallbackSize?.width && fallbackSize?.height) existing.fallbackSize = fallbackSize;
      touchControlIdle(serial, existing);
      return existing.control;
    }

    if (controlFlights.has(serial)) return controlFlights.get(serial);

    const flight = (async () => {
      const deviceJar = await ensureDeviceJar(adbBinary, serial);
      const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
      const port = await allocatePort();

      await executeFile(adbBinary, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`], {
        encoding: 'utf8', windowsHide: true, timeout: 6_000,
      });

      const proc = spawnProcess(adbBinary, [
        '-s', serial, 'shell',
        `CLASSPATH=${deviceJar}`,
        'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_SERVER_VERSION,
        `scid=${scid}`,
        'log_level=warn',
        'tunnel_forward=true',
        'cleanup=false',
        'clipboard_autosync=false',
        'power_on=false',
        'video=false',
        'audio=false',
        'control=true',
        'send_device_meta=true',
        'send_dummy_byte=true',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      let stderrTail = '';
      proc.stderr?.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-512); });

      try {
        const { socket } = await connectFirstSocketWithDummyByte(createSocket, port, { timeoutMs: 3_500 });
        socket.on('data', () => {});
        const entry = {
          serial,
          adbBinary,
          port,
          proc,
          socket,
          closed: false,
          idleTimer: undefined,
          fallbackSize: fallbackSize || { width: 1080, height: 2400 },
          control: null,
        };
        const markClosed = () => {
          if (entry.closed) return;
          entry.closed = true;
          if (/Aborted|ClassNotFoundException|No such file/i.test(stderrTail)) {
            pushedSerials.delete(`${adbBinary}:${serial}`);
          }
          void closeControlSession(serial);
        };
        socket.once('close', markClosed);
        socket.once('error', markClosed);
        proc.once('exit', markClosed);

        entry.control = createControlActions(
          (buf) => {
            if (entry.closed || socket.destroyed) return false;
            touchControlIdle(serial, entry);
            socket.write(buf);
            return true;
          },
          (overrideSize) => overrideSize?.width && overrideSize?.height ? overrideSize : entry.fallbackSize,
        );
        controlSessions.set(serial, entry);
        touchControlIdle(serial, entry);
        return entry.control;
      } catch (err) {
        if (/Aborted|ClassNotFoundException|No such file/i.test(stderrTail)) {
          pushedSerials.delete(`${adbBinary}:${serial}`);
        }
        try { proc.kill(); } catch {}
        await executeFile(adbBinary, ['-s', serial, 'forward', '--remove', `tcp:${port}`], {
          encoding: 'utf8', windowsHide: true, timeout: 4_000,
        }).catch(() => {});
        throw err;
      }
    })().finally(() => {
      controlFlights.delete(serial);
    });

    controlFlights.set(serial, flight);
    return flight;
  }

  function warmControl({ adbBinary, serial, fallbackSize }) {
    if (!adbBinary || !serial) return;
    void acquireControl({ adbBinary, serial, fallbackSize }).catch(() => {});
  }

  async function openVideoStreamAttempt(
    {
      deviceJar,
      adbBinary,
      serial,
      safeFps,
      safeMaxSize,
      safeBitRate,
      codecOptions,
      fallbackSize,
      clientReadyFallbackMs,
      closeSessionOnInitFailure = true,
    },
    session,
    context = {},
  ) {
    const signal = context?.signal;
    signal?.throwIfAborted?.();

    const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
    const port = await allocatePort();

    await executeFile(adbBinary, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`], {
      encoding: 'utf8', windowsHide: true, timeout: 6_000, signal,
    });

    const proc = spawnProcess(adbBinary, [
      '-s', serial, 'shell',
      `CLASSPATH=${deviceJar}`,
      'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_SERVER_VERSION,
      `scid=${scid}`,
      'log_level=info',
      'tunnel_forward=true',
      'cleanup=false',
      'clipboard_autosync=false',
      'power_on=true',
      'video=true',
      'audio=false',
      'control=true',
      'video_codec=h264',
      `max_size=${safeMaxSize}`,
      `max_fps=${safeFps}`,
      `video_bit_rate=${safeBitRate}`,
      `video_codec_options=${codecOptions}`,
      'send_device_meta=true',
      'send_stream_meta=true',
      'send_frame_meta=true',
      'send_dummy_byte=true',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stderrTail = '';
    proc.stderr?.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-1024); });

    let videoSocket = null;
    let controlSocket = null;
    let closed = false;
    let handshakeDone = false;
    let clientReadyFallbackTimer = null;
    let procExitErr = null;
    let onEarlyProcExit = null;
    const unsubs = [];

    const attemptAbort = new AbortController();
    const connectSignal = signal ? AbortSignal.any([signal, attemptAbort.signal]) : attemptAbort.signal;

    const streamRecord = { closed: false, control: null, close: null };

    const cleanup = (reason, { closeSession = true } = {}) => {
      if (closed) return;
      closed = true;
      streamRecord.closed = true;
      clearTimeout(clientReadyFallbackTimer);
      clientReadyFallbackTimer = null;
      const set = activeVideoStreams.get(serial);
      if (set) {
        set.delete(streamRecord);
        if (set.size === 0) activeVideoStreams.delete(serial);
      }
      for (const off of unsubs.splice(0)) {
        try { off?.(); } catch {}
      }
      signal?.removeEventListener?.('abort', onAbort);
      try { videoSocket?.destroy(); } catch {}
      try { controlSocket?.destroy(); } catch {}
      try { proc.kill(); } catch {}
      void executeFile(adbBinary, ['-s', serial, 'forward', '--remove', `tcp:${port}`], {
        encoding: 'utf8', windowsHide: true, timeout: 4_000,
      }).catch(() => {});
      if (closeSession) {
        try { session?.close?.(reason); } catch {}
      }
    };

    function onAbort() {
      cleanup('aborted');
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    streamRecord.close = cleanup;

    proc.once('exit', () => {
      if (/Aborted|ClassNotFoundException|No such file/i.test(stderrTail)) {
        pushedSerials.delete(`${adbBinary}:${serial}`);
      }
      if (!handshakeDone) {
        procExitErr = new Error(`scrcpy-server exited (${stderrTail.trim() || 'unknown'})`);
        if (!attemptAbort.signal.aborted) attemptAbort.abort(procExitErr);
        onEarlyProcExit?.(procExitErr);
      } else {
        cleanup('scrcpy_exited');
      }
    });

    try {
      const first = await connectFirstSocketWithDummyByte(createSocket, port, { timeoutMs: 4_000, signal: connectSignal });
      videoSocket = first.socket;
      if (procExitErr) throw procExitErr;
      controlSocket = await connectSecondarySocket(createSocket, port, { timeoutMs: 2_000 });
      if (procExitErr) throw procExitErr;
      controlSocket.on('data', () => {});

      const parser = new ScrcpyVideoStreamParser({ expectDummyByte: true });
      let seq = 0;
      let streamFlushed = false;
      let droppingUntilKeyframe = false;
      let lastKeyPacket = null;
      let keyEpochDeltas = [];
      let epochBroken = false;
      let lastBackpressureResetAt = 0;
      let graceTimer = null;

      let resolveInitial;
      let rejectInitial;
      const initialReady = new Promise((res, rej) => {
        resolveInitial = res;
        rejectInitial = rej;
      });
      const finishHandshake = () => {
        clearTimeout(initTimer);
        clearTimeout(graceTimer);
        resolveInitial();
      };
      const initTimer = setTimeout(() => {
        clearTimeout(graceTimer);
        rejectInitial(new Error(`scrcpy initial video metadata timed out (${stderrTail.trim() || 'no frames'})`));
      }, 4_000);
      initTimer.unref?.();

      const control = createControlActions(
        (buf) => {
          if (closed || !controlSocket || controlSocket.destroyed) return false;
          controlSocket.write(buf);
          return true;
        },
        (overrideSize) => {
          if (parser.width > 0 && parser.height > 0) return { width: parser.width, height: parser.height };
          return overrideSize?.width && overrideSize?.height ? overrideSize : (fallbackSize || { width: 1080, height: 2400 });
        },
      );
      streamRecord.control = control;
      if (!activeVideoStreams.has(serial)) activeVideoStreams.set(serial, new Set());
      activeVideoStreams.get(serial).add(streamRecord);

      const replayCurrentEpoch = () => {
        if (closed) return;
        streamFlushed = true;
        droppingUntilKeyframe = false;
        clearTimeout(clientReadyFallbackTimer);
        clientReadyFallbackTimer = null;

        if (!lastKeyPacket) {
          control.resetVideo();
          return;
        }
        const okKey = session.sendBinary(lastKeyPacket);
        if (okKey === false) {
          droppingUntilKeyframe = true;
          return;
        }
        if (epochBroken) {
          droppingUntilKeyframe = true;
          control.resetVideo();
          return;
        }
        for (const deltaPkt of keyEpochDeltas) {
          const okDelta = session.sendBinary(deltaPkt);
          if (okDelta === false) {
            droppingUntilKeyframe = true;
            return;
          }
        }
      };

      const handleParsedEvents = (events) => {
        for (const ev of events) {
          if (ev.kind === 'error') {
            if (!handshakeDone) rejectInitial(new Error(ev.message));
            else cleanup(ev.message);
            return;
          }
          if (ev.kind === 'session') {
            lastKeyPacket = null;
            keyEpochDeltas = [];
            epochBroken = false;
            if (!handshakeDone && !graceTimer) {
              graceTimer = setTimeout(finishHandshake, 180);
              graceTimer.unref?.();
            } else if (handshakeDone) {
              session.sendText?.(JSON.stringify({
                type: 'meta',
                width: ev.width,
                height: ev.height,
                codec: 'h264',
                codecProfile: parser.codecProfile,
              }));
            }
          }
          if (ev.kind === 'config') {
            lastKeyPacket = null;
            keyEpochDeltas = [];
            epochBroken = false;
            if (handshakeDone) {
              session.sendText?.(JSON.stringify({
                type: 'meta',
                width: parser.width,
                height: parser.height,
                codec: 'h264',
                codecProfile: ev.codecProfile,
              }));
            }
          }
          if (ev.kind === 'frame') {
            const pkt = packVideoFrame({
              keyFrame: ev.keyFrame,
              width: ev.width || fallbackSize?.width || 1080,
              height: ev.height || fallbackSize?.height || 2400,
              seq: seq++,
              ptsUs: ev.ptsUs,
              data: ev.data,
            });

            if (ev.keyFrame) {
              lastKeyPacket = pkt;
              keyEpochDeltas = [];
              epochBroken = false;
            } else if (lastKeyPacket && !epochBroken) {
              if (keyEpochDeltas.length < 60) {
                keyEpochDeltas.push(pkt);
              } else {
                keyEpochDeltas = [];
                epochBroken = true;
              }
            }

            if (!handshakeDone) {
              if (parser.width > 0 && parser.height > 0) {
                finishHandshake();
              }
              continue;
            }

            if (!streamFlushed) {
              continue;
            }

            if (droppingUntilKeyframe && !ev.keyFrame) {
              if ((session.bufferedAmount?.() ?? 0) === 0) {
                const now = Date.now();
                if (now - lastBackpressureResetAt >= 350) {
                  lastBackpressureResetAt = now;
                  control.resetVideo();
                }
              }
              continue;
            }
            if (ev.keyFrame) droppingUntilKeyframe = false;

            const ok = session.sendBinary(pkt);
            if (ok === false) {
              droppingUntilKeyframe = true;
            }
          }
        }
      };

      videoSocket.on('data', (chunk) => {
        if (closed) return;
        handleParsedEvents(parser.push(chunk));
      });
      videoSocket.once('close', () => {
        clearTimeout(initTimer);
        clearTimeout(graceTimer);
        if (!handshakeDone) rejectInitial(new Error(`scrcpy video socket closed early (${stderrTail.trim() || 'EOF'})`));
        else cleanup('device_stream_closed');
      });
      videoSocket.once('error', (err) => {
        clearTimeout(initTimer);
        clearTimeout(graceTimer);
        if (!handshakeDone) rejectInitial(err);
        else cleanup(err.message || 'video_socket_error');
      });
      controlSocket.once('error', () => {});
      onEarlyProcExit = (err) => {
        clearTimeout(initTimer);
        clearTimeout(graceTimer);
        rejectInitial(err);
      };
      if (procExitErr) {
        onEarlyProcExit(procExitErr);
      }

      if (first.initialChunk?.length) {
        handleParsedEvents(parser.push(first.initialChunk));
      }

      await initialReady;

      if (typeof session.onBinary === 'function') {
        unsubs.push(session.onBinary((buf) => {
          if (closed) return;
          const sw = parser.width || fallbackSize?.width || 1080;
          const sh = parser.height || fallbackSize?.height || 2400;
          const raw = parseClientBinaryControl(buf, sw, sh);
          if (raw) control.writeRaw(raw);
        }));
      }

      if (typeof session.onText === 'function') {
        unsubs.push(session.onText((text) => {
          if (closed) return;
          let msg;
          try { msg = typeof text === 'string' ? JSON.parse(text) : text; } catch { return; }
          if (!msg || typeof msg !== 'object') return;
          switch (msg.type) {
            case 'clientReady':
              replayCurrentEpoch();
              break;
            case 'button':
            case 'key':
              void control.pressButton(msg.button || msg.key);
              break;
            case 'keycode':
              if (Number.isInteger(msg.keycode)) void control.pressKeycode(msg.keycode);
              break;
            case 'text':
            case 'paste':
              void control.injectText(msg.text, { pasteUnicode: true });
              break;
            case 'power':
              control.setDisplayPower(msg.on !== false);
              break;
            case 'rotate':
              control.rotateDevice();
              break;
            case 'resetVideo':
              control.resetVideo();
              break;
            default:
              break;
          }
        }));
      }

      if (typeof session.onClose === 'function') {
        unsubs.push(session.onClose(() => cleanup('client_closed')));
      }

      handshakeDone = true;
      const fallbackDelay = Math.max(0, Number(clientReadyFallbackMs) || 0);
      clientReadyFallbackTimer = setTimeout(() => {
        if (!closed && !streamFlushed) {
          replayCurrentEpoch();
        }
      }, fallbackDelay);
      clientReadyFallbackTimer.unref?.();

      return {
        protocol: SCRCPY_STREAM_PROTOCOL,
        width: parser.width || fallbackSize?.width || 1080,
        height: parser.height || fallbackSize?.height || 2400,
        codec: 'h264',
        codecProfile: parser.codecProfile,
        deviceName: parser.deviceName || undefined,
      };
    } catch (err) {
      cleanup(err.message || 'handshake_failed', { closeSession: closeSessionOnInitFailure });
      throw err;
    }
  }

  async function openVideoStream(
    {
      adbBinary,
      serial,
      maxFps = 60,
      maxWidth = 1080,
      bitRate = 8_000_000,
      fallbackSize,
      clientReadyFallbackMs = 60,
    },
    session,
    context = {},
  ) {
    if (!adbBinary) throw new Error('Android ADB is not configured. Run phone_prepare first.');
    if (!serial) throw new Error('No Android serial specified for screen stream.');

    const signal = context?.signal;
    signal?.throwIfAborted?.();

    const deviceJar = await ensureDeviceJar(adbBinary, serial, signal);
    const safeFps = clamp(Math.round(Number(maxFps) || 60), 10, 120);
    const safeMaxSize = clamp(Math.round(Number(maxWidth) || 1080) & ~7, 360, 2400);
    const safeBitRate = clamp(Math.round(Number(bitRate) || 8_000_000), 500_000, 20_000_000);

    try {
      return await openVideoStreamAttempt(
        {
          deviceJar,
          adbBinary,
          serial,
          safeFps,
          safeMaxSize,
          safeBitRate,
          codecOptions: 'i-frame-interval=1,repeat-previous-frame-after=100000',
          fallbackSize,
          clientReadyFallbackMs,
          closeSessionOnInitFailure: false,
        },
        session,
        context,
      );
    } catch (firstErr) {
      if (signal?.aborted) {
        try { session?.close?.(firstErr.message || 'aborted'); } catch {}
        throw firstErr;
      }
      const msg = String(firstErr?.message || '');
      const shouldFallbackCodecOpts = /scrcpy-server exited|closed early|video stream disabled|codec|option/i.test(msg);
      if (!shouldFallbackCodecOpts) {
        try { session?.close?.(msg || 'handshake_failed'); } catch {}
        throw firstErr;
      }
      return openVideoStreamAttempt(
        {
          deviceJar,
          adbBinary,
          serial,
          safeFps,
          safeMaxSize,
          safeBitRate,
          codecOptions: 'i-frame-interval=1',
          fallbackSize,
          clientReadyFallbackMs,
          closeSessionOnInitFailure: true,
        },
        session,
        context,
      );
    }
  }

  async function dispose() {
    for (const set of activeVideoStreams.values()) {
      for (const item of [...set]) {
        try { item.close?.('disposed'); } catch {}
      }
    }
    activeVideoStreams.clear();
    await Promise.all([...controlSessions.keys()].map((serial) => closeControlSession(serial)));
  }

  return {
    acquireControl,
    warmControl,
    openVideoStream,
    dispose,
  };
}
