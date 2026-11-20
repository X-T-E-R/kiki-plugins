import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitDeviceFrame,
  normalizePointerToDevice,
  computeContainedRect,
  mapContainedPointToDevice,
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

test('normalizePointerToDevice and mapContainedPointToDevice map contained canvas rects onto exact device pixels', () => {
  assert.deepEqual(normalizePointerToDevice(0.5, 0.25, 1080, 2400), { x: 540, y: 600 });
  assert.deepEqual(normalizePointerToDevice(-0.2, 1.4, 1179, 2556), { x: 0, y: 2555 });

  // Wide container (600x480) displaying a 1080x2400 portrait screen -> 216x480 centered with 192px pillarbox bars
  const rect = computeContainedRect(600, 480, 1080, 2400);
  assert.deepEqual({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, { x: 192, y: 0, width: 216, height: 480 });

  const outsideLeftBar = mapContainedPointToDevice(80, 240, 600, 480, 1080, 2400);
  assert.equal(outsideLeftBar.inside, false);
  assert.equal(outsideLeftBar.x, 0);

  const exactCenter = mapContainedPointToDevice(300, 240, 600, 480, 1080, 2400);
  assert.equal(exactCenter.inside, true);
  assert.equal(exactCenter.normX, 0.5);
  assert.equal(exactCenter.normY, 0.5);
  assert.deepEqual({ x: exactCenter.x, y: exactCenter.y }, { x: Math.round(0.5 * 1079), y: Math.round(0.5 * 2399) });

  const bottomRight = mapContainedPointToDevice(192 + 216, 480, 600, 480, 1080, 2400);
  assert.equal(bottomRight.inside, true);
  assert.deepEqual({ x: bottomRight.x, y: bottomRight.y }, { x: 1079, y: 2399 });
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
          id: 'SYNTH-ANDROID-01',
          name: 'Synth Android Phone',
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
    async swipe(dir, opts) { events.push(['swipe', this.platform, dir, opts]); }
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

    await preview.handlePanelRequest('action', { action: 'select', deviceId: 'SYNTH-ANDROID-01', platform: 'android' });
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
    assert.match(e5.sections[0].content, /Synth Android Phone/);
    assert.match(e5.sections[0].content, /iPhone 16 Pro/);

    const described = await slotHandlers['E12:server-gui-slots']({ kind: 'describe' });
    assert.equal(described.routes.length, PHONE_HTTP_ROUTES.length);
    assert.equal(described.guiSlots.some((s) => s.slot === 'sidebar-panel'), false);
    assert.equal(described.guiSlots.some((s) => s.slot === 'sidebar-nav'), false);
    assert.equal(described.guiSlots.some((s) => s.slot === 'inspector-tab'), false);
    assert.ok(described.guiSlots.some((s) => s.slot === 'composer-toolbar' && s.icon === 'smartphone' && s.action?.panelId === 'preview'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'slash-command' && s.command === 'phone-preview' && s.action?.panelId === 'preview'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'tool-card-renderer' && s.actionVerb.default === 'Phone Control'));
    assert.ok(described.guiSlots.some((s) => s.slot === 'status-capsule' && s.label.default === 'iPhone 16 Pro' && s.dotTone === 'ok' && s.action?.panelId === 'preview'));

    // Direct canvas HTTP route actions: scroll, key, pasteText
    const scrollRoute = await slotHandlers['E12:server-gui-slots']({
      kind: 'http-route',
      method: 'POST',
      subpath: 'preview/action',
      body: {
        action: 'scroll',
        deviceId: 'SYNTH-ANDROID-01',
        platform: 'android',
        normX: 0.5,
        normY: 0.6,
        deltaX: 0,
        deltaY: 160,
      },
    });
    assert.equal(scrollRoute.status, 200);
    assert.equal(scrollRoute.data.ok, true);

    const keyRoute = await slotHandlers['E12:server-gui-slots']({
      kind: 'http-route',
      method: 'POST',
      subpath: 'preview/action',
      body: {
        action: 'key',
        deviceId: '00008130-IOS',
        platform: 'ios',
        key: 'ENTER',
      },
    });
    assert.equal(keyRoute.status, 200);
    assert.equal(keyRoute.data.ok, true);
    assert.ok(events.some((e) => e[0] === 'pressKeys' && e[1] === 'ios' && e[2][0] === 'ENTER'));

    const pasteRoute = await slotHandlers['E12:server-gui-slots']({
      kind: 'http-route',
      method: 'POST',
      subpath: 'preview/action',
      body: {
        action: 'pasteText',
        deviceId: '00008130-IOS',
        platform: 'ios',
        text: '验证码 849201',
      },
    });
    assert.equal(pasteRoute.status, 200);
    assert.equal(pasteRoute.data.ok, true);
    assert.ok(events.some((e) => e[0] === 'typeText' && e[1] === 'ios' && e[2] === '验证码 849201'));

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
      return [{ id: 'SYNTH-ANDROID-01', name: 'Synth Android Phone', platform: 'android', type: 'real', state: 'online', screenSize: { width: 1080, height: 2400 } }];
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
        deviceId: 'SYNTH-ANDROID-01',
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
      deviceId: 'SYNTH-ANDROID-01',
      platform: 'android',
      format: 'jpeg',
      settings: { adbPath: '/mock/adb' },
    });
    await new Promise((r) => setTimeout(r, 15));

    const tapStart = performance.now();
    const fastTap = await preview.performAction(
      { action: 'tap', deviceId: 'SYNTH-ANDROID-01', platform: 'android', normX: 0.5, normY: 0.25 },
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
      { action: 'tap', deviceId: 'SYNTH-ANDROID-01', platform: 'android', normX: 0.25, normY: 0.5 },
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
      this.noDelayEnabled = false;
    }
    setNoDelay(flag) {
      this.noDelayEnabled = Boolean(flag);
    }
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
          Buffer.from('Synth Android Phone').copy(nameBuf);
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
      () => preview.openPanelStream('audio', { deviceId: 'SYNTH-ANDROID-01', platform: 'android' }, { sendBinary: () => true }, {}),
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
      { deviceId: 'SYNTH-ANDROID-01', platform: 'android', maxFps: 60, maxWidth: 1080, bitRate: 8_000_000 },
      session,
      { settings: { adbPath: '/mock/adb' }, signal: abortCtl.signal },
    );

    assert.equal(hs.protocol, 'h264-scrcpy-v1');
    assert.equal(hs.width, 540);
    assert.equal(hs.height, 1200);
    assert.equal(hs.codec, 'h264');
    assert.equal(hs.codecProfile, 'avc1.640020');
    assert.equal(videoSocket.noDelayEnabled, true, 'video socket must disable TCP Nagle');
    assert.equal(controlSocket.noDelayEnabled, true, 'control socket must disable TCP Nagle');
    assert.equal(sentBinary.length, 0, 'initial keyframe must wait for clientReady instead of racing openPanelStream return');

    onTextHandler(JSON.stringify({ type: 'clientReady' }));
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

    const t0 = Date.now();
    const staleSwr = await preview.peekState({ maxAgeMs: 0, waitBudgetMs: 150 });
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 100, `stale peekState should return immediately without awaiting 4s probe, took ${elapsedMs}ms`);
    assert.equal(staleSwr.devices[0]?.name, 'Pixel 9');
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
    assert.match(html, /safeStorage/);
    assert.match(html, /execCommand\('copy'\)/);
    assert.match(html, /interactiveBtn/);
    assert.match(html, /object-fit:\s*contain/);
    assert.match(html, /URLSearchParams\(window\.location\.search\)\.get\('theme'\)/);
    assert.doesNotMatch(html, /\b(?:localStorage|sessionStorage)\./);
    assert.doesNotMatch(html, /数据可能已过期|结果可能不完整|仅供预览|data may be stale|results may be incomplete/i);
    assert.doesNotMatch(html, /protocol:\s*'kiki\.panel\.v1'/);
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u);
    assert.ok(SCRCPY_SERVER_SHA256.length === 64);
});

