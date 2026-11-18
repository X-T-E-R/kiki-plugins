import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { packageFiles } from '../../../../scripts/package-files.mjs';
import { validateRegistration } from '../../../../scripts/validate-registration.mjs';
import { activate, deactivate, handlePanelRequest, openPanelStream, register, slots } from '../entry.mjs';
import {
  computeContainedRect,
  computeScaledDimensions,
  computeWin32VirtualDeskCoords,
  invertWin32VirtualDeskCoords,
  mapContainedClientToTarget,
  resolveTargetPoint,
  resolveZoomCropBounds,
} from '../lib/coordinates.mjs';
import { createCuaService } from '../lib/cua-service.mjs';
import { CUA_SETTINGS_SCHEMA, definitions, normalizeCuaSettings } from '../lib/definitions.mjs';
import {
  createSyntheticSurfacePng,
  cropAndScaleRgba,
  decodePngToRgba,
  encodeRgbaPng,
  isValidPngBuffer,
  parsePngDimensions,
} from '../lib/png-utils.mjs';
import {
  CUA_PROVIDER_PROTOCOL,
  createCuaProviderServer,
  discoverCuaProviders,
  isValidLoopbackEndpoint,
  resolveCuaProviderBusDir,
} from '../lib/provider-bus.mjs';
import { createWin32Bridge } from '../lib/win32-bridge.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(pluginRoot, '../../..');
const tempBaseDir = path.resolve(repoRoot, '../../.tmp/kiki-cua-test');

async function makeIsolatedTmpDir(prefix) {
  await mkdir(tempBaseDir, { recursive: true });
  return mkdtemp(path.join(tempBaseDir, `${prefix}-`));
}

test('manifest, sync-manifest --check, validateRegistration, packageFiles, and vendor-neutrality invariants', async () => {
  const syncCheck = spawnSync(
    process.execPath,
    [path.join(pluginRoot, 'scripts/sync-manifest.mjs'), '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(syncCheck.status, 0, syncCheck.stderr || syncCheck.stdout);

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'kiki-cua');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.icon, './icon.svg');
  assert.deepEqual(manifest.skills, ['./skills']);
  assert.equal(manifest.interface.displayName, 'Kiki Computer Use');
  assert.equal(manifest.interface.localization.en.displayName, 'Kiki Computer Use');
  assert.equal(manifest.interface.localization['zh-CN'].displayName, 'Kiki 电脑操控与远控总线');

  const xk = manifest['x-kiki'];
  assert.deepEqual(xk.engines, { kiki: '^0.4.0' });
  assert.equal(xk.entry, './entry.mjs');
  assert.equal(xk.activation, 'app');
  assert.deepEqual(xk.slots, ['E5:prompt-context', 'E8:tool-pipeline', 'E12:server-gui-slots']);
  assert.deepEqual(xk.permissions, {
    fs: 'outside',
    net: ['127.0.0.1'],
    exec: ['powershell.exe', 'pwsh', 'osascript', 'xdotool', 'ydotool', 'grim'],
    uiPanel: true,
  });
  assert.deepEqual(xk.panels, [
    { schemaVersion: 1, id: 'preview', label: 'Computer Preview', slot: 'workspace', path: './panel.html' },
  ]);
  assert.deepEqual(xk.settings, CUA_SETTINGS_SCHEMA);
  assert.deepEqual(xk.tools, definitions);

  await validateRegistration(manifest, register);
  assert.equal(typeof activate, 'function');
  assert.equal(typeof deactivate, 'function');
  assert.equal(typeof handlePanelRequest, 'function');
  assert.equal(typeof openPanelStream, 'function');
  assert.equal(typeof slots['E5:prompt-context'], 'function');
  assert.equal(typeof slots['E8:tool-pipeline'], 'function');
  assert.equal(typeof slots['E12:server-gui-slots'], 'function');

  const files = await packageFiles(pluginRoot);
  for (const expected of [
    'kimi.plugin.json',
    'entry.mjs',
    'panel.html',
    'icon.svg',
    'README.md',
    'LICENSE',
    'lib/definitions.mjs',
    'lib/coordinates.mjs',
    'lib/png-utils.mjs',
    'lib/provider-bus.mjs',
    'lib/win32-bridge.mjs',
    'lib/win32-host.ps1',
    'lib/win32-native.cs',
    'lib/unix-driver.mjs',
    'lib/cua-service.mjs',
    'lib/slots.mjs',
    'skills/computer-control/SKILL.md',
  ]) {
    assert.ok(files.includes(expected), `Expected packaged file: ${expected}`);
  }
  assert.ok(files.every((f) => !f.startsWith('test/') && !f.startsWith('scripts/')));

  const panelHtml = await readFile(path.join(pluginRoot, 'panel.html'), 'utf8');
  assert.doesNotMatch(panelHtml, /\p{Extended_Pictographic}/u, 'panel.html must contain zero UI emojis');
  assert.doesNotMatch(panelHtml, /data may be stale|results may be incomplete|数据可能已过期|结果可能不完整|仅供预览/i);
  assert.doesNotMatch(panelHtml, /\b(?:localStorage|sessionStorage)\./);
  assert.match(panelHtml, /safeStorage/);
  assert.match(panelHtml, /execCommand\('copy'\)/);
  assert.match(panelHtml, /object-fit:\s*contain/);
  assert.match(panelHtml, /URLSearchParams\(window\.location\.search\)\.get\('theme'\)/);
  assert.match(panelHtml, /Takeover Control/);

  for (const rel of files) {
    const text = await readFile(path.join(pluginRoot, rel), 'utf8');
    assert.doesNotMatch(text, /C:\\Programs|C:\/Programs|C:\\Users|C:\/Users/i, `Leak in ${rel}`);
  }

  assert.deepEqual(normalizeCuaSettings({ defaultMaxWidth: 99999, takeoverThresholdPx: 32 }), {
    defaultMaxWidth: 3840,
    takeoverThresholdPx: 32,
    groundingEndpoint: '',
    groundingModel: '',
  });
  assert.deepEqual(normalizeCuaSettings({ defaultMaxWidth: 200 }), {
    defaultMaxWidth: 640,
    takeoverThresholdPx: 48,
    groundingEndpoint: '',
    groundingModel: '',
  });
});

