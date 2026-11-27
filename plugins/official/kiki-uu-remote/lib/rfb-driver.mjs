import { spawn } from 'node:child_process';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buttons as RFB_BUTTONS,
  connect as rfbConnect,
  encodings as RFB_ENCODINGS,
  fenceFlags as RFB_FENCE_FLAGS,
  Framebuffer,
} from '../vendor/rfb2/dist/index.js';
import { mapPointToTarget } from './frame-math.mjs';
import {
  assertValidPveHost,
  assertValidPveVmid,
  isPveTargetId,
  parsePveTargetId,
} from './pve-qmp-driver.mjs';
import {
  ALL_MODIFIER_RFB_KEYS,
  SHIFT_LEFT_KEY,
  asciiCharToRfbKey,
  createUnicodeUnsupportedError,
  isAsciiOnlyText,
  normalizeRfbKeyChord,
  resolveDomCodeOrKey,
} from './xt-scancode-map.mjs';

export const MAX_RFB_CLIPBOARD_BYTES = 2 * 1024 * 1024; // 2 MiB (Frame Audit B5)
export const DIRTY_FRAME_MAGIC = 0x02;
export const RECT_RAW_RGBA = 0;
export const RECT_DEFLATE_RGBA = 1;
export const RECT_COPYRECT = 2;

export function packDirtyRectFrame({
  frameSeq = 1,
  fbWidth,
  fbHeight,
  keyFrame = false,
  takeoverActive = false,
  rects = [],
}) {
  const encodedParts = [];
  let bodyLen = 0;
  for (const r of rects) {
    if (r.encoding === RECT_COPYRECT) {
      const hdr = Buffer.allocUnsafe(13);
      hdr.writeUInt8(RECT_COPYRECT, 0);
      hdr.writeUInt16BE(r.x & 0xffff, 1);
      hdr.writeUInt16BE(r.y & 0xffff, 3);
      hdr.writeUInt16BE(r.width & 0xffff, 5);
      hdr.writeUInt16BE(r.height & 0xffff, 7);
      hdr.writeUInt16BE(r.srcX & 0xffff, 9);
      hdr.writeUInt16BE(r.srcY & 0xffff, 11);
      encodedParts.push(hdr);
      bodyLen += hdr.length;
      continue;
    }
    const rgba = Buffer.isBuffer(r.rgba) ? r.rgba : Buffer.from(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength);
    const useRaw = rgba.length <= 512;
    const payload = useRaw ? rgba : deflateSync(rgba, { level: 1 });
    const encType = (useRaw || payload.length >= rgba.length) ? RECT_RAW_RGBA : RECT_DEFLATE_RGBA;
    const finalBytes = encType === RECT_RAW_RGBA ? rgba : payload;
    const hdr = Buffer.allocUnsafe(13);
    hdr.writeUInt8(encType, 0);
    hdr.writeUInt16BE(r.x & 0xffff, 1);
    hdr.writeUInt16BE(r.y & 0xffff, 3);
    hdr.writeUInt16BE(r.width & 0xffff, 5);
    hdr.writeUInt16BE(r.height & 0xffff, 7);
    hdr.writeUInt32BE(finalBytes.length >>> 0, 9);
    encodedParts.push(hdr, finalBytes);
    bodyLen += hdr.length + finalBytes.length;
  }

  const header = Buffer.allocUnsafe(12);
  header.writeUInt8(DIRTY_FRAME_MAGIC, 0);
  header.writeUInt8((keyFrame ? 1 : 0) | (takeoverActive ? 2 : 0), 1);
  header.writeUInt32BE(frameSeq >>> 0, 2);
  header.writeUInt16BE(Math.min(65535, Math.max(1, fbWidth || 1)), 6);
  header.writeUInt16BE(Math.min(65535, Math.max(1, fbHeight || 1)), 8);
  header.writeUInt16BE(Math.min(65535, rects.length), 10);
  return Buffer.concat([header, ...encodedParts], 12 + bodyLen);
}

export function unpackDirtyRectFrame(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 12 || b[0] !== DIRTY_FRAME_MAGIC) return null;
  const flags = b.readUInt8(1);
  const frameSeq = b.readUInt32BE(2);
  const fbWidth = b.readUInt16BE(6);
  const fbHeight = b.readUInt16BE(8);
  const rectCount = b.readUInt16BE(10);
  const rects = [];
  let off = 12;
  for (let i = 0; i < rectCount; i += 1) {
    if (off >= b.length) break;
    const enc = b.readUInt8(off);
    if (enc === RECT_COPYRECT) {
      if (off + 13 > b.length) break;
      rects.push({
        encoding: RECT_COPYRECT,
        x: b.readUInt16BE(off + 1),
        y: b.readUInt16BE(off + 3),
        width: b.readUInt16BE(off + 5),
        height: b.readUInt16BE(off + 7),
        srcX: b.readUInt16BE(off + 9),
        srcY: b.readUInt16BE(off + 11),
      });
      off += 13;
    } else {
      if (off + 13 > b.length) break;
      const x = b.readUInt16BE(off + 1);
      const y = b.readUInt16BE(off + 3);
      const width = b.readUInt16BE(off + 5);
      const height = b.readUInt16BE(off + 7);
      const dataLen = b.readUInt32BE(off + 9);
      off += 13;
      if (off + dataLen > b.length) break;
      const slice = b.subarray(off, off + dataLen);
      off += dataLen;
      const rgba = enc === RECT_DEFLATE_RGBA ? inflateSync(slice) : Buffer.from(slice);
      rects.push({ encoding: enc, x, y, width, height, rgba });
    }
  }
  return {
    keyFrame: Boolean(flags & 1),
    takeoverActive: Boolean(flags & 2),
    frameSeq,
    fbWidth,
    fbHeight,
    rects,
  };
}
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_FRAME_TIMEOUT_MS = 4_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 8 * 60 * 1000; // < 15 min qm vncproxy idle timeout (OQ1)
const VNC_PREFIX_RE = /^vnc:/i;
const VNC_HOST_SIMPLE_RE = /^[A-Za-z0-9._-]+$/;
const RFB_BANNER_RE = /^RFB \d{3}\.\d{3}\n$/;
const TICKET_LINE_RE = /KIKI_PVE_TICKET:([0-9a-fA-F]{8})\r?\n/;

/**
 * Lossless RFB encodings only — intentionally omits jpegQuality / jpegFineQuality
 * so small UI fonts and sharp edges stay crisp for VLM grounding.
 */
