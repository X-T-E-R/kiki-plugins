import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { computeScaledDimensions } from './coordinates.mjs';
import {
  applyGridOverlayToPng,
  cropAndScaleRgba,
  decodePngToRgba,
  encodeRgbaPng,
  parsePngDimensions,
} from './png-utils.mjs';
import { parseKeyChordTokens } from './win32-bridge.mjs';

const execFileAsync = promisify(execFile);

const MAC_KEYCODES = {
  RETURN: 36, ENTER: 36, TAB: 48, SPACE: 49, BACKSPACE: 51, ESCAPE: 53, ESC: 53,
  LEFT: 123, RIGHT: 124, DOWN: 125, UP: 126, DELETE: 117, HOME: 115, END: 119,
  PAGEUP: 116, PAGEDOWN: 121,
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12,
  W: 13, E: 14, R: 15, Y: 16, T: 17, '1': 18, '2': 19, '3': 20, '4': 21,
  '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, O: 31, U: 32, '[': 33, I: 34, P: 35, L: 37, J: 38, "'": 39, K: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, N: 45, M: 46, '.': 47,
};

async function runWithStdin(cmd, args, inputText) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `${cmd} exited with ${code}`));
    });
    child.stdin.end(inputText, 'utf8');
  });
}

export function createUnixDriver({ platform = process.platform } = {}) {
  async function listMonitorsDarwin() {
    const jxa = `
      ObjC.import('AppKit');
      const screens = $.NSScreen.screens;
      const count = screens.count;
      const primaryFrame = count > 0 ? screens.objectAtIndex(0).frame : { origin: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };
      const primaryH = primaryFrame.size.height;
      const out = [];
      let minX = 0, minY = 0, maxX = 1920, maxY = 1080;
      for (let i = 0; i < count; i++) {
        const s = screens.objectAtIndex(i);
        const f = s.frame;
        const scale = s.backingScaleFactor;
        const x = Math.round(f.origin.x);
        const y = Math.round(primaryH - f.origin.y - f.size.height);
        const w = Math.round(f.size.width);
        const h = Math.round(f.size.height);
        if (i === 0 || x < minX) minX = x;
        if (i === 0 || y < minY) minY = y;
        if (i === 0 || x + w > maxX) maxX = x + w;
        if (i === 0 || y + h > maxY) maxY = y + h;
        out.push({
          index: i,
          id: 'local:monitor-' + i,
          deviceName: 'Display ' + (i + 1),
          primary: i === 0,
          bounds: { x, y, width: w, height: h },
          workArea: { x, y, width: w, height: h },
          dpiX: Math.round(96 * scale),
          dpiY: Math.round(96 * scale),
          scaleFactor: Number(scale),
        });
      }
      const mouse = $.NSEvent.mouseLocation;
      const cursor = { x: Math.round(mouse.x), y: Math.round(primaryH - mouse.y) };
      JSON.stringify({ monitors: out, virtualScreen: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, cursor, selfElevated: true });
    `;
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 6_000 });
    return JSON.parse(stdout.trim());
  }

  async function listMonitorsLinux() {
    try {
      const { stdout } = await execFileAsync('xrandr', ['--query'], { timeout: 5_000 });
      const monitors = [];
      const lineRe = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/gm;
      let match;
      let idx = 0;
      while ((match = lineRe.exec(stdout)) !== null) {
        const w = Number(match[3]);
        const h = Number(match[4]);
        const x = Number(match[5]);
        const y = Number(match[6]);
        monitors.push({
          index: idx,
          id: `local:monitor-${idx}`,
          deviceName: match[1],
          primary: Boolean(match[2]) || idx === 0,
          bounds: { x, y, width: w, height: h },
          workArea: { x, y, width: w, height: h },
          dpiX: 96,
          dpiY: 96,
          scaleFactor: 1,
        });
        idx += 1;
      }
      if (monitors.length > 0) {
        const minX = Math.min(...monitors.map((m) => m.bounds.x));
        const minY = Math.min(...monitors.map((m) => m.bounds.y));
        const maxX = Math.max(...monitors.map((m) => m.bounds.x + m.bounds.width));
        const maxY = Math.max(...monitors.map((m) => m.bounds.y + m.bounds.height));
        const cursor = await getCursorPos();
        return {
          monitors,
          virtualScreen: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
          cursor,
          selfElevated: true,
        };
      }
    } catch {}
    return {
      monitors: [{
        index: 0,
        id: 'local:monitor-0',
        deviceName: 'default',
        primary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        dpiX: 96,
        dpiY: 96,
        scaleFactor: 1,
      }],
      virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
      cursor: { x: 0, y: 0 },
      selfElevated: true,
    };
  }

  async function getCursorPos() {
    if (platform === 'darwin') {
      const info = await listMonitorsDarwin();
      return info.cursor;
    }
    try {
      const { stdout } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 3_000 });
      const mx = /^X=(-?\d+)/m.exec(stdout);
      const my = /^Y=(-?\d+)/m.exec(stdout);
      return { x: mx ? Number(mx[1]) : 0, y: my ? Number(my[1]) : 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  async function capture(params) {
    const {
      originX = 0,
      originY = 0,
      targetW = 1920,
      targetH = 1080,
      hasCrop = false,
      cropX = 0,
      cropY = 0,
      cropW = targetW,
      cropH = targetH,
      maxWidth = 1280,
      maxHeight = 900,
      overlay = 'none',
    } = params;

    const viewX = hasCrop ? cropX : 0;
    const viewY = hasCrop ? cropY : 0;
    const viewW = hasCrop ? cropW : targetW;
    const viewH = hasCrop ? cropH : targetH;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kiki-cua-cap-'));
    const shotPath = path.join(tmpDir, 'shot.png');

    try {
      const capX = originX + viewX;
      const capY = originY + viewY;
      if (platform === 'darwin') {
        await execFileAsync('screencapture', ['-x', '-t', 'png', '-R', `${capX},${capY},${viewW},${viewH}`, shotPath], { timeout: 10_000 });
      } else {
        let captured = false;
        try {
          await execFileAsync('grim', ['-g', `${capX},${capY} ${viewW}x${viewH}`, shotPath], { timeout: 8_000 });
          captured = true;
        } catch {}
        if (!captured) {
          await execFileAsync('import', ['-window', 'root', '-crop', `${viewW}x${viewH}+${capX}+${capY}`, '+repage', shotPath], { timeout: 8_000 });
        }
      }

      let pngBuf = await readFile(shotPath);
      const rawDim = parsePngDimensions(pngBuf);
      const scaled = computeScaledDimensions(rawDim.width, rawDim.height, maxWidth, maxHeight);
      if (scaled.width !== rawDim.width || scaled.height !== rawDim.height) {
        const decoded = decodePngToRgba(pngBuf);
        const resizedRgba = cropAndScaleRgba(decoded.rgba, decoded.width, decoded.height, null, scaled.width, scaled.height);
        pngBuf = encodeRgbaPng(scaled.width, scaled.height, resizedRgba);
      }
      if (overlay === 'grid') {
        pngBuf = applyGridOverlayToPng(pngBuf);
      }
      const finalDim = parsePngDimensions(pngBuf);
      const cursor = await getCursorPos();
      return {
        imageBase64: pngBuf.toString('base64'),
        byteLength: pngBuf.length,
        imageSize: { width: finalDim.width, height: finalDim.height },
        logicalSize: { width: targetW, height: targetH },
        targetOrigin: { x: originX, y: originY },
        cropBounds: hasCrop ? { x: viewX, y: viewY, width: viewW, height: viewH } : null,
        cursor,
        foregroundWindow: null,
        accessibility: [],
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function macCgMouse(kind, x, y, button = 'left', count = 1, endX = x, endY = y, deltaX = 0, deltaY = 0) {
    const script = `
      ObjC.import('CoreGraphics');
      const pt = $.CGPointMake(${Number(x)}, ${Number(y)});
      const btn = ${button === 'right' ? '$.kCGMouseButtonRight' : button === 'middle' ? '$.kCGMouseButtonCenter' : '$.kCGMouseButtonLeft'};
      const downType = ${button === 'right' ? '$.kCGEventRightMouseDown' : button === 'middle' ? '$.kCGEventOtherMouseDown' : '$.kCGEventLeftMouseDown'};
      const upType = ${button === 'right' ? '$.kCGEventRightMouseUp' : button === 'middle' ? '$.kCGEventOtherMouseUp' : '$.kCGEventLeftMouseUp'};
      const dragType = ${button === 'right' ? '$.kCGEventRightMouseDragged' : button === 'middle' ? '$.kCGEventOtherMouseDragged' : '$.kCGEventLeftMouseDragged'};
      if (${JSON.stringify(kind)} === 'move') {
        const ev = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, pt, btn);
        $.CGEventPost($.kCGHIDEventTap, ev);
      } else if (${JSON.stringify(kind)} === 'click') {
        for (let c = 1; c <= ${Number(count)}; c++) {
          const d = $.CGEventCreateMouseEvent($(), downType, pt, btn);
          $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, c);
          $.CGEventPost($.kCGHIDEventTap, d);
          const u = $.CGEventCreateMouseEvent($(), upType, pt, btn);
          $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, c);
          $.CGEventPost($.kCGHIDEventTap, u);
        }
      } else if (${JSON.stringify(kind)} === 'down') {
        const d = $.CGEventCreateMouseEvent($(), downType, pt, btn);
        $.CGEventPost($.kCGHIDEventTap, d);
      } else if (${JSON.stringify(kind)} === 'up') {
        const u = $.CGEventCreateMouseEvent($(), upType, pt, btn);
        $.CGEventPost($.kCGHIDEventTap, u);
      } else if (${JSON.stringify(kind)} === 'drag') {
        const endPt = $.CGPointMake(${Number(endX)}, ${Number(endY)});
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), downType, pt, btn));
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), dragType, endPt, btn));
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), upType, endPt, btn));
      } else if (${JSON.stringify(kind)} === 'scroll') {
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft));
        const s = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, ${Math.round(-deltaY)}, ${Math.round(-deltaX)});
        $.CGEventPost($.kCGHIDEventTap, s);
      }
    `;
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 6_000 });
    return { blocked: false, cursor: await getCursorPos() };
  }

  return {
    platform,
    isReady: () => true,
    warmup: async () => ({ ok: true }),
    listMonitors: () => (platform === 'darwin' ? listMonitorsDarwin() : listMonitorsLinux()),
    getCursorPos,
    async listWindows(query = '') {
      const q = String(query || '').trim().toLowerCase();
      if (platform === 'darwin') {
        const jxa = `
          const se = Application('System Events');
          const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
          const wins = [];
          for (const p of procs) {
            const pName = p.name();
            const pId = p.unixId();
            for (const w of p.windows()) {
              try {
                const pos = w.position();
                const sz = w.size();
                wins.push({
                  hwnd: pName + ':' + (w.name() || '0'),
                  windowId: pName + ':' + (w.name() || '0'),
                  title: w.name() || pName,
                  processId: pId,
                  processName: pName,
                  bounds: { x: pos[0], y: pos[1], width: sz[0], height: sz[1] },
                  dpi: 96,
                  scaleFactor: 1,
                  isMinimized: false,
                  isMaximized: false,
                  isForeground: Boolean(p.frontmost()),
                  isElevated: false,
                });
              } catch {}
            }
          }
          JSON.stringify(wins);
        `;
        const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 8_000 });
        const all = JSON.parse(stdout.trim());
        return { windows: q ? all.filter((w) => w.title.toLowerCase().includes(q) || w.processName.toLowerCase().includes(q)) : all };
      }
      const { stdout } = await execFileAsync('wmctrl', ['-lGxp'], { timeout: 5_000 }).catch(() => ({ stdout: '' }));
      const windows = stdout.split('\n').filter(Boolean).map((line) => {
        const parts = line.trim().split(/\s+/);
        const id = parts[0];
        const pid = Number(parts[2]) || 0;
        const x = Number(parts[3]) || 0;
        const y = Number(parts[4]) || 0;
        const width = Number(parts[5]) || 800;
        const height = Number(parts[6]) || 600;
        const processName = parts[7] || '';
        const title = parts.slice(9).join(' ');
        return {
          hwnd: id,
          windowId: id,
          title,
          processId: pid,
          processName,
          bounds: { x, y, width, height },
          dpi: 96,
          scaleFactor: 1,
          isMinimized: false,
          isMaximized: false,
          isForeground: false,
          isElevated: false,
        };
      });
      return { windows: q ? windows.filter((w) => w.title.toLowerCase().includes(q) || w.processName.toLowerCase().includes(q)) : windows };
    },
    async focusWindow(windowId) {
      if (platform === 'darwin') {
        const procName = String(windowId).split(':')[0];
        await execFileAsync('osascript', ['-e', `tell application ${JSON.stringify(procName)} to activate`], { timeout: 5_000 });
        return { windowId: String(windowId), isForeground: true };
      }
      await execFileAsync('wmctrl', ['-i', '-a', String(windowId)], { timeout: 5_000 });
      return { windowId: String(windowId), isForeground: true };
    },
    async restoreWindow(windowId) {
      return this.focusWindow(windowId);
    },
    capture,
    async mouseMove(screenX, screenY) {
      if (platform === 'darwin') return (await macCgMouse('move', screenX, screenY)).cursor;
      await execFileAsync('xdotool', ['mousemove', '--sync', String(screenX), String(screenY)], { timeout: 4_000 });
      return getCursorPos();
    },
    async mouseClick({ screenX, screenY, button = 'left', count = 1 }) {
      if (platform === 'darwin') return macCgMouse('click', screenX, screenY, button, count);
      const btnNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      await execFileAsync('xdotool', ['mousemove', '--sync', String(screenX), String(screenY), 'click', '--repeat', String(count), btnNum], { timeout: 5_000 });
      return { blocked: false, cursor: await getCursorPos() };
    },
    async mouseDown({ hasCoords, screenX, screenY, button = 'left' }) {
      const pos = hasCoords ? { x: screenX, y: screenY } : await getCursorPos();
      if (platform === 'darwin') return macCgMouse('down', pos.x, pos.y, button);
      const btnNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      const args = hasCoords ? ['mousemove', '--sync', String(screenX), String(screenY), 'mousedown', btnNum] : ['mousedown', btnNum];
      await execFileAsync('xdotool', args, { timeout: 4_000 });
      return { blocked: false, cursor: await getCursorPos() };
    },
    async mouseUp({ hasCoords, screenX, screenY, button = 'left' }) {
      const pos = hasCoords ? { x: screenX, y: screenY } : await getCursorPos();
      if (platform === 'darwin') return macCgMouse('up', pos.x, pos.y, button);
      const btnNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      const args = hasCoords ? ['mousemove', '--sync', String(screenX), String(screenY), 'mouseup', btnNum] : ['mouseup', btnNum];
      await execFileAsync('xdotool', args, { timeout: 4_000 });
      return { blocked: false, cursor: await getCursorPos() };
    },
    async mouseDrag({ startX, startY, endX, endY, button = 'left' }) {
      if (platform === 'darwin') return macCgMouse('drag', startX, startY, button, 1, endX, endY);
      const btnNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      await execFileAsync('xdotool', ['mousemove', '--sync', String(startX), String(startY), 'mousedown', btnNum, 'mousemove', '--sync', String(endX), String(endY), 'mouseup', btnNum], { timeout: 6_000 });
      return { blocked: false, cursor: await getCursorPos() };
    },
    async mouseScroll({ screenX, screenY, deltaX = 0, deltaY = 0 }) {
      if (platform === 'darwin') return macCgMouse('scroll', screenX, screenY, 'left', 1, screenX, screenY, deltaX, deltaY);
      await execFileAsync('xdotool', ['mousemove', '--sync', String(screenX), String(screenY)], { timeout: 4_000 });
      if (deltaY !== 0) {
        const btn = deltaY > 0 ? '5' : '4';
        const ticks = Math.max(1, Math.round(Math.abs(deltaY)));
        await execFileAsync('xdotool', ['click', '--repeat', String(ticks), btn], { timeout: 4_000 });
      }
      return { blocked: false, cursor: await getCursorPos() };
    },
    async keyChord(keys) {
      const tokens = parseKeyChordTokens(keys);
      if (platform === 'darwin') {
        let flags = 0;
        let mainKey = null;
        for (const t of tokens) {
          const u = t.toUpperCase();
          if (u === 'CMD' || u === 'COMMAND' || u === 'META' || u === 'WIN') flags |= 0x100000;
          else if (u === 'SHIFT') flags |= 0x020000;
          else if (u === 'ALT' || u === 'OPTION') flags |= 0x080000;
          else if (u === 'CTRL' || u === 'CONTROL') flags |= 0x040000;
          else mainKey = u;
        }
        const code = MAC_KEYCODES[mainKey] ?? 36;
        const jxa = `
          ObjC.import('CoreGraphics');
          const d = $.CGEventCreateKeyboardEvent($(), ${code}, true);
          const u = $.CGEventCreateKeyboardEvent($(), ${code}, false);
          if (${flags} !== 0) { $.CGEventSetFlags(d, ${flags}); $.CGEventSetFlags(u, ${flags}); }
          $.CGEventPost($.kCGHIDEventTap, d);
          $.CGEventPost($.kCGHIDEventTap, u);
        `;
        await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 5_000 });
        return { blocked: false };
      }
      await execFileAsync('xdotool', ['key', tokens.join('+')], { timeout: 5_000 });
      return { blocked: false };
    },
    async holdKey(key, durationMs = 250) {
      await this.keyChord([key]);
      await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(10, durationMs))));
      return { blocked: false };
    },
    async typeText({ text, submit = false }) {
      const str = String(text ?? '');
      if (platform === 'darwin') {
        await runWithStdin('pbcopy', [], str);
        await this.keyChord(['Command', 'V']);
        if (submit) await this.keyChord(['Enter']);
        return { blocked: false, mode: 'clipboard', length: str.length };
      }
      await execFileAsync('xdotool', ['type', '--clearmodifiers', '--', str], { timeout: 8_000 });
      if (submit) await execFileAsync('xdotool', ['key', 'Return'], { timeout: 4_000 });
      return { blocked: false, mode: 'unicode', length: str.length };
    },
    async clipboardGet() {
      if (platform === 'darwin') {
        const { stdout } = await execFileAsync('pbpaste', [], { timeout: 4_000 });
        return { text: stdout };
      }
      const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], { timeout: 4_000 }).catch(() => ({ stdout: '' }));
      return { text: stdout };
    },
    async clipboardSet(text) {
      if (platform === 'darwin') {
        await runWithStdin('pbcopy', [], String(text ?? ''));
        return { ok: true };
      }
      await runWithStdin('xclip', ['-selection', 'clipboard'], String(text ?? ''));
      return { ok: true };
    },
    releaseAllInputs: async () => ({ ok: true }),
    dispose: async () => {},
  };
}