test('coordinate math across normalized_1000, normalized_01, target_pixels, image_pixels, zoomRelative, and negative virtual-desktop offsets', () => {
  const secondaryOrigin = { x: 3826, y: -723 };
  const logicalSize = { width: 2560, height: 1440 };

  // Endpoints on negative-offset secondary monitor (3826, -723)
  const topLeft = resolveTargetPoint(0, 0, {
    coordinateMode: 'normalized_1000',
    logicalSize,
    targetOrigin: secondaryOrigin,
  });
  assert.deepEqual(topLeft, {
    targetX: 0,
    targetY: 0,
    screenX: 3826,
    screenY: -723,
    normX: 0,
    normY: 0,
  });

  const bottomRight = resolveTargetPoint(1000, 1000, {
    coordinateMode: 'normalized_1000',
    logicalSize,
    targetOrigin: secondaryOrigin,
  });
  assert.deepEqual(bottomRight, {
    targetX: 2559,
    targetY: 1439,
    screenX: 3826 + 2559,
    screenY: -723 + 1439,
    normX: 1000,
    normY: 1000,
  });

  // normalized_01 center
  const mid01 = resolveTargetPoint(0.5, 0.25, {
    coordinateMode: 'normalized_01',
    logicalSize,
    targetOrigin: secondaryOrigin,
  });
  assert.equal(mid01.targetX, Math.round(0.5 * 2559));
  assert.equal(mid01.targetY, Math.round(0.25 * 1439));
  assert.equal(mid01.screenX, 3826 + mid01.targetX);
  assert.equal(mid01.screenY, -723 + mid01.targetY);
  assert.ok(mid01.screenY < 0, 'Secondary monitor upper region preserves negative Y coordinate');

  // target_pixels direct
  const directPx = resolveTargetPoint(400, 300, {
    coordinateMode: 'target_pixels',
    logicalSize,
    targetOrigin: secondaryOrigin,
  });
  assert.equal(directPx.screenX, 4226);
  assert.equal(directPx.screenY, -423);

  // image_pixels downscaled from 2560x1440 -> 1280x720
  const scaled = computeScaledDimensions(2560, 1440, 1280, 900);
  assert.deepEqual({ width: scaled.width, height: scaled.height }, { width: 1280, height: 720 });
  const fromImg = resolveTargetPoint(1279, 719, {
    coordinateMode: 'image_pixels',
    logicalSize,
    targetOrigin: secondaryOrigin,
    lastObservation: {
      imageSize: { width: 1280, height: 720 },
      logicalSize,
      cropBounds: null,
    },
  });
  assert.equal(fromImg.targetX, 2559);
  assert.equal(fromImg.targetY, 1439);

  // Zoom crop before downscaling + zoomRelative follow-up click
  const cropBounds = resolveZoomCropBounds(
    { x: 500, y: 250, width: 250, height: 250 },
    { coordinateMode: 'normalized_1000', logicalSize },
  );
  assert.deepEqual(cropBounds, { x: 1280, y: 360, width: 640, height: 360 });

  const zoomClick = resolveTargetPoint(500, 500, {
    coordinateMode: 'normalized_1000',
    zoomRelative: true,
    logicalSize,
    targetOrigin: secondaryOrigin,
    lastObservation: {
      imageSize: { width: 640, height: 360 },
      logicalSize,
      cropBounds,
    },
  });
  assert.equal(zoomClick.targetX, 1280 + Math.round(0.5 * 639));
  assert.equal(zoomClick.targetY, 360 + Math.round(0.5 * 359));
  assert.equal(zoomClick.screenX, 3826 + zoomClick.targetX);
  assert.equal(zoomClick.screenY, -723 + zoomClick.targetY);

  // zoomRelative without prior zoom must throw clearly instead of misclicking full screen
  assert.throws(
    () => resolveTargetPoint(500, 500, {
      coordinateMode: 'normalized_1000',
      zoomRelative: true,
      logicalSize,
      lastObservation: { imageSize: { width: 1280, height: 720 }, logicalSize, cropBounds: null },
    }),
    /zoomRelative=true requires a prior zoomed cua_observe/,
  );

  // Win32 MOUSEEVENTF_VIRTUALDESK (vw - 1) / (vh - 1) fence-post precision across monitor seam
  const virtualScreen = { x: 0, y: -723, width: 6386, height: 2883 };
  for (const pt of [
    { x: 0, y: 0 },
    { x: 3825, y: 2159 },
    { x: 3826, y: -723 },
    { x: 3826, y: 0 },
    { x: 5106, y: -3 },
    { x: 6385, y: 2159 },
  ]) {
    const { dx, dy } = computeWin32VirtualDeskCoords(pt.x, pt.y, virtualScreen);
    assert.ok(dx >= 0 && dx <= 65535);
    assert.ok(dy >= 0 && dy <= 65535);
    const roundTrip = invertWin32VirtualDeskCoords(dx, dy, virtualScreen);
    assert.deepEqual(roundTrip, { screenX: pt.x, screenY: pt.y });
  }

  // Contained canvas rect inverse mapping (deducts pillarbox/letterbox margins cleanly)
  const contained = computeContainedRect(800, 600, 1920, 1080);
  assert.deepEqual({ x: contained.x, y: contained.y, width: contained.width, height: contained.height }, {
    x: 0,
    y: 75,
    width: 800,
    height: 450,
  });
  const topBarMiss = mapContainedClientToTarget(400, 20, 800, 600, { width: 1920, height: 1080 });
  assert.equal(topBarMiss.inside, false);
  assert.equal(topBarMiss.targetY, 0);

  const midHit = mapContainedClientToTarget(400, 300, 800, 600, { width: 1920, height: 1080 });
  assert.equal(midHit.inside, true);
  assert.deepEqual({ targetX: midHit.targetX, targetY: midHit.targetY, normX: midHit.normX, normY: midHit.normY }, {
    targetX: Math.round(0.5 * 1919),
    targetY: Math.round(0.5 * 1079),
    normX: 500,
    normY: 500,
  });
});

