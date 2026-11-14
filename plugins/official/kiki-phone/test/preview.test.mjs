import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fitDeviceFrame,
  normalizePointerToDevice,
  flattenViewHierarchy,
  createPhonePreviewService,
} from '../lib/preview-service.mjs';
import { buildPhoneGuiSlots, createPhoneSlotHandlers, PHONE_HTTP_ROUTES } from '../lib/slots.mjs';

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
      return { stdout: '', stderr: '' };
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

test('panel.html stays within the Kiki 256 KiB single-file srcDoc limit, speaks the canonical kiki.panel.v1 host envelope, and carries no emoji', async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(html, 'utf8') < 256 * 1024);
  assert.match(html, /kiki\.panel\.v1/);
  assert.match(html, /kind:\s*'request'/);
  assert.match(html, /channel:\s*CHANNEL/);
  assert.doesNotMatch(html, /protocol:\s*'kiki\.panel\.v1'/);
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u);
});
