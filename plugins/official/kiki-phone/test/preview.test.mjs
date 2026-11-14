import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fitDeviceFrame,
  normalizePointerToDevice,
  flattenViewHierarchy,
  createPhonePreviewService,
} from '../lib/preview-service.mjs';
import {
  CLIENT_SCROLL_MAGIC,
  CLIENT_TOUCH_MAGIC,
  CONTROL_MSG,
  FRAME_PACKET_MAGIC,
  SCRCPY_SERVER_SHA256,
  SCRCPY_SERVER_URL,
  createScrcpyManager,
  ensureScrcpyServer,
  extractAvcCodecFromAnnexB,
} from '../lib/scrcpy-stream.mjs';
import { buildPhoneGuiSlots, createPhoneSlotHandlers, PHONE_HTTP_ROUTES } from '../lib/slots.mjs';
import { openPanelStream as entryOpenPanelStream } from '../entry.mjs';

test('fitDeviceFrame preserves aspect ratio across tall and narrow containers', () => {
  const portrait = fitDeviceFrame(1080 / 2400, 460, 720, 52);
  assert.deepEqual(portrait, { width: 324, height: 720 });

  const narrow = fitDeviceFrame(1080 / 2400, 260, 800, 60);
  assert.deepEqual(narrow, { width: 200, height: 444 });

  assert.deepEqual(fitDeviceFrame(9 / 19.5, 40, 500, 60), { width: 0, height: 0 });
});

test('normalizePointerToDevice clamps normalized [0,1] canvas coordinates onto screen bounds', () => {
  assert.deepEqual(normalizePointerToDevice(0.5, 0.25, 1080, 2400), { x: 540, y: 600 });
  assert.deepEqual(normalizePointerToDevice(-0.2, 1.4, 1179, 2556), { x: 0, y: 2555 });
});

test('flattenViewHierarchy extracts visible semantic nodes and Mobilewright locator hints', () => {
  const tree = [
    {
      type: 'FrameLayout',
      bounds: { x: 0, y: 0, width: 1080, height: 2400 },
      children: [
        {
          type: 'Button',
          text: '去结算',
          clickable: true,
          bounds: { x: 760, y: 2180, width: 280, height: 120 },
        },
        {
          type: 'ImageView',
          label: 'Search button',
          clickable: true,
          bounds: { x: 920, y: 120, width: 96, height: 96 },
        },
        {
          type: 'View',
          bounds: { x: -200, y: -200, width: 50, height: 50 },
        },
      ],
    },
  ];
  const nodes = flattenViewHierarchy(tree, { width: 1080, height: 2400 });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, '去结算');
  assert.equal(nodes[0].locator, "await screen.getByText('去结算', { exact: true }).tap();");
  assert.equal(nodes[1].locator, "await screen.getByLabel('Search button', { exact: true }).tap();");
});