test('resolveCuaProviderBusDir follows exact 5-step precedence', () => {
  assert.equal(
    resolveCuaProviderBusDir({
      env: { KIKI_CUA_BUS_DIR: '/tmp/custom-bus', KIKI_HOME: '/tmp/ignored-home' },
      context: { kikiHome: '/tmp/ctx-home' },
      dataDir: '/tmp/data/kiki-cua',
    }),
    path.resolve('/tmp/custom-bus'),
  );

  assert.equal(
    resolveCuaProviderBusDir({
      env: { KIKI_HOME: '/tmp/env-home' },
      context: { kikiHome: '/tmp/ctx-home' },
    }),
    path.join(path.resolve('/tmp/ctx-home'), 'plugins', 'data', 'kiki-cua', 'providers'),
  );

  assert.equal(
    resolveCuaProviderBusDir({
      env: {},
      dataDir: '/tmp/home-a/plugins/data/kiki-uu-remote',
    }),
    path.join(path.resolve('/tmp/home-a/plugins/data'), 'kiki-cua', 'providers'),
  );

  assert.equal(
    resolveCuaProviderBusDir({
      env: {},
      pluginRoot: '/tmp/home-b/plugins/managed/kiki-cua',
    }),
    path.join(path.resolve('/tmp/home-b'), 'plugins', 'data', 'kiki-cua', 'providers'),
  );

  assert.equal(
    resolveCuaProviderBusDir({ env: {}, pluginRoot: '/opt/dev/kiki-cua' }),
    path.join(os.homedir(), '.kiki', 'plugins', 'data', 'kiki-cua', 'providers'),
  );
});

function createMockLocalDriver() {
  let cursor = { x: 200, y: 200 };
  let releasedCount = 0;
  let uipiBlocked = false;
  const fullPng = createSyntheticSurfacePng(1920, 1080, { x: 960, y: 540, radius: 18 });
  const decodedFull = decodePngToRgba(fullPng);

  return {
    get state() {
      return { cursor, releasedCount };
    },
    setPhysicalCursor(x, y) {
      cursor = { x, y };
    },
    setUipiBlocked(val) {
      uipiBlocked = Boolean(val);
    },
    async listMonitors() {
      return {
        monitors: [
          {
            index: 0,
            id: 'local:monitor-0',
            deviceName: 'DISPLAY1',
            primary: true,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            workArea: { x: 0, y: 0, width: 1920, height: 1040 },
            dpiX: 144,
            dpiY: 144,
            scaleFactor: 1.5,
          },
        ],
        virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
        cursor,
        selfElevated: false,
      };
    },
    async getCursorPos() {
      return { ...cursor };
    },
    async listWindows() {
      return {
        windows: [
          {
            hwnd: '0x20010',
            windowId: '0x20010',
            title: 'Sample Editor',
            processId: 4242,
            processName: 'editor',
            bounds: { x: 100, y: 80, width: 1200, height: 800 },
            dpi: 144,
            scaleFactor: 1.5,
            isMinimized: false,
            isMaximized: false,
            isForeground: true,
            isElevated: uipiBlocked,
          },
        ],
      };
    },
    async focusWindow(hwnd) {
      return { hwnd, windowId: hwnd, title: 'Sample Editor', bounds: { x: 100, y: 80, width: 1200, height: 800 }, scaleFactor: 1.5, dpi: 144, isForeground: true };
    },
    async restoreWindow(hwnd) {
      return { hwnd, windowId: hwnd, title: 'Sample Editor', bounds: { x: 100, y: 80, width: 1200, height: 800 }, scaleFactor: 1.5, dpi: 144, isMinimized: false };
    },
    async capture({ originX, originY, targetW, targetH, hasCrop, cropX, cropY, cropW, cropH, maxWidth, maxHeight }) {
      const viewW = hasCrop ? cropW : targetW;
      const viewH = hasCrop ? cropH : targetH;
      const scaled = computeScaledDimensions(viewW, viewH, maxWidth, maxHeight);
      const cropRect = hasCrop ? { x: cropX, y: cropY, width: cropW, height: cropH } : null;
      const rgba = cropAndScaleRgba(decodedFull.rgba, decodedFull.width, decodedFull.height, cropRect, scaled.width, scaled.height);
      const png = encodeRgbaPng(scaled.width, scaled.height, rgba);
      return {
        imageBase64: png.toString('base64'),
        byteLength: png.length,
        imageSize: { width: scaled.width, height: scaled.height },
        logicalSize: { width: targetW, height: targetH },
        targetOrigin: { x: originX, y: originY },
        cropBounds: cropRect,
        cursor: { ...cursor },
        foregroundWindow: { hwnd: '0x20010', title: 'Sample Editor', processName: 'editor' },
        accessibility: [],
      };
    },
    async mouseClick({ screenX, screenY }) {
      if (uipiBlocked) {
        return {
          blocked: true,
          code: 'uipi_elevated_window',
          hwnd: '0x20010',
          pid: 4242,
          processName: 'elevated-tool',
          title: 'Administrator Console',
          message: 'Target window is elevated (Windows UIPI).',
        };
      }
      cursor = { x: screenX, y: screenY };
      return { blocked: false, cursor: { ...cursor } };
    },
    async mouseMove(screenX, screenY) {
      cursor = { x: screenX, y: screenY };
      return { ...cursor };
    },
    async mouseDown({ hasCoords, screenX, screenY }) {
      if (hasCoords) cursor = { x: screenX, y: screenY };
      return { blocked: false, cursor: { ...cursor } };
    },
    async mouseUp({ hasCoords, screenX, screenY }) {
      if (hasCoords) cursor = { x: screenX, y: screenY };
      return { blocked: false, cursor: { ...cursor } };
    },
    async mouseDrag({ endX, endY }) {
      cursor = { x: endX, y: endY };
      return { blocked: false, cursor: { ...cursor } };
    },
    async mouseScroll({ screenX, screenY }) {
      cursor = { x: screenX, y: screenY };
      return { blocked: false, cursor: { ...cursor } };
    },
    async keyChord() {
      return { blocked: false };
    },
    async holdKey() {
      return { blocked: false };
    },
    async typeText({ text }) {
      return { blocked: false, mode: text.length > 64 ? 'clipboard' : 'unicode', length: text.length };
    },
    async clipboardGet() {
      return { text: 'sample-clipboard' };
    },
    async clipboardSet() {
      return { ok: true };
    },
    async releaseAllInputs() {
      releasedCount += 1;
      return { ok: true };
    },
    async dispose() {},
  };
}