export const LOSSLESS_RFB_ENCODINGS = Object.freeze([
  RFB_ENCODINGS.zrle,
  RFB_ENCODINGS.tight,
  RFB_ENCODINGS.trle,
  RFB_ENCODINGS.hextile,
  RFB_ENCODINGS.zlib,
  RFB_ENCODINGS.copyRect,
  RFB_ENCODINGS.raw,
  RFB_ENCODINGS.pseudoDesktopSize,
  RFB_ENCODINGS.pseudoExtendedDesktopSize,
  RFB_ENCODINGS.pseudoLastRect,
  RFB_ENCODINGS.pseudoDesktopName,
  RFB_ENCODINGS.pseudoFence,
  RFB_ENCODINGS.pseudoContinuousUpdates,
  RFB_ENCODINGS.pseudoExtendedClipboard,
  RFB_ENCODINGS.pseudoQemuExtendedKeyEvent,
  RFB_ENCODINGS.pseudoExtendedMouseButtons,
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function sleep(ms, signal) {
  const clamped = Math.max(0, Math.min(30_000, Math.round(Number(ms) || 0)));
  if (clamped === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, clamped);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function isVncTargetId(value) {
  return VNC_PREFIX_RE.test(String(value ?? '').trim());
}

export function assertValidVncHost(host) {
  const raw = String(host ?? '').trim();
  if (!raw || raw.length > 253) {
    throw new Error(`Invalid VNC host "${raw}": must be a non-empty hostname or IP address.`);
  }
  if (/[\s\x00-\x1f\x7f;|&`$<>'"\\/@]/.test(raw)) {
    throw new Error(`Invalid VNC host "${raw}": contains prohibited whitespace, control, or shell characters.`);
  }
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!unbracketed || unbracketed.startsWith('-')) {
    throw new Error(`Invalid VNC host "${raw}": must not start with "-".`);
  }
  if (net.isIP(unbracketed) === 6) {
    return unbracketed;
  }
  if (!VNC_HOST_SIMPLE_RE.test(unbracketed)) {
    throw new Error(`Invalid VNC host "${raw}": must match hostname/IPv4/IPv6 syntax.`);
  }
  return unbracketed;
}

export function assertValidVncPort(port = 5900) {
  if (port === undefined || port === null || port === '') return 5900;
  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`Invalid VNC port "${String(port)}": must be an integer in 1..65535.`);
  }
  return num;
}

export function buildVncTargetId(host, port = 5900) {
  const cleanHost = assertValidVncHost(host);
  const cleanPort = assertValidVncPort(port);
  const formattedHost = net.isIP(cleanHost) === 6 ? `[${cleanHost}]` : cleanHost;
  return `vnc:${formattedHost}:${cleanPort}`;
}

export function parseVncTargetId(value, { strict = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!VNC_PREFIX_RE.test(raw)) {
    if (strict) {
      throw new Error(`Invalid VNC target ID "${raw}": expected format vnc:<host>:<port>.`);
    }
    return null;
  }
  const rest = raw.slice(4);
  if (!rest || /[\s\x00-\x1f\x7f@/]/.test(rest)) {
    if (strict) {
      throw new Error(`Invalid VNC target ID "${raw}": expected format vnc:<host>:<port>.`);
    }
    return null;
  }

  let hostPart;
  let portPart = '5900';

  if (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx <= 1) {
      if (strict) throw new Error(`Invalid VNC IPv6 target ID "${raw}".`);
      return null;
    }
    hostPart = rest.slice(1, closeIdx);
    const tail = rest.slice(closeIdx + 1);
    if (tail) {
      if (!tail.startsWith(':')) {
        if (strict) throw new Error(`Invalid VNC target ID "${raw}": expected ":<port>" after "]".`);
        return null;
      }
      portPart = tail.slice(1);
    }
  } else {
    const firstColon = rest.indexOf(':');
    const lastColon = rest.lastIndexOf(':');
    if (firstColon !== lastColon) {
      if (strict) {
        throw new Error(`Invalid VNC target ID "${raw}": wrap IPv6 addresses in brackets, e.g. vnc:[::1]:5900.`);
      }
      return null;
    }
    if (firstColon === -1) {
      hostPart = rest;
    } else {
      hostPart = rest.slice(0, firstColon);
      portPart = rest.slice(firstColon + 1);
    }
  }

  try {
    const host = assertValidVncHost(hostPart);
    const port = assertValidVncPort(portPart);
    return {
      id: buildVncTargetId(host, port),
      host,
      port,
    };
  } catch (err) {
    if (strict) throw err;
    return null;
  }
}

export function normalizeVncTargetId(value) {
  const parsed = parseVncTargetId(value, { strict: false });
  return parsed ? parsed.id : String(value ?? '').trim();
}

/**
 * Build SSH arguments for the zero-race PVE vncproxy bridge (Frame Audit A3).
 * Remote Python generates an exact 8-char ASCII hex ticket via `secrets.token_hex(4)`,
 * prints `KIKI_PVE_TICKET:<8hex>\n` to stderr + flushes, sets `LC_PVE_TICKET`, and
 * `os.execvp('qm', ['qm', 'vncproxy', '<vmid>'])` without reading a single byte from stdin.
 */
export function buildPveVncProxyArgs(sshHost, vmid, { connectTimeoutSec = 8 } = {}) {
  const validHost = assertValidPveHost(sshHost);
  const validVmid = assertValidPveVmid(vmid);
  const pyCode = [
    'import os,secrets,sys',
    't=secrets.token_hex(4)',
    'sys.stderr.write("KIKI_PVE_TICKET:"+t+"\\n")',
    'sys.stderr.flush()',
    'os.environ["LC_PVE_TICKET"]=t',
    `os.execvp("qm",["qm","vncproxy","${validVmid}"])`,
  ].join('\n');
  const pyB64 = Buffer.from(pyCode, 'utf8').toString('base64');
  // Zero double quotes in remoteCmd for Windows OpenSSH / POSIX sh parity.
  const remoteCmd = `python3 -u -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' ${pyB64}`;
  return [
    '-T',
    '-e', 'none',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${clamp(Math.round(Number(connectTimeoutSec) || 8), 2, 30)}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '--',
    validHost,
    remoteCmd,
  ];
}

export function buildVncSshTunnelArgs(sshHost, vncHost, vncPort, { connectTimeoutSec = 8 } = {}) {
  const validSshHost = assertValidPveHost(sshHost);
  const validVncHost = assertValidVncHost(vncHost);
  const validPort = assertValidVncPort(vncPort);
  const forwardSpec = net.isIP(validVncHost) === 6
    ? `[${validVncHost}]:${validPort}`
    : `${validVncHost}:${validPort}`;
  return [
    '-T',
    '-e', 'none',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${clamp(Math.round(Number(connectTimeoutSec) || 8), 2, 30)}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-W', forwardSpec,
    '--',
    validSshHost,
  ];
}

function redactSecret(text, secret) {
  let out = String(text ?? '');
  if (secret && typeof secret === 'string' && secret.length > 0) {
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/KIKI_PVE_TICKET:[0-9a-fA-F]{8}/g, 'KIKI_PVE_TICKET:[REDACTED]');
  return out;
}

function mergeBounds(a, b) {
  if (!a) return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  if (!b) return a;
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

function createProcessDuplex(proc, initialBuffer, onDestroyCleanup) {
  const prebuffered = initialBuffer && initialBuffer.length > 0 ? [Buffer.from(initialBuffer)] : [];
  let stdoutEnded = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    proc.stdout?.off?.('data', onStdoutData);
    proc.stdout?.off?.('end', onStdoutEnd);
    proc.stdout?.off?.('close', onStdoutEnd);
    proc.off?.('error', onProcError);
    proc.off?.('exit', onProcExit);
    onDestroyCleanup?.();
  };

  const duplex = new Duplex({
    read() {
      while (prebuffered.length > 0) {
        const next = prebuffered.shift();
        if (!this.push(next)) {
          proc.stdout?.pause?.();
          return;
        }
      }
      if (stdoutEnded) {
        this.push(null);
        return;
      }
      proc.stdout?.resume?.();
    },
    write(chunk, encoding, callback) {
      if (!proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded || proc.killed) {
        callback(new Error('RFB SSH transport stdin is closed.'));
        return;
      }
      let settled = false;
      const onDrain = () => done(null);
      const done = (err) => {
        if (settled) return;
        settled = true;
        proc.stdin?.off?.('drain', onDrain);
        callback(err || null);
      };
      try {
        const ok = proc.stdin.write(chunk, encoding, (err) => {
          if (err) done(err);
          else if (ok) done(null);
        });
        if (!ok) {
          proc.stdin.once('drain', onDrain);
        }
      } catch (err) {
        done(err);
      }
    },
    final(callback) {
      try {
        proc.stdin?.end?.();
      } catch {}
      callback();
    },
    destroy(err, callback) {
      cleanup();
      callback(err);
    },
  });

  const onStdoutData = (chunk) => {
    if (duplex.destroyed) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (prebuffered.length > 0) {
      prebuffered.push(buf);
      proc.stdout?.pause?.();
      return;
    }
    if (!duplex.push(buf)) {
      proc.stdout?.pause?.();
    }
  };

  const onStdoutEnd = () => {
    stdoutEnded = true;
    if (!duplex.destroyed && prebuffered.length === 0) {
      duplex.push(null);
    }
  };

  const onProcError = (err) => {
    if (!duplex.destroyed) duplex.destroy(err);
  };

  const onProcExit = () => {
    stdoutEnded = true;
    if (!duplex.destroyed && prebuffered.length === 0) {
      duplex.push(null);
    }
  };

  proc.stdout.on('data', onStdoutData);
  proc.stdout.once('end', onStdoutEnd);
  proc.stdout.once('close', onStdoutEnd);
  proc.once('error', onProcError);
  proc.once('exit', onProcExit);

  return duplex;
}

function normalizeRfbTarget(targetOrId) {
  if (typeof targetOrId === 'string') {
    const trimmed = targetOrId.trim();
    if (isPveTargetId(trimmed)) {
      const parsed = parsePveTargetId(trimmed, { strict: true });
      return { kind: 'pve', id: parsed.id, sshHost: parsed.sshHost, vmid: parsed.vmid };
    }
    if (isVncTargetId(trimmed)) {
      const parsed = parseVncTargetId(trimmed, { strict: true });
      return { kind: 'vnc', id: parsed.id, host: parsed.host, port: parsed.port, sshHost: null };
    }
    throw new Error(`Unsupported RFB target ID: "${trimmed}"`);
  }
  if (!targetOrId || typeof targetOrId !== 'object') {
    throw new Error('RFB target descriptor is required.');
  }
  if (targetOrId.kind === 'pve' || isPveTargetId(targetOrId.id) || (targetOrId.sshHost && targetOrId.vmid)) {
    const sshHost = assertValidPveHost(targetOrId.sshHost);
    const vmid = assertValidPveVmid(targetOrId.vmid);
    return { kind: 'pve', id: `pve:${sshHost}:${vmid}`, sshHost, vmid };
  }
  if (targetOrId.kind === 'vnc' || isVncTargetId(targetOrId.id) || targetOrId.host) {
    const parsed = targetOrId.id && isVncTargetId(targetOrId.id)
      ? parseVncTargetId(targetOrId.id, { strict: true })
      : {
          id: buildVncTargetId(targetOrId.host, targetOrId.port ?? 5900),
          host: assertValidVncHost(targetOrId.host),
          port: assertValidVncPort(targetOrId.port ?? 5900),
        };
    const sshHost = targetOrId.sshHost ? assertValidPveHost(targetOrId.sshHost) : null;
    return {
      kind: 'vnc',
      id: parsed.id,
      host: parsed.host,
      port: parsed.port,
      sshHost,
    };
  }
  throw new Error(`Unsupported RFB target object: ${JSON.stringify({ id: targetOrId.id })}`);
}

/**
 * Unified RFB 3.8 driver backed by vendored `rfb2@1.1.0` (MIT, 0 runtime deps).
 * Supports both PVE VNC-over-SSH (`pve:<ssh_host>:<vmid>`) and direct/SSH-tunneled VNC (`vnc:<host>:<port>`).
 */
export function createRfbDriver({
  connectFn = rfbConnect,
  spawnProcess = spawn,
  sshBinary = 'ssh',
  hostPlatform = process.platform,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  initialFrameTimeoutMs = DEFAULT_INITIAL_FRAME_TIMEOUT_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  nowFn = Date.now,
} = {}) {
  const sessionsById = new Map();
  const connectFlights = new Map();
  const passwordsByTargetId = new Map(); // In-memory only; NEVER persisted or logged.
  const subscribersByTargetId = new Map();
  const clipboardSubscribersByTargetId = new Map();
  const resizeListeners = new Set();
  const needsConservativeRelease = new Set();

  function killProcessTree(proc) {
    if (!proc) return;
    if (hostPlatform === 'win32' && proc.pid) {
      try {
        const killer = spawnProcess('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer?.on?.('error', () => {});
        killer?.unref?.();
      } catch {}
    }
    try { proc.kill(); } catch {}
  }

  function setVncPassword(targetId, password) {
    const norm = normalizeVncTargetId(targetId);
    if (password === undefined || password === null || password === '') {
      passwordsByTargetId.delete(norm);
    } else {
      passwordsByTargetId.set(norm, String(password));
    }
  }

  function clearVncPassword(targetId) {
    passwordsByTargetId.delete(normalizeVncTargetId(targetId));
  }

  function hasVncPassword(targetId) {
    return passwordsByTargetId.has(normalizeVncTargetId(targetId));
  }

  function onResize(listener) {
    if (typeof listener !== 'function') return () => {};
    resizeListeners.add(listener);
    return () => resizeListeners.delete(listener);
  }

  function subscribeUpdates(targetId, listener) {
    if (typeof listener !== 'function') return () => {};
    let set = subscribersByTargetId.get(targetId);
    if (!set) {
      set = new Set();
      subscribersByTargetId.set(targetId, set);
    }
    set.add(listener);
    const active = sessionsById.get(targetId);
    if (active && !active.closed && active.client?.connected && !active.continuousUpdatesActive && !active.updatePending) {
      try {
        active.updatePending = true;
        active.client.requestUpdate(true);
      } catch {
        active.updatePending = false;
      }
    }
    return () => {
      set.delete(listener);
      if (set.size === 0) subscribersByTargetId.delete(targetId);
    };
  }

  function subscribeClipboard(targetId, listener) {
    if (typeof listener !== 'function') return () => {};
    let set = clipboardSubscribersByTargetId.get(targetId);
    if (!set) {
      set = new Set();
      clipboardSubscribersByTargetId.set(targetId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) clipboardSubscribersByTargetId.delete(targetId);
    };
  }

  function emitSubscriberClipboard(targetId, text, updatedAtMs) {
    const set = clipboardSubscribersByTargetId.get(targetId);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn({ targetId, text, updatedAtMs }); } catch {}
    }
  }

  function emitSubscriberUpdate(targetId, payload) {
    const set = subscribersByTargetId.get(targetId);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch {}
    }
  }

  function openSshRfbStream(target, { timeoutMs, signal }) {
    const isPve = target.kind === 'pve';
    const sshArgs = isPve
      ? buildPveVncProxyArgs(target.sshHost, target.vmid)
      : buildVncSshTunnelArgs(target.sshHost, target.host, target.port);

    const proc = spawnProcess(sshBinary, sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.unref?.();

    return new Promise((resolve, reject) => {
      let settled = false;
      let ticket = null;
      let stderrBuf = '';
      const stdoutChunks = [];
      let stdoutLen = 0;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanupGateListeners();
        killProcessTree(proc);
        reject(err);
      };

      const finishIfReady = () => {
        if (settled) return;
        if (isPve && !ticket) return;
        if (stdoutLen < 12) return;

        const combined = Buffer.concat(stdoutChunks, stdoutLen);
        const banner = combined.subarray(0, 12).toString('latin1');
        if (!RFB_BANNER_RE.test(banner)) {
          const safeStderr = redactSecret(stderrBuf.trim(), ticket);
          const tail = safeStderr ? ` (stderr: ${safeStderr.slice(-400)})` : '';
          fail(
            new Error(
              `RFB handshake gate failed for ${target.id}: expected 12-byte "RFB 003.008\\n" banner, got ${JSON.stringify(banner)}${tail}`,
            ),
          );
          return;
        }

        settled = true;
        cleanupGateListeners();
        const duplex = createProcessDuplex(proc, combined, () => killProcessTree(proc));
        resolve({ stream: duplex, ticket, proc, banner });
      };

      const onStdout = (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutChunks.push(buf);
        stdoutLen += buf.length;
        finishIfReady();
      };

      const onStderr = (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000);
        if (isPve && !ticket) {
          const match = TICKET_LINE_RE.exec(stderrBuf);
          if (match) {
            ticket = match[1];
            finishIfReady();
          }
        }
      };

      const onError = (err) => {
        const safeStderr = redactSecret(stderrBuf.trim(), ticket);
        fail(new Error(`RFB SSH spawn failed for ${target.id}: ${err?.message || String(err)}${safeStderr ? ` (${safeStderr.slice(-300)})` : ''}`));
      };

      const onExit = (code, sig) => {
        const safeStderr = redactSecret(stderrBuf.trim(), ticket);
        fail(
          new Error(
            `RFB SSH bridge exited before handshake for ${target.id} (code=${code ?? 'null'}, signal=${sig ?? 'none'})${safeStderr ? `: ${safeStderr.slice(-400)}` : ''}`,
          ),
        );
      };

      const onAbort = () => {
        fail(signal?.reason || Object.assign(new Error(`RFB connect aborted for ${target.id}`), { name: 'AbortError' }));
      };

      const timer = setTimeout(() => {
        const safeStderr = redactSecret(stderrBuf.trim(), ticket);
        const missing = isPve && !ticket ? 'KIKI_PVE_TICKET from stderr' : '12-byte RFB banner from stdout';
        fail(
          new Error(
            `RFB SSH bridge timed out after ${timeoutMs}ms waiting for ${missing} on ${target.id}${safeStderr ? `: ${safeStderr.slice(-400)}` : ''}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      const cleanupGateListeners = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        proc.stdout?.off?.('data', onStdout);
        proc.stderr?.off?.('data', onStderr);
        proc.off?.('error', onError);
        proc.off?.('exit', onExit);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      proc.stdout.on('data', onStdout);
      proc.stderr.on('data', onStderr);
      proc.once('error', onError);
      proc.once('exit', onExit);
    });
  }

  function teardownSession(targetId, { markNeedsRelease = false } = {}) {
    const sess = sessionsById.get(targetId);
    if (!sess) return;
    sessionsById.delete(targetId);
    sess.closed = true;
    if (sess.heartbeatTimer) {
      clearInterval(sess.heartbeatTimer);
      sess.heartbeatTimer = null;
    }
    if (sess.updateThrottleTimer) {
      clearTimeout(sess.updateThrottleTimer);
      sess.updateThrottleTimer = null;
    }
    if (sess.initialQuietTimer) {
      clearTimeout(sess.initialQuietTimer);
      sess.initialQuietTimer = null;
    }
    sess.heldButtonMask = 0;
    sess.heldKeys.clear();
    if (markNeedsRelease) {
      needsConservativeRelease.add(targetId);
    }
    for (const waiter of sess.settleWaiters.splice(0)) {
      waiter.onClose();
    }
    try { sess.client?.destroy?.(); } catch {}
    if (sess.proc) {
      killProcessTree(sess.proc);
      sess.proc = null;
    }
  }

  async function openSession(target, { signal } = {}) {
    let stream = null;
    let proc = null;
    let password;

    if (target.kind === 'pve') {
      const bridge = await openSshRfbStream(target, { timeoutMs: connectTimeoutMs, signal });
      stream = bridge.stream;
      proc = bridge.proc;
      password = bridge.ticket;
    } else {
      password = passwordsByTargetId.get(target.id);
      if (target.sshHost) {
        const bridge = await openSshRfbStream(target, { timeoutMs: connectTimeoutMs, signal });
        stream = bridge.stream;
        proc = bridge.proc;
      }
    }

    const connectOpts = {
      ...(stream ? { stream } : { host: target.host, port: target.port }),
      ...(password !== undefined ? { password } : {}),
      shared: true,
      maxClipboardBytes: MAX_RFB_CLIPBOARD_BYTES,
      encodings: [...LOSSLESS_RFB_ENCODINGS],
      timeout: connectTimeoutMs,
      initialUpdate: true,
      ...(signal ? { signal } : {}),
    };

    let client;
    try {
      client = await connectFn(connectOpts);
    } catch (err) {
      if (stream) {
        try { stream.destroy(); } catch {}
      }
      if (proc) killProcessTree(proc);
      const code = err?.code;
      const safeMsg = redactSecret(err?.message || String(err), password);
      if (target.kind === 'vnc' && (code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED')) {
        const hint = !passwordsByTargetId.has(target.id)
          ? `VNC authentication required for ${target.id} (passwords are kept in memory only and cleared on restart). Call uu_launch(action="connect", deviceId="${target.id}", vncPassword="...") to reconnect.`
          : `VNC authentication failed for ${target.id}. Verify the password and call uu_launch(action="connect", deviceId="${target.id}", vncPassword="...").`;
        throw Object.assign(new Error(hint), { code: code === 'AUTH_REQUIRED' ? 'vnc_auth_required' : 'vnc_auth_failed' });
      }
      throw new Error(`RFB connect failed for ${target.id}: ${safeMsg}`);
    }

    const fb = Framebuffer.attach(client);
    let resolveInitialFrame;
    const initialFramePromise = new Promise((resolve) => {
      resolveInitialFrame = resolve;
    });

    const session = {
      target,
      id: target.id,
      client,
      framebuffer: fb,
      proc,
      closed: false,
      connectedAtMs: nowFn(),
      frameSeq: 0,
      hasInitialFrame: false,
      initialFramePromise,
      initialPixelArea: 0,
      initialNonPixelRetries: 0,
      initialQuietTimer: null,
      lastDirtyAtMs: nowFn(),
      dirtyBounds: null,
      continuousUpdatesActive: false,
      triedContinuousUpdates: false,
      updatePending: false,
      updateThrottleTimer: null,
      heartbeatTimer: null,
      heldButtonMask: 0,
      lastPointerX: 0,
      lastPointerY: 0,
      heldKeys: new Map(),
      clipboardText: '',
      clipboardGeneration: 0,
      clipboardUpdatedAtMs: 0,
      lastSelfClipboardText: '',
      lastSelfClipboardAtMs: 0,
      settleWaiters: [],
    };

    const completeInitialFrame = () => {
      if (session.hasInitialFrame) return;
      session.hasInitialFrame = true;
      if (session.initialQuietTimer) {
        clearTimeout(session.initialQuietTimer);
        session.initialQuietTimer = null;
      }
      resolveInitialFrame();
      if (!session.continuousUpdatesActive && client.connected && subscribersByTargetId.has(target.id)) {
        scheduleIncrementalPull(10);
      }
    };

    const tryEnableContinuousUpdates = () => {
      if (session.closed || !client.connected || session.triedContinuousUpdates) return;
      if (!client.supports?.continuousUpdates) return;
      session.triedContinuousUpdates = true;
      try {
        client.enableContinuousUpdates(true);
        session.continuousUpdatesActive = true;
      } catch {
        session.continuousUpdatesActive = false;
      }
    };

    const scheduleIncrementalPull = (delayMs = 8) => {
      if (session.closed || !client.connected || session.continuousUpdatesActive) return;
      if (session.updatePending) return;
      session.updatePending = true;
      if (session.updateThrottleTimer) clearTimeout(session.updateThrottleTimer);
      session.updateThrottleTimer = setTimeout(() => {
        session.updateThrottleTimer = null;
        if (session.closed || !client.connected || session.continuousUpdatesActive) {
          session.updatePending = false;
          return;
        }
        try {
          client.requestUpdate(true);
        } catch {
          session.updatePending = false;
        }
      }, Math.max(2, delayMs));
      session.updateThrottleTimer.unref?.();
    };

    // Enable continuous updates immediately if Tight capabilities advertised it during handshake,
    // or once if a TigerVNC-style server sends an unsolicited EndOfContinuousUpdates banner.
    tryEnableContinuousUpdates();
    client.once('endOfContinuousUpdates', () => {
      tryEnableContinuousUpdates();
    });

    client.on('update', (update) => {
      session.updatePending = false;
      const rects = Array.isArray(update?.rects) ? update.rects : [];
      let bounds = null;
      let hasPixelChange = false;
      let hasPixelRect = false;
      let rectPixelArea = 0;
      for (const r of rects) {
        if (r && r.type === 'pixels') {
          hasPixelChange = true;
          hasPixelRect = true;
          rectPixelArea += Math.max(0, Number(r.width) || 0) * Math.max(0, Number(r.height) || 0);
          bounds = mergeBounds(bounds, { x: r.x, y: r.y, width: r.width, height: r.height });
        } else if (r && r.type === 'copy') {
          hasPixelChange = true;
          hasPixelRect = true;
          bounds = mergeBounds(bounds, { x: r.x, y: r.y, width: r.width, height: r.height });
        } else if (r && (r.type === 'desktopSize' || r.type === 'extendedDesktopSize')) {
          hasPixelChange = true;
          bounds = mergeBounds(bounds, { x: 0, y: 0, width: r.width, height: r.height });
        }
      }

      // F1: Never resolve initialFramePromise on a pseudo-rect-only update (QEMU sends capability/resize
      // pseudo-rects before pixels). Keep requesting until real pixels cover the framebuffer or settle.
      if (!session.hasInitialFrame) {
        if (hasPixelRect) {
          session.initialPixelArea += rectPixelArea;
          const targetArea = Math.max(1, (fb.width || client.width || 1) * (fb.height || client.height || 1));
          if (session.initialPixelArea >= targetArea) {
            completeInitialFrame();
          } else {
            if (session.initialQuietTimer) clearTimeout(session.initialQuietTimer);
            session.initialQuietTimer = setTimeout(() => completeInitialFrame(), 80);
            session.initialQuietTimer.unref?.();
            if (!session.continuousUpdatesActive && client.connected) {
              try { client.requestUpdate(true); } catch {}
            }
          }
        } else if (!session.continuousUpdatesActive && client.connected && session.initialNonPixelRetries < 6) {
          session.initialNonPixelRetries += 1;
          try { client.requestUpdate(false); } catch {}
        }
      }

      if (hasPixelChange) {
        session.frameSeq += 1;
        session.lastDirtyAtMs = nowFn();
        session.dirtyBounds = mergeBounds(session.dirtyBounds, bounds);
        for (const waiter of [...session.settleWaiters]) {
          waiter.onUpdate(session.frameSeq, bounds);
        }

        let orderedRects = null;
        if (subscribersByTargetId.has(target.id) && fb.width > 0 && fb.height > 0) {
          const hasResize = rects.some((r) => r && (r.type === 'desktopSize' || r.type === 'extendedDesktopSize'));
          if (!hasResize && rects.length <= 128) {
            // Check whether any CopyRect destination overlaps an earlier pixel rect in the same batch;
            // if so, materialize from authoritative fb so order-dependent overwrites never diverge!
            let copyOverlapsEarlier = false;
            const seenPixelRects = [];
            for (const r of rects) {
              if (!r) continue;
              if (r.type === 'pixels') {
                seenPixelRects.push(r);
              } else if (r.type === 'copy') {
                for (const p of seenPixelRects) {
                  const overlap = r.x < p.x + p.width && r.x + r.width > p.x && r.y < p.y + p.height && r.y + r.height > p.y;
                  if (overlap) {
                    copyOverlapsEarlier = true;
                    break;
                  }
                }
                if (copyOverlapsEarlier) break;
              }
            }

            if (!copyOverlapsEarlier) {
              orderedRects = [];
              for (const r of rects) {
                if (!r || r.width <= 0 || r.height <= 0) continue;
                const rx = clamp(r.x, 0, Math.max(0, fb.width - 1));
                const ry = clamp(r.y, 0, Math.max(0, fb.height - 1));
                const rw = Math.min(r.width, fb.width - rx);
                const rh = Math.min(r.height, fb.height - ry);
                if (rw <= 0 || rh <= 0) continue;
                if (r.type === 'copy') {
                  orderedRects.push({
                    encoding: RECT_COPYRECT,
                    x: rx,
                    y: ry,
                    width: rw,
                    height: rh,
                    srcX: clamp(r.srcX || 0, 0, Math.max(0, fb.width - rw)),
                    srcY: clamp(r.srcY || 0, 0, Math.max(0, fb.height - rh)),
                  });
                } else if (r.type === 'pixels') {
                  orderedRects.push({
                    encoding: RECT_DEFLATE_RGBA,
                    x: rx,
                    y: ry,
                    width: rw,
                    height: rh,
                    rgba: fb.toRgba(client.colorMap, { x: rx, y: ry, width: rw, height: rh }),
                  });
                }
              }
            }
          }
        }

        emitSubscriberUpdate(target.id, {
          targetId: target.id,
          frameSeq: session.frameSeq,
          width: fb.width,
          height: fb.height,
          dirtyBounds: bounds,
          rects: orderedRects,
        });
      }

      // Keep framebuffer fresh via backpressure-throttled incremental pulls when subscribers or waiters exist.
      if (session.hasInitialFrame && !session.continuousUpdatesActive && (subscribersByTargetId.has(target.id) || session.settleWaiters.length > 0)) {
        scheduleIncrementalPull();
      }
    });

    client.on('resize', ({ width, height, screens }) => {
      const dims = { width, height, screens };
      for (const fn of [...resizeListeners]) {
        try { fn(target.id, dims); } catch {}
      }
      emitSubscriberUpdate(target.id, {
        targetId: target.id,
        frameSeq: session.frameSeq,
        width,
        height,
        resized: true,
      });
    });

    client.on('clipboard', (text) => {
      const str = String(text ?? '');
      const now = nowFn();
      session.clipboardText = str;
      session.clipboardGeneration += 1;
      session.clipboardUpdatedAtMs = now;
      if (str && (str !== session.lastSelfClipboardText || now - session.lastSelfClipboardAtMs > 1200)) {
        emitSubscriberClipboard(target.id, str, now);
      }
    });

    client.on('clipboardEmpty', () => {
      session.clipboardText = '';
      session.clipboardGeneration += 1;
      session.clipboardUpdatedAtMs = nowFn();
    });

    client.on('error', () => {
      teardownSession(target.id, { markNeedsRelease: true });
    });

    client.on('close', () => {
      teardownSession(target.id, { markNeedsRelease: true });
    });

    if (heartbeatIntervalMs > 0) {
      session.heartbeatTimer = setInterval(() => {
        if (session.closed || !client.connected) return;
        try {
          client.requestUpdate(true);
        } catch {}
      }, heartbeatIntervalMs);
      session.heartbeatTimer.unref?.();
    }

    sessionsById.set(target.id, session);

    // Wait briefly for the first framebuffer update so width/height/pixels and capabilities settle.
    if (!session.hasInitialFrame) {
      await Promise.race([
        initialFramePromise,
        sleep(initialFrameTimeoutMs, signal).catch(() => {}),
      ]);
    }

    // D2.3: After unexpected disconnect/reconnect, conservatively release modifier keys & pointer buttons (idempotent).
    if (needsConservativeRelease.delete(target.id) && client.connected && !session.closed) {
      sendConservativeReleaseOnSession(session);
    }

    return session;
  }

  async function ensureConnected(targetOrId, { signal } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const existing = sessionsById.get(target.id);
    if (existing && !existing.closed && existing.client?.connected) {
      return existing;
    }
    if (existing) {
      teardownSession(target.id, { markNeedsRelease: true });
    }
    if (connectFlights.has(target.id)) {
      return connectFlights.get(target.id);
    }
    const flight = openSession(target, { signal }).finally(() => {
      if (connectFlights.get(target.id) === flight) {
        connectFlights.delete(target.id);
      }
    });
    connectFlights.set(target.id, flight);
    return flight;
  }

  function sendKeyOnSession(session, keyInfo, down) {
    if (session.closed || !session.client?.connected) {
      throw new Error(`RFB connection closed on ${session.id}.`);
    }
    const trackKey = `${keyInfo.keysym}:${keyInfo.xtScancode}`;
    if (down) {
      session.heldKeys.set(trackKey, keyInfo);
    } else {
      session.heldKeys.delete(trackKey);
    }
    if (session.client.supports?.qemuExtendedKeyEvent && Number.isInteger(keyInfo.xtScancode)) {
      session.client.qemuKeyEvent(keyInfo.keysym, keyInfo.xtScancode, Boolean(down));
    } else {
      session.client.keyEvent(keyInfo.keysym, Boolean(down));
    }
  }

  function sendPointerOnSession(session, x, y, buttonMask) {
    if (session.closed || !session.client?.connected) {
      throw new Error(`RFB connection closed on ${session.id}.`);
    }
    const px = clamp(Math.round(x), 0, Math.max(0, (session.client.width || 1) - 1));
    const py = clamp(Math.round(y), 0, Math.max(0, (session.client.height || 1) - 1));
    session.lastPointerX = px;
    session.lastPointerY = py;
    session.heldButtonMask = buttonMask & 0xff;
    session.client.pointerEvent(px, py, session.heldButtonMask);
  }

  function sendConservativeReleaseOnSession(session) {
    if (session.closed || !session.client?.connected) return;
    try {
      session.client.pointerEvent(session.lastPointerX, session.lastPointerY, 0);
      session.heldButtonMask = 0;
    } catch {}
    for (const [, keyInfo] of [...session.heldKeys.entries()]) {
      try {
        sendKeyOnSession(session, keyInfo, false);
      } catch {}
    }
    session.heldKeys.clear();
    for (const mod of ALL_MODIFIER_RFB_KEYS) {
      try {
        if (session.client.supports?.qemuExtendedKeyEvent) {
          session.client.qemuKeyEvent(mod.keysym, mod.xtScancode, false);
        } else {
          session.client.keyEvent(mod.keysym, false);
        }
      } catch {}
    }
  }

  async function releaseAllInputs(targetOrId, { conservative = true } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    if (!session || session.closed || !session.client?.connected) {
      needsConservativeRelease.add(target.id);
      return { ok: true, released: false, deferred: true };
    }
    if (conservative) {
      sendConservativeReleaseOnSession(session);
    } else {
      if (session.heldButtonMask !== 0) {
        try {
          sendPointerOnSession(session, session.lastPointerX, session.lastPointerY, 0);
        } catch {}
      }
      for (const [, keyInfo] of [...session.heldKeys.entries()]) {
        try {
          sendKeyOnSession(session, keyInfo, false);
        } catch {}
      }
      session.heldKeys.clear();
    }
    return { ok: true, released: true };
  }

  async function getSessionCapabilities(targetOrId) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    if (!session || session.closed || !session.client?.connected) {
      return {
        connected: false,
        unicodeClipboard: false,
        extendedClipboard: false,
        qemuExtendedKeyEvent: false,
        continuousUpdates: false,
        width: null,
        height: null,
        name: null,
      };
    }
    return {
      connected: true,
      unicodeClipboard: Boolean(session.client.supports?.unicodeClipboard),
      extendedClipboard: Boolean(session.client.supports?.extendedClipboard),
      qemuExtendedKeyEvent: Boolean(session.client.supports?.qemuExtendedKeyEvent),
      continuousUpdates: Boolean(session.client.supports?.continuousUpdates),
      width: session.framebuffer.width || session.client.width,
      height: session.framebuffer.height || session.client.height,
      name: session.client.name || null,
    };
  }

  async function awaitFreshUpdateOnSession(session, { timeoutMs = 250, signal } = {}) {
    if (session.closed || !session.client?.connected) return;
    if (session.client.supports?.fence && typeof session.client.fence === 'function') {
      const token = Buffer.from(`kf${Date.now() & 0xffff}`);
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          session.client.off('fence', onFence);
          session.client.off('close', finish);
          signal?.removeEventListener?.('abort', finish);
          resolve();
        };
        const onFence = (evt) => {
          if (evt?.payload && Buffer.isBuffer(evt.payload) && evt.payload.equals(token)) {
            finish();
          }
        };
        const timer = setTimeout(finish, timeoutMs);
        timer.unref?.();
        session.client.on('fence', onFence);
        session.client.once('close', finish);
        signal?.addEventListener?.('abort', finish, { once: true });
        try {
          session.client.requestUpdate(true);
          session.client.fence(RFB_FENCE_FLAGS.blockBefore | RFB_FENCE_FLAGS.blockAfter, token);
        } catch {
          finish();
        }
      });
      return;
    }
    try {
      session.client.requestUpdate(true);
      await Promise.race([
        session.client.nextUpdate().catch(() => {}),
        sleep(timeoutMs, signal).catch(() => {}),
      ]);
    } catch {}
  }

  async function captureRgba(targetOrId, { signal, requestFresh = false } = {}) {
    const session = await ensureConnected(targetOrId, { signal });
    if (!session.hasInitialFrame) {
      await Promise.race([
        session.initialFramePromise,
        sleep(initialFrameTimeoutMs, signal).catch(() => {}),
      ]);
    }
    if (requestFresh && !session.continuousUpdatesActive && session.client.connected) {
      await awaitFreshUpdateOnSession(session, { timeoutMs: 250, signal });
    }
    const fb = session.framebuffer;
    const width = Math.max(1, fb.width);
    const height = Math.max(1, fb.height);
    const rawRgba = fb.toRgba(session.client.colorMap);
    const data = new Uint8Array(rawRgba.buffer, rawRgba.byteOffset, rawRgba.byteLength);
    return {
      width,
      height,
      data,
      image: { width, height, data },
      frameSeq: session.frameSeq,
      stageBounds: { x: 0, y: 0, width, height },
      supports: { ...session.client.supports },
      desktopName: session.client.name || null,
    };
  }

  function getCurrentFrameSeq(targetOrId) {
    const target = normalizeRfbTarget(targetOrId);
    return sessionsById.get(target.id)?.frameSeq ?? 0;
  }

  async function waitForSettle(targetOrId, {
    startSeq = 0,
    changeWaitMs = 300,
    quietMs = 150,
    maxWaitMs = 1200,
    signal,
  } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    const startedAt = nowFn();
    if (!session || session.closed || !session.client?.connected) {
      return { settled: false, changed: false, waitedMs: 0, dirtyBounds: null };
    }

    const effectiveMax = Math.max(0, Math.min(10_000, Math.round(Number(maxWaitMs) || 1200)));
    const effectiveChangeWait = Math.max(0, Math.min(effectiveMax, Math.round(Number(changeWaitMs) || 300)));
    const effectiveQuiet = Math.max(10, Math.min(effectiveMax, Math.round(Number(quietMs) || 150)));
    if (effectiveMax === 0) {
      return {
        settled: true,
        changed: session.frameSeq > startSeq,
        waitedMs: 0,
        dirtyBounds: session.frameSeq > startSeq ? session.dirtyBounds : null,
      };
    }

    if (!session.continuousUpdatesActive) {
      try {
        session.client.requestUpdate(true);
      } catch {}
    }

    return new Promise((resolve) => {
      let done = false;
      let changed = session.frameSeq > startSeq;
      let dirtyBounds = changed ? session.dirtyBounds : null;
      let changeTimer = null;
      let quietTimer = null;
      let maxTimer = null;

      const finish = (settled) => {
        if (done) return;
        done = true;
        if (changeTimer) clearTimeout(changeTimer);
        if (quietTimer) clearTimeout(quietTimer);
        if (maxTimer) clearTimeout(maxTimer);
        signal?.removeEventListener?.('abort', onAbort);
        const idx = session.settleWaiters.indexOf(waiter);
        if (idx >= 0) session.settleWaiters.splice(idx, 1);
        resolve({
          settled,
          changed,
          waitedMs: Math.max(0, Math.round(nowFn() - startedAt)),
          dirtyBounds,
        });
      };

      const armQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(true), effectiveQuiet);
        quietTimer.unref?.();
      };

      const onAbort = () => finish(false);

      const waiter = {
        onUpdate(seq, bounds) {
          if (seq <= startSeq) return;
          changed = true;
          dirtyBounds = mergeBounds(dirtyBounds, bounds);
          if (changeTimer) {
            clearTimeout(changeTimer);
            changeTimer = null;
          }
          armQuiet();
        },
        onClose() {
          finish(false);
        },
      };

      if (signal?.aborted) {
        finish(false);
        return;
      }

      session.settleWaiters.push(waiter);
      signal?.addEventListener?.('abort', onAbort, { once: true });

      maxTimer = setTimeout(() => finish(false), effectiveMax);
      maxTimer.unref?.();

      if (changed) {
        armQuiet();
      } else {
        changeTimer = setTimeout(() => finish(true), effectiveChangeWait);
        changeTimer.unref?.();
      }
    });
  }

  async function clipboardGet(targetOrId, { allowLatin1Fallback = false, signal } = {}) {
    const session = await ensureConnected(targetOrId, { signal });
    const unicodeOk = Boolean(session.client.supports?.unicodeClipboard);
    if (!unicodeOk && !allowLatin1Fallback) {
      throw createUnicodeUnsupportedError('RFB server does not advertise ExtendedClipboard');
    }
    return {
      ok: true,
      text: session.clipboardText ?? '',
      generation: session.clipboardGeneration,
      unicodeClipboard: unicodeOk,
    };
  }

  async function clipboardSet(targetOrId, text, { allowLatin1Fallback = false, signal } = {}) {
    const str = String(text ?? '');
    const byteLen = Buffer.byteLength(str, 'utf8');
    if (byteLen > MAX_RFB_CLIPBOARD_BYTES) {
      throw new Error(`Clipboard payload (${byteLen} bytes) exceeds 2 MiB ExtendedClipboard cap.`);
    }
    const session = await ensureConnected(targetOrId, { signal });
    const unicodeOk = Boolean(session.client.supports?.unicodeClipboard);
    if (unicodeOk) {
      session.lastSelfClipboardText = str;
      session.lastSelfClipboardAtMs = nowFn();
      session.client.updateClipboard(str);
      session.clipboardText = str;
      session.clipboardGeneration += 1;
      session.clipboardUpdatedAtMs = session.lastSelfClipboardAtMs;
      return { ok: true, length: str.length, mode: 'extended_clipboard_utf8' };
    }
    if (!isAsciiOnlyText(str)) {
      throw createUnicodeUnsupportedError('RFB server lacks ExtendedClipboard for non-ASCII text');
    }
    if (!allowLatin1Fallback) {
      throw createUnicodeUnsupportedError('RFB server does not advertise ExtendedClipboard');
    }
    session.lastSelfClipboardText = str;
    session.lastSelfClipboardAtMs = nowFn();
    session.client.updateClipboard(str);
    session.clipboardText = str;
    session.clipboardGeneration += 1;
    session.clipboardUpdatedAtMs = nowFn();
    return { ok: true, length: str.length, mode: 'latin1_cut_text' };
  }

  function buttonNameToMask(button) {
    if (button === 'right') return RFB_BUTTONS.right;
    if (button === 'middle') return RFB_BUTTONS.middle;
    return RFB_BUTTONS.left;
  }

  /**
   * Execute an ordered batch of high-level actions over RFB.
   * Enforces OSWorld non-idempotent guard: transparent reconnect is allowed ONLY before
   * sending the first input byte; mid-flight disconnect fails immediately without replay.
   */
  async function executeActions(targetOrId, actions, {
    coordinateMode = 'normalized_1000',
    zoomRelative = false,
    lastObservation = null,
    allowLatin1Clipboard = false,
    signal,
  } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    let session;
    try {
      session = await ensureConnected(target, { signal });
    } catch (err) {
      throw Object.assign(err, { failedBeforeSending: true });
    }

    const screenSize = {
      width: Math.max(1, session.framebuffer.width || session.client.width || 1024),
      height: Math.max(1, session.framebuffer.height || session.client.height || 768),
    };
    const stageBounds = { x: 0, y: 0, width: screenSize.width, height: screenSize.height };
    const contentRect = { x: 0, y: 0, width: screenSize.width, height: screenSize.height };

    const results = [];
    let lastPoint = null;
    let bytesSent = false;
    let midFlightClosed = false;

    const onMidFlightClose = () => {
      if (bytesSent) midFlightClosed = true;
    };
    session.client.on('close', onMidFlightClose);

    const assertStillConnected = () => {
      if (signal?.aborted) {
        throw signal.reason || Object.assign(new Error('RFB action aborted'), { name: 'AbortError' });
      }
      if (midFlightClosed || session.closed || !session.client?.connected) {
        if (bytesSent) {
          throw Object.assign(
            new Error(`RFB connection dropped mid-flight on ${target.id}; non-idempotent input was NOT replayed.`),
            {
              code: 'non_idempotent_transport_failure',
              replaySuppressed: true,
              executed: results.length,
              results,
            },
          );
        }
        throw Object.assign(new Error(`RFB connection closed before sending on ${target.id}.`), {
          failedBeforeSending: true,
        });
      }
    };

    const markSent = () => {
      bytesSent = true;
    };

    const resolvePt = (x, y) => mapPointToTarget({
      x,
      y,
      coordinateMode,
      zoomRelative,
      stageBounds,
      contentRect,
      lastObservation,
    });

    try {
      for (const item of actions) {
        assertStillConnected();
        const kind = item.kind;

        if (kind === 'wait') {
          const durationMs = clamp(Math.round(Number(item.durationMs) || 250), 0, 30_000);
          await sleep(durationMs, signal);
          results.push({ kind: 'wait', durationMs });
          continue;
        }

        if (kind === 'focus' || kind === 'restore') {
          results.push({ kind, focused: true, note: 'RFB session does not require local window focus.' });
          continue;
        }

        if (kind === 'clipboard_get') {
          const clip = await clipboardGet(target, { allowLatin1Fallback: allowLatin1Clipboard, signal });
          results.push({ kind: 'clipboard_get', text: clip.text, generation: clip.generation });
          continue;
        }

        if (kind === 'clipboard_set') {
          const text = String(item.text ?? '');
          const setRes = await clipboardSet(target, text, { allowLatin1Fallback: allowLatin1Clipboard, signal });
          markSent();
          results.push({ kind: 'clipboard_set', length: setRes.length, mode: setRes.mode });
          continue;
        }

        if (kind === 'move') {
          const pt = resolvePt(item.x, item.y);
          markSent();
          sendPointerOnSession(session, pt.x, pt.y, session.heldButtonMask);
          lastPoint = { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY };
          results.push({ kind: 'move', point: lastPoint });
          continue;
        }

        if (
          kind === 'click' ||
          kind === 'double_click' ||
          kind === 'right_click' ||
          kind === 'mouse_down' ||
          kind === 'mouse_up'
        ) {
          const button = kind === 'right_click' ? 'right' : (item.button || 'left');
          const bit = buttonNameToMask(button);
          let pt = null;
          let px = session.lastPointerX;
          let py = session.lastPointerY;
          if (item.x !== undefined && item.y !== undefined) {
            pt = resolvePt(item.x, item.y);
            px = pt.x;
            py = pt.y;
          }

          const modKeys = Array.isArray(item.modifiers) && item.modifiers.length > 0
            ? normalizeRfbKeyChord(item.modifiers)
            : [];

          markSent();
          if (pt) {
            sendPointerOnSession(session, px, py, session.heldButtonMask);
            await sleep(10, signal);
            assertStillConnected();
          }

          for (const mod of modKeys) {
            sendKeyOnSession(session, mod, true);
          }

          const count = kind === 'double_click'
            ? 2
            : kind === 'right_click'
              ? 1
              : clamp(Math.round(Number(item.count) || 1), 1, 3);

          if (kind === 'mouse_down') {
            sendPointerOnSession(session, px, py, session.heldButtonMask | bit);
          } else if (kind === 'mouse_up') {
            sendPointerOnSession(session, px, py, session.heldButtonMask & ~bit);
          } else {
            for (let c = 0; c < count; c += 1) {
              assertStillConnected();
              sendPointerOnSession(session, px, py, session.heldButtonMask | bit);
              await sleep(24, signal);
              assertStillConnected();
              sendPointerOnSession(session, px, py, session.heldButtonMask & ~bit);
              if (c + 1 < count) {
                await sleep(48, signal);
              }
            }
          }

          for (let m = modKeys.length - 1; m >= 0; m -= 1) {
            if (!session.closed && session.client?.connected) {
              sendKeyOnSession(session, modKeys[m], false);
            }
          }

          if (pt) {
            lastPoint = { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY };
          }
          results.push({
            kind,
            button,
            ...(kind === 'mouse_down' || kind === 'mouse_up' ? {} : { count }),
            ...(lastPoint ? { point: lastPoint } : {}),
          });
          continue;
        }

        if (kind === 'drag') {
          const startPt = resolvePt(item.startX, item.startY);
          const endPt = resolvePt(item.endX, item.endY);
          const button = item.button || 'left';
          const bit = buttonNameToMask(button);
          const durationMs = clamp(Math.round(Number(item.durationMs) || 260), 60, 5000);
          const segments = clamp(Math.round(durationMs / 25), 5, 20);
          const stepSleep = Math.max(8, Math.round(durationMs / segments));

          markSent();
          sendPointerOnSession(session, startPt.x, startPt.y, session.heldButtonMask);
          await sleep(16, signal);
          assertStillConnected();
          sendPointerOnSession(session, startPt.x, startPt.y, session.heldButtonMask | bit);
          await sleep(20, signal);

          for (let s = 1; s <= segments; s += 1) {
            assertStillConnected();
            const t = s / segments;
            const ix = Math.round(startPt.x + (endPt.x - startPt.x) * t);
            const iy = Math.round(startPt.y + (endPt.y - startPt.y) * t);
            sendPointerOnSession(session, ix, iy, session.heldButtonMask);
            await sleep(stepSleep, signal);
          }

          assertStillConnected();
          sendPointerOnSession(session, endPt.x, endPt.y, session.heldButtonMask & ~bit);
          lastPoint = { x: endPt.x, y: endPt.y, normX: endPt.normX, normY: endPt.normY };
          results.push({
            kind: 'drag',
            button,
            start: { x: startPt.x, y: startPt.y, normX: startPt.normX, normY: startPt.normY },
            end: lastPoint,
            durationMs,
          });
          continue;
        }

        if (kind === 'scroll') {
          let pt = null;
          let px = session.lastPointerX;
          let py = session.lastPointerY;
          if (item.x !== undefined && item.y !== undefined) {
            pt = resolvePt(item.x, item.y);
            px = pt.x;
            py = pt.y;
          }
          const rawDy = Number(item.deltaY) || 0;
          const rawDx = Number(item.deltaX) || 0;
          const toTicks = (delta) => {
            if (delta === 0) return 0;
            const mag = Math.abs(delta);
            return clamp(mag <= 20 ? Math.round(mag) : Math.max(1, Math.round(mag / 120)), 1, 20);
          };

          markSent();
          if (pt) {
            sendPointerOnSession(session, px, py, session.heldButtonMask);
            await sleep(10, signal);
          }

          const yTicks = toTicks(rawDy);
          const yBit = rawDy > 0 ? RFB_BUTTONS.wheelDown : RFB_BUTTONS.wheelUp;
          for (let i = 0; i < yTicks; i += 1) {
            assertStillConnected();
            sendPointerOnSession(session, px, py, session.heldButtonMask | yBit);
            sendPointerOnSession(session, px, py, session.heldButtonMask & ~yBit);
            if (i + 1 < yTicks) await sleep(15, signal);
          }

          const xTicks = toTicks(rawDx);
          const xBit = rawDx > 0 ? RFB_BUTTONS.wheelRight : RFB_BUTTONS.wheelLeft;
          for (let i = 0; i < xTicks; i += 1) {
            assertStillConnected();
            sendPointerOnSession(session, px, py, session.heldButtonMask | xBit);
            sendPointerOnSession(session, px, py, session.heldButtonMask & ~xBit);
            if (i + 1 < xTicks) await sleep(15, signal);
          }

          if (pt) {
            lastPoint = { x: pt.x, y: pt.y, normX: pt.normX, normY: pt.normY };
          }
          results.push({ kind: 'scroll', deltaX: rawDx, deltaY: rawDy, yTicks, xTicks, ...(lastPoint ? { point: lastPoint } : {}) });
          continue;
        }

        if (kind === 'key') {
          const chordInput = item.keys !== undefined ? item.keys : item.key;
          const chord = normalizeRfbKeyChord(chordInput);
          markSent();
          for (const k of chord) {
            assertStillConnected();
            sendKeyOnSession(session, k, true);
            await sleep(14, signal);
          }
          for (let i = chord.length - 1; i >= 0; i -= 1) {
            assertStillConnected();
            sendKeyOnSession(session, chord[i], false);
            if (i > 0) await sleep(10, signal);
          }
          results.push({ kind: 'key', keys: chord.map((k) => k.name) });
          continue;
        }

        if (kind === 'hold_key') {
          const chordInput = item.keys !== undefined ? item.keys : item.key;
          const chord = normalizeRfbKeyChord(chordInput);
          const holdMs = clamp(Math.round(Number(item.durationMs) || 300), 20, 10_000);
          markSent();
          for (const k of chord) {
            assertStillConnected();
            sendKeyOnSession(session, k, true);
          }
          await sleep(holdMs, signal);
          for (let i = chord.length - 1; i >= 0; i -= 1) {
            assertStillConnected();
            sendKeyOnSession(session, chord[i], false);
          }
          results.push({ kind: 'hold_key', keys: chord.map((k) => k.name), durationMs: holdMs });
          continue;
        }

        if (kind === 'type') {
          const text = String(item.text ?? '');
          const mode = item.mode || 'auto';
          const asciiOnly = isAsciiOnlyText(text);
          const wantClipboard = mode === 'clipboard' || !asciiOnly;

          if (wantClipboard) {
            if (!session.client.supports?.unicodeClipboard) {
              throw createUnicodeUnsupportedError(
                !asciiOnly
                  ? 'cannot type non-ASCII text without ExtendedClipboard'
                  : 'clipboard paste requested without ExtendedClipboard',
              );
            }
            markSent();
            await clipboardSet(target, text, { signal });
            await sleep(40, signal);
            assertStillConnected();
            const pasteChord = normalizeRfbKeyChord(['Ctrl', 'v']);
            for (const k of pasteChord) sendKeyOnSession(session, k, true);
            await sleep(20, signal);
            for (let i = pasteChord.length - 1; i >= 0; i -= 1) sendKeyOnSession(session, pasteChord[i], false);
            if (item.submit) {
              await sleep(25, signal);
              assertStillConnected();
              const retKey = asciiCharToRfbKey('\n');
              sendKeyOnSession(session, retKey, true);
              await sleep(16, signal);
              sendKeyOnSession(session, retKey, false);
            }
            results.push({ kind: 'type', length: text.length, mode: 'extended_clipboard_paste', submit: Boolean(item.submit) });
            continue;
          }

          // Pre-validate every ASCII character BEFORE sending any byte!
          const compiledChars = [];
          for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (ch === '\r' && text[i + 1] === '\n') continue;
            compiledChars.push(asciiCharToRfbKey(ch));
          }

          markSent();
          for (let i = 0; i < compiledChars.length; i += 1) {
            assertStillConnected();
            const key = compiledChars[i];
            if (key.shift) {
              sendKeyOnSession(session, SHIFT_LEFT_KEY, true);
              await sleep(6, signal);
            }
            sendKeyOnSession(session, key, true);
            await sleep(12, signal);
            sendKeyOnSession(session, key, false);
            if (key.shift) {
              await sleep(6, signal);
              sendKeyOnSession(session, SHIFT_LEFT_KEY, false);
            }
            if (i + 1 < compiledChars.length) {
              await sleep(10, signal);
            }
          }
          if (item.submit) {
            assertStillConnected();
            if (compiledChars.length > 0) await sleep(18, signal);
            const retKey = asciiCharToRfbKey('\n');
            sendKeyOnSession(session, retKey, true);
            await sleep(16, signal);
            sendKeyOnSession(session, retKey, false);
          }
          results.push({ kind: 'type', length: text.length, mode: 'rfb_keystrokes', submit: Boolean(item.submit) });
          continue;
        }

        throw new Error(`Unsupported RFB action kind: "${String(kind)}"`);
      }

      return {
        ok: true,
        executed: results.length,
        results,
        lastPoint,
        supports: { ...session.client.supports },
      };
    } catch (err) {
      // On abort or error while keys/buttons may be held, release all inputs cleanly!
      if (bytesSent && !session.closed && session.client?.connected) {
        sendConservativeReleaseOnSession(session);
      }
      throw err;
    } finally {
      session.client?.off?.('close', onMidFlightClose);
    }
  }

  async function buildKeyframePacket(targetOrId, { takeoverActive = false, signal } = {}) {
    const session = await ensureConnected(targetOrId, { signal });
    if (!session.hasInitialFrame) {
      await Promise.race([
        session.initialFramePromise,
        sleep(initialFrameTimeoutMs, signal).catch(() => {}),
      ]);
    }
    const fb = session.framebuffer;
    const width = Math.max(1, fb.width || session.client.width || 1024);
    const height = Math.max(1, fb.height || session.client.height || 768);
    if (session.frameSeq === 0) session.frameSeq = 1;
    const rgba = fb.toRgba(session.client.colorMap);
    const packet = packDirtyRectFrame({
      frameSeq: session.frameSeq,
      fbWidth: width,
      fbHeight: height,
      keyFrame: true,
      takeoverActive,
      rects: [{ encoding: RECT_DEFLATE_RGBA, x: 0, y: 0, width, height, rgba }],
    });
    return {
      packet,
      frameSeq: session.frameSeq,
      width,
      height,
      capabilities: await getSessionCapabilities(session.target),
    };
  }

  function buildCoalescedBoundsPacket(targetOrId, bounds, { takeoverActive = false } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    if (!session || session.closed || !session.client?.connected) return null;
    const fb = session.framebuffer;
    const width = Math.max(1, fb.width || session.client.width || 1024);
    const height = Math.max(1, fb.height || session.client.height || 768);
    const bx = clamp(Math.round(bounds?.x || 0), 0, width - 1);
    const by = clamp(Math.round(bounds?.y || 0), 0, height - 1);
    const bw = clamp(Math.round(bounds?.width || width), 1, width - bx);
    const bh = clamp(Math.round(bounds?.height || height), 1, height - by);
    const isFull = bx === 0 && by === 0 && bw === width && bh === height;
    const rgba = fb.toRgba(session.client.colorMap, { x: bx, y: by, width: bw, height: bh });
    return packDirtyRectFrame({
      frameSeq: session.frameSeq,
      fbWidth: width,
      fbHeight: height,
      keyFrame: isFull,
      takeoverActive,
      rects: [{ encoding: RECT_DEFLATE_RGBA, x: bx, y: by, width: bw, height: bh, rgba }],
    });
  }

  function armInteractivePull(session) {
    if (!session || session.closed || !session.client?.connected || session.continuousUpdatesActive) return;
    if (session.updateThrottleTimer) {
      clearTimeout(session.updateThrottleTimer);
      session.updateThrottleTimer = null;
      session.updatePending = false;
    }
    if (!session.updatePending) {
      session.updatePending = true;
      try {
        session.client.requestUpdate(true);
      } catch {
        session.updatePending = false;
      }
    }
  }

  function requestImmediateUpdate(targetOrId) {
    try {
      const target = normalizeRfbTarget(targetOrId);
      const session = sessionsById.get(target.id);
      if (!session || session.closed || !session.client?.connected) return false;
      armInteractivePull(session);
      return true;
    } catch {
      return false;
    }
  }

  function sendLivePointer(targetOrId, { norm1000X, norm1000Y, buttonsMask = 0 } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    if (!session || session.closed || !session.client?.connected) return false;
    const w = Math.max(1, session.framebuffer.width || session.client.width || 1024);
    const h = Math.max(1, session.framebuffer.height || session.client.height || 768);
    const nx = clamp(Number(norm1000X) || 0, 0, 1000) / 1000;
    const ny = clamp(Number(norm1000Y) || 0, 0, 1000) / 1000;
    const px = w <= 1 ? 0 : Math.round(nx * (w - 1));
    const py = h <= 1 ? 0 : Math.round(ny * (h - 1));
    sendPointerOnSession(session, px, py, buttonsMask & 0x07);
    armInteractivePull(session);
    return { x: px, y: py };
  }

  function sendLiveWheel(targetOrId, { norm1000X, norm1000Y, deltaX = 0, deltaY = 0 } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    if (!session || session.closed || !session.client?.connected) return false;
    const w = Math.max(1, session.framebuffer.width || session.client.width || 1024);
    const h = Math.max(1, session.framebuffer.height || session.client.height || 768);
    const nx = clamp(Number(norm1000X) || 0, 0, 1000) / 1000;
    const ny = clamp(Number(norm1000Y) || 0, 0, 1000) / 1000;
    const px = w <= 1 ? 0 : Math.round(nx * (w - 1));
    const py = h <= 1 ? 0 : Math.round(ny * (h - 1));
    const toTicks = (d) => {
      if (!d) return 0;
      const mag = Math.abs(d);
      return clamp(mag <= 20 ? Math.round(mag) : Math.max(1, Math.round(mag / 100)), 1, 8);
    };
    const yTicks = toTicks(deltaY);
    if (yTicks > 0) {
      const bit = deltaY > 0 ? RFB_BUTTONS.wheelDown : RFB_BUTTONS.wheelUp;
      for (let i = 0; i < yTicks; i += 1) {
        sendPointerOnSession(session, px, py, session.heldButtonMask | bit);
        sendPointerOnSession(session, px, py, session.heldButtonMask & ~bit);
      }
    }
    const xTicks = toTicks(deltaX);
    if (xTicks > 0) {
      const bit = deltaX > 0 ? RFB_BUTTONS.wheelRight : RFB_BUTTONS.wheelLeft;
      for (let i = 0; i < xTicks; i += 1) {
        sendPointerOnSession(session, px, py, session.heldButtonMask | bit);
        sendPointerOnSession(session, px, py, session.heldButtonMask & ~bit);
      }
    }
    armInteractivePull(session);
    return { x: px, y: py, yTicks, xTicks };
  }

  function sendLiveRawKey(targetOrId, { code = '', key = '', down = true, shiftKey = false } = {}) {
    const target = normalizeRfbTarget(targetOrId);
    const session = sessionsById.get(target.id);
    if (!session || session.closed || !session.client?.connected) return false;
    const keyInfo = resolveDomCodeOrKey({ code, key, shiftKey });
    if (!keyInfo) return false;
    if (down === 2) {
      sendKeyOnSession(session, keyInfo, true);
      sendKeyOnSession(session, keyInfo, false);
    } else {
      sendKeyOnSession(session, keyInfo, Boolean(down));
    }
    armInteractivePull(session);
    return keyInfo;
  }

  async function disconnectTarget(targetOrId) {
    const target = normalizeRfbTarget(targetOrId);
    teardownSession(target.id, { markNeedsRelease: false });
    needsConservativeRelease.delete(target.id);
    return { ok: true, id: target.id };
  }

  async function dispose() {
    for (const id of [...sessionsById.keys()]) {
      teardownSession(id, { markNeedsRelease: false });
    }
    passwordsByTargetId.clear();
    subscribersByTargetId.clear();
    clipboardSubscribersByTargetId.clear();
    needsConservativeRelease.clear();
  }

  return {
    ensureConnected,
    captureRgba,
    buildKeyframePacket,
    buildCoalescedBoundsPacket,
    sendLivePointer,
    sendLiveWheel,
    sendLiveRawKey,
    requestImmediateUpdate,
    getCurrentFrameSeq,
    waitForSettle,
    executeActions,
    clipboardGet,
    clipboardSet,
    releaseAllInputs,
    getSessionCapabilities,
    subscribeUpdates,
    subscribeClipboard,
    onResize,
    setVncPassword,
    clearVncPassword,
    hasVncPassword,
    disconnectTarget,
    dispose,
  };
}