test('preview service supports Android + iOS discovery, frame streaming, normalized touch, and E12/E5 slots', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kiki-phone-preview-'));
  const events = [];

  class FakeMobilecliDriver {
    async listDevices() {
      return [
        {
          id: 'ca03b197',
          name: 'Xiaomi 12S Ultra',
          platform: 'android',
          type: 'real',
          state: 'online',
          version: '15',
          screenSize: { width: 1080, height: 2400 },
        },
        {
          id: '00008130-IOS',
          name: 'iPhone 16 Pro',
          platform: 'ios',
          type: 'real',
          state: 'online',
          version: '18.2',
          screenSize: { width: 1179, height: 2556 },
        },
      ];
    }
    async connect(cfg) {
      events.push(['connect', cfg.platform, cfg.deviceId]);
      this.platform = cfg.platform;
    }
    async getScreenSize() {
      return this.platform === 'ios' ? { width: 1179, height: 2556 } : { width: 1080, height: 2400 };
    }
    async getOrientation() { return 'portrait'; }
    async setOrientation(next) { events.push(['rotate', next]); }
    async screenshot(opts) {
      events.push(['screenshot', this.platform, opts.format]);
      return Buffer.from(`frame-${this.platform}-${opts.format}`);
    }
    async getForegroundApp() {
      return { bundleId: this.platform === 'ios' ? 'com.apple.Preferences' : 'com.tencent.mm' };
    }
    async getViewHierarchy() {
      return [{ type: 'Button', text: '微信', clickable: true, bounds: { x: 120, y: 400, width: 180, height: 180 } }];
    }
    async tap(x, y) { events.push(['tap', this.platform, x, y]); }
    async longPress(x, y, duration) { events.push(['longPress', this.platform, x, y, duration]); }
    async pressButton(btn) { events.push(['button', this.platform, btn]); }
    async typeText(text) { events.push(['typeText', this.platform, text]); }
    async pressKeys(keys) { events.push(['pressKeys', this.platform, keys]); }
    async openUrl(url) { events.push(['openUrl', this.platform, url]); }
    async disconnect() { events.push(['disconnect', this.platform]); }
    async dispose() {}
  }

  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'darwin',
    executeFile: async (file, argv) => {
      if (file === 'xcrun' && argv[0] === 'simctl' && argv[1] === 'list') {
        return {
          stdout: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                { udid: 'SIM-IOS-1', name: 'iPhone 16 Simulator', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
          stderr: '',
        };
      }
      if (argv?.[0] === 'devices') return { stdout: 'List of devices attached\n', stderr: '' };
      throw new Error(`Unexpected executeFile in test: ${file} ${argv?.join(' ')}`);
    },
    loadDriverModule: async () => ({ MobilecliDriver: FakeMobilecliDriver }),
  });

  try {
    const state = await preview.handlePanelRequest('state');
    assert.equal(state.ok, true);
    assert.equal(state.groups.android.length, 1);
    assert.equal(state.groups.ios.length, 2);
    assert.deepEqual(state.selected, { id: '00008130-IOS', platform: 'ios' });

    await preview.handlePanelRequest('action', { action: 'select', deviceId: 'ca03b197', platform: 'android' });
    const androidFrame = await preview.handlePanelRequest('frame', { format: 'jpeg', maxWidth: 540 });
    assert.equal(androidFrame.ok, true);
    assert.equal(androidFrame.platform, 'android');
    assert.equal(androidFrame.foregroundApp, 'com.tencent.mm');
    assert.match(androidFrame.dataUrl, /^data:image\/jpeg;base64,/);

    await preview.handlePanelRequest('action', { action: 'select', deviceId: '00008130-IOS', platform: 'ios' });
    const iosTap = await preview.handlePanelRequest('action', {
      action: 'tap',
      deviceId: '00008130-IOS',
      platform: 'ios',
      normX: 0.5,
      normY: 0.5,
    });
    assert.equal(iosTap.ok, true);
    assert.deepEqual(iosTap.point, { x: 590, y: 1278 });

    const iosFrame = await preview.handlePanelRequest('frame', {
      deviceId: '00008130-IOS',
      platform: 'ios',
      format: 'png',
    });
    assert.equal(iosFrame.ok, true);
    assert.equal(iosFrame.mimeType, 'image/png');
    assert.equal(iosFrame.foregroundApp, 'com.apple.Preferences');

    const slotHandlers = createPhoneSlotHandlers(preview);
    const e5 = await slotHandlers['E5:prompt-context']({});
    assert.equal(e5.sections.length, 1);
    assert.match(e5.sections[0].content, /Xiaomi 12S Ultra/);
    assert.match(e5.sections[0].content, /iPhone 16 Pro/);

    const described = await slotHandlers['E12:server-gui-slots']({ kind: 'describe' });
    assert.equal(described.routes.length, PHONE_HTTP_ROUTES.length);
    assert.ok(described.guiSlots.some((s) => s.slot === 'sidebar-panel' && s.panelId === 'preview'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'composer-toolbar' && s.icon === 'smartphone'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'slash-command' && s.command === 'phone-preview'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'tool-card-renderer' && s.actionVerb.default === 'Phone Control'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'status-capsule' && s.label.default === 'iPhone 16 Pro' && s.dotTone === 'ok'));

    const httpRes = await slotHandlers['E12:server-gui-slots']({
      kind: 'http-route',
      method: 'GET',
      subpath: 'preview/state',
    });
    assert.equal(httpRes.status, 200);
    assert.equal(httpRes.data.ok, true);
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('captureFrame hot path caches metadata without per-frame dumpsys and never blocks touch behind slow frames', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kiki-phone-hotpath-'));
  let dumpsysCount = 0;
  let screenSizeCalls = 0;
  let orientationCalls = 0;
  let fgAppCalls = 0;
  let frameCounter = 0;
  let slowCaptureMs = 0;
  const scrcpyTaps = [];

  class HotPathDriver {
    async listDevices() {
      return [{ id: 'ca03b197', name: 'Xiaomi 12S Ultra', platform: 'android', type: 'real', state: 'online', screenSize: { width: 1080, height: 2400 } }];
    }
    async connect() {}
    async getScreenSize() { screenSizeCalls++; return { width: 1080, height: 2400 }; }
    async getOrientation() { orientationCalls++; return 'portrait'; }
    async getForegroundApp() { fgAppCalls++; return { packageName: 'com.xingin.xhs' }; }
    async call(method) {
      if (method === 'device.screenshot') {
        if (slowCaptureMs > 0) await new Promise((r) => setTimeout(r, slowCaptureMs));
        const b64 = Buffer.from(`jpeg-${++frameCounter}`).toString('base64');
        return { data: b64 };
      }
      return undefined;
    }
    async screenshot() {
      if (slowCaptureMs > 0) await new Promise((r) => setTimeout(r, slowCaptureMs));
      return Buffer.from(`jpeg-${++frameCounter}`);
    }
    async tap(x, y) { scrcpyTaps.push(['driver-tap', x, y]); }
    async disconnect() {}
    async dispose() {}
  }

  let useScrcpyControl = true;
  const fakeScrcpy = {
    warmControl() {},
    async acquireControl() {
      if (!useScrcpyControl) throw new Error('scrcpy control unavailable');
      return {
        async tap(x, y) { scrcpyTaps.push(['scrcpy-tap', x, y]); },
        async doubleTap(x, y) { scrcpyTaps.push(['scrcpy-double', x, y]); },
        async longPress(x, y, d) { scrcpyTaps.push(['scrcpy-long', x, y, d]); },
        async swipe(x1, y1, x2, y2, d) { scrcpyTaps.push(['scrcpy-swipe', x1, y1, x2, y2, d]); },
        async pressButton(b) { scrcpyTaps.push(['scrcpy-btn', b]); return true; },
      };
    },
    async openVideoStream() { throw new Error('unused'); },
    async dispose() {},
  };

  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'win32',
    metadataTtlMs: 5_000,
    scrcpyManager: fakeScrcpy,
    executeFile: async (file, argv) => {
      assert.equal(file, '/mock/adb');
      const cmd = argv.join(' ');
      if (cmd.includes('dumpsys')) {
        dumpsysCount++;
        await new Promise((r) => setTimeout(r, 220));
        return { stdout: '  mWakefulness=Awake\n  showing=false\n  secure=false\n', stderr: '' };
      }
      if (cmd.includes('wm size')) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected adb invocation: ${cmd}`);
    },
    loadDriverModule: async () => ({ MobilecliDriver: HotPathDriver }),
  });

  try {
    const t0 = performance.now();
    const payloads = [];
    for (let i = 0; i < 20; i++) {
      const f = await preview.captureFrame({
        deviceId: 'ca03b197',
        platform: 'android',
        format: 'jpeg',
        quality: 72,
        maxWidth: 720,
        live: true,
        settings: { adbPath: '/mock/adb' },
      });
      assert.equal(f.ok, true);
      assert.equal(f.foregroundApp, 'com.xingin.xhs');
      payloads.push(f.dataUrl);
    }
    const burstElapsed = performance.now() - t0;
    assert.ok(burstElapsed < 180, `20 cached frames must not wait on 220ms dumpsys (took ${burstElapsed.toFixed(1)}ms)`);
    assert.equal(new Set(payloads).size, 20, 'Each live capture must deliver a distinct fresh frame');
    assert.equal(screenSizeCalls, 1);
    assert.equal(orientationCalls, 1);
    assert.equal(fgAppCalls, 1);
    assert.equal(dumpsysCount, 2, 'Background power probe runs at most 1 non-blocking cycle (power + policy) per TTL');

    // Now simulate a 350ms slow screenshot in flight and verify touch never queues behind it
    slowCaptureMs = 350;
    const inflight = preview.captureFrame({
      deviceId: 'ca03b197',
      platform: 'android',
      format: 'jpeg',
      settings: { adbPath: '/mock/adb' },
    });
    await new Promise((r) => setTimeout(r, 15));

    const tapStart = performance.now();
    const fastTap = await preview.performAction(
      { action: 'tap', deviceId: 'ca03b197', platform: 'android', normX: 0.5, normY: 0.25 },
      { settings: { adbPath: '/mock/adb' } },
    );
    const tapMs = performance.now() - tapStart;
    assert.equal(fastTap.ok, true);
    assert.equal(fastTap.channel, 'scrcpy');
    assert.deepEqual(fastTap.point, { x: 540, y: 600 });
    assert.ok(tapMs < 80, `scrcpy touch must not block behind 350ms captureFrame (took ${tapMs.toFixed(1)}ms)`);

    // Also verify driver fallback is equally lock-free when scrcpy control is unavailable
    useScrcpyControl = false;
    const fbStart = performance.now();
    const fallbackTap = await preview.performAction(
      { action: 'tap', deviceId: 'ca03b197', platform: 'android', normX: 0.25, normY: 0.5 },
      { settings: { adbPath: '/mock/adb' } },
    );
    const fbMs = performance.now() - fbStart;
    assert.equal(fallbackTap.ok, true);
    assert.deepEqual(fallbackTap.point, { x: 270, y: 1200 });
    assert.ok(fbMs < 80, `Driver fallback touch must use independent lane without waiting for 350ms captureFrame (took ${fbMs.toFixed(1)}ms)`);

    await inflight;
    assert.deepEqual(scrcpyTaps, [
      ['scrcpy-tap', 540, 600],
      ['driver-tap', 270, 1200],
    ]);
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('openPanelStream negotiates scrcpy v4.0 H.264 stream, handles backpressure + binary touch/scroll, and cleans up on abort', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kiki-phone-stream-'));
  const adbCommands = [];
  const controlWrites = [];
  let killedProc = false;

  // Prepare a fake cached jar that we pre-verify by testing ensureScrcpyServer rejection first
  await assert.rejects(
    () => ensureScrcpyServer({
      dataDir,
      env: { PATH: '' },
      platform: 'linux',
      fetchImpl: async (url) => {
        assert.equal(url, SCRCPY_SERVER_URL);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('tampered-jar-bytes').buffer,
        };
      },
    }),
    /SHA-256 mismatch/,
  );

  // Build mock sockets for video + control
  class MockSocket extends EventEmitter {
    constructor(role) {
      super();
      this.role = role;
      this.destroyed = false;
    }
    setNoDelay() {}
    write(buf) {
      if (this.role === 'control') controlWrites.push(Buffer.from(buf));
      return true;
    }
    destroy() {
      this.destroyed = true;
      this.emit('close');
    }
  }

  let socketCount = 0;
  let videoSocket;
  let controlSocket;

  const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x20, 0xac, 0xb4, 0x0f, 0x81]);
  const pps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x06, 0xf2]);
  const spsPps = Buffer.concat([sps, pps]);
  assert.equal(extractAvcCodecFromAnnexB(spsPps), 'avc1.640020');

  function makeSessionPacket(width, height) {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(0x80000000, 0);
    b.writeUInt32BE(width, 4);
    b.writeUInt32BE(height, 8);
    return b;
  }

  function makeFramePacket({ config = false, key = false, ptsUs = 0n, payload }) {
    const b = Buffer.alloc(12 + payload.length);
    let flags = config ? (1n << 62n) : BigInt(ptsUs);
    if (!config && key) flags |= (1n << 61n);
    b.writeBigUInt64BE(flags, 0);
    b.writeUInt32BE(payload.length, 8);
    payload.copy(b, 12);
    return b;
  }

  const scrcpyManager = createScrcpyManager({
    resolveDataDir: () => dataDir,
    ensureServer: async () => ({ jarPath: '/mock/scrcpy-server-v4.0.jar', version: '4.0', source: 'cache' }),
    fetchImpl: async () => {
      throw new Error('Unexpected network request in unit test');
    },
    allocatePort: async () => 28902,
    executeFile: async (file, argv) => {
      adbCommands.push([file, ...argv]);
      return { stdout: '', stderr: '' };
    },
    spawnProcess: () => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.kill = () => {
        killedProc = true;
        proc.emit('exit', 0);
      };
      return proc;
    },
    createSocket: () => {
      socketCount++;
      if (socketCount % 2 === 1) {
        videoSocket = new MockSocket('video');
        queueMicrotask(() => {
          const nameBuf = Buffer.alloc(64);
          Buffer.from('Xiaomi 12S Ultra').copy(nameBuf);
          videoSocket.emit('data', Buffer.concat([
            Buffer.from([0x00]),
            nameBuf,
            Buffer.from('h264', 'ascii'),
            makeSessionPacket(540, 1200),
            makeFramePacket({ config: true, payload: spsPps }),
            makeFramePacket({ key: true, ptsUs: 16666n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa]) }),
          ]));
        });
        return videoSocket;
      }
      controlSocket = new MockSocket('control');
      queueMicrotask(() => controlSocket.emit('connect'));
      return controlSocket;
    },
  });

  const preview = createPhonePreviewService({
    dataDir,
    scrcpyManager,
    executeFile: async (file, argv) => {
      adbCommands.push([file, ...argv]);
      return { stdout: '', stderr: '' };
    },
    loadDriverModule: async () => ({
      MobilecliDriver: class {
        async listDevices() { return []; }
        async dispose() {}
      },
    }),
  });

  try {
    assert.equal(typeof entryOpenPanelStream, 'function');
    assert.equal(entryOpenPanelStream.length, 4);

    await assert.rejects(
      () => preview.openPanelStream('screen', { deviceId: 'ios-1', platform: 'ios' }, { sendBinary: () => true }, {}),
      /Android/,
    );
    await assert.rejects(
      () => preview.openPanelStream('audio', { deviceId: 'ca03b197', platform: 'android' }, { sendBinary: () => true }, {}),
      /Unsupported phone panel stream/,
    );

    let bufferedBytes = 0;
    let allowDownstream = true;
    const sentBinary = [];
    const sentText = [];
    let onBinaryHandler;
    let onTextHandler;
    let closedReason = null;

    const abortCtl = new AbortController();
    const session = {
      sendBinary(pkt) {
        sentBinary.push(Buffer.from(pkt));
        return allowDownstream;
      },
      sendText(txt) {
        sentText.push(txt);
        return true;
      },
      close(reason) {
        closedReason = reason;
      },
      onBinary(fn) { onBinaryHandler = fn; return () => {}; },
      onText(fn) { onTextHandler = fn; return () => {}; },
      onClose() { return () => {}; },
      bufferedAmount: () => bufferedBytes,
    };

    const hs = await preview.openPanelStream(
      'screen',
      { deviceId: 'ca03b197', platform: 'android', maxFps: 60, maxWidth: 1080, bitRate: 4_000_000 },
      session,
      { settings: { adbPath: '/mock/adb' }, signal: abortCtl.signal },
    );

    assert.equal(hs.protocol, 'h264-scrcpy-v1');
    assert.equal(hs.width, 540);
    assert.equal(hs.height, 1200);
    assert.equal(hs.codec, 'h264');
    assert.equal(hs.codecProfile, 'avc1.640020');
    assert.equal(sentBinary.length, 1);
    assert.equal(sentBinary[0][0], FRAME_PACKET_MAGIC);
    assert.equal(sentBinary[0][1], 1);
    assert.equal(sentBinary[0].readUInt16BE(2), 540);
    assert.equal(sentBinary[0].readUInt16BE(4), 1200);
    assert.deepEqual(sentBinary[0].subarray(16, 16 + spsPps.length), spsPps);

    // Simulate backpressure on delta frame -> drop subsequent delta, request RESET_VIDEO when drained, recover on keyframe
    allowDownstream = false;
    bufferedBytes = 256_000;
    videoSocket.emit('data', makeFramePacket({ key: false, ptsUs: 33333n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x01]) }));
    assert.equal(sentBinary.length, 2);

    bufferedBytes = 0;
    allowDownstream = true;
    videoSocket.emit('data', makeFramePacket({ key: false, ptsUs: 50000n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x02]) }));
    assert.equal(sentBinary.length, 2, 'Delta frame after backpressure must be dropped until next keyframe');
    assert.ok(controlWrites.some((w) => w.length === 1 && w[0] === CONTROL_MSG.RESET_VIDEO), 'Drained buffer should request IDR reset');

    videoSocket.emit('data', makeFramePacket({ key: true, ptsUs: 66666n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xbb]) }));
    assert.equal(sentBinary.length, 3, 'Next keyframe resumes stream cleanly');

    // Client -> server binary touch ('T') and scroll ('S')
    controlWrites.length = 0;
    const touchBuf = Buffer.alloc(12);
    touchBuf[0] = CLIENT_TOUCH_MAGIC;
    touchBuf[1] = 0;
    touchBuf[2] = 1;
    touchBuf[3] = 0;
    touchBuf.writeFloatBE(0.5, 4);
    touchBuf.writeFloatBE(0.25, 8);
    onBinaryHandler(touchBuf);
    assert.equal(controlWrites.length, 1);
    assert.equal(controlWrites[0].length, 32);
    assert.equal(controlWrites[0][0], CONTROL_MSG.INJECT_TOUCH_EVENT);
    assert.equal(controlWrites[0].readInt32BE(10), 270);
    assert.equal(controlWrites[0].readInt32BE(14), 300);

    const scrollBuf = Buffer.alloc(16);
    scrollBuf[0] = CLIENT_SCROLL_MAGIC;
    scrollBuf.writeFloatBE(0.5, 4);
    scrollBuf.writeFloatBE(0.5, 8);
    scrollBuf.writeInt16BE(0, 12);
    scrollBuf.writeInt16BE(-2048, 14);
    onBinaryHandler(scrollBuf);
    assert.equal(controlWrites.length, 2);
    assert.equal(controlWrites[1].length, 21);
    assert.equal(controlWrites[1][0], CONTROL_MSG.INJECT_SCROLL_EVENT);

    onTextHandler(JSON.stringify({ type: 'button', button: 'HOME' }));
    assert.ok(controlWrites.some((w) => w[0] === CONTROL_MSG.INJECT_KEYCODE));

    videoSocket.emit('data', makeSessionPacket(1200, 540));
    assert.ok(sentText.some((t) => JSON.parse(t).width === 1200 && JSON.parse(t).height === 540));

    abortCtl.abort();
    assert.equal(killedProc, true);
    assert.equal(closedReason, 'aborted');
    assert.ok(adbCommands.some((c) => c.includes('--remove') && c.includes('tcp:28902')));
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('E5 and E12 describe use fast bounded state cache without blocking on hung probes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kiki-phone-fast-slot-'));
  let calls = 0;
  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'win32',
    loadDriverModule: async () => ({
      MobilecliDriver: class SlowDriver {
        async listDevices() {
          calls += 1;
          if (calls === 1) {
            return [{ id: 'SERIAL-FAST', name: 'Pixel 9', platform: 'android', type: 'real', state: 'online', screenWidth: 1080, screenHeight: 2400 }];
          }
          await new Promise((r) => setTimeout(r, 4000));
          return [];
        }
        async dispose() {}
      },
    }),
    executeFile: async () => ({ stdout: 'List of devices attached\n', stderr: '' }),
  });
  try {
    const slots = createPhoneSlotHandlers(preview);
    const first = await slots['E5:prompt-context']({});
    assert.equal(first.sections.length, 1);
    assert.equal(calls, 1);

    const cached = await slots['E12:server-gui-slots']({ kind: 'describe' });
    assert.equal(calls, 1);
    assert.ok(cached.guiSlots.some((s) => s.slot === 'status-capsule' && s.label.default === 'Pixel 9'));
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('panel.html stays within the Kiki 256 KiB single-file srcDoc limit, speaks kiki.panel.v1 + plugin.openStream + WebCodecs canvas, and carries no emoji', async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(html, 'utf8') < 256 * 1024);
  assert.match(html, /kiki\.panel\.v1/);
  assert.match(html, /kind:\s*'request'/);
  assert.match(html, /channel:\s*CHANNEL/);
  assert.match(html, /plugin\.openStream/);
  assert.match(html, /VideoDecoder/);
  assert.match(html, /EncodedVideoChunk/);
  assert.match(html, /createImageBitmap/);
  assert.match(html, /screenCanvas/);
  assert.match(html, /__kikiStreamEvent/);
  assert.match(html, /__kikiStreamControl/);
  assert.doesNotMatch(html, /protocol:\s*'kiki\.panel\.v1'/);
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u);
  assert.ok(SCRCPY_SERVER_SHA256.length === 64);
});