test('kiki.cua.provider.v1 bus round-trip: discovery, SSRF rejection, bad token 401, remote zoom + act, and 409 takeover blocking', async () => {
  const workDir = await makeIsolatedTmpDir('bus-roundtrip');
  const busDir = path.join(workDir, 'providers');
  const stateDir = path.join(workDir, 'state');

  assert.equal(isValidLoopbackEndpoint('http://127.0.0.1:54321'), true);
  assert.equal(isValidLoopbackEndpoint('http://localhost:54321'), false);
  assert.equal(isValidLoopbackEndpoint('http://192.168.1.20:54321'), false);
  assert.equal(isValidLoopbackEndpoint('https://127.0.0.1:54321'), false);
  assert.equal(isValidLoopbackEndpoint('http://127.0.0.1:54321/evil'), false);

  await mkdir(busDir, { recursive: true });

  // Inject malicious SSRF lease and expired dead lease
  const ssrfLeasePath = path.join(busDir, 'ssrf-evil.json');
  await writeFile(ssrfLeasePath, JSON.stringify({
    protocol: CUA_PROVIDER_PROTOCOL,
    providerId: 'ssrf-evil',
    endpoint: 'http://192.168.1.99:8080',
    authToken: 'a'.repeat(64),
    pid: process.pid,
    updatedAtMs: Date.now(),
    ttlMs: 35_000,
  }));

  const expiredLeasePath = path.join(busDir, 'stale-provider.json');
  await writeFile(expiredLeasePath, JSON.stringify({
    protocol: CUA_PROVIDER_PROTOCOL,
    providerId: 'stale-provider',
    endpoint: 'http://127.0.0.1:55111',
    authToken: 'b'.repeat(64),
    pid: 99999999,
    updatedAtMs: Date.now() - 120_000,
    ttlMs: 35_000,
  }));

  const remoteLogical = { width: 2561, height: 1510 };
  const remoteFullPng = createSyntheticSurfacePng(remoteLogical.width, remoteLogical.height, { x: 600, y: 400, radius: 24 });
  const remoteDecoded = decodePngToRgba(remoteFullPng);
  let remoteTakeover = false;
  const recordedRemoteActs = [];

  const providerServer = await createCuaProviderServer({
    providerId: 'kiki-uu-remote',
    displayName: 'Sample Remote Provider',
    busDir,
    handlers: {
      async listTargets() {
        return [
          {
            id: 'uu:24780134',
            providerId: 'kiki-uu-remote',
            kind: 'remote-desktop',
            label: 'Remote Workstation Surface',
            platform: 'desktop',
            online: true,
            takeoverActive: remoteTakeover,
            controlledBy: remoteTakeover ? 'human' : 'agent',
            dimensions: { width: remoteLogical.width, height: remoteLogical.height, scaleFactor: 1 },
            capabilities: ['screenshot', 'zoom', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'clipboard', 'takeover'],
          },
        ];
      },
      async observe(req) {
        const cropBounds = req.zoom
          ? resolveZoomCropBounds(req.zoom, { coordinateMode: req.coordinateMode || 'normalized_1000', logicalSize: remoteLogical })
          : null;
        const viewW = cropBounds ? cropBounds.width : remoteLogical.width;
        const viewH = cropBounds ? cropBounds.height : remoteLogical.height;
        const scaled = computeScaledDimensions(viewW, viewH, req.maxWidth || 1280, req.maxHeight || 900);
        const croppedRgba = cropAndScaleRgba(remoteDecoded.rgba, remoteDecoded.width, remoteDecoded.height, cropBounds, scaled.width, scaled.height);
        const png = encodeRgbaPng(scaled.width, scaled.height, croppedRgba);
        return {
          ok: true,
          targetId: req.targetId,
          capturedAtMs: Date.now(),
          mimeType: 'image/png',
          imageBase64: png.toString('base64'),
          imageSize: { width: scaled.width, height: scaled.height },
          logicalSize: remoteLogical,
          cropBounds,
          contentRect: { x: 0, y: 0, width: remoteLogical.width, height: remoteLogical.height },
          cursor: { x: 600, y: 400 },
          takeoverActive: remoteTakeover,
          controlledBy: remoteTakeover ? 'human' : 'agent',
          accessibility: [],
        };
      },
      async act(req) {
        if (remoteTakeover && !req.overrideHumanTakeover) {
          return {
            ok: false,
            code: 'human_takeover_active',
            message: 'Remote desktop is currently locked by local operator',
            takeoverActive: true,
          };
        }
        if (req.overrideHumanTakeover) remoteTakeover = false;
        recordedRemoteActs.push(req);
        return {
          ok: true,
          targetId: req.targetId,
          executed: req.actions.length,
          results: req.actions.map((a) => ({ kind: a.kind })),
          lastPoint: { x: 500, y: 300, normX: 500, normY: 300 },
          takeoverActive: false,
        };
      },
      async takeover(req) {
        remoteTakeover = Boolean(req.active);
        return {
          ok: true,
          targetId: req.targetId,
          takeoverActive: remoteTakeover,
          controlledBy: remoteTakeover ? 'human' : 'agent',
        };
      },
    },
  });

  try {
    // Bad token must be rejected with HTTP 401
    const badAuthRes = await fetch(`${providerServer.endpoint}/v1/targets`, {
      headers: { Authorization: 'Bearer wrong-token-value' },
    });
    assert.equal(badAuthRes.status, 401);

    // Discovery accepts valid loopback provider, rejects SSRF endpoint, and prunes expired lease
    const discovered = await discoverCuaProviders({ busDir });
    assert.equal(discovered.providers.length, 1);
    assert.equal(discovered.providers[0].providerId, 'kiki-uu-remote');
    assert.ok(discovered.rejected.some((r) => r.providerId === 'ssrf-evil' && r.reason === 'invalid_non_loopback_endpoint'));
    await assert.rejects(() => stat(expiredLeasePath), { code: 'ENOENT' });

    const mockLocal = createMockLocalDriver();
    const service = createCuaService({
      localDriver: mockLocal,
      env: { KIKI_CUA_BUS_DIR: busDir },
      dataDir: stateDir,
    });

    const listRes = await service.executeTool('cua_targets', { action: 'list' }, {});
    const listData = JSON.parse(listRes.output);
    assert.ok(listData.targets.some((t) => t.id === 'local:primary'));
    assert.ok(listData.targets.some((t) => t.id === 'uu:24780134'));

    // Select remote target and verify persistence
    const selRes = await service.executeTool('cua_targets', { action: 'select', targetId: 'uu:24780134' }, {});
    assert.equal(JSON.parse(selRes.output).selectedTargetId, 'uu:24780134');

    // Observe remote target with native zoom crop + grid overlay
    const obsRes = await service.executeTool('cua_observe', {
      zoom: { x: 100, y: 200, width: 400, height: 300 },
      coordinateMode: 'normalized_1000',
      overlay: 'grid',
    }, { imageIn: true });
    assert.equal(obsRes.output.length, 2);
    const obsMeta = JSON.parse(obsRes.output[0].text);
    assert.equal(obsMeta.targetId, 'uu:24780134');
    assert.ok(obsMeta.cropBounds);

    // Verify multimodal external VLM grounding sends image_url and preserves mixed-batch coordinateMode
    let capturedGroundingBody = null;
    const groundingSrv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      capturedGroundingBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"x": 500, "y": 500}' } }],
      }));
    });
    await new Promise((r) => groundingSrv.listen(0, '127.0.0.1', r));
    try {
      const gPort = groundingSrv.address().port;
      const gRes = await service.executeTool('cua_act', {
        coordinateMode: 'target_pixels',
        observeAfter: false,
        actions: [
          { kind: 'click', x: 100, y: 120 },
          { kind: 'click', x: 0, y: 0, label: 'Submit button' },
        ],
      }, {
        settings: { groundingEndpoint: `http://127.0.0.1:${gPort}/v1`, groundingModel: 'ui-grounder' },
        imageIn: false,
      });
      assert.ok(!gRes.isError, gRes.output);
      assert.ok(Array.isArray(capturedGroundingBody?.messages?.[0]?.content));
      assert.ok(capturedGroundingBody.messages[0].content.some((p) => p.type === 'image_url' && p.image_url?.url?.startsWith('data:image/png;base64,')));
      const lastRecorded = recordedRemoteActs.at(-1);
      assert.equal(lastRecorded.coordinateMode, 'target_pixels');
      assert.deepEqual({ x: lastRecorded.actions[0].x, y: lastRecorded.actions[0].y }, { x: 100, y: 120 });
      const expectedRefinedX = obsMeta.cropBounds.x + Math.round(0.5 * (obsMeta.cropBounds.width - 1));
      const expectedRefinedY = obsMeta.cropBounds.y + Math.round(0.5 * (obsMeta.cropBounds.height - 1));
      assert.deepEqual({ x: lastRecorded.actions[1].x, y: lastRecorded.actions[1].y }, { x: expectedRefinedX, y: expectedRefinedY });
    } finally {
      recordedRemoteActs.length = 0;
      await new Promise((r) => groundingSrv.close(r));
    }
    assert.equal(obsMeta.cropBounds.x, Math.round(0.1 * 2561));
    assert.equal(obsMeta.cropBounds.y, Math.round(0.2 * 1510));
    assert.match(obsRes.output[1].imageUrl.url, /^data:image\/png;base64,/);

    // Verify imageIn=false cleanly omits image_url part
    const textOnlyObs = await service.executeTool('cua_observe', {}, { imageIn: false });
    assert.equal(textOnlyObs.output.length, 1);
    assert.equal(textOnlyObs.output[0].type, 'text');

    // Re-zoom then act with zoomRelative: true -> remaps into exact target_pixels for remote provider
    const zoom2 = await service.executeTool('cua_observe', {
      zoom: { x: 200, y: 200, width: 200, height: 200 },
      coordinateMode: 'normalized_1000',
    }, { imageIn: true });
    const zoom2Bounds = JSON.parse(zoom2.output[0].text).cropBounds;

    const actRes = await service.executeTool('cua_act', {
      zoomRelative: true,
      actions: [{ kind: 'click', x: 500, y: 500 }],
      observeAfter: false,
    }, { imageIn: true });
    assert.ok(!actRes.isError);
    assert.equal(recordedRemoteActs.length, 1);
    assert.equal(recordedRemoteActs[0].coordinateMode, 'target_pixels');
    assert.equal(recordedRemoteActs[0].actions[0].x, zoom2Bounds.x + Math.round(0.5 * (zoom2Bounds.width - 1)));
    assert.equal(recordedRemoteActs[0].actions[0].y, zoom2Bounds.y + Math.round(0.5 * (zoom2Bounds.height - 1)));

    // Remote provider 409 human_takeover_active blocks cua_act immediately
    remoteTakeover = true;
    const blockedRes = await service.executeTool('cua_act', {
      actions: [{ kind: 'click', x: 300, y: 300 }],
      observeAfter: false,
    }, {});
    assert.equal(blockedRes.isError, true);
    assert.equal(JSON.parse(blockedRes.output).code, 'human_takeover_active');

    // Release remote takeover via cua_targets
    const unlockRes = await service.executeTool('cua_targets', {
      action: 'takeover',
      targetId: 'uu:24780134',
      takeoverActive: false,
    }, {});
    assert.equal(JSON.parse(unlockRes.output).takeoverActive, false);
    assert.equal(remoteTakeover, false);

    await service.dispose();
  } finally {
    await providerServer.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

test('local Human-Takeover physical cursor displacement guard, UIPI guard, and PreviewWorkspace binary stream', async () => {
  const workDir = await makeIsolatedTmpDir('local-guards');
  try {
    const mockLocal = createMockLocalDriver();
    const service = createCuaService({
      localDriver: mockLocal,
      env: { KIKI_CUA_BUS_DIR: path.join(workDir, 'empty-bus') },
      dataDir: path.join(workDir, 'state'),
    });

    // Step 1: Normal local click records synthetic cursor at (960, 540)
    const firstAct = await service.executeTool('cua_act', {
      targetId: 'local:primary',
      actions: [{ kind: 'click', x: 500, y: 500 }],
      observeAfter: true,
      settleMs: 0,
    }, { settings: { takeoverThresholdPx: 48 }, imageIn: true });
    assert.ok(!firstAct.isError);
    assert.equal(firstAct.output.length, 2);

    // Step 2: Simulate human moving physical mouse by 95px (> 48px threshold)
    mockLocal.setPhysicalCursor(mockLocal.state.cursor.x + 80, mockLocal.state.cursor.y + 55);
    const abortedAct = await service.executeTool('cua_act', {
      targetId: 'local:primary',
      actions: [
        { kind: 'click', x: 200, y: 200 },
        { kind: 'type', text: 'should-not-run' },
      ],
      observeAfter: false,
    }, { settings: { takeoverThresholdPx: 48 } });

    assert.equal(abortedAct.isError, true);
    const abortedJson = JSON.parse(abortedAct.output);
    assert.equal(abortedJson.code, 'human_takeover_active');
    assert.equal(abortedJson.executed, 0);
    assert.ok(abortedJson.displacementPx > 48);
    assert.ok(mockLocal.state.releasedCount >= 1);

    // Step 3: Hand control back to agent and test UIPI elevated window guard
    await service.executeTool('cua_targets', { action: 'takeover', targetId: 'local:primary', takeoverActive: false }, {});
    mockLocal.setUipiBlocked(true);
    const uipiRes = await service.executeTool('cua_act', {
      targetId: 'local:primary',
      actions: [{ kind: 'click', x: 300, y: 300 }],
      observeAfter: false,
    }, {});
    assert.equal(uipiRes.isError, true);
    assert.equal(JSON.parse(uipiRes.output).code, 'uipi_elevated_window');
    mockLocal.setUipiBlocked(false);

    // Step 4: Verify openPanelStream binary PNG frames + interactive human click auto-takeover
    const binaryFrames = [];
    const textFrames = [];
    const streamAbort = new AbortController();
    const fakeSession = {
      signal: streamAbort.signal,
      bufferedAmount: () => 0,
      sendBinary(buf) { binaryFrames.push(buf); },
      sendText(msg) { textFrames.push(typeof msg === 'string' ? JSON.parse(msg) : msg); },
    };

    const opened = await service.openPanelStream('screen', { targetId: 'local:primary', maxWidth: 960, fps: 10 }, fakeSession, {});
    assert.equal(opened.result.protocol, 'kiki-cua-png-stream-v1');

    for (let i = 0; i < 25 && binaryFrames.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(binaryFrames.length >= 1, 'Expected at least 1 binary PNG stream packet');
    const pkt = binaryFrames[0];
    assert.equal(pkt[0], 0x4b);
    assert.equal(pkt[1], 0x02);
    assert.equal(isValidPngBuffer(pkt.subarray(16)), true);

    // Interactive click from panel canvas engages Human Takeover automatically
    await service.handlePanelRequest('action', { targetId: 'local:primary', kind: 'click', normX: 400, normY: 400 }, {});
    const panelState = await service.handlePanelRequest('state', {}, {});
    assert.equal(panelState.takeoverActive, true);
    assert.equal(panelState.controlledBy, 'human');

    streamAbort.abort();
    opened.onClose();
    await service.dispose();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('live Windows read-only hardware test: monitors, windows, native zoom + grid PNG, and <350ms warm capture', { skip: process.platform !== 'win32' }, async () => {
  const bridge = createWin32Bridge();
  try {
    const monInfo = await bridge.listMonitors();
    assert.ok(Array.isArray(monInfo.monitors) && monInfo.monitors.length >= 1);
    const primary = monInfo.monitors.find((m) => m.primary) || monInfo.monitors[0];
    assert.ok(primary.bounds.width >= 640 && primary.bounds.height >= 480);
    assert.ok(primary.dpiX >= 96 && primary.scaleFactor >= 1);

    const winInfo = await bridge.listWindows();
    assert.ok(Array.isArray(winInfo.windows) && winInfo.windows.length >= 1);
    assert.equal(typeof winInfo.windows[0].hwnd, 'string');
    assert.ok(winInfo.windows[0].bounds.width > 0);

    // Warmup capture (read-only: ZERO SendInput calls)
    const warmup = await bridge.capture({
      hwnd: '',
      originX: primary.bounds.x,
      originY: primary.bounds.y,
      targetW: primary.bounds.width,
      targetH: primary.bounds.height,
      hasCrop: false,
      cropX: 0,
      cropY: 0,
      cropW: primary.bounds.width,
      cropH: primary.bounds.height,
      maxWidth: 1280,
      maxHeight: 900,
      overlay: 'none',
      includeAccessibility: false,
    });
    const warmupBuf = Buffer.from(warmup.imageBase64, 'base64');
    assert.equal(isValidPngBuffer(warmupBuf), true);
    const warmupDim = parsePngDimensions(warmupBuf);
    assert.deepEqual({ width: warmupDim.width, height: warmupDim.height }, warmup.imageSize);
    assert.ok(warmupDim.width <= 1280 && warmupDim.height <= 900);

    // Measure warm full-monitor capture latency (best of 2 warm runs to avoid OS scheduler spikes)
    let fullElapsedMs = Infinity;
    let warmFull = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fullStart = performance.now();
      warmFull = await bridge.capture({
        hwnd: '',
        originX: primary.bounds.x,
        originY: primary.bounds.y,
        targetW: primary.bounds.width,
        targetH: primary.bounds.height,
        hasCrop: false,
        cropX: 0,
        cropY: 0,
        cropW: primary.bounds.width,
        cropH: primary.bounds.height,
        maxWidth: 1280,
        maxHeight: 900,
        overlay: 'none',
        includeAccessibility: false,
      });
      fullElapsedMs = Math.min(fullElapsedMs, performance.now() - fullStart);
    }
    assert.equal(isValidPngBuffer(Buffer.from(warmFull.imageBase64, 'base64')), true);
    assert.ok(fullElapsedMs < 350, `Expected warm full-screen capture <350ms, got ${Math.round(fullElapsedMs)}ms`);

    // Measure warm zoom + grid overlay capture (read-only)
    const cropW = Math.min(640, primary.bounds.width);
    const cropH = Math.min(400, primary.bounds.height);
    const zoomStart = performance.now();
    const zoomGrid = await bridge.capture({
      hwnd: '',
      originX: primary.bounds.x,
      originY: primary.bounds.y,
      targetW: primary.bounds.width,
      targetH: primary.bounds.height,
      hasCrop: true,
      cropX: 100,
      cropY: 100,
      cropW,
      cropH,
      maxWidth: 1280,
      maxHeight: 900,
      overlay: 'grid',
      includeAccessibility: false,
    });
    const zoomElapsedMs = performance.now() - zoomStart;
    const zoomBuf = Buffer.from(zoomGrid.imageBase64, 'base64');
    assert.equal(isValidPngBuffer(zoomBuf), true);
    assert.deepEqual(zoomGrid.imageSize, { width: cropW, height: cropH });
    assert.deepEqual(zoomGrid.cropBounds, { x: 100, y: 100, width: cropW, height: cropH });
    assert.ok(zoomElapsedMs < 350, `Expected warm zoom+grid capture <350ms, got ${Math.round(zoomElapsedMs)}ms`);

    // Verify bounded UIA accessibility + Set-of-Mark overlay (read-only, <=120 nodes, never blocks hung HWNDs)
    const somCapture = await bridge.capture({
      hwnd: '',
      originX: primary.bounds.x,
      originY: primary.bounds.y,
      targetW: primary.bounds.width,
      targetH: primary.bounds.height,
      hasCrop: false,
      cropX: 0,
      cropY: 0,
      cropW: primary.bounds.width,
      cropH: primary.bounds.height,
      maxWidth: 1280,
      maxHeight: 900,
      overlay: 'som',
      includeAccessibility: true,
    });
    assert.equal(isValidPngBuffer(Buffer.from(somCapture.imageBase64, 'base64')), true);
    assert.ok(Array.isArray(somCapture.accessibility) && somCapture.accessibility.length <= 120);
  } finally {
    await bridge.dispose();
  }
});

test('E5/E8/E12 extension slots return well-formed GUI slots, routes, and prompt context', async () => {
  const workDir = await makeIsolatedTmpDir('slots-check');
  try {
    const mockLocal = createMockLocalDriver();
    const service = createCuaService({
      localDriver: mockLocal,
      env: { KIKI_CUA_BUS_DIR: path.join(workDir, 'empty-bus') },
      dataDir: path.join(workDir, 'state'),
    });
    const { createCuaSlotHandlers } = await import('../lib/slots.mjs');
    const slotHandlers = createCuaSlotHandlers(service);

    const pipeRes = await slotHandlers['E8:tool-pipeline']({ args: { action: 'list' } });
    assert.deepEqual(pipeRes, { action: 'continue', args: { action: 'list' } });

    const descRes = await slotHandlers['E12:server-gui-slots']({ kind: 'describe' }, {});
    assert.ok(Array.isArray(descRes.guiSlots) && descRes.guiSlots.length >= 3);
    assert.equal(descRes.guiSlots.some((s) => s.slot === 'inspector-tab'), false);
    assert.equal(descRes.guiSlots.some((s) => s.slot === 'sidebar-nav'), false);
    assert.equal(descRes.guiSlots.some((s) => s.slot === 'sidebar-panel'), false);
    assert.ok(descRes.guiSlots.some((s) => s.slot === 'composer-toolbar' && s.icon === 'monitor' && s.action?.panelId === 'preview'));
    assert.ok(descRes.guiSlots.some((s) => s.slot === 'slash-command' && s.command === 'cua-preview' && s.action?.panelId === 'preview'));
    assert.ok(descRes.guiSlots.some((s) => s.slot === 'status-capsule' && s.action?.panelId === 'preview'));
    assert.ok(descRes.routes.some((r) => r.subpath === '/preview/state'));

    const routeRes = await slotHandlers['E12:server-gui-slots']({
      kind: 'http-route',
      method: 'GET',
      subpath: '/preview/state',
    }, {});
    assert.equal(routeRes.status, 200);
    assert.equal(routeRes.data.ok, true);

    // Direct canvas HTTP route actions: right-click, drag, wheel, key chord, clipboard paste, and release takeover
    for (const body of [
      { targetId: 'local:primary', kind: 'click', normX: 500, normY: 500, button: 'right', count: 1 },
      { targetId: 'local:primary', kind: 'drag', startNormX: 200, startNormY: 300, endNormX: 700, endNormY: 600, durationMs: 180 },
      { targetId: 'local:primary', kind: 'scroll', normX: 500, normY: 500, deltaX: 0, deltaY: 3 },
      { targetId: 'local:primary', kind: 'key', key: 'Ctrl+C' },
      { targetId: 'local:primary', kind: 'paste', text: '粘贴测试 123' },
    ]) {
      const actRoute = await slotHandlers['E12:server-gui-slots']({
        kind: 'http-route',
        method: 'POST',
        subpath: '/preview/action',
        body,
      }, {});
      assert.equal(actRoute.status, 200);
      assert.equal(actRoute.data.ok, true);
      assert.equal(actRoute.data.takeoverActive, true);
    }

    const releaseRoute = await slotHandlers['E12:server-gui-slots']({
      kind: 'http-route',
      method: 'POST',
      subpath: '/preview/takeover',
      body: { targetId: 'local:primary', active: false },
    }, {});
    assert.equal(releaseRoute.status, 200);
    assert.equal(releaseRoute.data.takeoverActive, false);

    await service.executeTool('cua_targets', { action: 'takeover', targetId: 'local:primary', takeoverActive: true }, {});
    const e5Res = await slotHandlers['E5:prompt-context']({}, {});
    assert.equal(e5Res.sections.length, 1);
    assert.match(e5Res.sections[0].content, /Human Takeover is ACTIVE/);

    await service.dispose();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

const hostRunnerPath = process.env.KIKI_HOST_RUNNER
  ? path.resolve(process.env.KIKI_HOST_RUNNER)
  : path.resolve(pluginRoot, '..', '..', '..', '.tmp', 'hostRunner.mjs');
test('Kiki hostRunner JSON-RPC lifecycle (handshake, register, activate, panel-request, execute, shutdown)', {
  skip: !existsSync(hostRunnerPath),
}, async () => {
  const workDir = await makeIsolatedTmpDir('host-runner');
  const child = spawn(process.execPath, [hostRunnerPath, path.join(pluginRoot, 'entry.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KIKI_CUA_BUS_DIR: path.join(workDir, 'bus'),
    },
  });

  const rl = createInterface({ input: child.stdout });
  const events = [];
  const pending = new Map();
  let readyResolve;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    events.push(msg);
    if (msg.method === 'ready') readyResolve(msg);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  });

  function rpcCall(id, method, params) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  try {
    const hs = await rpcCall(1, 'handshake', { version: 1 });
    assert.deepEqual(hs, { version: 1 });
    await readyPromise;

    const registeredNames = events
      .filter((e) => e.method === 'register')
      .map((e) => e.params.tool.name);
    assert.deepEqual(registeredNames, ['cua_targets', 'cua_observe', 'cua_act', 'cua_windows']);

    const actRes = await rpcCall(2, 'activate', {
      settings: { defaultMaxWidth: 1280, takeoverThresholdPx: 48 },
      dataDir: path.join(workDir, 'data'),
    });
    assert.equal(actRes.ok, true);

    const panelState = await rpcCall(3, 'panel-request', {
      action: 'state',
      args: {},
      settings: { defaultMaxWidth: 1280 },
    });
    assert.equal(panelState.ok, true);
    assert.ok(Array.isArray(panelState.targets));

    const shut = await rpcCall(4, 'shutdown', {});
    assert.equal(shut, true);
  } finally {
    rl.close();
    try { child.kill(); } catch {}
    await rm(workDir, { recursive: true, force: true });
  }
});