async function createRepoScratchDir(prefix) {
  const parent = fileURLToPath(new URL('../../../../.tmp/phone-preview-tests', import.meta.url));
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

test('listState({ fast: true }) and E5:prompt-context retain cached rich metadata when mobilecli times out while propagating live ADB state transitions', async () => {
  const dataDir = await createRepoScratchDir('rich-cache-');
  let mobilecliShouldHang = false;
  let mobilecliCalls = 0;
  let getpropCalls = 0;
  let adbRows = [
    'SYNTH-SER-01 device product:synth_p1 model:TEST_CODE_01 device:d1 transport_id:1',
    'SYNTH-SER-02 device product:synth_p2 model:TEST_CODE_02 device:d2 transport_id:2',
  ];

  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'win32',
    fastStateTtlMs: 0,
    fastProbeTimeoutMs: 50,
    loadDriverModule: async () => ({
      MobilecliDriver: class FlakyDriver {
        async listDevices() {
          mobilecliCalls += 1;
          if (mobilecliShouldHang) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 400);
              timer.unref?.();
            });
            return [];
          }
          return [
            {
              id: 'SYNTH-SER-01',
              name: 'Synth Flagship Ultra',
              platform: 'android',
              type: 'real',
              state: 'online',
              version: '15',
              orientation: 'portrait',
              screenSize: { width: 1440, height: 3200 },
            },
            {
              id: 'SYNTH-SER-02',
              name: 'Synth Compact Pro',
              platform: 'android',
              type: 'real',
              state: 'online',
              version: '14',
              orientation: 'landscape',
              screenSize: { width: 1260, height: 2800 },
            },
          ];
        }
        async dispose() {}
      },
    }),
    executeFile: async (file, argv) => {
      assert.equal(file, '/mock/adb');
      if (argv[0] === 'devices' && argv[1] === '-l') {
        return { stdout: `List of devices attached\n${adbRows.join('\n')}\n`, stderr: '' };
      }
      if (argv.includes('getprop') || argv.includes('wm')) {
        getpropCalls += 1;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected adb command: ${argv.join(' ')}`);
    },
  });

  try {
    const slots = createPhoneSlotHandlers(preview);
    const settings = { adbPath: '/mock/adb' };

    // Probe 1: mobilecli succeeds and populates per-device rich metadata cache
    const state1 = await preview.listState({ settings, fast: true });
    assert.equal(state1.ok, true);
    assert.equal(state1.devices.length, 2);
    const dev1Before = state1.devices.find((d) => d.id === 'SYNTH-SER-01');
    const dev2Before = state1.devices.find((d) => d.id === 'SYNTH-SER-02');
    assert.equal(dev1Before.name, 'Synth Flagship Ultra');
    assert.deepEqual(dev1Before.screenSize, { width: 1440, height: 3200 });
    assert.equal(dev2Before.name, 'Synth Compact Pro');
    assert.deepEqual(dev2Before.screenSize, { width: 1260, height: 2800 });
    assert.equal(dev2Before.orientation, 'landscape');

    const e5Baseline = await slots['E5:prompt-context']({}, { settings });
    assert.equal(e5Baseline.sections.length, 1);
    assert.match(e5Baseline.sections[0].content, /Synth Flagship Ultra \(android, id=SYNTH-SER-01, 1440x3200/);
    assert.match(e5Baseline.sections[0].content, /Synth Compact Pro \(android, id=SYNTH-SER-02, 1260x2800/);

    // Probe 2: mobilecli times out under fast:true while adb devices -l reports raw model:TEST_CODE_01/02
    mobilecliShouldHang = true;
    const state2 = await preview.listState({ settings, fast: true });
    assert.match(state2.diagnostics.mobilecliError, /timed out/);
    const dev1AfterTimeout = state2.devices.find((d) => d.id === 'SYNTH-SER-01');
    const dev2AfterTimeout = state2.devices.find((d) => d.id === 'SYNTH-SER-02');
    assert.equal(dev1AfterTimeout.name, 'Synth Flagship Ultra');
    assert.deepEqual(dev1AfterTimeout.screenSize, { width: 1440, height: 3200 });
    assert.equal(dev1AfterTimeout.version, '15');
    assert.equal(dev2AfterTimeout.name, 'Synth Compact Pro');
    assert.deepEqual(dev2AfterTimeout.screenSize, { width: 1260, height: 2800 });
    assert.equal(dev2AfterTimeout.orientation, 'landscape');
    assert.equal(getpropCalls, 0, 'Already mobilecli-enriched serials must not spawn adb shell getprop');

    const e5AfterTimeout = await slots['E5:prompt-context']({}, { settings });
    assert.deepEqual(e5AfterTimeout, e5Baseline);
    assert.equal(e5AfterTimeout.sections[0].content, e5Baseline.sections[0].content);

    // Repeated peekState + listState({ fast: true }) cycles alternating timeout/success produce byte-identical E5 output
    for (const hang of [true, false, true]) {
      mobilecliShouldHang = hang;
      await preview.listState({ settings, fast: true });
      const peeked = await preview.peekState({ settings, maxAgeMs: 60_000 });
      assert.equal(peeked.devices.find((d) => d.id === 'SYNTH-SER-01')?.name, 'Synth Flagship Ultra');
      const e5Cycle = await slots['E5:prompt-context']({}, { settings });
      assert.equal(e5Cycle.sections[0].content, e5Baseline.sections[0].content);
    }
    assert.ok(mobilecliCalls >= 5);

    // Probe 3: while mobilecli times out, adb state transitions online -> offline / unauthorized propagate accurately
    mobilecliShouldHang = true;
    adbRows = [
      'SYNTH-SER-01 offline transport_id:1',
      'SYNTH-SER-02 unauthorized usb:1-2 transport_id:2',
    ];
    const state3 = await preview.listState({ settings, fast: true });
    const dev1Offline = state3.devices.find((d) => d.id === 'SYNTH-SER-01');
    const dev2Unauth = state3.devices.find((d) => d.id === 'SYNTH-SER-02');
    assert.equal(dev1Offline.state, 'offline');
    assert.equal(dev1Offline.name, 'Synth Flagship Ultra');
    assert.deepEqual(dev1Offline.screenSize, { width: 1440, height: 3200 });
    assert.equal(dev2Unauth.state, 'unauthorized');
    assert.equal(dev2Unauth.name, 'Synth Compact Pro');
    assert.deepEqual(dev2Unauth.screenSize, { width: 1260, height: 2800 });

    const e5Offline = await slots['E5:prompt-context']({}, { settings });
    assert.deepEqual(e5Offline, { sections: [] });

    // Probe 4: devices return online while mobilecli still times out -> byte-identical E5 prompt restored
    adbRows = [
      'SYNTH-SER-01 device product:synth_p1 model:TEST_CODE_01 device:d1 transport_id:1',
      'SYNTH-SER-02 device product:synth_p2 model:TEST_CODE_02 device:d2 transport_id:2',
    ];
    const state4 = await preview.listState({ settings, fast: true });
    assert.equal(state4.devices.every((d) => d.state === 'online'), true);
    const e5Restored = await slots['E5:prompt-context']({}, { settings });
    assert.equal(e5Restored.sections[0].content, e5Baseline.sections[0].content);
    assert.equal(getpropCalls, 0);
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cold ADB-only fast probes enrich marketname + wm size once per serial and stay byte-identical after slow mobilecli completes', async () => {
  const dataDir = await createRepoScratchDir('cold-adb-enrich-');
  let mobilecliReady = false;
  const shellInvocations = [];

  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'win32',
    fastStateTtlMs: 0,
    fastProbeTimeoutMs: 50,
    loadDriverModule: async () => ({
      MobilecliDriver: class ColdDriver {
        async listDevices() {
          if (!mobilecliReady) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 400);
              timer.unref?.();
            });
            return [];
          }
          return [
            {
              id: 'SYNTH-COLD-01',
              name: 'Synth Cold Flagship',
              platform: 'android',
              type: 'real',
              state: 'online',
              screenSize: { width: 1200, height: 2670 },
            },
            {
              id: 'SYNTH-COLD-02',
              name: 'Synth Fallback Model',
              platform: 'android',
              type: 'real',
              state: 'online',
              screenSize: { width: 1080, height: 2340 },
            },
          ];
        }
        async dispose() {}
      },
    }),
    executeFile: async (file, argv) => {
      assert.equal(file, '/mock/adb');
      if (argv[0] === 'devices' && argv[1] === '-l') {
        return {
          stdout: [
            'List of devices attached',
            'SYNTH-COLD-01 device product:cold1 model:TEST_COLD_01 device:c1',
            'SYNTH-COLD-02 device product:cold2 model:TEST_COLD_02 device:c2',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (argv[0] === '-s' && argv[2] === 'shell') {
        const serial = argv[1];
        const cmd = argv.slice(3).join(' ');
        shellInvocations.push(`${serial}:${cmd}`);
        if (serial === 'SYNTH-COLD-01' && cmd === 'getprop ro.product.marketname') {
          return { stdout: 'Synth Cold Flagship\r\n', stderr: '' };
        }
        if (serial === 'SYNTH-COLD-01' && cmd === 'wm size') {
          return { stdout: 'Physical size: 1440x3200\nOverride size: 1200x2670\n', stderr: '' };
        }
        if (serial === 'SYNTH-COLD-02' && cmd === 'getprop ro.product.marketname') {
          return { stdout: '\n', stderr: '' };
        }
        if (serial === 'SYNTH-COLD-02' && cmd === 'getprop ro.product.model') {
          return { stdout: 'Synth Fallback Model\n', stderr: '' };
        }
        if (serial === 'SYNTH-COLD-02' && cmd === 'wm size') {
          return { stdout: 'Physical size: 1080x2340\n', stderr: '' };
        }
      }
      throw new Error(`Unexpected adb command: ${argv.join(' ')}`);
    },
  });

  try {
    const slots = createPhoneSlotHandlers(preview);
    const settings = { adbPath: '/mock/adb' };

    // Cold fast probe 1: mobilecli times out -> one-shot ADB getprop + wm size enrichment
    const cold1 = await preview.listState({ settings, fast: true });
    const c1 = cold1.devices.find((d) => d.id === 'SYNTH-COLD-01');
    const c2 = cold1.devices.find((d) => d.id === 'SYNTH-COLD-02');
    assert.equal(c1.name, 'Synth Cold Flagship');
    assert.deepEqual(c1.screenSize, { width: 1200, height: 2670 });
    assert.equal(c2.name, 'Synth Fallback Model');
    assert.deepEqual(c2.screenSize, { width: 1080, height: 2340 });

    const e5Cold1 = await slots['E5:prompt-context']({}, { settings });
    const countAfterFirstProbe = shellInvocations.length;
    assert.equal(countAfterFirstProbe, 6, 'Expected single parallel batch (marketname+model+wm) once per online serial');

    // Cold fast probe 2 & 3: mobilecli still times out -> zero additional getprop/wm calls, byte-identical E5
    await preview.listState({ settings, fast: true });
    await preview.listState({ settings, fast: true });
    assert.equal(shellInvocations.length, countAfterFirstProbe, 'Repeated fast probes must not re-spawn adb shell getprop');
    const e5Cold2 = await slots['E5:prompt-context']({}, { settings });
    assert.equal(e5Cold2.sections[0].content, e5Cold1.sections[0].content);

    // Slow mobilecli finally completes -> zero prompt-context flap
    mobilecliReady = true;
    await preview.listState({ settings, fast: false });
    const e5AfterMobilecli = await slots['E5:prompt-context']({}, { settings });
    assert.equal(e5AfterMobilecli.sections[0].content, e5Cold1.sections[0].content);
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('scrcpy-stream replays latest keyframe epoch on clientReady, falls back for legacy clients, and retries codec_options on encoder rejection', async () => {
  const dataDir = await createRepoScratchDir('scrcpy-replay-');
  const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x20, 0xac, 0xb4, 0x0f, 0x81]);
  const pps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x06, 0xf2]);
  const spsPps = Buffer.concat([sps, pps]);

  const makeSessionPacket = (width, height) => {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(0x80000000, 0);
    b.writeUInt32BE(width, 4);
    b.writeUInt32BE(height, 8);
    return b;
  };
  const makeFramePacket = ({ config = false, key = false, ptsUs = 0n, payload }) => {
    const b = Buffer.alloc(12 + payload.length);
    let flags = config ? (1n << 62n) : BigInt(ptsUs);
    if (!config && key) flags |= (1n << 61n);
    b.writeBigUInt64BE(flags, 0);
    b.writeUInt32BE(payload.length, 8);
    payload.copy(b, 12);
    return b;
  };

  class MockSocket extends EventEmitter {
    constructor(role) {
      super();
      this.role = role;
      this.destroyed = false;
      this.noDelay = false;
      this.writes = [];
    }
    setNoDelay(flag) { this.noDelay = Boolean(flag); }
    write(buf) { this.writes.push(Buffer.from(buf)); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }

  const spawnArgsList = [];
  let attempt = 0;
  let videoSocket;
  let controlSocket;
  let attemptSocketSeq = 0;

  const scrcpyManager = createScrcpyManager({
    resolveDataDir: () => dataDir,
    ensureServer: async () => ({ jarPath: '/mock/scrcpy-server-v4.0.jar', version: '4.0', source: 'cache' }),
    allocatePort: async () => 29100 + attempt,
    executeFile: async () => ({ stdout: '', stderr: '' }),
    spawnProcess: (_file, argv) => {
      attempt += 1;
      attemptSocketSeq = 0;
      spawnArgsList.push(argv);
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => { proc.emit('exit', 0); };
      if (attempt === 1) {
        // Simulate an encoder rejecting repeat-previous-frame-after on attempt 1
        queueMicrotask(() => {
          proc.stderr.emit('data', Buffer.from('ERROR: IllegalArgumentException unsupported codec option\n'));
          proc.emit('exit', 1);
        });
      }
      return proc;
    },
    createSocket: () => {
      attemptSocketSeq += 1;
      if (attempt === 1) {
        const failSock = new MockSocket('video');
        queueMicrotask(() => failSock.emit('close'));
        return failSock;
      }
      if (attemptSocketSeq === 1) {
        videoSocket = new MockSocket('video');
        queueMicrotask(() => {
          const nameBuf = Buffer.alloc(64);
          Buffer.from('Synth Stream Phone').copy(nameBuf);
          videoSocket.emit('data', Buffer.concat([
            Buffer.from([0x00]),
            nameBuf,
            Buffer.from('h264', 'ascii'),
            makeSessionPacket(720, 1600),
            makeFramePacket({ config: true, payload: spsPps }),
            makeFramePacket({ key: true, ptsUs: 1000n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x11]) }),
            makeFramePacket({ key: false, ptsUs: 17666n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x22]) }),
            makeFramePacket({ key: false, ptsUs: 34333n, payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x33]) }),
          ]));
        });
        return videoSocket;
      }
      controlSocket = new MockSocket('control');
      queueMicrotask(() => controlSocket.emit('connect'));
      return controlSocket;
    },
  });

  try {
    const sent = [];
    let onTextHandler;
    let closedBySession = false;
    const abort1 = new AbortController();
    const hs = await scrcpyManager.openVideoStream(
      { adbBinary: '/mock/adb', serial: 'SYNTH-STREAM-01', clientReadyFallbackMs: 80 },
      {
        sendBinary: (pkt) => { sent.push(Buffer.from(pkt)); return true; },
        sendText: () => true,
        close: () => { closedBySession = true; },
        onText: (fn) => { onTextHandler = fn; return () => {}; },
        onBinary: () => () => {},
        onClose: () => () => {},
        bufferedAmount: () => 0,
      },
      { signal: abort1.signal },
    );

    assert.equal(closedBySession, false, 'Fallback retry must not prematurely close session');
    assert.equal(spawnArgsList.length, 2, 'Expected automatic retry with i-frame-interval=1 after codec_options rejection');
    assert.ok(spawnArgsList[0].includes('video_codec_options=i-frame-interval=1,repeat-previous-frame-after=100000'));
    assert.ok(spawnArgsList[1].includes('video_codec_options=i-frame-interval=1'));
    assert.equal(hs.width, 720);
    assert.equal(hs.height, 1600);
    assert.equal(videoSocket.noDelay, true);
    assert.equal(controlSocket.noDelay, true);
    assert.equal(sent.length, 0, 'Pre-ready frames stay buffered until clientReady');

    // Sending clientReady replays keyframe + contiguous deltas in exact order
    onTextHandler(JSON.stringify({ type: 'clientReady' }));
    assert.equal(sent.length, 3);
    assert.equal(sent[0][1], 1);
    assert.equal(sent[1][1], 0);
    assert.equal(sent[2][1], 0);
    assert.equal(sent[0].readDoubleBE(8), 1000);
    assert.equal(sent[1].readDoubleBE(8), 17666);
    assert.equal(sent[2].readDoubleBE(8), 34333);

    // Overflowing delta epoch (>60 deltas) then receiving a late clientReady sends keyframe + RESET_VIDEO
    for (let i = 0; i < 62; i++) {
      videoSocket.emit('data', makeFramePacket({ key: false, ptsUs: BigInt(50000 + i * 16666), payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, i & 0xff]) }));
    }
    sent.length = 0;
    controlSocket.writes.length = 0;
    onTextHandler(JSON.stringify({ type: 'clientReady' }));
    assert.equal(sent.length, 1, 'Broken delta epoch replays only lastKeyPacket and requests RESET_VIDEO');
    assert.equal(sent[0][1], 1);
    assert.ok(controlSocket.writes.some((w) => w.length === 1 && w[0] === CONTROL_MSG.RESET_VIDEO));
    abort1.abort();

    // Legacy client that never sends clientReady receives keyframe automatically via fallback timer
    const legacySent = [];
    const abort2 = new AbortController();
    await scrcpyManager.openVideoStream(
      { adbBinary: '/mock/adb', serial: 'SYNTH-STREAM-02', clientReadyFallbackMs: 25 },
      {
        sendBinary: (pkt) => { legacySent.push(Buffer.from(pkt)); return true; },
        sendText: () => true,
        close: () => {},
        onText: () => () => {},
        onBinary: () => () => {},
        onClose: () => () => {},
        bufferedAmount: () => 0,
      },
      { signal: abort2.signal },
    );
    assert.equal(legacySent.length, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(legacySent.length, 3, 'Legacy client receives buffered epoch after fallback timer');
    assert.equal(legacySent[0][1], 1);
    abort2.abort();
  } finally {
    await scrcpyManager.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('panel.html streaming runtime attaches port before async configure, preserves FIFO delta chain during VideoDecoder.isConfigSupported, and coalesces VideoFrames via rAF', async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Expected inline script block in panel.html');

  const drawCalls = [];
  const postedToServer = [];
  const decodedChunks = [];
  const rafQueue = [];
  let rafSeq = 1;
  let streamPortRef = null;
  let decoderOutputCb = null;
  let resolveConfigSupport = null;

  const makeEl = (id) => ({
    id,
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    width: 0,
    height: 0,
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    getAttribute() { return ''; },
    addEventListener() {},
    removeEventListener() {},
    replaceChildren() {},
    append() {},
    appendChild() {},
    focus() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 800 }),
    getContext: (_type, opts) => {
      assert.equal(opts?.alpha, false);
      assert.equal(opts?.desynchronized, true);
      return {
        drawImage(frame, _x, _y, w, h) {
          drawCalls.push({ frameId: frame.frameId, w, h });
        },
      };
    },
  });

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.data = new Uint8Array(init.data);
    }
  }

  class FakeVideoDecoder {
    constructor({ output, error }) {
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
      this._output = output;
      this._error = error;
      decoderOutputCb = output;
    }
    static isConfigSupported() {
      return new Promise((resolve) => {
        resolveConfigSupport = () => resolve({ supported: true });
      });
    }
    configure(cfg) {
      this.config = cfg;
      this.state = 'configured';
    }
    decode(chunk) {
      decodedChunks.push({ type: chunk.type, timestamp: chunk.timestamp, byte0: chunk.data[chunk.data.length - 1] });
    }
    close() {
      this.state = 'closed';
    }
  }

  const fakeWindow = {
    location: { search: '' },
    navigator: { language: 'en-US' },
    performance,
    parent: null,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    ResizeObserver: class { observe() {} },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(fn) {
      const id = rafSeq++;
      rafQueue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      const idx = rafQueue.findIndex((item) => item.id === id);
      if (idx !== -1) rafQueue.splice(idx, 1);
    },
    __kikiPhoneTestBridge(method, payload) {
      if (method === 'plugin.call' && payload.action === 'state') {
        return Promise.resolve({
          ok: true,
          selected: { id: 'SYNTH-VM-01', platform: 'android' },
          devices: [{ id: 'SYNTH-VM-01', name: 'Synth VM Phone', platform: 'android', type: 'real', state: 'online', screenSize: { width: 1080, height: 2400 } }],
          diagnostics: { android: { available: true }, ios: { simulatorsSupported: false } },
        });
      }
      if (method === 'plugin.openStream') {
        assert.equal(payload.args.bitRate, 8000000);
        streamPortRef = {
          started: false,
          onmessage: null,
          start() { this.started = true; },
          postMessage(msg) { postedToServer.push(msg); },
          close() {},
        };
        return Promise.resolve({
          result: { protocol: 'h264-scrcpy-v1', width: 1080, height: 2400, codec: 'h264', codecProfile: 'avc1.640020' },
          port: streamPortRef,
        });
      }
      return Promise.resolve({ ok: true });
    },
  };
  fakeWindow.parent = fakeWindow;

  const sandbox = {
    window: fakeWindow,
    self: fakeWindow,
    document: {
      hidden: false,
      documentElement: { setAttribute() {}, style: { setProperty() {} } },
      activeElement: null,
      getElementById: getEl,
      querySelectorAll: () => [],
      createElement: () => makeEl('dyn'),
      addEventListener() {},
    },
    navigator: fakeWindow.navigator,
    performance,
    ResizeObserver: fakeWindow.ResizeObserver,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    requestAnimationFrame: fakeWindow.requestAnimationFrame,
    cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Blob,
    atob,
  };

  // Boot the real panel.html script in an isolated VM context
  vm.runInNewContext(scriptMatch[1], sandbox);
  // Wait for boot timer (200ms) + async openPanelStream resolution
  for (let i = 0; i < 40 && !streamPortRef; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(streamPortRef, 'Expected panel.html to open hardware stream');
  assert.equal(streamPortRef.started, true, 'port.start() must be called immediately before decoder configure resolves');
  assert.equal(typeof streamPortRef.onmessage, 'function', 'port.onmessage must be attached immediately');
  assert.ok(
    postedToServer.some((m) => typeof m === 'string' && JSON.parse(m).type === 'clientReady'),
    'panel.html must send clientReady immediately before async isConfigSupported settles',
  );

  // Build synthetic H.264 packets with SPS (avc1.640020) and send keyframe + 3 deltas BEFORE isConfigSupported resolves
  const makePktBuf = (isKey, ptsUs, tailByte) => {
    const spsPrefix = isKey ? [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x20, 0, 0, 0, 1, 0x65, tailByte] : [0, 0, 0, 1, 0x41, tailByte];
    const ab = new ArrayBuffer(16 + spsPrefix.length);
    const dv = new DataView(ab);
    dv.setUint8(0, FRAME_PACKET_MAGIC);
    dv.setUint8(1, isKey ? 1 : 0);
    dv.setUint16(2, 1080, false);
    dv.setUint16(4, 2400, false);
    dv.setFloat64(8, ptsUs, false);
    new Uint8Array(ab, 16).set(spsPrefix);
    return ab;
  };

  streamPortRef.onmessage({ data: makePktBuf(true, 1000, 0xa0) });
  streamPortRef.onmessage({ data: makePktBuf(false, 2000, 0xa1) });
  streamPortRef.onmessage({ data: makePktBuf(false, 3000, 0xa2) });
  streamPortRef.onmessage({ data: makePktBuf(false, 4000, 0xa3) });
  assert.equal(decodedChunks.length, 0, 'Chunks wait cleanly while VideoDecoder is asynchronously configuring');

  assert.equal(typeof resolveConfigSupport, 'function');
  resolveConfigSupport();
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(decodedChunks, [
    { type: 'key', timestamp: 1000, byte0: 0xa0 },
    { type: 'delta', timestamp: 2000, byte0: 0xa1 },
    { type: 'delta', timestamp: 3000, byte0: 0xa2 },
    { type: 'delta', timestamp: 4000, byte0: 0xa3 },
  ], 'All queued keyframe + P-frames must decode in exact FIFO order without dropping deltas');
  assert.equal(
    postedToServer.some((m) => typeof m === 'string' && JSON.parse(m).type === 'resetVideo'),
    false,
    'Zero spurious resetVideo requests during initial async configure',
  );

  // Verify zero-jank rAF coalescing: 3 decoded VideoFrames in one burst -> first 2 closed immediately, latest painted on rAF and closed
  const closedFrames = [];
  const makeVideoFrame = (frameId) => ({
    frameId,
    displayWidth: 1080,
    displayHeight: 2400,
    close() { closedFrames.push(frameId); },
  });
  decoderOutputCb(makeVideoFrame(1));
  decoderOutputCb(makeVideoFrame(2));
  decoderOutputCb(makeVideoFrame(3));
  assert.deepEqual(closedFrames, [1, 2], 'Superseded unrendered VideoFrames must close immediately');
  assert.equal(drawCalls.length, 0, 'Canvas draw waits for requestAnimationFrame');
  assert.equal(rafQueue.length, 1, 'Only one rAF scheduled per burst');

  rafQueue.shift().fn();
  assert.deepEqual(drawCalls, [{ frameId: 3, w: 1080, h: 2400 }], 'rAF draws only latest decoded VideoFrame');
  assert.deepEqual(closedFrames, [1, 2, 3], 'Drawn VideoFrame is closed immediately in finally');
});

test('P1-1: hung/failing adb shell enrichment stays within caller timeout budget and does not falsely latch adbEnriched', async () => {
  const dataDir = await createRepoScratchDir('p1-1-adb-budget-');
  let shellShouldHang = true;
  let shellCalls = 0;

  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'win32',
    fastStateTtlMs: 0,
    fastProbeTimeoutMs: 45,
    loadDriverModule: async () => ({
      MobilecliDriver: class AlwaysHungDriver {
        async listDevices() {
          await new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); });
          return [];
        }
        async dispose() {}
      },
    }),
    executeFile: async (file, argv) => {
      assert.equal(file, '/mock/adb');
      if (argv[0] === 'devices' && argv[1] === '-l') {
        return {
          stdout: 'List of devices attached\nSYNTH-BUDGET-01 device product:p1 model:TEST_BUDGET_01 device:d1\n',
          stderr: '',
        };
      }
      if (argv[0] === '-s' && argv[2] === 'shell') {
        shellCalls += 1;
        const cmd = argv.slice(3).join(' ');
        if (shellShouldHang) {
          await new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); });
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'getprop ro.product.marketname') return { stdout: 'Synth Recovered Ultra\n', stderr: '' };
        if (cmd === 'getprop ro.product.model') return { stdout: 'TEST_BUDGET_01\n', stderr: '' };
        if (cmd === 'wm size') return { stdout: 'Physical size: 1440x3200\n', stderr: '' };
      }
      throw new Error(`Unexpected adb command: ${argv.join(' ')}`);
    },
  });

  try {
    const settings = { adbPath: '/mock/adb' };

    // Probe 1: mobilecli hangs (45ms) AND adb shell hangs (45ms single parallel window) -> total must stay well under 200ms
    const t0 = performance.now();
    const s1 = await preview.listState({ settings, fast: true });
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 200, `Expected single bounded 45ms enrich window after 45ms mobilecli timeout, took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(s1.devices[0].name, 'TEST BUDGET 01');
    assert.deepEqual(s1.devices[0].screenSize, { width: 1080, height: 2400 });

    // Probe 2: adb shell recovers -> since Probe 1 failed, adbEnriched was NOT latched, so Probe 2 enriches cleanly
    shellShouldHang = false;
    const callsBeforeRecovery = shellCalls;
    const s2 = await preview.listState({ settings, fast: true });
    assert.ok(shellCalls > callsBeforeRecovery, 'Failed enrichment must not falsely latch adbEnriched');
    assert.equal(s2.devices[0].name, 'Synth Recovered Ultra');
    assert.deepEqual(s2.devices[0].screenSize, { width: 1440, height: 3200 });

    // Probe 3: now adbEnriched IS latched -> zero extra adb shell calls on repeated fast probes
    const callsAfterRecovery = shellCalls;
    const s3 = await preview.listState({ settings, fast: true });
    assert.equal(shellCalls, callsAfterRecovery, 'Successful enrichment must cache per serial across fast probes');
    assert.equal(s3.devices[0].name, 'Synth Recovered Ultra');
    assert.deepEqual(s3.devices[0].screenSize, { width: 1440, height: 3200 });
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('P1-2: authoritative unplug prunes richDeviceCache, fast:false refreshes wm size, and rotate syncs cached orientation', async () => {
  const dataDir = await createRepoScratchDir('p1-2-prune-refresh-');
  let mobilecliShouldHang = false;
  let mobilecliName = 'Synth Initial Phone';
  let mobilecliSize = { width: 1440, height: 3200 };
  let adbConnected = true;
  let marketName = 'Synth Initial Phone';
  let wmSizeOut = 'Physical size: 1440x3200\n';

  const preview = createPhonePreviewService({
    dataDir,
    hostPlatform: 'win32',
    fastStateTtlMs: 0,
    fastProbeTimeoutMs: 50,
    loadDriverModule: async () => ({
      MobilecliDriver: class LifecycleDriver {
        async listDevices() {
          if (mobilecliShouldHang) {
            await new Promise((r) => { const t = setTimeout(r, 400); t.unref?.(); });
            return [];
          }
          if (!adbConnected) return [];
          return [{
            id: 'SYNTH-LIFE-01',
            name: mobilecliName,
            platform: 'android',
            type: 'real',
            state: 'online',
            screenSize: { ...mobilecliSize },
          }];
        }
        async connect() {}
        async getScreenSize() { return { width: 1080, height: 2340 }; }
        async getOrientation() { return 'portrait'; }
        async setOrientation() {}
        async disconnect() {}
        async dispose() {}
      },
    }),
    executeFile: async (file, argv) => {
      assert.equal(file, '/mock/adb');
      if (argv[0] === 'devices' && argv[1] === '-l') {
        const rows = adbConnected ? 'SYNTH-LIFE-01 device product:p1 model:TEST_LIFE_01 device:d1\n' : '';
        return { stdout: `List of devices attached\n${rows}`, stderr: '' };
      }
      if (argv[0] === '-s' && argv[2] === 'shell') {
        const cmd = argv.slice(3).join(' ');
        if (cmd === 'getprop ro.product.marketname') return { stdout: `${marketName}\n`, stderr: '' };
        if (cmd === 'getprop ro.product.model') return { stdout: 'TEST_LIFE_01\n', stderr: '' };
        if (cmd === 'wm size') return { stdout: wmSizeOut, stderr: '' };
      }
      throw new Error(`Unexpected adb command: ${argv.join(' ')}`);
    },
  });

  try {
    const settings = { adbPath: '/mock/adb' };

    // 1. Connected phone enriched via mobilecli
    const s1 = await preview.listState({ settings, fast: true });
    assert.equal(s1.devices[0].name, 'Synth Initial Phone');
    assert.deepEqual(s1.devices[0].screenSize, { width: 1440, height: 3200 });

    // 2. Physical unplug while mobilecli times out -> authoritative adbOutcome.ok prunes richDeviceCache
    mobilecliShouldHang = true;
    adbConnected = false;
    const sUnplugged = await preview.listState({ settings, fast: true });
    assert.equal(sUnplugged.devices.length, 0);

    // 3. Reconnect with different identity/size while mobilecli still times out -> starts fresh without stale cache
    adbConnected = true;
    marketName = 'Synth Replugged Phone';
    wmSizeOut = 'Physical size: 1080x2400\n';
    const sReplugged = await preview.listState({ settings, fast: true });
    assert.equal(sReplugged.devices[0].name, 'Synth Replugged Phone');
    assert.deepEqual(sReplugged.devices[0].screenSize, { width: 1080, height: 2400 });

    // 4. Full refresh (fast:false) updates changed wm size even when mobilecli reports stale size
    mobilecliShouldHang = false;
    mobilecliName = 'Synth Replugged Phone';
    mobilecliSize = { width: 1080, height: 2400 };
    wmSizeOut = 'Physical size: 1440x3200\nOverride size: 1080x2340\n';
    const sRefreshed = await preview.listState({ settings, fast: false });
    assert.deepEqual(sRefreshed.devices[0].screenSize, { width: 1080, height: 2340 });

    // 5. performAction({ action: 'rotate' }) immediately syncs rotated orientation + effectiveSize into subsequent listState
    mobilecliShouldHang = true;
    const rot = await preview.performAction(
      { action: 'rotate', deviceId: 'SYNTH-LIFE-01', platform: 'android', orientation: 'landscape' },
      { settings },
    );
    assert.equal(rot.ok, true);
    assert.equal(rot.orientation, 'landscape');
    const sRotated = await preview.listState({ settings, fast: true });
    assert.equal(sRotated.devices[0].orientation, 'landscape');
    assert.deepEqual(sRotated.devices[0].screenSize, { width: 2340, height: 1080 });
  } finally {
    await preview.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
