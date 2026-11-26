import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { packageFiles } from '../../../../scripts/package-files.mjs';
import { packLocalPlugin } from '../../../../scripts/pack.mjs';
import { validateRegistration } from '../../../../scripts/validate-registration.mjs';
import * as entryModule from '../entry.mjs';
import {
  CUA_PROVIDER_PROTOCOL,
  createCuaProviderBridge,
  resolveCuaProviderBusDir,
} from '../lib/cua-provider-bridge.mjs';
import { definitions } from '../lib/definitions.mjs';
import {
  computeContainedRect,
  computeStreamContentRect,
  mapContainedClientToRemote,
  mapPointToTarget,
  processCapturedStagePng,
} from '../lib/frame-math.mjs';
import { assertSafeRemoteKeyChord } from '../lib/key-map.mjs';
import {
  applyGridOverlay,
  computeSampledFrameDiff,
  decodePng,
  encodePng,
  hashPngOrSample,
} from '../lib/png-codec.mjs';
import {
  REMOTE_PYTHON_BRIDGE,
  asciiCharToQmpKeys,
  buildPveTargetId,
  buildQmpStepsForAction,
  buildSshBridgeArgs,
  createPveQmpDriver,
  mapPointToQmpAbs,
  normalizeQmpKeyChord,
  parsePpmP6,
  parsePveTargetId,
  ppmToPngBuffer,
} from '../lib/pve-qmp-driver.mjs';
import {
  CLIENT_POINTER_MAGIC,
  CLIENT_RAW_KEY_MAGIC,
  CLIENT_WHEEL_MAGIC,
  createUuPreviewService,
  decodeClientBinaryInput,
} from '../lib/preview-service.mjs';
import {
  DIRTY_FRAME_MAGIC,
  LOSSLESS_RFB_ENCODINGS,
  MAX_RFB_CLIPBOARD_BYTES,
  RECT_COPYRECT,
  RECT_DEFLATE_RGBA,
  RECT_RAW_RGBA,
  buildPveVncProxyArgs,
  buildVncSshTunnelArgs,
  buildVncTargetId,
  createRfbDriver,
  packDirtyRectFrame,
  parseVncTargetId,
  unpackDirtyRectFrame,
} from '../lib/rfb-driver.mjs';
import { createUuSlotHandlers } from '../lib/slots.mjs';
import { compileWin32StepsForAction, createUuRemoteService } from '../lib/uu-service.mjs';
import { createUuycCliClient, discoverUuycCli, parseCliJsonOutput } from '../lib/uuyc-cli.mjs';
import { createWin32SystemDriver } from '../lib/win32-driver.mjs';
import { classifyUuWindows, computeRescueBounds, normalizeSessionId } from '../lib/window-topology.mjs';
import {
  ALL_MODIFIER_RFB_KEYS,
  asciiCharToRfbKey,
  normalizeRfbKeyChord,
  resolveDomCodeOrKey,
  resolveRfbKeyToken,
} from '../lib/xt-scancode-map.mjs';
import {
  createServer as createRfbServer,
  encodings as RFB_ENCODINGS,
  keysyms as RFB_KEYSYMS,
  pixelFormats as RFB_PIXEL_FORMATS,
} from '../vendor/rfb2/dist/index.js';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP_BASE = process.env.KIKI_UU_TEST_TMP
  ? path.resolve(process.env.KIKI_UU_TEST_TMP)
  : path.join(os.tmpdir(), 'kiki-uu-remote-tests');

async function makeTempDir(t, prefix = 'case-') {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(path.join(TMP_BASE, prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  return dir;
}

function buildSyntheticStagePng({
  width,
  height,
  topBar = 0,
  bottomBar = 0,
  leftBar = 0,
  rightBar = 0,
  barColor = [0, 0, 0],
  quadrants = false,
  fill = [42, 92, 148],
}) {
  const data = new Uint8Array(width * height * 4);
  const contentLeft = leftBar;
  const contentRight = width - rightBar;
  const contentTop = topBar;
  const contentBottom = height - bottomBar;
  const midX = contentLeft + Math.floor((contentRight - contentLeft) / 2);
  const midY = contentTop + Math.floor((contentBottom - contentTop) / 2);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const inBar = y < contentTop || y >= contentBottom || x < contentLeft || x >= contentRight;
      if (inBar) {
        data[idx] = barColor[0];
        data[idx + 1] = barColor[1];
        data[idx + 2] = barColor[2];
        data[idx + 3] = 255;
      } else if (quadrants) {
        if (x < midX && y < midY) {
          data[idx] = 220; data[idx + 1] = 50; data[idx + 2] = 50; // TL red
        } else if (x >= midX && y < midY) {
          data[idx] = 50; data[idx + 1] = 190; data[idx + 2] = 80; // TR green
        } else if (x < midX && y >= midY) {
          data[idx] = 50; data[idx + 1] = 100; data[idx + 2] = 220; // BL blue
        } else {
          data[idx] = 240; data[idx + 1] = 190; data[idx + 2] = 40; // BR amber
        }
        data[idx + 3] = 255;
      } else {
        data[idx] = fill[0];
        data[idx + 1] = fill[1];
        data[idx + 2] = fill[2];
        data[idx + 3] = 255;
      }
    }
  }
  return encodePng({ width, height, data });
}

function createMockDriverFixture() {
  const stagePng = buildSyntheticStagePng({
    width: 640,
    height: 400,
    topBar: 20,
    bottomBar: 20,
    quadrants: true,
  });

  const state = {
    cursor: { x: 4000, y: -400 },
    clipboard: 'initial clipboard',
    sentBatches: [],
    rescuedTargets: [],
    windowActions: [],
    sessions: [
      {
        id: 'uu:24780134',
        hwnd: 24780134,
        stageHwnd: 24780999,
        hasInnerStage: true,
        pid: 8812,
        label: 'Remote Mac Studio',
        className: 'Qt51519QWindowIcon',
        state: 'active',
        dpi: 216,
        scaleFactor: 2.25,
        outerBounds: { x: 3826, y: -723, width: 667, height: 518 },
        canvasBounds: { x: 3826, y: -633, width: 640, height: 400 },
      },
      {
        id: 'uu:24780555',
        hwnd: 24780555,
        stageHwnd: 24780556,
        hasInnerStage: true,
        pid: 8812,
        label: 'Office Workstation',
        className: 'Qt51519QWindowIcon',
        state: 'offscreen',
        dpi: 96,
        scaleFactor: 1,
        outerBounds: { x: 9200, y: -2400, width: 1280, height: 800 },
        canvasBounds: { x: 9200, y: -2310, width: 1280, height: 710 },
      },
    ],
  };

  const driver = {
    hostPlatform: 'win32',
    async discoverInstallation() {
      return {
        installed: true,
        executablePath: 'C:\\Program Files\\NetEase\\GameViewer\\bin\\GameViewer.exe',
        configuredExecutablePath: null,
        source: 'standard_path',
        serviceBinaries: ['C:\\Program Files\\NetEase\\GameViewer\\bin\\GameViewerService.exe'],
        uriSchemes: { uuremote: true, gameviewer: true },
        wingetId: 'NetEase.UURemote',
        portalUrl: 'https://uuyc.163.com/',
      };
    },
    async inspectTopology() {
      return {
        supported: true,
        hostPlatform: 'win32',
        monitors: [
          {
            deviceName: '\\\\.\\DISPLAY1',
            primary: true,
            bounds: { x: 0, y: 0, width: 2560, height: 1440 },
            workArea: { x: 0, y: 0, width: 2560, height: 1392 },
          },
          {
            deviceName: '\\\\.\\DISPLAY2',
            primary: false,
            bounds: { x: 3826, y: -723, width: 2560, height: 1600 },
            workArea: { x: 3826, y: -723, width: 2560, height: 1552 },
          },
        ],
        processes: [{ pid: 8812, name: 'GameViewer', path: null }],
        sessions: state.sessions.map((s) => ({ ...s })),
        launchers: [],
        ignored: [],
        cursor: { ...state.cursor },
        foregroundHwnd: 24780134,
      };
    },
    async getCursorState() {
      return { cursor: { ...state.cursor }, foregroundHwnd: 24780134 };
    },
    async captureSessionStage({ hwnd }) {
      const hit = state.sessions.find((s) => s.hwnd === hwnd);
      return {
        pngBuffer: stagePng,
        stageBounds: hit ? { ...hit.canvasBounds } : { x: 3826, y: -633, width: 640, height: 400 },
        outerBounds: hit ? { ...hit.outerBounds } : { x: 3826, y: -723, width: 667, height: 518 },
        cursor: { ...state.cursor },
      };
    },
    async recoverOffscreenWindows(targets) {
      state.rescuedTargets.push(...targets);
      for (const item of targets) {
        const match = state.sessions.find((s) => s.hwnd === item.hwnd);
        if (match) {
          match.state = 'active';
          match.outerBounds = { x: item.x, y: item.y, width: item.width, height: item.height };
        }
      }
      return { moved: targets };
    },
    async performWindowAction({ hwnd, mode }) {
      state.windowActions.push({ hwnd, mode });
      const match = state.sessions.find((s) => s.hwnd === hwnd);
      if (match && mode === 'restore') match.state = 'active';
      return { focused: true, outerBounds: match?.outerBounds, clientBounds: match?.canvasBounds };
    },
    async getClipboardText() {
      return state.clipboard;
    },
    async setClipboardText(text) {
      state.clipboard = text;
      return { ok: true };
    },
    async sendInputBatch(batch) {
      state.sentBatches.push(batch);
      const lastMove = [...batch.steps].reverse().find((s) => s.op === 'mouse_move');
      if (lastMove) {
        state.cursor = { x: lastMove.x, y: lastMove.y };
      }
      return { ok: true, cursor: { ...state.cursor }, foregroundHwnd: batch.hwndTop };
    },
    async openClientExecutable(exe) {
      return { launched: exe, pid: 9999 };
    },
    async openProtocolUri(uri) {
      return { opened: uri };
    },
    async dispose() {},
  };

  return { driver, state };
}

test('manifest, sync-manifest --check, validateRegistration, packageFiles, and repo cleanliness pass', async () => {
  const syncCheck = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, 'scripts', 'sync-manifest.mjs'), '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(syncCheck.status, 0, syncCheck.stderr);

  const manifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'kiki-uu-remote');
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest['x-kiki'].activation, 'app');
  assert.deepEqual(manifest['x-kiki'].tools, definitions);

  await validateRegistration(manifest, entryModule.register);

  const files = await packageFiles(PLUGIN_ROOT);
  assert.ok(files.includes('kimi.plugin.json'));
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(files.includes('entry.mjs'));
  assert.ok(files.includes('panel.html'));
  assert.ok(files.includes('icon.svg'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('skills/uu-remote/SKILL.md'));
  assert.ok(files.includes('lib/win32-worker.ps1'));
  assert.ok(files.includes('lib/pve-qmp-driver.mjs'));
  assert.ok(files.includes('lib/rfb-driver.mjs'));
  assert.ok(files.includes('lib/xt-scancode-map.mjs'));
  assert.ok(files.includes('vendor/rfb2/LICENSE'));
  assert.ok(files.includes('vendor/rfb2/dist/index.js'));
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('scripts/')));

  const deprecatedHost = ['web', 'uuremote', 'com'].join('.');
  for (const rel of files) {
    const text = await readFile(path.join(PLUGIN_ROOT, rel), 'utf8');
    assert.equal(text.includes(deprecatedHost), false, `Unexpected deprecated domain in ${rel}`);
  }

  const panelHtml = await readFile(path.join(PLUGIN_ROOT, 'panel.html'), 'utf8');
  assert.equal(/\p{Extended_Pictographic}/u.test(panelHtml), false, 'panel.html must contain zero UI emojis');
  assert.doesNotMatch(panelHtml, /data may be stale|results may be incomplete|数据可能已过期|结果可能不完整|仅供预览/i);
  assert.doesNotMatch(panelHtml, /\b(?:localStorage|sessionStorage)\./);
  assert.match(panelHtml, /safeStorage/);
  assert.match(panelHtml, /execCommand\('copy'\)/);
  assert.match(panelHtml, /object-fit:\s*contain/);
  assert.match(panelHtml, /URLSearchParams\(window\.location\.search\)\.get\('theme'\)/);
  assert.ok(panelHtml.includes('Takeover Control'));
  assert.ok(panelHtml.includes('Rescue Off-screen'));
});

test('entry.mjs activate/deactivate lifecycle manages provider bus lease and packLocalPlugin builds clean zip', async (t) => {
  const dir = await makeTempDir(t, 'lifecycle-pack-');
  const kikiHome = path.join(dir, 'kiki-home');
  const dataDir = path.join(kikiHome, 'plugins', 'data', 'kiki-uu-remote');
  const expectedLeasePath = path.join(kikiHome, 'plugins', 'data', 'kiki-cua', 'providers', 'kiki-uu-remote.json');

  const prevBusEnv = process.env.KIKI_CUA_BUS_DIR;
  const prevHomeEnv = process.env.KIKI_HOME;
  const prevKimiHomeEnv = process.env.KIMI_CODE_HOME;
  delete process.env.KIKI_CUA_BUS_DIR;
  delete process.env.KIKI_HOME;
  delete process.env.KIMI_CODE_HOME;

  t.after(async () => {
    if (prevBusEnv !== undefined) process.env.KIKI_CUA_BUS_DIR = prevBusEnv;
    if (prevHomeEnv !== undefined) process.env.KIKI_HOME = prevHomeEnv;
    if (prevKimiHomeEnv !== undefined) process.env.KIMI_CODE_HOME = prevKimiHomeEnv;
    await entryModule.deactivate();
  });

  const ac = new AbortController();
  const leaseReceipt = await entryModule.activate({
    settings: {},
    userHome: dir,
    dataDir,
    signal: ac.signal,
  });

  assert.equal(leaseReceipt.registered, true);
  assert.equal(existsSync(expectedLeasePath), true);
  const lease = JSON.parse(await readFile(expectedLeasePath, 'utf8'));
  const health = await (
    await fetch(`${lease.endpoint}/v1/health`, {
      headers: { Authorization: `Bearer ${lease.authToken}` },
    })
  ).json();
  assert.equal(health.ok, true);
  assert.equal(health.providerId, 'kiki-uu-remote');

  await entryModule.deactivate();
  assert.equal(existsSync(expectedLeasePath), false);

  const zipOutDir = path.join(dir, 'dist');
  await mkdir(zipOutDir, { recursive: true });
  const zipFile = await packLocalPlugin({
    id: 'kiki-uu-remote',
    pluginsRoot: path.resolve(PLUGIN_ROOT, '..', '..'),
    outDir: zipOutDir,
  });
  assert.equal(existsSync(zipFile), true);
});

test('computeStreamContentRect trims symmetric letterbox/pillarbox and guards dark/all-black screens', () => {
  // 1. Symmetric letterbox (top=28, bottom=28)
  const letterboxPng = buildSyntheticStagePng({
    width: 320,
    height: 236,
    topBar: 28,
    bottomBar: 28,
    barColor: [2, 2, 2],
  });
  const lb = computeStreamContentRect(letterboxPng);
  assert.equal(lb.trimmed, true);
  assert.equal(lb.axis, 'letterbox');
  assert.deepEqual({ x: lb.x, y: lb.y, width: lb.width, height: lb.height }, {
    x: 0,
    y: 28,
    width: 320,
    height: 180,
  });

  // 2. Symmetric pillarbox (left=40, right=40)
  const pillarboxPng = buildSyntheticStagePng({
    width: 400,
    height: 180,
    leftBar: 40,
    rightBar: 40,
    barColor: [5, 5, 5],
  });
  const pb = computeStreamContentRect(pillarboxPng);
  assert.equal(pb.trimmed, true);
  assert.equal(pb.axis, 'pillarbox');
  assert.deepEqual({ x: pb.x, y: pb.y, width: pb.width, height: pb.height }, {
    x: 40,
    y: 0,
    width: 320,
    height: 180,
  });

  // 3. All-black sleeping remote desktop -> NEVER collapses to 0x0
  const allBlackPng = buildSyntheticStagePng({
    width: 320,
    height: 200,
    fill: [0, 0, 0],
  });
  const blackRect = computeStreamContentRect(allBlackPng);
  assert.equal(blackRect.trimmed, false);
  assert.equal(blackRect.reason, 'all_black');
  assert.equal(blackRect.width, 320);
  assert.equal(blackRect.height, 200);

  // 4. Four-sided dark border around centered login card -> mutual exclusivity rejects collapse
  const fourSideDarkPng = buildSyntheticStagePng({
    width: 400,
    height: 300,
    topBar: 50,
    bottomBar: 50,
    leftBar: 60,
    rightBar: 60,
  });
  const fourSide = computeStreamContentRect(fourSideDarkPng);
  assert.equal(fourSide.trimmed, false);
  assert.equal(fourSide.reason, 'four_sided_margin_rejected');
  assert.equal(fourSide.width, 400);
  assert.equal(fourSide.height, 300);

  // 5. Asymmetric black header (top=60, bottom=0) -> symmetry guard preserves full desktop
  const asymmetricPng = buildSyntheticStagePng({
    width: 320,
    height: 200,
    topBar: 60,
    bottomBar: 0,
  });
  const asym = computeStreamContentRect(asymmetricPng);
  assert.equal(asym.trimmed, false);
  assert.equal(asym.width, 320);
  assert.equal(asym.height, 200);

  // 6. Explicit remoteAspect override ("16:9" inside 1920x1200)
  const overrideRect = computeStreamContentRect(
    { width: 1920, height: 1200, data: new Uint8Array(0) },
    { remoteAspect: '16:9' },
  );
  assert.deepEqual(
    { x: overrideRect.x, y: overrideRect.y, width: overrideRect.width, height: overrideRect.height },
    { x: 0, y: 60, width: 1920, height: 1080 },
  );
});

test('mapPointToTarget maps normalized_1000 cleanly across negative multi-monitor stage bounds', () => {
  // Empirical multi-monitor stage: outer=(3826, -723, 2588x1628), inner stage=(3826, -633, 2561x1510)
  const stageBounds = { x: 3826, y: -633, width: 2561, height: 1510 };
  const contentRect = { x: 0, y: 35, width: 2561, height: 1440 };

  const topLeft = mapPointToTarget({
    x: 0,
    y: 0,
    coordinateMode: 'normalized_1000',
    stageBounds,
    contentRect,
  });
  assert.equal(topLeft.screenX, 3826);
  assert.equal(topLeft.screenY, -598);

  const center = mapPointToTarget({
    x: 500,
    y: 500,
    coordinateMode: 'normalized_1000',
    stageBounds,
    contentRect,
  });
  assert.equal(center.screenX, 3826 + Math.round(0.5 * (2561 - 1)));
  assert.equal(center.screenY, -633 + 35 + Math.round(0.5 * (1440 - 1)));

  const bottomRight = mapPointToTarget({
    x: 1000,
    y: 1000,
    coordinateMode: 'normalized_1000',
    stageBounds,
    contentRect,
  });
  assert.equal(bottomRight.screenX, 3826 + 2560);
  assert.equal(bottomRight.screenY, -598 + 1439);
});

test('classifyUuWindows separates launcher, inner GameViewer stage, minimized, offscreen, and toolbar popups', () => {
  const monitors = [
    {
      primary: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1392 },
    },
    {
      primary: false,
      bounds: { x: 3826, y: -723, width: 2560, height: 1600 },
      workArea: { x: 3826, y: -723, width: 2560, height: 1552 },
    },
  ];

  const rawWindows = [
    {
      hwnd: 1001,
      pid: 4200,
      className: 'Qt51519QWindowIcon',
      title: 'UU远程',
      visible: true,
      isIconic: false,
      dpi: 96,
      outerBounds: { x: 200, y: 150, width: 980, height: 640 },
      clientBounds: { x: 200, y: 150, width: 980, height: 640 },
      children: [{ hwnd: 1002, className: 'Chrome_WidgetWin_0', title: '', visible: true, bounds: { x: 200, y: 200, width: 980, height: 590 } }],
    },
    {
      hwnd: 24780134,
      pid: 4200,
      className: 'Qt51519QWindowIcon',
      title: 'Remote Mac Studio',
      visible: true,
      isIconic: false,
      dpi: 216,
      outerBounds: { x: 3826, y: -723, width: 2588, height: 1628 },
      clientBounds: { x: 3826, y: -723, width: 2561, height: 1600 },
      children: [
        { hwnd: 24780190, className: 'Qt51519QWindowIcon', title: 'HeaderBar', visible: true, clientBounds: { x: 3826, y: -723, width: 2561, height: 90 } },
        { hwnd: 24780200, className: 'Qt51519QWindowIcon', title: 'GameViewer', visible: true, clientBounds: { x: 3826, y: -633, width: 2561, height: 1510 } },
      ],
    },
    {
      hwnd: 3001,
      pid: 4200,
      className: 'Qt51519QWindowIcon',
      title: 'Office Workstation',
      visible: true,
      isIconic: true,
      dpi: 96,
      outerBounds: { x: -32000, y: -32000, width: 160, height: 28 },
      clientBounds: { x: -32000, y: -32000, width: 160, height: 28 },
      children: [],
    },
    {
      hwnd: 4001,
      pid: 4200,
      className: 'Qt51519QWindowIcon',
      title: 'Lab Linux Node',
      visible: true,
      isIconic: false,
      dpi: 144,
      outerBounds: { x: -4800, y: 200, width: 1920, height: 1080 },
      clientBounds: { x: -4800, y: 260, width: 1920, height: 1020 },
      children: [],
    },
    {
      hwnd: 5001,
      pid: 4200,
      className: 'Qt51519QWindowToolSaveBits',
      title: 'GameViewer',
      visible: true,
      isIconic: false,
      dpi: 216,
      outerBounds: { x: 4800, y: -723, width: 216, height: 306 },
      children: [],
    },
  ];

  const { sessions, launchers, ignored } = classifyUuWindows(rawWindows, monitors);
  assert.equal(launchers.length, 1);
  assert.equal(launchers[0].hwnd, 1001);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].reason, 'toolbar_popup');

  assert.equal(sessions.length, 3);
  const active = sessions.find((s) => s.id === 'uu:24780134');
  assert.equal(active.state, 'active');
  assert.equal(active.stageHwnd, 24780200);
  assert.deepEqual(active.canvasBounds, { x: 3826, y: -633, width: 2561, height: 1510 });

  const minimized = sessions.find((s) => s.id === 'uu:3001');
  assert.equal(minimized.state, 'minimized');

  const offscreen = sessions.find((s) => s.id === 'uu:4001');
  assert.equal(offscreen.state, 'offscreen');
  const rescued = computeRescueBounds(offscreen.outerBounds, monitors[0], 0);
  assert.ok(rescued.x >= 0 && rescued.y >= 0);
  assert.ok(rescued.x + rescued.width <= monitors[0].workArea.width);
  assert.ok(rescued.y + rescued.height <= monitors[0].workArea.height);
});

test('uuyc-cli client strips UTF-8 BOM, merges paired devices/terminals, and enforces non-empty disconnect deviceId', async (t) => {
  const dir = await makeTempDir(t, 'uuyc-cli-');
  const mockCliPath = path.join(dir, 'mock-uuyc-cli.mjs');
  const logPath = path.join(dir, 'invocations.json');

  await writeFile(
    mockCliPath,
    `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const logFile = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const prev = existsSync(logFile) ? JSON.parse(readFileSync(logFile, 'utf8')) : [];
prev.push(args);
writeFileSync(logFile, JSON.stringify(prev));

const bom = '\\uFEFF';
if (args[0] === '--version') {
  process.stdout.write(bom + '4.46.0.4716\\r\\n');
  process.exit(0);
}
if (args[0] === 'status' && args.includes('--json')) {
  process.stdout.write(bom + JSON.stringify({ app_running: true, logged_in: true, version: '4.46.0' }));
  process.exit(0);
}
if (args[0] === 'device' && args[1] === 'list') {
  process.stdout.write(bom + JSON.stringify({
    devices: [
      { device_id: 'dev-mac-01', name: 'Remote Mac Studio', online: true, os: 'macOS' },
      { device_id: 'dev-win-02', name: 'Office Workstation', online: false, os: 'Windows' }
    ]
  }));
  process.exit(0);
}
if (args[0] === 'device' && args[1] === 'status') {
  process.stdout.write(bom + JSON.stringify({
    connections: [{ device_id: 'dev-mac-01', status: 'connected' }]
  }));
  process.exit(0);
}
if (args[0] === 'term' && args[1] === '-d' && args[3] === 'ls') {
  process.stdout.write(bom + JSON.stringify({
    sessions: [{ name: 'build-shell', id: 'term-1', device_id: args[2] }]
  }));
  process.exit(0);
}
if (args[0] === 'device' && args[1] === 'connect') {
  process.stdout.write(bom + JSON.stringify({ connected: true, device_id: args[2] }));
  process.exit(0);
}
if (args[0] === 'device' && args[1] === 'disconnect') {
  if (!args[2] || args[2].startsWith('-')) {
    process.stderr.write('FATAL: disconnect called without positional deviceId!\\n');
    process.exit(99);
  }
  process.stdout.write(bom + JSON.stringify({ disconnected: true, device_id: args[2] }));
  process.exit(0);
}
process.exit(2);
`,
    'utf8',
  );

  assert.deepEqual(parseCliJsonOutput('\uFEFF{"ok":true}\n'), { ok: true });

  const discovered = await discoverUuycCli({ settings: { cliPath: mockCliPath } });
  assert.equal(discovered.available, true);
  assert.equal(discovered.path, mockCliPath);

  const { driver } = createMockDriverFixture();
  const cliClient = createUuycCliClient();
  const service = createUuRemoteService({
    systemDriver: driver,
    cliClient,
    stateDir: path.join(dir, 'state'),
  });

  const settings = { cliPath: mockCliPath };
  const status = await service.getStatus({}, { settings });
  assert.equal(status.cli.version, '4.46.0.4716');
  assert.equal(status.cli.diagnostics.logged_in, true);

  const sessionList = await service.manageSessions(
    { action: 'list', includeDevices: true, includeTerminals: true },
    { settings },
  );
  assert.equal(sessionList.pairedDevices.length, 2);
  assert.equal(sessionList.pairedDevices[0].name, 'Remote Mac Studio');
  assert.equal(sessionList.pairedDevices[0].connected, true);
  assert.equal(sessionList.remoteTerminals.length, 1);
  assert.equal(sessionList.remoteTerminals[0].terminals[0].name, 'build-shell');

  const connectRes = await service.launchAction(
    { action: 'connect_device', deviceId: 'dev-mac-01', waitForWindowMs: 0 },
    { settings },
  );
  assert.equal(connectRes.ok, true);
  assert.equal(connectRes.deviceId, 'dev-mac-01');

  // Disconnect guard: empty, missing, or flag-prefixed deviceId MUST fail before spawning CLI!
  for (const badId of [undefined, '', '   ', '--all', '-h']) {
    await assert.rejects(
      service.launchAction({ action: 'disconnect_device', deviceId: badId }, { settings }),
      /deviceId/i,
    );
  }

  const disconnectRes = await service.launchAction(
    { action: 'disconnect_device', deviceId: 'dev-mac-01' },
    { settings },
  );
  assert.equal(disconnectRes.ok, true);

  const invocations = JSON.parse(await readFile(logPath, 'utf8'));
  const disconnectCalls = invocations.filter((argv) => argv[0] === 'device' && argv[1] === 'disconnect');
  assert.equal(disconnectCalls.length, 1);
  assert.deepEqual(disconnectCalls[0], ['device', 'disconnect', 'dev-mac-01', '--json']);
});

test('key safety blocks Ctrl+Alt client hotkeys and physical cursor displacement locks Human Takeover', async (t) => {
  assert.throws(() => assertSafeRemoteKeyChord('Ctrl+Alt+Enter'), /Ctrl\+Alt/i);
  assert.throws(() => assertSafeRemoteKeyChord(['Control', 'Alt', 'f']), /Ctrl\+Alt/i);
  assert.equal(assertSafeRemoteKeyChord('Ctrl+Alt+Enter', { allowClientHotkey: true }).length, 3);
  assert.equal(assertSafeRemoteKeyChord('Ctrl+Shift+Esc').length, 3);

  const dir = await makeTempDir(t, 'takeover-');
  const { driver, state } = createMockDriverFixture();
  const service = createUuRemoteService({
    systemDriver: driver,
    stateDir: dir,
  });

  const firstClick = await service.controlSession(
    {
      sessionId: 'uu:24780134',
      action: 'click',
      x: 500,
      y: 500,
      observeAfter: false,
    },
    { settings: { takeoverThresholdPx: 48 } },
  );
  assert.equal(firstClick.ok, true);
  assert.equal(state.sentBatches.length, 1);

  // Simulate a human physically moving the mouse 160px away during active agent control
  state.cursor = { x: state.cursor.x + 160, y: state.cursor.y };

  const secondClick = await service.controlSession(
    {
      sessionId: 'uu:24780134',
      action: 'click',
      x: 200,
      y: 200,
      observeAfter: false,
    },
    { settings: { takeoverThresholdPx: 48 } },
  );
  assert.equal(secondClick.ok, false);
  assert.equal(secondClick.code, 'human_takeover_active');
  assert.equal(secondClick.takeoverActive, true);
  assert.equal(state.sentBatches.length, 1, 'SendInput must not run when displacement trips takeover');

  // Releasing takeover restores agent control
  await service.manageSessions({ action: 'takeover', sessionId: 'uu:24780134', active: false });
  const thirdClick = await service.controlSession(
    {
      sessionId: 'uu:24780134',
      action: 'click',
      x: 200,
      y: 200,
      observeAfter: false,
    },
    { settings: { takeoverThresholdPx: 48 } },
  );
  assert.equal(thirdClick.ok, true);
  assert.equal(state.sentBatches.length, 2);
});

test('resolveCuaProviderBusDir honors all 5 precedence tiers and loopback bus serves /v1/* end-to-end', async (t) => {
  const dir = await makeTempDir(t, 'bus-e2e-');

  // Precedence tier checks
  assert.equal(
    resolveCuaProviderBusDir({
      env: { KIKI_CUA_BUS_DIR: path.join(dir, 'tier1'), KIKI_HOME: path.join(dir, 'tier2') },
      dataDir: path.join(dir, 'plugins', 'data', 'kiki-uu-remote'),
    }),
    path.resolve(dir, 'tier1'),
  );
  assert.equal(
    resolveCuaProviderBusDir({
      context: { kikiHome: path.join(dir, 'tier2-ctx') },
      env: { KIKI_HOME: path.join(dir, 'tier2-env') },
    }),
    path.join(path.resolve(dir, 'tier2-ctx'), 'plugins', 'data', 'kiki-cua', 'providers'),
  );
  assert.equal(
    resolveCuaProviderBusDir({
      env: {},
      dataDir: path.join(dir, 'home3', 'plugins', 'data', 'kiki-uu-remote'),
    }),
    path.join(path.resolve(dir, 'home3'), 'plugins', 'data', 'kiki-cua', 'providers'),
  );
  assert.equal(
    resolveCuaProviderBusDir({
      env: {},
      pluginRoot: path.join(dir, 'home4', 'plugins', 'managed', 'kiki-uu-remote'),
      pluginId: 'kiki-uu-remote',
    }),
    path.join(path.resolve(dir, 'home4'), 'plugins', 'data', 'kiki-cua', 'providers'),
  );
  assert.equal(
    resolveCuaProviderBusDir({
      env: {},
      pluginRoot: path.join(dir, 'unmanaged'),
      homedir: () => path.join(dir, 'home5'),
    }),
    path.join(dir, 'home5', '.kiki', 'plugins', 'data', 'kiki-cua', 'providers'),
  );

  // Start live loopback provider bus server
  const busDir = path.join(dir, 'bus');
  const { driver, state } = createMockDriverFixture();
  const uuService = createUuRemoteService({
    systemDriver: driver,
    stateDir: path.join(dir, 'state'),
  });
  const bridge = createCuaProviderBridge({
    uuService,
    heartbeatMs: 5000,
    ttlMs: 35000,
    env: { KIKI_CUA_BUS_DIR: busDir },
  });
  t.after(() => bridge.stop());

  const started = await bridge.start({});
  assert.equal(started.registered, true);
  assert.match(started.endpoint, /^http:\/\/127\.0\.0\.1:\d{2,5}$/);

  const leasePath = path.join(busDir, 'kiki-uu-remote.json');
  const lease = JSON.parse(await readFile(leasePath, 'utf8'));
  assert.equal(lease.protocol, CUA_PROVIDER_PROTOCOL);
  assert.equal(lease.providerId, 'kiki-uu-remote');
  assert.equal(lease.authToken.length, 64);
  assert.deepEqual(lease.capabilities, ['targets', 'observe', 'act', 'clipboard', 'takeover']);

  // Unauthorized requests are denied with 401
  const unauthResp = await fetch(`${lease.endpoint}/v1/health`);
  assert.equal(unauthResp.status, 401);
  const wrongTokenResp = await fetch(`${lease.endpoint}/v1/health`, {
    headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
  });
  assert.equal(wrongTokenResp.status, 401);

  const authHeaders = {
    Authorization: `Bearer ${lease.authToken}`,
    'Content-Type': 'application/json',
  };

  // GET /v1/health
  const health = await (await fetch(`${lease.endpoint}/v1/health`, { headers: authHeaders })).json();
  assert.equal(health.ok, true);
  assert.equal(health.providerId, 'kiki-uu-remote');

  // GET /v1/targets
  const targetsRes = await (await fetch(`${lease.endpoint}/v1/targets`, { headers: authHeaders })).json();
  assert.equal(targetsRes.ok, true);
  assert.equal(targetsRes.targets.length, 2);
  const macTarget = targetsRes.targets.find((item) => item.id === 'uu:24780134');
  assert.equal(macTarget.online, true);
  assert.equal(macTarget.label, 'Remote Mac Studio');

  // POST /v1/observe (full trimmed frame + zoomed bottom-right quadrant)
  const fullObs = await (
    await fetch(`${lease.endpoint}/v1/observe`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ targetId: 'uu:24780134', maxWidth: 1280, maxHeight: 800 }),
    })
  ).json();
  assert.equal(fullObs.ok, true);
  assert.deepEqual(fullObs.contentRect, { x: 0, y: 20, width: 640, height: 360 });
  assert.deepEqual(fullObs.logicalSize, { width: 640, height: 360 });
  assert.equal(fullObs.cropBounds, null);

  const zoomObs = await (
    await fetch(`${lease.endpoint}/v1/observe`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        targetId: 'uu:24780134',
        coordinateMode: 'normalized_1000',
        zoom: { x: 500, y: 500, width: 500, height: 500 },
        maxWidth: 640,
        maxHeight: 360,
      }),
    })
  ).json();
  assert.equal(zoomObs.ok, true);
  assert.deepEqual(zoomObs.cropBounds, { x: 320, y: 180, width: 320, height: 180 });
  assert.deepEqual(zoomObs.imageSize, { width: 320, height: 180 });
  const decodedZoom = decodePng(Buffer.from(zoomObs.imageBase64, 'base64'));
  // Bottom-right quadrant is amber (240, 190, 40)
  assert.equal(decodedZoom.data[0], 240);
  assert.equal(decodedZoom.data[1], 190);
  assert.equal(decodedZoom.data[2], 40);

  // POST /v1/act
  const actRes = await (
    await fetch(`${lease.endpoint}/v1/act`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        targetId: 'uu:24780134',
        coordinateMode: 'normalized_1000',
        actions: [
          { kind: 'click', x: 500, y: 500, button: 'left', count: 1 },
          { kind: 'clipboard_set', text: 'hello workstation' },
          { kind: 'clipboard_get' },
        ],
      }),
    })
  ).json();
  assert.equal(actRes.ok, true);
  assert.equal(actRes.executed, 3);
  assert.equal(actRes.results[2].text, 'hello workstation');
  assert.equal(state.clipboard, 'hello workstation');

  // POST /v1/takeover -> blocks /v1/act with 409 human_takeover_active
  const tkOn = await (
    await fetch(`${lease.endpoint}/v1/takeover`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ targetId: 'uu:24780134', active: true, holder: 'human', reason: 'Manual review' }),
    })
  ).json();
  assert.equal(tkOn.takeoverActive, true);
  assert.equal(tkOn.controlledBy, 'human');

  const blockedResp = await fetch(`${lease.endpoint}/v1/act`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      targetId: 'uu:24780134',
      actions: [{ kind: 'click', x: 100, y: 100 }],
    }),
  });
  assert.equal(blockedResp.status, 409);
  const blockedBody = await blockedResp.json();
  assert.equal(blockedBody.ok, false);
  assert.equal(blockedBody.code, 'human_takeover_active');
  assert.equal(blockedBody.takeoverActive, true);

  // Deactivate/stop removes lease file cleanly
  await bridge.stop();
  assert.equal(existsSync(leasePath), false);
});

test('previewService streams binary PNG packets over openPanelStream and serves E5/E12 slots', async (t) => {
  const dir = await makeTempDir(t, 'preview-');
  const { driver, state } = createMockDriverFixture();
  const uuService = createUuRemoteService({ systemDriver: driver, stateDir: dir });
  const previewService = createUuPreviewService({ uuService });
  t.after(() => previewService.dispose());

  const panelState = await previewService.handlePanelRequest('state', { includeDevices: false }, {});
  assert.equal(panelState.ok, true);
  assert.equal(panelState.offscreenCount, 1);

  const rescueRes = await previewService.handlePanelRequest('action', { action: 'rescueOffscreen' }, {});
  assert.equal(rescueRes.ok, true);
  assert.equal(rescueRes.rescuedCount, 1);
  assert.equal(state.rescuedTargets.length, 1);

  // Binary stream handshake + frame delivery
  const binaryPackets = [];
  let closeHook = null;
  const mockStreamSession = {
    bufferedAmount: () => 0,
    sendBinary(buf) {
      binaryPackets.push(buf);
      return true;
    },
    sendText() {},
    onClose(fn) {
      closeHook = fn;
    },
    onText() {},
  };

  const handshake = await previewService.openPanelStream(
    'screen',
    { sessionId: 'uu:24780134', fps: 15, maxWidth: 640 },
    mockStreamSession,
    {},
  );
  assert.equal(handshake.protocol, 'uu-png-stream-v1');

  const deadline = Date.now() + 2000;
  while (binaryPackets.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  closeHook?.();

  assert.ok(binaryPackets.length >= 1);
  const pkt = binaryPackets[0];
  assert.equal(pkt[0], 0x55);
  assert.equal(pkt[1], 0x52);
  assert.equal(pkt[2] & 1, 1); // contentTrimmed flag
  const decoded = decodePng(pkt.subarray(16));
  assert.equal(decoded.width, 640);
  assert.equal(decoded.height, 360);

  const slots = createUuSlotHandlers(previewService);
  const promptCtx = await slots['E5:prompt-context']({}, {});
  assert.equal(promptCtx.sections.length, 1);
  assert.match(promptCtx.sections[0].content, /uu:24780134/);

  const guiDescribe = await slots['E12:server-gui-slots']({ kind: 'describe' }, {});
  assert.equal(guiDescribe.guiSlots.some((s) => s.slot === 'inspector-tab'), false);
  assert.equal(guiDescribe.guiSlots.some((s) => s.slot === 'sidebar-nav'), false);
  assert.equal(guiDescribe.guiSlots.some((s) => s.slot === 'sidebar-panel'), false);
  assert.ok(guiDescribe.guiSlots.some((s) => s.slot === 'composer-toolbar' && s.icon === 'monitor' && s.action?.panelId === 'preview'));
  assert.ok(guiDescribe.guiSlots.some((s) => s.slot === 'slash-command' && s.command === 'uu-remote' && s.action?.panelId === 'preview'));
  assert.ok(guiDescribe.guiSlots.some((s) => s.id === 'uu-active-capsule' && s.action?.panelId === 'preview'));

  // Contained canvas inverse mapping deducts pillarbox/letterbox bars accurately
  const contained = computeContainedRect(800, 600, 1920, 1080);
  assert.deepEqual({ x: contained.x, y: contained.y, width: contained.width, height: contained.height }, {
    x: 0,
    y: 75,
    width: 800,
    height: 450,
  });
  const topMarginClick = mapContainedClientToRemote(400, 30, 800, 600, { width: 1920, height: 1080 });
  assert.equal(topMarginClick.inside, false);
  const centerClick = mapContainedClientToRemote(400, 300, 800, 600, { width: 1920, height: 1080 });
  assert.equal(centerClick.inside, true);
  assert.deepEqual({ targetX: centerClick.targetX, targetY: centerClick.targetY, normX: centerClick.normX, normY: centerClick.normY }, {
    targetX: Math.round(0.5 * 1919),
    targetY: Math.round(0.5 * 1079),
    normX: 500,
    normY: 500,
  });

  // Direct canvas HTTP route actions: auto-engages Human Takeover, supports right+modifier click, drag, scroll, key chord, and clipboard paste
  for (const body of [
    {
      action: 'input',
      sessionId: 'uu:24780134',
      subAction: 'click',
      coordinateMode: 'normalized_1000',
      x: 500,
      y: 500,
      button: 'right',
      count: 1,
      modifiers: ['Ctrl'],
      fromHumanPanel: true,
    },
    {
      action: 'input',
      sessionId: 'uu:24780134',
      subAction: 'drag',
      coordinateMode: 'normalized_1000',
      startX: 250,
      startY: 300,
      endX: 750,
      endY: 650,
      button: 'left',
      durationMs: 180,
      fromHumanPanel: true,
    },
    {
      action: 'input',
      sessionId: 'uu:24780134',
      subAction: 'scroll',
      coordinateMode: 'normalized_1000',
      x: 500,
      y: 500,
      deltaX: 0,
      deltaY: 240,
      fromHumanPanel: true,
    },
    {
      action: 'input',
      sessionId: 'uu:24780134',
      subAction: 'key',
      keys: ['Ctrl', 'C'],
      fromHumanPanel: true,
    },
    {
      action: 'input',
      sessionId: 'uu:24780134',
      subAction: 'paste',
      text: '远端剪贴板直发',
      fromHumanPanel: true,
    },
  ]) {
    const actRoute = await slots['E12:server-gui-slots'](
      {
        kind: 'http-route',
        method: 'POST',
        subpath: '/preview/action',
        body,
      },
      {},
    );
    assert.equal(actRoute.status, 200);
    assert.equal(actRoute.data.ok, true);
    assert.equal(actRoute.data.takeoverActive, true);
  }

  // Background agent action without overrideHumanTakeover is blocked while human panel takeover is active
  const agentBlocked = await uuService.controlSession(
    { sessionId: 'uu:24780134', action: 'click', x: 100, y: 100 },
    {},
  );
  assert.equal(agentBlocked.ok, false);
  assert.equal(agentBlocked.code, 'human_takeover_active');

  // Release takeover cleanly via /preview/action
  const releaseRoute = await slots['E12:server-gui-slots'](
    {
      kind: 'http-route',
      method: 'POST',
      subpath: '/preview/action',
      body: { action: 'takeover', sessionId: 'uu:24780134', active: false },
    },
    {},
  );
  assert.equal(releaseRoute.status, 200);
  assert.equal(releaseRoute.data.takeoverActive, false);
});

test(
  'read-only live Windows discovery enumerates installation, uuyc-cli version, and monitors without touching focus or input',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = await makeTempDir(t, 'live-ro-');
    const liveDriver = createWin32SystemDriver({ workerIdleMs: 5000 });
    const liveCli = createUuycCliClient();
    const service = createUuRemoteService({
      systemDriver: liveDriver,
      cliClient: liveCli,
      stateDir: dir,
    });
    t.after(async () => {
      await service.dispose();
    });

    // Strictly read-only: includeCliStatus=false & includeDevices=false avoids mutating or IPC-waking idle services
    const status = await service.getStatus({ includeCliStatus: false }, {});
    assert.equal(status.ok, true);
    assert.equal(status.hostPlatform, 'win32');
    assert.equal(typeof status.installation.installed, 'boolean');
    assert.equal(typeof status.cli.available, 'boolean');
    if (status.cli.available) {
      assert.match(String(status.cli.version || ''), /^\d+\.\d+/);
    }

    const topo = await liveDriver.inspectTopology({});
    assert.equal(topo.supported, true);
    assert.ok(Array.isArray(topo.monitors) && topo.monitors.length >= 1, 'Expected at least one display monitor');
    assert.ok(Array.isArray(topo.sessions));

    const sessionsRes = await service.manageSessions(
      { action: 'list', includeDevices: false, probeContentRect: false },
      {},
    );
    assert.equal(sessionsRes.ok, true);
    assert.ok(Array.isArray(sessionsRes.sessions));

    // Optional non-destructive background PrintWindow smoke check if an active session happens to be open
    const activeSession = topo.sessions.find((s) => s.state === 'active');
    if (activeSession) {
      const stageCapture = await liveDriver.captureSessionStage({
        hwnd: activeSession.hwnd,
        stageHwnd: activeSession.stageHwnd,
      });
      const processed = processCapturedStagePng(stageCapture.pngBuffer, { maxWidth: 640, maxHeight: 400 });
      assert.ok(processed.imageSize.width > 0 && processed.imageSize.height > 0);
    }
  },
);

test('P0-1: static CLI/install discovery caches 60s single-flight and E5/E12 peekState is non-blocking without calling getStatus', async (t) => {
  let execCalls = 0;
  const fakeExec = async (file, argv) => {
    execCalls += 1;
    await new Promise((r) => setTimeout(r, 15));
    if (file === 'reg.exe') return { stdout: '    instDir    REG_SZ    C:\\UU\r\n', stderr: '' };
    if (argv.includes('--version')) return { stdout: '4.46.1\r\n', stderr: '' };
    return { stdout: 'C:\\UU\\bin\\uuyc-cli.exe\r\n', stderr: '' };
  };

  let fakeNow = 10_000;
  const cli = createUuycCliClient({
    hostPlatform: 'win32',
    fileExists: (p) => p.includes('uuyc-cli.exe'),
    executeFile: fakeExec,
    staticCacheTtlMs: 60_000,
    nowFn: () => fakeNow,
  });

  // Concurrent getVersion calls dedup to a single discovery + version execution
  const [v1, v2] = await Promise.all([cli.getVersion({}), cli.getVersion({})]);
  assert.equal(v1.version, '4.46.1');
  assert.equal(v2.version, '4.46.1');
  const callsAfterWarm = execCalls;
  await cli.getVersion({});
  assert.equal(execCalls, callsAfterWarm, 'Cached CLI version must not re-spawn subprocesses within 60s');

  // Win32 installation discovery caches 60s single-flight
  let regCalls = 0;
  const winDriver = createWin32SystemDriver({
    hostPlatform: 'win32',
    fileExists: () => false,
    executeFile: async () => {
      regCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('not found');
    },
    installCacheTtlMs: 60_000,
    nowFn: () => fakeNow,
  });
  await Promise.all([winDriver.discoverInstallation({}), winDriver.discoverInstallation({})]);
  const regAfterFirst = regCalls;
  await winDriver.discoverInstallation({});
  assert.equal(regCalls, regAfterFirst, 'discoverInstallation must reuse 60s cache');

  // E5 and E12 describe use peekState without calling getStatus and never block on slow refreshes
  const dir = await makeTempDir(t, 'uu-p0-1-swr-');
  const { driver } = createMockDriverFixture();
  let statusCalls = 0;
  let topoCalls = 0;
  let topoDelayMs = 0;
  const origInspect = driver.inspectTopology.bind(driver);
  driver.inspectTopology = async (...args) => {
    topoCalls += 1;
    if (topoDelayMs > 0) await new Promise((r) => setTimeout(r, topoDelayMs));
    return origInspect(...args);
  };
  const origDiscover = driver.discoverInstallation.bind(driver);
  driver.discoverInstallation = async (...args) => {
    statusCalls += 1;
    return origDiscover(...args);
  };

  const uuService = createUuRemoteService({ systemDriver: driver, stateDir: dir });
  const previewService = createUuPreviewService({ uuService, nowFn: () => fakeNow });
  t.after(() => previewService.dispose());
  const slots = createUuSlotHandlers(previewService);

  const e5 = await slots['E5:prompt-context']({}, {});
  assert.equal(e5.sections.length, 1);
  assert.equal(statusCalls, 0, 'E5:prompt-context must not invoke getStatus/discoverInstallation');
  assert.equal(topoCalls, 1);

  const e12 = await slots['E12:server-gui-slots']({ kind: 'describe' }, {});
  assert.ok(e12.guiSlots.some((s) => s.id === 'uu-active-capsule'));
  assert.equal(statusCalls, 0, 'E12 describe must not invoke getStatus/discoverInstallation');
  assert.equal(topoCalls, 1, 'E12 describe should hit 15s SWR cache from E5');

  // Expire cache and simulate a slow 2s topology probe; stale peekState returns immediately (<100ms)
  fakeNow += 20_000;
  topoDelayMs = 1_500;
  const t0 = performance.now();
  const stale = await previewService.peekState({ maxAgeMs: 15_000, waitBudgetMs: 200 }, {});
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 100, `stale peekState must return immediately via SWR, took ${elapsed.toFixed(1)}ms`);
  assert.equal(stale.sessions.length, 2);
});

test('P0-3: wedged Win32 PowerShell worker is force-killed on timeout/abort and next RPC spawns a clean worker', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const spawnedWorkers = [];
  const taskkillCalls = [];

  const driver = createWin32SystemDriver({
    hostPlatform: 'win32',
    workerIdleMs: 0,
    spawnProcess: (file, args) => {
      if (file === 'taskkill') {
        taskkillCalls.push(args);
        const k = new EventEmitter();
        k.unref = () => {};
        return k;
      }
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const proc = new EventEmitter();
      proc.pid = 40_000 + spawnedWorkers.length + 1;
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.stdin = stdin;
      proc.killed = false;
      proc.unref = () => {};
      proc.kill = () => {
        proc.killed = true;
        proc.emit('exit', 1, 'SIGKILL');
      };
      const workerIdx = spawnedWorkers.length;
      spawnedWorkers.push(proc);

      // Worker 0 hangs forever on every RPC; Worker 1 answers immediately
      if (workerIdx >= 1) {
        let buf = '';
        stdin.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          for (const line of buf.split('\n')) {
            if (!line.trim()) continue;
            try {
              const req = JSON.parse(line);
              stdout.write(JSON.stringify({ id: req.id, ok: true, result: { cursor: { x: 42, y: 84 }, foregroundHwnd: 1 } }) + '\n');
            } catch {}
          }
          buf = '';
        });
      }
      return proc;
    },
  });

  // Queue two RPCs on wedged Worker 0; the first times out at 60ms and kills/detaches Worker 0,
  // rejecting both pending calls cleanly
  const p1 = driver.callWorker({ op: 'cursor_pos' }, 60);
  const p2 = driver.callWorker({ op: 'cursor_pos' }, 5000);
  await assert.rejects(p1, /timed out/);
  await assert.rejects(p2, /timed out/);
  assert.equal(spawnedWorkers.length, 1);
  assert.equal(spawnedWorkers[0].killed, true);
  assert.ok(taskkillCalls.some((a) => a.includes(String(spawnedWorkers[0].pid)) && a.includes('/T') && a.includes('/F')));

  // Next RPC spawns fresh Worker 1 and succeeds
  const recovered = await driver.getCursorState();
  assert.equal(spawnedWorkers.length, 2);
  assert.deepEqual(recovered.cursor, { x: 42, y: 84 });
  await driver.dispose();
});

test('P1-2: openPanelStream skips per-frame inspectTopology until 3s or capture error, and panel.html wires visibilitychange/pagehide/backoff', async (t) => {
  const dir = await makeTempDir(t, 'uu-p1-2-stream-');
  const { driver } = createMockDriverFixture();
  let topoCalls = 0;
  let captureCalls = 0;
  let failNextCapture = false;
  let fakeNow = 50_000;

  const origInspect = driver.inspectTopology.bind(driver);
  driver.inspectTopology = async (...args) => {
    topoCalls += 1;
    return origInspect(...args);
  };
  const origCapture = driver.captureSessionStage.bind(driver);
  driver.captureSessionStage = async (...args) => {
    captureCalls += 1;
    if (failNextCapture) {
      failNextCapture = false;
      throw new Error('simulated PrintWindow failure');
    }
    const base = await origCapture(...args);
    // Vary fill color per frame so live changing frames pass SHA-256 unchanged-frame dedup
    const varyingPng = buildSyntheticStagePng({
      width: 640,
      height: 400,
      topBar: 20,
      bottomBar: 20,
      fill: [40 + (captureCalls * 17) % 180, 90, 148],
    });
    return { ...base, pngBuffer: varyingPng };
  };

  const uuService = createUuRemoteService({ systemDriver: driver, stateDir: dir, nowFn: () => fakeNow });
  const previewService = createUuPreviewService({ uuService, nowFn: () => fakeNow });
  t.after(() => previewService.dispose());

  let closeHook = null;
  const frames = [];
  const warnings = [];
  await previewService.openPanelStream(
    'screen',
    { sessionId: 'uu:24780134', fps: 20, maxWidth: 640 },
    {
      bufferedAmount: () => 0,
      sendBinary(buf) {
        frames.push(buf);
        return true;
      },
      sendText(txt) {
        warnings.push(txt);
      },
      onClose(fn) {
        closeHook = fn;
      },
      onText() {},
    },
    {},
  );

  // Wait for at least 3 frames to pump within fakeNow (elapsed < 3s)
  const deadline = Date.now() + 1500;
  while (frames.length < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(frames.length >= 3, `expected >=3 frames, got ${frames.length}`);
  assert.equal(topoCalls, 1, 'pumpFrame must NOT re-call inspectTopology on every frame within 3s');

  // Trigger a capture error -> forces topology re-resolution on subsequent frame
  failNextCapture = true;
  const warnDeadline = Date.now() + 1500;
  while (topoCalls < 2 && Date.now() < warnDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  closeHook?.();
  assert.ok(topoCalls >= 2, 'capture error must trigger topology re-resolution');
  assert.ok(warnings.some((w) => w.includes('streamWarning')));

  const panelHtml = await readFile(path.join(PLUGIN_ROOT, 'panel.html'), 'utf8');
  assert.match(panelHtml, /visibilitychange/);
  assert.match(panelHtml, /pagehide/);
  assert.match(panelHtml, /POLL_BACKOFF_MS\s*=\s*\[220,\s*500,\s*1000,\s*3000\]/);
});

function buildSyntheticPpmP6({ width, height, comment = null, quadrants = true }) {
  const header = comment
    ? `P6\n# ${comment}\n${width} ${height}\n255\n`
    : `P6\n${width} ${height}\n255\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  const rgb = Buffer.allocUnsafe(width * height * 3);
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      if (quadrants) {
        if (x < midX && y < midY) {
          rgb[idx] = 220; rgb[idx + 1] = 40; rgb[idx + 2] = 50; // TL red
        } else if (x >= midX && y < midY) {
          rgb[idx] = 32; rgb[idx + 1] = 185; rgb[idx + 2] = 75; // TR green (starts with 0x20 space!)
        } else if (x < midX && y >= midY) {
          rgb[idx] = 45; rgb[idx + 1] = 95; rgb[idx + 2] = 230; // BL blue
        } else {
          rgb[idx] = 245; rgb[idx + 1] = 195; rgb[idx + 2] = 35; // BR amber
        }
      } else {
        rgb[idx] = 10; rgb[idx + 1] = 32; rgb[idx + 2] = 128; // Leading 0x0a/0x20 bytes test delimiter
      }
    }
  }
  return Buffer.concat([headerBuf, rgb]);
}

test('PVE QMP: target validation rejects command injection and parses valid pve:<host>:<vmid>', () => {
  const parsed = parsePveTargetId('PVE:pve-lab-node:103', { strict: true });
  assert.deepEqual(parsed, {
    id: 'pve:pve-lab-node:103',
    sshHost: 'pve-lab-node',
    vmid: 103,
  });
  assert.equal(buildPveTargetId('Node_01.lan', 42), 'pve:Node_01.lan:42');

  const sshArgs = buildSshBridgeArgs('pve-lab-node');
  const sepIdx = sshArgs.indexOf('--');
  assert.ok(sepIdx > 0);
  assert.equal(sshArgs[sepIdx + 1], 'pve-lab-node');
  assert.ok(sshArgs.includes('BatchMode=yes'));

  const maliciousInputs = [
    'pve:-oProxyCommand=calc:103',
    'pve:host;rm -rf /:103',
    'pve:host$(whoami):103',
    'pve:host`id`:103',
    'pve:host name:103',
    'pve:host/path:103',
    'pve:host:0',
    'pve:host:-1',
    'pve:host:103;id',
    'pve:host:abc',
    'pve:host:103:extra',
    'pve::103',
  ];
  for (const bad of maliciousInputs) {
    assert.equal(parsePveTargetId(bad, { strict: false }), null, `Expected null for ${bad}`);
    assert.throws(() => parsePveTargetId(bad, { strict: true }), /Invalid PVE/i, `Expected throw for ${bad}`);
  }
  assert.throws(() => buildSshBridgeArgs('-oProxyCommand=evil'), /Invalid PVE SSH host/i);
});

test('PVE QMP: pure-JS P6 PPM parser handles comments, leading whitespace pixel bytes, and PNG round-trip', () => {
  // Test leading pixel byte = 0x0a (LF) & 0x20 (space) so parser only eats 1 delimiter byte after maxval
  const trickyPpm = buildSyntheticPpmP6({ width: 4, height: 2, comment: 'QEMU screendump test', quadrants: false });
  const parsed = parsePpmP6(trickyPpm);
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.data.length, 4 * 2 * 4);
  assert.deepEqual([...parsed.data.subarray(0, 4)], [10, 32, 128, 255]);

  const quadPpm = buildSyntheticPpmP6({ width: 320, height: 240, quadrants: true });
  const { width, height, pngBuffer } = ppmToPngBuffer(quadPpm);
  assert.equal(width, 320);
  assert.equal(height, 240);
  const decoded = decodePng(pngBuffer);
  assert.equal(decoded.width, 320);
  assert.equal(decoded.height, 240);
  // Top-left pixel is red (220, 40, 50)
  assert.deepEqual([...decoded.data.subarray(0, 4)], [220, 40, 50, 255]);
  // Bottom-right pixel is amber (245, 195, 35)
  const brIdx = ((239 * 320) + 319) * 4;
  assert.deepEqual([...decoded.data.subarray(brIdx, brIdx + 4)], [245, 195, 35, 255]);

  // Truncated and non-P6 buffers fail loudly
  assert.throws(() => parsePpmP6(Buffer.from('P3\n2 2\n255\n0 0 0\n')), /expected P6/i);
  assert.throws(() => parsePpmP6(Buffer.from('P6\n10 10\n255\n123')), /Truncated PPM/i);
});

test('PVE QMP: coordinate scaling (0..32767) and mouse/keyboard QMP command compilation', () => {
  const origin = mapPointToQmpAbs({ x: 0, y: 0, coordinateMode: 'normalized_1000', screenSize: { width: 1024, height: 768 } });
  assert.equal(origin.absX, 0);
  assert.equal(origin.absY, 0);

  const mid = mapPointToQmpAbs({ x: 500, y: 500, coordinateMode: 'normalized_1000', screenSize: { width: 1024, height: 768 } });
  assert.equal(mid.absX, 16384);
  assert.equal(mid.absY, 16384);

  const corner = mapPointToQmpAbs({ x: 1000, y: 1000, coordinateMode: 'normalized_1000', screenSize: { width: 1024, height: 768 } });
  assert.equal(corner.absX, 32767);
  assert.equal(corner.absY, 32767);

  const pix = mapPointToQmpAbs({ x: 511.5, y: 383.5, coordinateMode: 'target_pixels', screenSize: { width: 1024, height: 768 } });
  assert.equal(pix.absX, 16384);
  assert.equal(pix.absY, 16384);

  // Double-click and right-click
  const dbl = buildQmpStepsForAction({ kind: 'double_click', x: 500, y: 500 }, { coordinateMode: 'normalized_1000' });
  const btnEvents = dbl.steps.filter((s) => s.op === 'qmp' && s.arguments?.events?.[0]?.type === 'btn');
  assert.equal(btnEvents.length, 4);
  assert.equal(btnEvents[0].arguments.events[0].data.button, 'left');
  assert.equal(btnEvents[0].arguments.events[0].data.down, true);
  assert.equal(btnEvents[1].arguments.events[0].data.down, false);

  const rclick = buildQmpStepsForAction({ kind: 'right_click', x: 250, y: 750, modifiers: ['Ctrl'] });
  const keyEvents = rclick.steps.filter((s) => s.op === 'qmp' && s.arguments?.events?.[0]?.type === 'key');
  assert.equal(keyEvents.length, 2);
  assert.equal(keyEvents[0].arguments.events[0].data.key.data, 'ctrl');
  assert.equal(keyEvents[0].arguments.events[0].data.down, true);
  assert.equal(keyEvents[1].arguments.events[0].data.down, false);
  const rBtn = rclick.steps.filter((s) => s.op === 'qmp' && s.arguments?.events?.[0]?.type === 'btn');
  assert.equal(rBtn[0].arguments.events[0].data.button, 'right');

  // Scroll down (deltaY > 0 -> wheel-down) and scroll up (deltaY < 0 -> wheel-up)
  const scrollDown = buildQmpStepsForAction({ kind: 'scroll', x: 500, y: 500, deltaY: 3 });
  const wheelDownBtns = scrollDown.steps.filter((s) => s.op === 'qmp' && s.arguments?.events?.[0]?.data?.button === 'wheel-down');
  assert.equal(wheelDownBtns.length, 6); // 3 ticks * (down + up)
  const scrollUp = buildQmpStepsForAction({ kind: 'scroll', deltaY: -240 });
  const wheelUpBtns = scrollUp.steps.filter((s) => s.op === 'qmp' && s.arguments?.events?.[0]?.data?.button === 'wheel-up');
  assert.equal(wheelUpBtns.length, 4); // 2 ticks * (down + up)

  // Drag generates abs move -> btn down -> interpolated abs moves -> btn up
  const drag = buildQmpStepsForAction({ kind: 'drag', startX: 100, startY: 200, endX: 800, endY: 600, durationMs: 200 });
  const dragAbs = drag.steps.filter((s) => s.op === 'qmp' && s.arguments?.events?.[0]?.type === 'abs');
  assert.ok(dragAbs.length >= 6);
  assert.equal(dragAbs[0].arguments.events[0].data.value, Math.round(0.1 * 32767));
  assert.equal(dragAbs[dragAbs.length - 1].arguments.events[0].data.value, Math.round(0.8 * 32767));

  // Keyboard chords including Ctrl+Alt+Delete and function keys
  assert.deepEqual(normalizeQmpKeyChord('Ctrl+Alt+Delete'), ['ctrl', 'alt', 'delete']);
  assert.deepEqual(normalizeQmpKeyChord(['Win', 'R']), ['meta_l', 'r']);
  assert.deepEqual(normalizeQmpKeyChord('F12'), ['f12']);
  assert.deepEqual(asciiCharToQmpKeys(':'), ['shift', 'semicolon']);
  assert.deepEqual(asciiCharToQmpKeys('@'), ['shift', '2']);
  assert.deepEqual(asciiCharToQmpKeys('_'), ['shift', 'minus']);
  assert.deepEqual(asciiCharToQmpKeys('/'), ['slash']);
  assert.deepEqual(asciiCharToQmpKeys('A'), ['shift', 'a']);

  const typed = buildQmpStepsForAction({ kind: 'type', text: 'Ab:/_.-=@', submit: true });
  const sendKeys = typed.steps.filter((s) => s.op === 'qmp' && s.execute === 'send-key');
  assert.equal(sendKeys.length, 10); // 9 chars + trailing ret
  assert.deepEqual(sendKeys[0].arguments.keys.map((k) => k.data), ['shift', 'a']);
  assert.deepEqual(sendKeys[2].arguments.keys.map((k) => k.data), ['shift', 'semicolon']);
  assert.deepEqual(sendKeys[8].arguments.keys.map((k) => k.data), ['shift', '2']);
  assert.deepEqual(sendKeys[9].arguments.keys.map((k) => k.data), ['ret']);
  assert.throws(() => buildQmpStepsForAction({ kind: 'type', text: '中文' }), /ASCII/i);
});

test('PVE QMP: persistent SSH worker reuses process, decodes gzipped PPM, and kills wedged workers on timeout', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { gzipSync } = await import('node:zlib');
  const quadPpm = buildSyntheticPpmP6({ width: 160, height: 120, quadrants: true });
  const quadGzB64 = gzipSync(quadPpm).toString('base64');

  const spawned = [];
  let wedgeNext = false;

  const pveDriver = createPveQmpDriver({
    hostPlatform: 'linux',
    workerIdleMs: 0,
    spawnProcess: (file, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const proc = new EventEmitter();
      proc.pid = 70_000 + spawned.length + 1;
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.stdin = stdin;
      proc.killed = false;
      proc.exitCode = null;
      proc.unref = () => {};
      proc.kill = () => {
        proc.killed = true;
        proc.exitCode = 1;
        proc.emit('exit', 1, 'SIGKILL');
      };
      spawned.push({ file, args, proc });

      let buf = '';
      let sawBootstrap = false;
      stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          if (!sawBootstrap && !line.trim().startsWith('{')) {
            sawBootstrap = true;
            continue;
          }
          if (wedgeNext) continue;
          const req = JSON.parse(line);
          if (req.op === 'status') {
            stdout.write(JSON.stringify({
              id: req.id,
              ok: true,
              result: { vmid: req.vmid, vmStatus: 'running', running: true, vmName: 'legacy-cad-xp', width: 160, height: 120 },
            }) + '\n');
          } else if (req.op === 'screendump') {
            stdout.write(JSON.stringify({
              id: req.id,
              ok: true,
              result: { encoding: 'ppm-gzip-base64', data: quadGzB64, rawBytes: quadPpm.length },
            }) + '\n');
          } else if (req.op === 'qmp_batch') {
            stdout.write(JSON.stringify({ id: req.id, ok: true, result: { executed: req.steps.length } }) + '\n');
          }
        }
      });
      return proc;
    },
  });

  const st = await pveDriver.probeStatus('pve:pve-lab-node:103', { probeResolution: true });
  assert.equal(st.running, true);
  assert.equal(st.vmName, 'legacy-cad-xp');
  assert.equal(spawned.length, 1);

  // Second call reuses the same SSH child process
  const cap = await pveDriver.captureScreen('pve:pve-lab-node:103');
  assert.equal(spawned.length, 1);
  assert.equal(cap.width, 160);
  assert.equal(cap.height, 120);
  assert.deepEqual([...cap.image.data.subarray(0, 4)], [220, 40, 50, 255]);

  // Simulate wedged SSH worker -> timeout tears it down and next RPC spawns a clean worker
  wedgeNext = true;
  await assert.rejects(
    pveDriver.probeStatus('pve:pve-lab-node:103', { timeoutMs: 500, forceRefresh: true }),
    /timed out/i,
  );
  assert.equal(spawned[0].proc.killed, true);

  wedgeNext = false;
  const recovered = await pveDriver.probeStatus('pve:pve-lab-node:103');
  assert.equal(spawned.length, 2);
  assert.equal(recovered.running, true);
  await pveDriver.dispose();
});

test('PVE QMP: end-to-end uu_launch, uu_sessions, uu_control, Human Takeover, Live Panel stream, and CUA Provider Bus', async (t) => {
  const dir = await makeTempDir(t, 'pve-e2e-');
  const stateDir = path.join(dir, 'state');
  const busDir = path.join(dir, 'bus');
  const { driver: winDriver, state: winState } = createMockDriverFixture();

  const quadPpm = buildSyntheticPpmP6({ width: 800, height: 600, quadrants: true });
  const quadImg = parsePpmP6(quadPpm);
  const sentQmpBatches = [];
  const disconnectedHosts = [];

  const mockPveDriver = {
    async probeStatus(target) {
      return {
        vmid: target.vmid,
        vmStatus: 'running',
        running: true,
        vmName: 'legacy-cad-xp',
        width: 800,
        height: 600,
      };
    },
    async captureScreen() {
      return {
        width: quadImg.width,
        height: quadImg.height,
        image: quadImg,
        stageBounds: { x: 0, y: 0, width: quadImg.width, height: quadImg.height },
      };
    },
    async sendQmpSteps(target, steps) {
      sentQmpBatches.push({ target: target.id || `pve:${target.sshHost}:${target.vmid}`, steps });
      return { executed: steps.length };
    },
    async disconnectHost(host) {
      disconnectedHosts.push(host);
    },
    async dispose() {},
  };

  const service = createUuRemoteService({
    systemDriver: winDriver,
    pveDriver: mockPveDriver,
    stateDir,
  });

  // 1. Register & connect PVE target via uu_launch(action="connect")
  const connected = await service.launchAction({
    action: 'connect',
    deviceId: 'pve:pve-lab-node:103',
  });
  assert.equal(connected.ok, true);
  assert.equal(connected.provider, 'pve-qmp');
  assert.equal(connected.sessionId, 'pve:pve-lab-node:103');
  assert.equal(connected.selectedSessionId, 'pve:pve-lab-node:103');
  assert.equal(connected.session.vmStatus, 'running');
  assert.equal(connected.session.label, 'legacy-cad-xp');

  // Verify persistence in pve-targets.json across fresh service instance
  const persisted = JSON.parse(await readFile(path.join(stateDir, 'pve-targets.json'), 'utf8'));
  assert.equal(persisted.targets.length, 1);
  assert.equal(persisted.targets[0].id, 'pve:pve-lab-node:103');

  const restartedService = createUuRemoteService({
    systemDriver: winDriver,
    pveDriver: mockPveDriver,
    stateDir,
  });

  // 2. uu_sessions(action="list") merges Win32 + PVE targets seamlessly
  const listed = await restartedService.manageSessions({ action: 'list', includeDevices: false });
  assert.equal(listed.selectedSessionId, 'pve:pve-lab-node:103');
  const pveSess = listed.sessions.find((s) => s.id === 'pve:pve-lab-node:103');
  assert.ok(pveSess);
  assert.equal(pveSess.provider, 'pve-qmp');
  assert.equal(pveSess.state, 'active');
  assert.deepEqual(pveSess.canvasBounds, { x: 0, y: 0, width: 800, height: 600 });
  assert.ok(listed.sessions.some((s) => s.id === 'uu:24780134'));

  // 3. uu_control screenshot + zoom crop routes to PVE QMP without touching Win32
  const zoomShot = await restartedService.controlSession({
    action: 'screenshot',
    coordinateMode: 'normalized_1000',
    zoom: { x: 500, y: 500, width: 500, height: 500 },
  });
  assert.equal(zoomShot.ok, true);
  assert.equal(zoomShot.provider, 'pve-qmp');
  assert.equal(zoomShot.sessionId, 'pve:pve-lab-node:103');
  assert.deepEqual(zoomShot.logicalSize, { width: 800, height: 600 });
  assert.deepEqual(zoomShot.cropBounds, { x: 400, y: 300, width: 400, height: 300 });
  const decodedZoom = decodePng(Buffer.from(zoomShot.imageBase64, 'base64'));
  assert.deepEqual([...decodedZoom.data.subarray(0, 4)], [245, 195, 35, 255]); // BR amber

  // 4. uu_control mouse/keyboard actions route to QMP and ignore local Windows cursor movement
  winState.cursor = { x: 9999, y: 9999 };
  const actRes = await restartedService.controlSession({
    actions: [
      { kind: 'move', x: 500, y: 500 },
      { kind: 'double_click', x: 250, y: 250 },
      { kind: 'key', key: 'Ctrl+Alt+Delete' },
      { kind: 'type', text: 'pdm:103', submit: true },
    ],
    observeAfter: false,
  });
  assert.equal(actRes.ok, true);
  assert.equal(actRes.provider, 'pve-qmp');
  assert.equal(actRes.transport, 'pve-qmp');
  assert.equal(actRes.executed, 4);
  assert.equal(sentQmpBatches.length, 1, 'Consecutive PVE QMP actions must coalesce into a single RPC batch');
  assert.equal(winState.sentBatches.length, 0, 'Win32 SendInput must not be called for PVE targets');

  // 5. Explicit Human Takeover lock blocks agent control on PVE target with 409
  await restartedService.manageSessions({
    action: 'takeover',
    sessionId: 'pve:pve-lab-node:103',
    active: true,
    reason: 'User operating KaMu PDM',
  });
  const blocked = await restartedService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'click',
    x: 500,
    y: 500,
    observeAfter: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, 'human_takeover_active');
  assert.equal(blocked.effect, 'refused');
  assert.equal(sentQmpBatches.length, 1);
  await restartedService.manageSessions({
    action: 'takeover',
    sessionId: 'pve:pve-lab-node:103',
    active: false,
  });

  // 6. Preview Panel binary stream works natively on PVE session
  const previewService = createUuPreviewService({ uuService: restartedService });
  t.after(() => previewService.dispose());
  const packets = [];
  let closeStream = null;
  const hs = await previewService.openPanelStream(
    'screen',
    { sessionId: 'pve:pve-lab-node:103', fps: 15, maxWidth: 640 },
    {
      bufferedAmount: () => 0,
      sendBinary(buf) { packets.push(buf); return true; },
      sendText() {},
      onClose(fn) { closeStream = fn; },
      onText() {},
    },
    {},
  );
  assert.equal(hs.sessionId, 'pve:pve-lab-node:103');
  const dl = Date.now() + 1500;
  while (packets.length === 0 && Date.now() < dl) {
    await new Promise((r) => setTimeout(r, 20));
  }
  closeStream?.();
  assert.ok(packets.length >= 1);
  assert.equal(packets[0][0], 0x55);
  assert.equal(packets[0][1], 0x52);

  // 7. CUA Provider Bus advertises & controls PVE target
  const bridge = createCuaProviderBridge({
    uuService: restartedService,
    heartbeatMs: 5000,
    ttlMs: 35000,
    env: { KIKI_CUA_BUS_DIR: busDir },
  });
  t.after(() => bridge.stop());
  await bridge.start({});
  const lease = JSON.parse(await readFile(path.join(busDir, 'kiki-uu-remote.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${lease.authToken}`, 'Content-Type': 'application/json' };
  const targetsRes = await (await fetch(`${lease.endpoint}/v1/targets`, { headers })).json();
  const cuaPve = targetsRes.targets.find((item) => item.id === 'pve:pve-lab-node:103');
  assert.ok(cuaPve);
  assert.equal(cuaPve.online, true);
  assert.equal(cuaPve.provider, 'pve-qmp');

  const cuaObs = await (
    await fetch(`${lease.endpoint}/v1/observe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targetId: 'pve:pve-lab-node:103' }),
    })
  ).json();
  assert.equal(cuaObs.ok, true);
  assert.equal(cuaObs.targetId, 'pve:pve-lab-node:103');

  // 8. Disconnect via pveHost + vmid removes target from pve-targets.json and closes host worker
  const disc = await restartedService.launchAction({
    action: 'disconnect',
    pveHost: 'pve-lab-node',
    vmid: 103,
  });
  assert.equal(disc.ok, true);
  assert.equal(disc.removed, true);
  assert.ok(disconnectedHosts.includes('pve-lab-node'));
  const afterDisc = JSON.parse(await readFile(path.join(stateDir, 'pve-targets.json'), 'utf8'));
  assert.equal(afterDisc.targets.length, 0);
});

// ============================================================================
// v0.3.0 Comprehensive Test Suite (RFB, XT Scancodes, ExtendedClipboard,
// Frame Math B2, Takeover Abort B4, QMP Dedupe/Fallback, Coalescing, Preview)
// ============================================================================

test('v0.3.0 XT scancode map: standard + extended 0xe0->0x80|xx keys, Shift symbols, and unicode_input_unsupported', () => {
  // Extended keys (QEMU keycodemapdb AT Set-1 -> 0x80 | xx)
  const expectedExtended = [
    ['Up', 0xc8, RFB_KEYSYMS.Up],
    ['Down', 0xd0, RFB_KEYSYMS.Down],
    ['Left', 0xcb, RFB_KEYSYMS.Left],
    ['Right', 0xcd, RFB_KEYSYMS.Right],
    ['Home', 0xc7, RFB_KEYSYMS.Home],
    ['End', 0xcf, RFB_KEYSYMS.End],
    ['PageUp', 0xc9, RFB_KEYSYMS.PageUp],
    ['PageDown', 0xd1, RFB_KEYSYMS.PageDown],
    ['Insert', 0xd2, RFB_KEYSYMS.Insert],
    ['Delete', 0xd3, RFB_KEYSYMS.Delete],
    ['RightCtrl', null, null], // check rctrl alias below
    ['rctrl', 0x9d, RFB_KEYSYMS.ControlRight],
    ['ralt', 0xb8, RFB_KEYSYMS.AltRight],
    ['Win', 0xdb, RFB_KEYSYMS.SuperLeft],
    ['rwin', 0xdc, RFB_KEYSYMS.SuperRight],
    ['Menu', 0xdd, RFB_KEYSYMS.Menu],
    ['Compose', 0xdd, RFB_KEYSYMS.Menu],
  ];
  for (const [name, code, sym] of expectedExtended) {
    if (code === null) continue;
    const [entry] = resolveRfbKeyToken(name);
    assert.equal(entry.xtScancode, code, `Expected ${name} xtScancode=0x${code.toString(16)}`);
    assert.equal(entry.keysym, sym, `Expected ${name} keysym=0x${sym.toString(16)}`);
  }

  // Standard F1-F12 & chord normalization
  assert.equal(resolveRfbKeyToken('F1')[0].xtScancode, 0x3b);
  assert.equal(resolveRfbKeyToken('F10')[0].xtScancode, 0x44);
  assert.equal(resolveRfbKeyToken('F11')[0].xtScancode, 0x57);
  assert.equal(resolveRfbKeyToken('F12')[0].xtScancode, 0x58);
  const cad = normalizeRfbKeyChord('Ctrl+Alt+Delete');
  assert.deepEqual(cad.map((k) => k.xtScancode), [0x1d, 0x38, 0xd3]);
  assert.ok(ALL_MODIFIER_RFB_KEYS.length >= 8);

  // All US Shift symbols must map to exact base physical AT Set-1 scancodes with shift=true
  const shiftSymbols = [
    ['!', 0x02], ['@', 0x03], ['#', 0x04], ['$', 0x05], ['%', 0x06],
    ['^', 0x07], ['&', 0x08], ['*', 0x09], ['(', 0x0a], [')', 0x0b],
    ['_', 0x0c], ['+', 0x0d], ['{', 0x1a], ['}', 0x1b], ['|', 0x2b],
    [':', 0x27], ['"', 0x28], ['<', 0x33], ['>', 0x34], ['?', 0x35], ['~', 0x29],
  ];
  for (const [ch, scancode] of shiftSymbols) {
    const k = asciiCharToRfbKey(ch);
    assert.equal(k.shift, true, `Expected shift=true for "${ch}"`);
    assert.equal(k.xtScancode, scancode, `Expected base scancode 0x${scancode.toString(16)} for "${ch}"`);
    assert.equal(k.keysym, ch.charCodeAt(0));
  }

  assert.equal(asciiCharToRfbKey('a').shift, false);
  assert.equal(asciiCharToRfbKey('A').shift, true);
  assert.equal(asciiCharToRfbKey('A').xtScancode, 0x1e);
  assert.equal(asciiCharToRfbKey('\n').xtScancode, 0x1c);
  assert.equal(asciiCharToRfbKey('\t').xtScancode, 0x0f);
  assert.equal(asciiCharToRfbKey(' ').xtScancode, 0x39);

  // Non-ASCII throws structured unicode_input_unsupported (never silent drop or '?')
  assert.throws(
    () => asciiCharToRfbKey('中'),
    (err) => err && err.code === 'unicode_input_unsupported',
  );
});

test('v0.3.0 Frame Audit B2: unified image_pixels /(w-1) precision, zoomRelative, grid overlay, and sampled diff', () => {
  // 1. image_pixels with cropBounds present -> exact 4-corner hit
  const obsWithCrop = {
    imageSize: { width: 201, height: 101 },
    cropBounds: { x: 100, y: 200, width: 401, height: 201 },
  };
  const screen = { width: 1024, height: 768 };
  const stageBounds = { x: 0, y: 0, width: 1024, height: 768 };
  for (const [ix, iy, ex, ey] of [
    [0, 0, 100, 200],
    [200, 0, 500, 200],
    [0, 100, 100, 400],
    [200, 100, 500, 400],
  ]) {
    const pt = mapPointToTarget({
      x: ix,
      y: iy,
      coordinateMode: 'image_pixels',
      stageBounds,
      contentRect: stageBounds,
      lastObservation: obsWithCrop,
    });
    const qmpPt = mapPointToQmpAbs({
      x: ix,
      y: iy,
      coordinateMode: 'image_pixels',
      screenSize: screen,
      lastObservation: obsWithCrop,
    });
    assert.equal(pt.x, ex);
    assert.equal(pt.y, ey);
    assert.equal(qmpPt.x, ex);
    assert.equal(qmpPt.y, ey);
    assert.equal(qmpPt.absX, Math.round((ex / 1023) * 32767));
    assert.equal(qmpPt.absY, Math.round((ey / 767) * 32767));
  }

  // 2. image_pixels without cropBounds -> exact 4-corner hit on full target
  const obsNoCrop = { imageSize: { width: 512, height: 384 }, cropBounds: null };
  const brTarget = mapPointToTarget({
    x: 511,
    y: 383,
    coordinateMode: 'image_pixels',
    stageBounds,
    contentRect: stageBounds,
    lastObservation: obsNoCrop,
  });
  const brQmp = mapPointToQmpAbs({
    x: 511,
    y: 383,
    coordinateMode: 'image_pixels',
    screenSize: screen,
    lastObservation: obsNoCrop,
  });
  assert.deepEqual([brTarget.x, brTarget.y], [1023, 767]);
  assert.deepEqual([brQmp.x, brQmp.y, brQmp.absX, brQmp.absY], [1023, 767, 32767, 32767]);

  // 3. width=1, height=1 degenerate guard (no NaN, no division by zero)
  const degen = mapPointToTarget({
    x: 500,
    y: 500,
    coordinateMode: 'image_pixels',
    stageBounds: { x: 0, y: 0, width: 1, height: 1 },
    contentRect: { x: 0, y: 0, width: 1, height: 1 },
    lastObservation: { imageSize: { width: 1, height: 1 }, cropBounds: null },
  });
  assert.deepEqual([degen.x, degen.y, degen.normX, degen.normY], [0, 0, 0, 0]);

  // 4. zoomRelative=true maps normalized_1000 inside cropBounds and throws when no zoom exists
  const zrCenter = mapPointToTarget({
    x: 500,
    y: 500,
    coordinateMode: 'normalized_1000',
    zoomRelative: true,
    stageBounds,
    contentRect: stageBounds,
    lastObservation: obsWithCrop,
  });
  assert.equal(zrCenter.x, 300);
  assert.equal(zrCenter.y, 300);
  assert.throws(
    () => mapPointToTarget({
      x: 500,
      y: 500,
      coordinateMode: 'normalized_1000',
      zoomRelative: true,
      stageBounds,
      contentRect: stageBounds,
      lastObservation: obsNoCrop,
    }),
    /zoomRelative=true requires a prior zoomed/i,
  );

  // 5. applyGridOverlay is strictly opt-in and non-mutating
  const plainPng = buildSyntheticStagePng({ width: 200, height: 120, fill: [240, 240, 240] });
  const plainRgba = decodePng(plainPng);
  const snapshotBefore = Buffer.from(plainRgba.data);
  const gridded = applyGridOverlay(plainRgba);
  assert.deepEqual(Buffer.from(plainRgba.data), snapshotBefore, 'applyGridOverlay must not mutate source RGBA');
  const diffGrid = computeSampledFrameDiff(plainRgba, gridded);
  assert.equal(diffGrid.changed, true);
  assert.ok(diffGrid.changeRatio > 0 && diffGrid.changeRatio < 0.5);

  // Identical diff returns changed=false; dimension mismatch returns changeRatio=1
  const sameDiff = computeSampledFrameDiff(plainRgba, plainRgba);
  assert.equal(sameDiff.changed, false);
  assert.equal(sameDiff.changeRatio, 0);
  const resizedRgba = { width: 100, height: 60, data: new Uint8Array(100 * 60 * 4) };
  const dimDiff = computeSampledFrameDiff(plainRgba, resizedRgba);
  assert.equal(dimDiff.changed, true);
  assert.equal(dimDiff.changeRatio, 1);

  assert.equal(hashPngOrSample(plainPng).length, 64);
  assert.equal(hashPngOrSample(plainRgba).length, 64);
});

test('v0.3.0 Real RFB 3.8 full-chain protocol test with vendored rfb2.createServer: auth, capture, input, settle, resize invalidation, ExtendedClipboard 2 MiB, and unicode_input_unsupported', async (t) => {
  const { deflateSync } = await import('node:zlib');
  const dir = await makeTempDir(t, 'rfb-real-');
  const stateDir = path.join(dir, 'state');

  const serverEvents = {
    pointers: [],
    keys: [],
    encodings: [],
    rawMessages: [],
    connections: 0,
  };
  let activeConn = null;
  let advertiseExtendedClipboard = false;
  let serverWidth = 160;
  let serverHeight = 120;
  let frameColor = [30, 120, 210]; // RGB

  const makeSolidBgrx = (w, h, [r, g, b]) => {
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      buf[i * 4] = b;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = r;
      buf[i * 4 + 3] = 0;
    }
    return buf;
  };

  const openSockets = new Set();
  const rfbServer = createRfbServer(
    {
      width: serverWidth,
      height: serverHeight,
      name: 'Kiki Test RFB Desktop',
      password: 'Pass1234',
      pixelFormat: RFB_PIXEL_FORMATS.bgrx,
    },
    (conn) => {
      serverEvents.connections += 1;
      activeConn = conn;
      conn.on('setEncodings', (encs) => {
        serverEvents.encodings = encs;
      });
      conn.on('updateRequest', (req) => {
        if (!req.incremental) {
          conn.sendUpdate([
            {
              type: 'pixels',
              x: 0,
              y: 0,
              width: serverWidth,
              height: serverHeight,
              data: makeSolidBgrx(serverWidth, serverHeight, frameColor),
            },
          ]);
        }
      });
      conn.on('pointer', (p) => {
        serverEvents.pointers.push(p);
        // Simulate UI repaint on button up
        if (p.buttons === 0 && serverEvents.pointers.length > 1) {
          frameColor = [220, 80, 40];
          setTimeout(() => {
            conn.sendUpdate([
              {
                type: 'pixels',
                x: 10,
                y: 10,
                width: 20,
                height: 20,
                data: makeSolidBgrx(20, 20, frameColor),
              },
            ]);
          }, 25);
        }
      });
      conn.on('key', (k) => {
        serverEvents.keys.push(k);
      });
      conn.on('error', () => {});
    },
  );
  rfbServer.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  await new Promise((resolve) => rfbServer.listen(0, '127.0.0.1', resolve));
  const port = rfbServer.address().port;
  t.after(() => new Promise((resolve) => {
    for (const s of openSockets) s.destroy();
    rfbServer.close(() => resolve());
  }));

  // Verify LOSSLESS_RFB_ENCODINGS never offers jpegQuality pseudo-encoding and maxClipboardBytes is 2 MiB
  assert.equal(MAX_RFB_CLIPBOARD_BYTES, 2 * 1024 * 1024);
  assert.ok(!LOSSLESS_RFB_ENCODINGS.some((e) => e >= -32 && e <= -23), 'Lossless encodings must NOT include jpegQuality');

  const { driver: winDriver } = createMockDriverFixture();
  const rfbDriver = createRfbDriver({ heartbeatIntervalMs: 0 });
  const service = createUuRemoteService({
    systemDriver: winDriver,
    rfbDriver,
    stateDir,
  });
  t.after(() => service.dispose());

  // 1. Connect via uu_launch with in-memory vncPassword
  const connRes = await service.launchAction({
    action: 'connect',
    vncHost: '127.0.0.1',
    vncPort: port,
    vncPassword: 'Pass1234',
    label: 'Lab VNC Box',
  });
  assert.equal(connRes.ok, true);
  assert.equal(connRes.provider, 'rfb');
  assert.equal(connRes.transport, 'rfb');
  assert.equal(connRes.sessionId, `vnc:127.0.0.1:${port}`);

  // Verify password is NEVER persisted to disk or present in outputs
  const vncFileRaw = await readFile(path.join(stateDir, 'vnc-targets.json'), 'utf8');
  const runtimeFileRaw = await readFile(path.join(stateDir, 'runtime-state.json'), 'utf8');
  assert.equal(vncFileRaw.includes('Pass1234'), false, 'vnc-targets.json must NEVER contain password');
  assert.equal(runtimeFileRaw.includes('Pass1234'), false, 'runtime-state.json must NEVER contain password');
  const statusOut = JSON.stringify(await service.getStatus({ includeCliStatus: false }));
  const sessOut = JSON.stringify(await service.manageSessions({ action: 'list', includeDevices: false }));
  assert.equal(statusOut.includes('Pass1234'), false);
  assert.equal(sessOut.includes('Pass1234'), false);

  // 2. Capture screenshot over RFB & verify exact pixel color + screenshotId + opt-in grid overlay
  const shot1 = await service.controlSession({
    sessionId: connRes.sessionId,
    action: 'screenshot',
  });
  assert.equal(shot1.ok, true);
  assert.equal(shot1.transport, 'rfb');
  assert.ok(shot1.screenshotId);
  assert.ok(shot1.frameHash);
  assert.equal(shot1.overlay, 'none');
  const decoded1 = decodePng(Buffer.from(shot1.imageBase64, 'base64'));
  assert.equal(decoded1.width, 160);
  assert.equal(decoded1.height, 120);
  assert.deepEqual([...decoded1.data.subarray(0, 4)], [30, 120, 210, 255]);

  // dedupeUnchanged=true suppresses identical frames (relative to shot1) up to maxStreak=2, then forces fresh image on 3rd
  const d1 = await service.controlSession({ sessionId: connRes.sessionId, action: 'screenshot', dedupeUnchanged: true });
  assert.equal(d1.deduped, true);
  assert.equal(d1.unchangedStreak, 1);
  assert.equal(d1.imageBase64, undefined);
  const d2 = await service.controlSession({ sessionId: connRes.sessionId, action: 'screenshot', dedupeUnchanged: true });
  assert.equal(d2.deduped, true);
  assert.equal(d2.unchangedStreak, 2);
  assert.equal(d2.imageBase64, undefined);
  const d3 = await service.controlSession({ sessionId: connRes.sessionId, action: 'screenshot', dedupeUnchanged: true });
  assert.equal(d3.deduped, undefined, '3rd consecutive unchanged must force fresh image');
  assert.ok(d3.imageBase64);

  // 3. Click + dirty-rect settle wait + honest ActionResult
  const clickRes = await service.controlSession({
    sessionId: connRes.sessionId,
    action: 'click',
    x: 500,
    y: 500,
    screenshotId: shot1.screenshotId,
    settleMs: 500,
  });
  assert.equal(clickRes.ok, true);
  assert.equal(clickRes.transport, 'rfb');
  assert.equal(clickRes.settleMode, 'rfb_dirty_rect');
  assert.equal(clickRes.effect, 'unverifiable');
  assert.equal(clickRes.diff.changed, true);
  assert.ok(serverEvents.pointers.length >= 2);

  // 4. Without ExtendedClipboard, Chinese text returns structured unicode_input_unsupported (never '?' or silent drop)
  const cnFail = await service.controlSession({
    sessionId: connRes.sessionId,
    action: 'type',
    text: '你好世界',
    observeAfter: false,
  });
  assert.equal(cnFail.ok, false);
  assert.equal(cnFail.code, 'unicode_input_unsupported');
  assert.deepEqual(cnFail.capabilities, { unicodeClipboard: false, guestAgent: false, clipboard: false });

  // 5. Desktop resize invalidates prior screenshotId -> fail-closed capture_geometry_mismatch
  const preResizeShot = await service.controlSession({
    sessionId: connRes.sessionId,
    action: 'screenshot',
  });
  serverWidth = 200;
  serverHeight = 150;
  activeConn.sendUpdate([{ type: 'desktopSize', width: 200, height: 150 }]);
  await new Promise((r) => setTimeout(r, 40));

  const staleAttempt = await service.controlSession({
    sessionId: connRes.sessionId,
    action: 'click',
    x: 500,
    y: 500,
    screenshotId: preResizeShot.screenshotId,
    observeAfter: false,
  });
  assert.equal(staleAttempt.ok, false);
  assert.equal(staleAttempt.status, 409);
  assert.equal(staleAttempt.code, 'capture_geometry_mismatch');
  assert.equal(staleAttempt.effect, 'refused');

  // 6. Simulate 15-min idle disconnect -> transparent reconnect on next captureRgba
  const beforeConns = serverEvents.connections;
  activeConn.destroy();
  await new Promise((r) => setTimeout(r, 40));
  const afterReconnectShot = await service.controlSession({
    sessionId: connRes.sessionId,
    action: 'screenshot',
  });
  assert.equal(afterReconnectShot.ok, true);
  assert.equal(serverEvents.connections, beforeConns + 1, 'Idle disconnect must transparently reconnect');

  // 7. Dedicated RFB 3.8 ExtendedClipboard wire test: verifies 2 MiB maxClipboardBytes CAPS,
  //    server->client UTF-8 Chinese PROVIDE, and client->server UTF-8 Chinese PROVIDE
  const netMod = await import('node:net');
  const { inflateSync } = await import('node:zlib');
  let clientAdvertisedMaxClip = null;
  let clientProvidedUtf8 = null;
  const extSockets = new Set();
  const extServer = netMod.createServer((sock) => {
    extSockets.add(sock);
    sock.once('close', () => extSockets.delete(sock));
    sock.setNoDelay(true);
    let rx = Buffer.alloc(0);
    let stage = 'version';

    sock.write(Buffer.from('RFB 003.008\n', 'latin1'));
    sock.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length > 0) {
        if (stage === 'version') {
          if (rx.length < 12) return;
          rx = rx.subarray(12);
          sock.write(Buffer.from([1, 1])); // 1 security type: None (1)
          stage = 'sec';
        } else if (stage === 'sec') {
          if (rx.length < 1) return;
          rx = rx.subarray(1);
          sock.write(Buffer.alloc(4)); // SecurityResult OK
          stage = 'init';
        } else if (stage === 'init') {
          if (rx.length < 1) return;
          rx = rx.subarray(1);
          // ServerInit (width=32, height=24, bgrx, name="ExtClip")
          const init = Buffer.alloc(24 + 7);
          init.writeUInt16BE(32, 0);
          init.writeUInt16BE(24, 2);
          init[4] = 32; init[5] = 24; init[6] = 0; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
          init[14] = 16; init[15] = 8; init[16] = 0;
          init.writeUInt32BE(7, 20);
          init.write('ExtClip', 24, 'utf8');
          sock.write(init);
          // Send ServerCutText ExtendedClipboard CAPS (2 MiB limit)
          const capsBody = Buffer.alloc(8);
          capsBody.writeUInt32BE(((1 << 24) | (1 << 25) | (1 << 27) | (1 << 28) | 1) >>> 0, 0);
          capsBody.writeUInt32BE(2 * 1024 * 1024, 4);
          const capsMsg = Buffer.alloc(8 + capsBody.length);
          capsMsg[0] = 3;
          capsMsg.writeInt32BE(-capsBody.length, 4);
          capsBody.copy(capsMsg, 8);
          sock.write(capsMsg);
          // Send initial pixel rect (32x24)
          const fbHdr = Buffer.alloc(4 + 12);
          fbHdr[0] = 0;
          fbHdr.writeUInt16BE(1, 2);
          fbHdr.writeUInt16BE(32, 8);
          fbHdr.writeUInt16BE(24, 10);
          sock.write(Buffer.concat([fbHdr, Buffer.alloc(32 * 24 * 4)]));
          // Send server->client UTF-8 Chinese clipboard PROVIDE
          const utf8Clip = Buffer.from('测试中文剪贴板\0', 'utf8');
          const sizeHdr = Buffer.alloc(4);
          sizeHdr.writeUInt32BE(utf8Clip.length, 0);
          const comp = deflateSync(Buffer.concat([sizeHdr, utf8Clip]));
          const pFlags = Buffer.alloc(4);
          pFlags.writeUInt32BE(((1 << 28) | 1) >>> 0, 0);
          const extBody = Buffer.concat([pFlags, comp]);
          const cutPkt = Buffer.alloc(8 + extBody.length);
          cutPkt[0] = 3;
          cutPkt.writeInt32BE(-extBody.length, 4);
          extBody.copy(cutPkt, 8);
          sock.write(cutPkt);
          stage = 'loop';
        } else {
          const msgType = rx[0];
          if (msgType === 0) {
            if (rx.length < 20) return;
            rx = rx.subarray(20);
          } else if (msgType === 2) {
            if (rx.length < 4) return;
            const n = rx.readUInt16BE(2);
            if (rx.length < 4 + n * 4) return;
            rx = rx.subarray(4 + n * 4);
          } else if (msgType === 3) {
            if (rx.length < 10) return;
            rx = rx.subarray(10);
          } else if (msgType === 6) {
            if (rx.length < 8) return;
            const len = rx.readInt32BE(4);
            const size = len < 0 ? -len : len;
            if (rx.length < 8 + size) return;
            const body = rx.subarray(8, 8 + size);
            rx = rx.subarray(8 + size);
            if (len < 0 && body.length >= 4) {
              const fl = body.readUInt32BE(0);
              if (fl & (1 << 24) && body.length >= 8) {
                clientAdvertisedMaxClip = body.readUInt32BE(4);
              } else if (fl & (1 << 28)) {
                const inf = inflateSync(body.subarray(4));
                const sz = inf.readUInt32BE(0);
                const val = inf.subarray(4, 4 + sz);
                const nul = val.indexOf(0);
                clientProvidedUtf8 = val.toString('utf8', 0, nul < 0 ? val.length : nul);
              }
            }
          } else {
            return;
          }
        }
      }
    });
  });
  await new Promise((resolve) => extServer.listen(0, '127.0.0.1', resolve));
  const extPort = extServer.address().port;
  t.after(() => new Promise((resolve) => {
    for (const s of extSockets) s.destroy();
    extServer.close(() => resolve());
  }));

  const extId = `vnc:127.0.0.1:${extPort}`;
  await rfbDriver.ensureConnected(extId);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(clientAdvertisedMaxClip, 2 * 1024 * 1024, 'B5: client must advertise 2 MiB maxClipboardBytes');

  const clipRead = await service.controlSession({
    sessionId: extId,
    action: 'clipboard_get',
    observeAfter: false,
  });
  assert.equal(clipRead.ok, true);
  assert.equal(clipRead.effect, 'confirmed');
  assert.equal(clipRead.results[0].text, '测试中文剪贴板');

  const clipWrite = await service.controlSession({
    sessionId: extId,
    action: 'clipboard_set',
    text: '写入UTF-8剪贴板',
    observeAfter: false,
  });
  assert.equal(clipWrite.ok, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(clientProvidedUtf8, '写入UTF-8剪贴板');

  // Oversized > 2 MiB clipboard rejected cleanly
  await assert.rejects(
    rfbDriver.clipboardSet(extId, 'A'.repeat(2 * 1024 * 1024 + 10)),
    /2 MiB/i,
  );

  // 8. Restart without in-memory password gives actionable reconnect error (OQ2)
  const restartedRfb = createRfbDriver({ heartbeatIntervalMs: 0 });
  const restartedSvc = createUuRemoteService({
    systemDriver: winDriver,
    rfbDriver: restartedRfb,
    stateDir,
  });
  t.after(() => restartedSvc.dispose());
  await assert.rejects(
    restartedSvc.controlSession({ sessionId: connRes.sessionId, action: 'screenshot' }),
    (err) => err.code === 'vnc_auth_required' && /uu_launch.*vncPassword/i.test(err.message) && !err.message.includes('Pass1234'),
  );
});

test('v0.3.0 Frame Audit A3 & OSWorld non-idempotent guard: PVE SSH launcher, RFB magic gate, and zero mid-flight replay', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');

  // 1. Verify A3 launcher command: zero double quotes, uses secrets.token_hex(4) + stderr KIKI_PVE_TICKET + execvp qm vncproxy (zero stdin read)
  const pveArgs = buildPveVncProxyArgs('pve-lab-node', 103);
  assert.ok(pveArgs.includes('-T') && pveArgs.includes('none') && pveArgs.includes('BatchMode=yes'));
  const remoteCmd = pveArgs[pveArgs.length - 1];
  assert.equal(remoteCmd.includes('"'), false, 'Remote SSH cmd must contain zero double quotes for Windows OpenSSH parity');
  const b64Part = remoteCmd.trim().split(/\s+/).pop();
  const decodedPy = Buffer.from(b64Part, 'base64').toString('utf8');
  assert.match(decodedPy, /secrets\.token_hex\(4\)/);
  assert.match(decodedPy, /KIKI_PVE_TICKET:/);
  assert.match(decodedPy, /os\.environ\["LC_PVE_TICKET"\]=t/);
  assert.match(decodedPy, /os\.execvp\("qm",\["qm","vncproxy","103"\]\)/);
  assert.equal(decodedPy.includes('stdin'), false, 'A3: launcher must NEVER read stdin');

  // 2. First-12-bytes RFB magic gate fails fast on garbage stdout and redacts ticket from stderr
  const badDriver = createRfbDriver({
    hostPlatform: 'linux',
    connectTimeoutMs: 1500,
    spawnProcess: () => {
      const proc = new EventEmitter();
      proc.pid = 81001;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new PassThrough();
      proc.killed = false;
      proc.unref = () => {};
      proc.kill = () => { proc.killed = true; };
      setTimeout(() => {
        proc.stderr.write('KIKI_PVE_TICKET:deadbeef\nPerl warning: polluted\n');
        proc.stdout.write('NOT_RFB_GARBAGE_BYTES');
      }, 10);
      return proc;
    },
  });
  await assert.rejects(
    badDriver.ensureConnected('pve:pve-lab-node:103'),
    (err) => /RFB handshake gate failed/i.test(err.message) && !err.message.includes('deadbeef'),
  );
  await badDriver.dispose();

  // 3. Non-idempotent guard: mid-flight disconnect AFTER sending first pointer event NEVER reconnects or replays!
  let connectCount = 0;
  let pointerSentCount = 0;
  const fakeRfbDriver = createRfbDriver({
    heartbeatIntervalMs: 0,
    initialFrameTimeoutMs: 50,
    connectFn: async () => {
      connectCount += 1;
      const client = new EventEmitter();
      client.width = 640;
      client.height = 480;
      client.connected = true;
      client.pixelFormat = RFB_PIXEL_FORMATS.bgrx;
      client.colorMap = [];
      client.supports = { qemuExtendedKeyEvent: true, unicodeClipboard: false, continuousUpdates: false };
      client.requestUpdate = () => {};
      client.destroy = () => { client.connected = false; };
      client.pointerEvent = () => {
        pointerSentCount += 1;
        // Drop connection right after first pointer write
        client.connected = false;
        client.emit('close', true);
      };
      client.keyEvent = () => {};
      client.qemuKeyEvent = () => {};
      setTimeout(() => client.emit('update', { rects: [] }), 5);
      return client;
    },
  });

  await assert.rejects(
    fakeRfbDriver.executeActions('vnc:10.0.0.2:5900', [
      { kind: 'click', x: 500, y: 500 },
      { kind: 'click', x: 200, y: 200 },
    ]),
    (err) => err.code === 'non_idempotent_transport_failure' && err.replaySuppressed === true,
  );
  assert.equal(connectCount, 1, 'Must NOT reconnect after mid-flight non-idempotent failure');
  assert.equal(pointerSentCount, 1, 'Must NOT replay pointer input');
  await fakeRfbDriver.dispose();
});

test('v0.3.0 Frame Audit B4: Human Takeover AbortController aborts in-flight batch + calls releaseAllInputs + aggregates lastHumanSummary', async (t) => {
  const dir = await makeTempDir(t, 'takeover-abort-');
  const { driver: winDriver, state: winState } = createMockDriverFixture();
  let releaseAllCalled = 0;
  winDriver.releaseAllInputs = async () => {
    releaseAllCalled += 1;
    return { ok: true, released: true };
  };

  const service = createUuRemoteService({ systemDriver: winDriver, stateDir: dir });
  t.after(() => service.dispose());

  // Launch an in-flight batch with a 2000ms wait followed by a click
  const batchPromise = service.controlSession({
    sessionId: 'uu:24780134',
    actions: [
      { kind: 'wait', durationMs: 2000 },
      { kind: 'click', x: 500, y: 500 },
    ],
    observeAfter: false,
  });

  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  await service.setTakeover({ sessionId: 'uu:24780134', active: true, reason: 'Human grabbed panel' });
  const batchResult = await batchPromise;
  const elapsed = Date.now() - t0;

  assert.equal(batchResult.ok, false);
  assert.equal(batchResult.status, 409);
  assert.equal(batchResult.code, 'human_takeover_active');
  assert.equal(batchResult.effect, 'refused');
  assert.ok(elapsed < 500, `Expected immediate abort (<500ms), took ${elapsed}ms`);
  assert.equal(winState.sentBatches.length, 0, 'Click after wait must never execute once takeover aborts batch');
  assert.equal(releaseAllCalled, 1, 'releaseAllInputs must be invoked on takeover');

  // Record human panel interactions and verify debounced aggregation on uu_sessions + takeover release
  const previewService = createUuPreviewService({ uuService: service });
  t.after(() => previewService.dispose());
  await previewService.performAction({ action: 'input', sessionId: 'uu:24780134', subAction: 'click', x: 100, y: 100, fromHumanPanel: true });
  await previewService.performAction({ action: 'input', sessionId: 'uu:24780134', subAction: 'click', x: 104, y: 102, fromHumanPanel: true });
  await previewService.performAction({ action: 'input', sessionId: 'uu:24780134', subAction: 'type', text: 'abc', fromHumanPanel: true });
  await previewService.performAction({ action: 'input', sessionId: 'uu:24780134', subAction: 'type', text: 'def', submit: true, fromHumanPanel: true });
  await previewService.performAction({ action: 'input', sessionId: 'uu:24780134', subAction: 'scroll', deltaY: 120, fromHumanPanel: true });
  await previewService.performAction({ action: 'input', sessionId: 'uu:24780134', subAction: 'scroll', deltaY: 120, fromHumanPanel: true });

  const listed = await service.manageSessions({ action: 'list', includeDevices: false });
  const sess = listed.sessions.find((s) => s.id === 'uu:24780134');
  assert.equal(sess.lastHumanSummary.length, 3, 'Clicks, typing, and scrolls should debounce into 3 summary entries');
  assert.match(sess.lastHumanSummary[0].summary, /x2/);
  assert.match(sess.lastHumanSummary[1].summary, /6 chars \+ Enter/);
  assert.match(sess.lastHumanSummary[2].summary, /240/);

  const released = await service.setTakeover({ sessionId: 'uu:24780134', active: false });
  assert.equal(released.takeoverActive, false);
  assert.equal(released.lastHumanSummary.length, 3);
});

test('v0.3.0 Win32 & PVE QMP coalescing fixed-literal golden equivalence + smart auto type mode + F4 Ctrl++', async (t) => {
  // F4 regression: QMP chord parser must match RFB parser on trailing '++'
  assert.deepEqual(normalizeQmpKeyChord('Ctrl++'), ['ctrl', 'shift', 'equal']);
  assert.deepEqual(normalizeRfbKeyChord('Ctrl++').map((k) => k.name), ['ctrl', 'shift', 'plus']);

  const dir = await makeTempDir(t, 'coalesce-golden-');
  const { driver: winDriver, state: winState } = createMockDriverFixture();
  const service = createUuRemoteService({ systemDriver: winDriver, stateDir: dir });
  t.after(() => service.dispose());

  // Establish contentRect geometry first: stageBounds={x:3826,y:-633,w:640,h:400}, contentRect={x:0,y:20,w:640,h:360}
  await service.controlSession({ sessionId: 'uu:24780134', action: 'screenshot' });

  const actions = [
    { kind: 'move', x: 200, y: 200 },
    { kind: 'click', x: 300, y: 400, button: 'left', count: 1, modifiers: ['Shift'] },
    { kind: 'key', keys: ['Ctrl', 'a'] },
    { kind: 'type', text: 'short', mode: 'auto' },
    { kind: 'type', text: '这是一段超过八个字符的中文自动剪贴板文本', mode: 'auto', submit: true },
    { kind: 'wait', durationMs: 10 },
    { kind: 'focus' },
    { kind: 'type', text: 'line1\nline2', mode: 'auto' },
  ];

  // Fixed pre-v0.3.0 literal golden step sequence (non-circular per Frame Audit D2.4)
  const expectedBatch0Steps = [
    // move(200, 200): target=(128, 72) -> screen=(3826+128, -633+20+72) = (3954, -541)
    { op: 'mouse_move', x: 3954, y: -541 },
    // click(300, 400, Shift): target=(192, 144) -> screen=(3826+192, -633+20+144) = (4018, -469)
    { op: 'mouse_move', x: 4018, y: -469 },
    { op: 'sleep', ms: 12 },
    { op: 'vk_down', vk: 0x10 },
    { op: 'mouse_down', button: 'left' },
    { op: 'sleep', ms: 24 },
    { op: 'mouse_up', button: 'left' },
    { op: 'vk_up', vk: 0x10 },
    // key(Ctrl+a)
    { op: 'vk_down', vk: 0x11 },
    { op: 'sleep', ms: 14 },
    { op: 'vk_down', vk: 0x41 },
    { op: 'sleep', ms: 14 },
    { op: 'vk_up', vk: 0x41 },
    { op: 'sleep', ms: 10 },
    { op: 'vk_up', vk: 0x11 },
    // type('short', auto) -> unicode_text
    { op: 'unicode_text', text: 'short' },
    // type(long non-ASCII, auto, submit=true) -> clipboard_paste + Enter
    { op: 'clipboard_paste', text: '这是一段超过八个字符的中文自动剪贴板文本' },
    { op: 'sleep', ms: 20 },
    { op: 'vk_down', vk: 0x0d },
    { op: 'sleep', ms: 20 },
    { op: 'vk_up', vk: 0x0d },
  ];
  const expectedBatch1Steps = [
    // type('line1\nline2', auto) -> clipboard_paste
    { op: 'clipboard_paste', text: 'line1\nline2' },
  ];

  const res = await service.controlSession({
    sessionId: 'uu:24780134',
    actions,
    observeAfter: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.executed, 8);
  assert.equal(winState.sentBatches.length, 2, '5 pre-wait actions coalesce to 1 RPC, post-focus to 1 RPC');
  assert.equal(winState.windowActions.length, 1, 'focus action must flush boundary and invoke performWindowAction');
  assert.deepEqual(winState.sentBatches[0].steps, expectedBatch0Steps, 'Coalesced Win32 steps must match fixed literal pre-v0.3.0 golden steps');
  assert.deepEqual(winState.sentBatches[1].steps, expectedBatch1Steps);

  // Also verify single-action execution produces the exact same literal steps for click+modifier
  const singleSteps = compileWin32StepsForAction(actions[1], {
    coordinateMode: 'normalized_1000',
    stageBounds: winState.sessions[0].canvasBounds,
    contentRect: { x: 0, y: 20, width: 640, height: 360 },
  }).steps;
  assert.deepEqual(singleSteps, expectedBatch0Steps.slice(1, 8));
});

test('v0.3.0 F1 regression: fresh RFB connect waits past pseudo-rect-only and split tiled updates (never returns black first frame) and requestFresh awaits update', async (t) => {
  const openSockets = new Set();
  const makeSolidBgrx = (w, h, [r, g, b]) => {
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      buf[i * 4] = b;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = r;
      buf[i * 4 + 3] = 0;
    }
    return buf;
  };

  let reqCount = 0;
  let freshPhase = false;
  const rfbServer = createRfbServer(
    { width: 80, height: 60, name: 'Split-Frame QEMU Sim', pixelFormat: RFB_PIXEL_FORMATS.bgrx },
    (conn) => {
      conn.on('updateRequest', () => {
        reqCount += 1;
        if (freshPhase) {
          // Answer requestFresh with green pixels after 25ms
          setTimeout(() => {
            conn.sendUpdate([
              { type: 'pixels', x: 0, y: 0, width: 80, height: 60, data: makeSolidBgrx(80, 60, [40, 210, 70]) },
            ]);
          }, 25);
          return;
        }
        if (reqCount === 1) {
          // Simulate QEMU sending ONLY a capability pseudo-rect on update #1 (0 pixels!)
          conn.sendUpdate([
            { type: 'encoded', x: 0, y: 0, width: 0, height: 0, encoding: RFB_ENCODINGS.pseudoQemuExtendedKeyEvent, body: Buffer.alloc(0) },
          ]);
        } else if (reqCount === 2) {
          // Top half tile (80x30) in red
          conn.sendUpdate([
            { type: 'pixels', x: 0, y: 0, width: 80, height: 30, data: makeSolidBgrx(80, 30, [220, 50, 40]) },
          ]);
        } else if (reqCount === 3) {
          // Bottom half tile (80x30) in blue
          conn.sendUpdate([
            { type: 'pixels', x: 0, y: 30, width: 80, height: 30, data: makeSolidBgrx(80, 30, [40, 90, 230]) },
          ]);
        }
      });
      conn.on('error', () => {});
    },
  );
  rfbServer.on('connection', (s) => {
    openSockets.add(s);
    s.once('close', () => openSockets.delete(s));
  });
  await new Promise((resolve) => rfbServer.listen(0, '127.0.0.1', resolve));
  const port = rfbServer.address().port;
  t.after(() => new Promise((resolve) => {
    for (const s of openSockets) s.destroy();
    rfbServer.close(() => resolve());
  }));

  const rfbDriver = createRfbDriver({ heartbeatIntervalMs: 0 });
  t.after(() => rfbDriver.dispose());

  // First capture on fresh connection MUST contain BOTH top red tile and bottom blue tile (zero black!)
  const first = await rfbDriver.captureRgba(`vnc:127.0.0.1:${port}`);
  assert.equal(first.width, 80);
  assert.equal(first.height, 60);
  assert.deepEqual([...first.data.subarray(0, 4)], [220, 50, 40, 255], 'Top tile must be populated on first capture');
  const bottomIdx = (45 * 80 + 10) * 4;
  assert.deepEqual([...first.data.subarray(bottomIdx, bottomIdx + 4)], [40, 90, 230, 255], 'Bottom tile must be populated on first capture');
  assert.equal(first.supports.qemuExtendedKeyEvent, true);

  // requestFresh: true must await the server's green update instead of reading stale pixels synchronously
  freshPhase = true;
  const fresh = await rfbDriver.captureRgba(`vnc:127.0.0.1:${port}`, { requestFresh: true });
  assert.deepEqual([...fresh.data.subarray(0, 4)], [40, 210, 70, 255], 'requestFresh must await updated server pixels');
});

test('v0.3.0 PVE RFB->QMP one-time fallback, /dev/shm + lastHash dedup, 5s status cache, and QGA clipboard sidechannel', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { gzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');

  // Verify REMOTE_PYTHON_BRIDGE prefers /dev/shm and checks lastHash
  assert.match(REMOTE_PYTHON_BRIDGE, /\/dev\/shm/);
  assert.match(REMOTE_PYTHON_BRIDGE, /lastHash/);
  assert.match(REMOTE_PYTHON_BRIDGE, /handle_qga_clipboard_set/);

  const quadPpm = buildSyntheticPpmP6({ width: 160, height: 120, quadrants: true });
  const ppmHash = createHash('sha256').update(quadPpm).digest('hex');
  const quadGzB64 = gzipSync(quadPpm).toString('base64');

  let fakeNow = 100_000;
  let statusRpcCount = 0;
  let screendumpRpcCount = 0;
  let qgaSetPayload = null;

  const qmpDriver = createPveQmpDriver({
    hostPlatform: 'linux',
    workerIdleMs: 0,
    statusCacheTtlMs: 5_000,
    nowFn: () => fakeNow,
    spawnProcess: () => {
      const proc = new EventEmitter();
      proc.pid = 72001;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new PassThrough();
      proc.killed = false;
      proc.exitCode = null;
      proc.unref = () => {};
      proc.kill = () => { proc.killed = true; };

      let buf = '';
      let sawBoot = false;
      proc.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          if (!sawBoot && !line.trim().startsWith('{')) { sawBoot = true; continue; }
          const req = JSON.parse(line);
          if (req.op === 'status') {
            statusRpcCount += 1;
            proc.stdout.write(JSON.stringify({
              id: req.id,
              ok: true,
              result: { vmid: req.vmid, vmStatus: 'running', running: true, vmName: 'legacy-cad-xp', width: 160, height: 120 },
            }) + '\n');
          } else if (req.op === 'screendump') {
            screendumpRpcCount += 1;
            if (req.lastHash && req.lastHash === ppmHash) {
              proc.stdout.write(JSON.stringify({
                id: req.id,
                ok: true,
                result: { unchanged: true, hash: ppmHash, rawBytes: quadPpm.length, compressedBytes: 0 },
              }) + '\n');
            } else {
              proc.stdout.write(JSON.stringify({
                id: req.id,
                ok: true,
                result: { unchanged: false, hash: ppmHash, encoding: 'ppm-gzip-base64', data: quadGzB64, rawBytes: quadPpm.length, compressedBytes: 123 },
              }) + '\n');
            }
          } else if (req.op === 'qga_probe') {
            proc.stdout.write(JSON.stringify({
              id: req.id,
              ok: true,
              result: { available: true, socketExists: true, osType: 'windows' },
            }) + '\n');
          } else if (req.op === 'qga_clipboard_set') {
            qgaSetPayload = Buffer.from(req.textB64, 'base64').toString('utf8');
            proc.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
          } else if (req.op === 'qga_clipboard_get') {
            proc.stdout.write(JSON.stringify({
              id: req.id,
              ok: true,
              result: { textB64: Buffer.from(qgaSetPayload || '', 'utf8').toString('base64') },
            }) + '\n');
          } else if (req.op === 'qmp_batch') {
            proc.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { executed: req.steps.length } }) + '\n');
          }
        }
      });
      return proc;
    },
  });
  t.after(() => qmpDriver.dispose());

  // 5s probeStatus TTL cache
  await qmpDriver.probeStatus('pve:pve-lab-node:103');
  await qmpDriver.probeStatus('pve:pve-lab-node:103');
  assert.equal(statusRpcCount, 1, 'Second probeStatus within 5s must hit cache');
  await qmpDriver.probeStatus('pve:pve-lab-node:103', { forceRefresh: true });
  assert.equal(statusRpcCount, 2, 'forceRefresh=true must bypass 5s cache');

  // lastHash unchanged frame skip reuses cached RGBA with compressedBytes=0
  const f1 = await qmpDriver.captureScreen('pve:pve-lab-node:103');
  assert.equal(f1.unchanged, false);
  const f2 = await qmpDriver.captureScreen('pve:pve-lab-node:103');
  assert.equal(f2.unchanged, true);
  assert.equal(f2.compressedBytes, 0);
  assert.equal(f2.width, 160);
  assert.equal(screendumpRpcCount, 2);

  // One-time RFB -> QMP fallback preserves provider='pve-qmp', switches transport to 'pve-qmp', doesn't retry RFB until explicit connect
  const dir = await makeTempDir(t, 'pve-fallback-');
  const { driver: winDriver } = createMockDriverFixture();
  let rfbAttempts = 0;
  const failingRfb = {
    onResize() {},
    async ensureConnected() {
      rfbAttempts += 1;
      throw Object.assign(new Error('qm vncproxy unavailable'), { failedBeforeSending: true });
    },
    async captureRgba() {
      rfbAttempts += 1;
      throw Object.assign(new Error('qm vncproxy unavailable'), { failedBeforeSending: true });
    },
    async executeActions() {
      rfbAttempts += 1;
      throw Object.assign(new Error('qm vncproxy unavailable'), { failedBeforeSending: true });
    },
    async getSessionCapabilities() { return { connected: false, unicodeClipboard: false }; },
    subscribeUpdates() { return () => {}; },
    async disconnectTarget() {},
    async dispose() {},
  };

  const svc = createUuRemoteService({
    systemDriver: winDriver,
    pveDriver: qmpDriver,
    rfbDriver: failingRfb,
    stateDir: dir,
    nowFn: () => fakeNow,
  });
  t.after(() => svc.dispose());

  const conn = await svc.launchAction({ action: 'connect', pveHost: 'pve-lab-node', vmid: 103 });
  assert.equal(conn.provider, 'pve-qmp', 'OQ5: provider field must stay pve-qmp');
  assert.equal(conn.transport, 'pve-qmp');
  assert.equal(rfbAttempts, 1);

  // Subsequent screenshot & QGA Chinese type do NOT retry failed RFB
  const shot = await svc.controlSession({ sessionId: 'pve:pve-lab-node:103', action: 'screenshot' });
  assert.equal(shot.ok, true);
  assert.equal(shot.provider, 'pve-qmp');
  assert.equal(shot.transport, 'pve-qmp');
  assert.equal(rfbAttempts, 1, 'OQ5: must NOT retry RFB on every call after one-time fallback');

  const qgaType = await svc.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'type',
    text: '中文QGA通道',
    observeAfter: false,
  });
  assert.equal(qgaType.ok, true);
  assert.equal(qgaSetPayload, '中文QGA通道');
  assert.equal(qgaType.results[0].mode, 'qga_clipboard_paste');

  // Explicit connect resets fallback and attempts RFB again
  await svc.launchAction({ action: 'connect', pveHost: 'pve-lab-node', vmid: 103 });
  assert.equal(rfbAttempts, 2, 'Explicit uu_launch(connect) resets fallback to retry RFB');
});

test('v0.3.0 VNC host whitelist (B1), normalizeSessionId, and preview-service static-frame skip + telemetry + new panel RPCs', async (t) => {
  // B1 VNC host validation
  assert.equal(buildVncTargetId('192.168.1.50', 5901), 'vnc:192.168.1.50:5901');
  assert.equal(buildVncTargetId('::1', 5900), 'vnc:[::1]:5900');
  assert.deepEqual(parseVncTargetId('VNC:[::1]:5902', { strict: true }), {
    id: 'vnc:[::1]:5902',
    host: '::1',
    port: 5902,
  });
  assert.equal(normalizeSessionId('VNC:lab.lan:5900'), 'vnc:lab.lan:5900');
  assert.ok(buildVncSshTunnelArgs('bastion.lan', '::1', 5900).includes('[::1]:5900'));

  for (const bad of [
    'vnc:-oProxyCommand=calc:5900',
    'vnc:host;id:5900',
    'vnc:user@host:5900',
    'vnc:host name:5900',
    'vnc:host:0',
    'vnc:host:70000',
    'vnc:host/path:5900',
  ]) {
    assert.equal(parseVncTargetId(bad, { strict: false }), null, `Expected null for ${bad}`);
    assert.throws(() => parseVncTargetId(bad, { strict: true }), /Invalid VNC/i, `Expected throw for ${bad}`);
  }

  // preview-service static-frame suppression + telemetry + new panel RPCs
  const dir = await makeTempDir(t, 'preview-v03-');
  const { driver: winDriver } = createMockDriverFixture();
  let fakeNow = 200_000;
  let dirtyListener = null;
  let rfbColor = [50, 140, 200];
  let rfbConnected = false;

  const mockRfb = {
    onResize() {},
    setVncPassword() {},
    clearVncPassword() {},
    subscribeUpdates(id, fn) {
      dirtyListener = fn;
      return () => { dirtyListener = null; };
    },
    async ensureConnected() {
      rfbConnected = true;
      return { client: { name: 'Studio VNC', width: 160, height: 120 }, framebuffer: { width: 160, height: 120 } };
    },
    async getSessionCapabilities() {
      return { connected: rfbConnected, unicodeClipboard: true, extendedClipboard: true, qemuExtendedKeyEvent: true, width: 160, height: 120, name: 'Studio VNC' };
    },
    async captureRgba() {
      const data = new Uint8Array(160 * 120 * 4);
      for (let i = 0; i < 160 * 120; i += 1) {
        data[i * 4] = rfbColor[0];
        data[i * 4 + 1] = rfbColor[1];
        data[i * 4 + 2] = rfbColor[2];
        data[i * 4 + 3] = 255;
      }
      return { width: 160, height: 120, data, image: { width: 160, height: 120, data }, frameSeq: 1, stageBounds: { x: 0, y: 0, width: 160, height: 120 } };
    },
    async executeActions(_target, actions) {
      const results = actions.map((a) => {
        if (a.kind === 'clipboard_get') return { kind: 'clipboard_get', text: 'remote-clip' };
        if (a.kind === 'clipboard_set') return { kind: 'clipboard_set', length: String(a.text ?? '').length };
        return { kind: a.kind };
      });
      return { ok: true, executed: results.length, results };
    },
    async disconnectTarget() { rfbConnected = false; },
    async dispose() {},
  };

  const mockPve = {
    async probeStatus(target) {
      return { vmid: target.vmid, vmStatus: 'running', running: true, vmName: 'vm-103', width: 160, height: 120 };
    },
    async disconnectHost() {},
    async dispose() {},
  };

  const uuService = createUuRemoteService({
    systemDriver: winDriver,
    pveDriver: mockPve,
    rfbDriver: mockRfb,
    stateDir: dir,
    nowFn: () => fakeNow,
  });
  const previewService = createUuPreviewService({ uuService, nowFn: () => fakeNow });
  t.after(async () => {
    await previewService.dispose();
    await uuService.dispose();
  });

  // New panel RPCs: connectVnc, clipboardSet, clipboardGet, connectPve, disconnectTarget
  const vncConn = await previewService.performAction({
    action: 'connectVnc',
    vncHost: '127.0.0.1',
    vncPort: 5905,
    vncPassword: 'secret',
    label: 'Studio VNC',
  });
  assert.equal(vncConn.ok, true);
  assert.equal(vncConn.sessionId, 'vnc:127.0.0.1:5905');

  const clipSet = await previewService.performAction({ action: 'clipboardSet', sessionId: vncConn.sessionId, text: 'hello' });
  assert.equal(clipSet.ok, true);
  const clipGet = await previewService.performAction({ action: 'clipboardGet', sessionId: vncConn.sessionId });
  assert.equal(clipGet.ok, true);
  assert.equal(clipGet.results[0].text, 'remote-clip');

  const pveConn = await previewService.performAction({ action: 'connectPve', pveHost: 'pve-lab-node', vmid: 103 });
  assert.equal(pveConn.ok, true);
  assert.equal(pveConn.sessionId, 'pve:pve-lab-node:103');

  // Stream static-frame skip + RFB event-driven dirty push + telemetry text messages
  const binaryPackets = [];
  const textMsgs = [];
  let closeStream = null;
  let topoCountBefore = 0;
  const origTopo = uuService.inspectTopology;
  uuService.inspectTopology = async (...args) => {
    topoCountBefore += 1;
    return origTopo(...args);
  };

  await previewService.openPanelStream(
    'screen',
    { sessionId: vncConn.sessionId, fps: 15 },
    {
      bufferedAmount: () => 0,
      sendBinary(buf) { binaryPackets.push(buf); return true; },
      sendText(txt) { textMsgs.push(JSON.parse(txt)); },
      onClose(fn) { closeStream = fn; },
      onText() {},
    },
    {},
  );

  // Wait for initial frame + telemetry
  const dl1 = Date.now() + 1000;
  while (binaryPackets.length < 1 && Date.now() < dl1) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(binaryPackets.length, 1);
  assert.ok(textMsgs.some((m) => m.type === 'telemetry' && m.unchanged === false && m.transport === 'rfb'));

  // Advance clock by 5s with NO dirty rect -> zero extra binary frames, zero extra inspectTopology!
  fakeNow += 5_000;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(binaryPackets.length, 1, 'Static RFB screen must skip resending identical binary PNGs');
  assert.equal(topoCountBefore, 1, 'Remote VNC/PVE stream must NOT re-run inspectTopology every 3s');

  // Trigger RFB dirty rect with new pixel color -> pushes 2nd binary frame immediately!
  rfbColor = [230, 60, 40];
  dirtyListener?.({ targetId: vncConn.sessionId, frameSeq: 2 });
  const dl2 = Date.now() + 1000;
  while (binaryPackets.length < 2 && Date.now() < dl2) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(binaryPackets.length, 2, 'Dirty rect must trigger immediate binary frame push');

  // Trigger RFB dirty rect with SAME pixel color -> hash dedup skips binary, emits unchanged telemetry!
  fakeNow += 2_500;
  dirtyListener?.({ targetId: vncConn.sessionId, frameSeq: 3 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(binaryPackets.length, 2, 'Identical PNG hash must skip sendBinary');
  assert.ok(textMsgs.some((m) => m.type === 'telemetry' && m.unchanged === true));

  closeStream?.();

  const discPve = await previewService.performAction({ action: 'disconnectTarget', sessionId: 'pve:pve-lab-node:103' });
  assert.equal(discPve.ok, true);
  assert.equal(discPve.removed, true);
  const discVnc = await previewService.performAction({ action: 'disconnectTarget', sessionId: vncConn.sessionId });
  assert.equal(discVnc.ok, true);
  assert.equal(discVnc.removed, true);
});

test('v0.3.0 PVE qemu-vdagent clipboard gating prevents QEMU VNC silent drop and exposes gated capabilities', async (t) => {
  // Verify REMOTE_PYTHON_BRIDGE queries QMP chardevs in handle_status without adding extra round-trips
  assert.match(REMOTE_PYTHON_BRIDGE, /query-chardev/);
  assert.match(REMOTE_PYTHON_BRIDGE, /vdagentConfigured/);
  assert.match(REMOTE_PYTHON_BRIDGE, /vdagentConnected/);
  assert.match(REMOTE_PYTHON_BRIDGE, /frontend-open/);
  assert.match(REMOTE_PYTHON_BRIDGE, /spicevmc/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'kiki-uu-vdagent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { driver: winDriver } = createMockDriverFixture();
  let fakeNow = 1_760_000_000_000;

  let pveStatusPayload = {
    vmid: 103,
    vmStatus: 'running',
    running: true,
    vmName: 'legacy-cad-xp',
    width: 160,
    height: 120,
    vdagentConfigured: false,
    vdagentConnected: false,
  };
  let qgaAvailable = false;
  let qgaProbeCalls = 0;
  const qgaSetCalls = [];
  const rfbExecuteCalls = [];

  const mockRfb = {
    onResize() {},
    setVncPassword() {},
    clearVncPassword() {},
    subscribeUpdates() { return () => {}; },
    async waitForSettle() { return { settled: true, waitedMs: 0 }; },
    async ensureConnected(target) {
      return { targetId: target.id, framebuffer: { width: 160, height: 120 }, client: { connected: true } };
    },
    async getSessionCapabilities() {
      // Simulate QEMU VNC negotiating pseudoExtendedClipboard even when VM has no vdagent chardev
      return {
        connected: true,
        unicodeClipboard: true,
        extendedClipboard: true,
        qemuExtendedKeyEvent: true,
        continuousUpdates: true,
        width: 160,
        height: 120,
      };
    },
    async captureRgba() {
      const data = Buffer.alloc(160 * 120 * 4, 0x88);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { width: 160, height: 120, data, image: { width: 160, height: 120, data }, frameSeq: 1, stageBounds: { x: 0, y: 0, width: 160, height: 120 } };
    },
    async executeActions(target, actions) {
      for (const a of actions) {
        rfbExecuteCalls.push({ targetId: target.id, kind: a.kind, text: a.text, keys: a.keys });
      }
      const results = actions.map((a) => {
        if (a.kind === 'clipboard_set') return { kind: 'clipboard_set', length: String(a.text ?? '').length, mode: 'extended_clipboard_utf8' };
        if (a.kind === 'clipboard_get') return { kind: 'clipboard_get', text: 'guest-utf8-你好', mode: 'extended_clipboard_utf8' };
        if (a.kind === 'type') return { kind: 'type', length: String(a.text ?? '').length, mode: /[^\x20-\x7e\r\n\t]/.test(String(a.text ?? '')) ? 'extended_clipboard_paste' : 'keysym_ascii' };
        return { kind: a.kind };
      });
      return { ok: true, executed: results.length, results };
    },
    async disconnectTarget() {},
    async dispose() {},
  };

  const mockPve = {
    async probeStatus(target) {
      return { ...pveStatusPayload, vmid: target.vmid };
    },
    async probeQga() {
      qgaProbeCalls += 1;
      return qgaAvailable ? { available: true, osType: 'windows' } : { available: false };
    },
    async qgaClipboardSet(_target, text) {
      qgaSetCalls.push(text);
      return { ok: true, length: text.length };
    },
    async qgaClipboardGet() {
      return { ok: true, text: 'from-qga-中文' };
    },
    async disconnectHost() {},
    async dispose() {},
  };

  const uuService = createUuRemoteService({
    systemDriver: winDriver,
    pveDriver: mockPve,
    rfbDriver: mockRfb,
    stateDir: dir,
    nowFn: () => fakeNow,
  });
  const previewService = createUuPreviewService({ uuService, nowFn: () => fakeNow });
  t.after(async () => {
    await previewService.dispose();
    await uuService.dispose();
  });

  // Register PVE VM 103
  const conn = await uuService.launchAction({ action: 'connect', pveHost: 'pve-lab-node', vmid: 103 });
  assert.equal(conn.ok, true);
  assert.equal(conn.provider, 'pve-qmp');
  assert.equal(conn.session.vdagentConfigured, false);
  assert.equal(conn.session.vdagentConnected, false);

  // Scenario (a): RFB negotiated extendedClipboard=true, vdagentConfigured=false, no QGA
  const setA = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'clipboard_set',
    text: '你好测试',
  });
  assert.equal(setA.ok, false);
  assert.equal(setA.code, 'unicode_input_unsupported');
  assert.equal(setA.capabilities.rfbExtendedClipboardNegotiated, true);
  assert.equal(setA.capabilities.vdagentConfigured, false);
  assert.equal(setA.capabilities.vdagentConnected, false);
  assert.equal(setA.capabilities.unicodeClipboard, false);
  assert.equal(setA.capabilities.guestAgent, false);
  assert.equal(setA.capabilities.clipboard, false);
  assert.equal(rfbExecuteCalls.length, 0, 'Must NEVER send clipboard_set into QEMU RFB black hole when vdagent is absent');

  const typeA = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'type',
    text: '中文输入测试',
  });
  assert.equal(typeA.ok, false);
  assert.equal(typeA.code, 'unicode_input_unsupported');
  assert.equal(typeA.capabilities.rfbExtendedClipboardNegotiated, true);
  assert.equal(typeA.capabilities.vdagentConfigured, false);
  assert.equal(typeA.capabilities.vdagentConnected, false);
  assert.equal(typeA.capabilities.unicodeClipboard, false);
  assert.equal(typeA.capabilities.clipboard, false);
  assert.equal(rfbExecuteCalls.length, 0, 'Must NEVER send non-ASCII type via RFB clipboard when vdagent is absent');

  // ASCII-only type still works over RFB keyboard without touching clipboard
  const asciiType = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'type',
    text: 'echo ok',
  });
  assert.equal(asciiType.ok, true);
  assert.equal(rfbExecuteCalls.length, 1);
  assert.equal(rfbExecuteCalls[0].kind, 'type');

  // Screenshot and preview telemetry both expose gated capabilities (clipboard=false, unicodeClipboard=false)
  const shotA = await uuService.controlSession({ sessionId: 'pve:pve-lab-node:103', action: 'screenshot' });
  assert.equal(shotA.ok, true);
  assert.equal(shotA.capabilities.rfbExtendedClipboardNegotiated, true);
  assert.equal(shotA.capabilities.vdagentConfigured, false);
  assert.equal(shotA.capabilities.vdagentConnected, false);
  assert.equal(shotA.capabilities.unicodeClipboard, false);
  assert.equal(shotA.capabilities.clipboard, false);

  const telemetryA = [];
  let closeStreamA = null;
  await previewService.openPanelStream(
    'screen',
    { sessionId: 'pve:pve-lab-node:103', fps: 10 },
    {
      bufferedAmount: () => 0,
      sendBinary() { return true; },
      sendText(txt) { telemetryA.push(JSON.parse(txt)); },
      onClose(fn) { closeStreamA = fn; },
      onText() {},
    },
    {},
  );
  const dlA = Date.now() + 1000;
  while (!telemetryA.some((m) => m.type === 'telemetry') && Date.now() < dlA) {
    await new Promise((r) => setTimeout(r, 15));
  }
  closeStreamA?.();
  const telMsgA = telemetryA.find((m) => m.type === 'telemetry');
  assert.ok(telMsgA, 'Preview stream must emit telemetry');
  assert.equal(telMsgA.capabilities.rfbExtendedClipboardNegotiated, true);
  assert.equal(telMsgA.capabilities.vdagentConfigured, false);
  assert.equal(telMsgA.capabilities.vdagentConnected, false);
  assert.equal(telMsgA.capabilities.unicodeClipboard, false);
  assert.equal(telMsgA.capabilities.clipboard, false);

  // Fail-closed check: if liveStatus omits vdagent fields entirely, default to false
  pveStatusPayload = { vmid: 103, vmStatus: 'running', running: true, vmName: 'legacy-qemu', width: 160, height: 120 };
  rfbExecuteCalls.length = 0;
  const setOmitted = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'clipboard_set',
    text: 'fail-closed',
  });
  assert.equal(setOmitted.ok, false);
  assert.equal(setOmitted.code, 'unicode_input_unsupported');
  assert.equal(setOmitted.capabilities.vdagentConfigured, false);
  assert.equal(setOmitted.capabilities.vdagentConnected, false);
  assert.equal(rfbExecuteCalls.length, 0);

  // Scenario (b): vdagentConfigured=true, vdagentConnected=false (guest spice-vdagent not running)
  pveStatusPayload = {
    vmid: 103,
    vmStatus: 'running',
    running: true,
    vmName: 'legacy-cad-xp',
    width: 160,
    height: 120,
    vdagentConfigured: true,
    vdagentConnected: false,
  };
  qgaAvailable = false;
  rfbExecuteCalls.length = 0;

  const setBNoQga = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'clipboard_set',
    text: '未连vdagent',
  });
  assert.equal(setBNoQga.ok, false);
  assert.equal(setBNoQga.code, 'unicode_input_unsupported');
  assert.equal(setBNoQga.capabilities.rfbExtendedClipboardNegotiated, true);
  assert.equal(setBNoQga.capabilities.vdagentConfigured, true);
  assert.equal(setBNoQga.capabilities.vdagentConnected, false);
  assert.equal(setBNoQga.capabilities.unicodeClipboard, false);
  assert.equal(setBNoQga.capabilities.clipboard, false);
  assert.equal(rfbExecuteCalls.length, 0, 'Must NOT call RFB clipboard_set when vdagent frontend-open is false');

  // Scenario (b2): vdagentConfigured=true, vdagentConnected=false, WITH QGA available -> falls back to QGA cleanly
  qgaAvailable = true;
  qgaSetCalls.length = 0;
  rfbExecuteCalls.length = 0;
  const setBQga = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'clipboard_set',
    text: '走QGA兜底',
  });
  assert.equal(setBQga.ok, true);
  assert.equal(setBQga.results[0].mode, 'qga_guest_exec');
  assert.deepEqual(qgaSetCalls, ['走QGA兜底']);
  assert.equal(rfbExecuteCalls.length, 0, 'QGA clipboard_set must not invoke RFB');

  const typeBQga = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'type',
    text: '粘贴中文',
    submit: true,
  });
  assert.equal(typeBQga.ok, true);
  assert.equal(typeBQga.results[0].mode, 'qga_clipboard_paste');
  assert.deepEqual(qgaSetCalls, ['走QGA兜底', '粘贴中文']);
  // Only Ctrl+v + Enter keys were sent over RFB, never clipboard_set
  assert.ok(rfbExecuteCalls.every((c) => c.kind === 'key'));

  // Cached QGA availability is now surfaced on screenshot capabilities (guestAgent=true, clipboard=true, unicodeClipboard=false)
  const shotBQga = await uuService.controlSession({ sessionId: 'pve:pve-lab-node:103', action: 'screenshot' });
  assert.equal(shotBQga.capabilities.unicodeClipboard, false);
  assert.equal(shotBQga.capabilities.guestAgent, true);
  assert.equal(shotBQga.capabilities.clipboard, true);

  // Scenario (c): vdagentConfigured=true, vdagentConnected=true -> normal RFB extended_clipboard_utf8
  pveStatusPayload = {
    vmid: 103,
    vmStatus: 'running',
    running: true,
    vmName: 'legacy-cad-xp',
    width: 160,
    height: 120,
    vdagentConfigured: true,
    vdagentConnected: true,
  };
  qgaAvailable = false;
  qgaProbeCalls = 0;
  rfbExecuteCalls.length = 0;

  // Reconnect clears stale QGA cache
  await uuService.launchAction({ action: 'connect', pveHost: 'pve-lab-node', vmid: 103 });
  const setC = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'clipboard_set',
    text: '正常走RFB剪贴板',
  });
  assert.equal(setC.ok, true);
  assert.equal(setC.results[0].mode, 'extended_clipboard_utf8');
  assert.equal(qgaProbeCalls, 0, 'Connected vdagent must not fall back to QGA');
  assert.equal(rfbExecuteCalls.length, 1);
  assert.equal(rfbExecuteCalls[0].kind, 'clipboard_set');

  const typeC = await uuService.controlSession({
    sessionId: 'pve:pve-lab-node:103',
    action: 'type',
    text: '你好世界',
  });
  assert.equal(typeC.ok, true);
  assert.equal(typeC.results[0].mode, 'extended_clipboard_paste');
  assert.equal(qgaProbeCalls, 0);

  const shotC = await uuService.controlSession({ sessionId: 'pve:pve-lab-node:103', action: 'screenshot' });
  assert.equal(shotC.capabilities.rfbExtendedClipboardNegotiated, true);
  assert.equal(shotC.capabilities.vdagentConfigured, true);
  assert.equal(shotC.capabilities.vdagentConnected, true);
  assert.equal(shotC.capabilities.unicodeClipboard, true);
  assert.equal(shotC.capabilities.clipboard, true);

  // Direct VNC target (runs inside Guest OS) is NOT gated by vdagentConnected
  const vncConn = await uuService.launchAction({ action: 'connect', vncHost: '127.0.0.1', vncPort: 5909 });
  assert.equal(vncConn.ok, true);
  rfbExecuteCalls.length = 0;
  const vncSet = await uuService.controlSession({
    sessionId: 'vnc:127.0.0.1:5909',
    action: 'clipboard_set',
    text: '直连VNC剪贴板',
  });
  assert.equal(vncSet.ok, true);
  assert.equal(vncSet.results[0].mode, 'extended_clipboard_utf8');
  assert.equal(rfbExecuteCalls.length, 1);
  const vncShot = await uuService.controlSession({ sessionId: 'vnc:127.0.0.1:5909', action: 'screenshot' });
  assert.equal(vncShot.capabilities.unicodeClipboard, true);
  assert.equal(vncShot.capabilities.clipboard, true);
  assert.equal(vncShot.capabilities.vdagentConnected, undefined);
});

test('v0.4.0: 0x02 dirty-rect + CopyRect zlib binary stream (<25 KB incremental) + frameSeq requestKeyframe recovery + 0x50/0x57/0x4b live input', async (t) => {
  // 1. Pack & unpack 1024x768 incremental dirty rect (<25 KB) + 13-byte CopyRect
  const rectW = 120;
  const rectH = 80;
  const rgba = Buffer.alloc(rectW * rectH * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 0x2c;
    rgba[i + 1] = 0x5e;
    rgba[i + 2] = 0x4f;
    rgba[i + 3] = 0xff;
  }
  const deltaPkt = packDirtyRectFrame({
    fbWidth: 1024,
    fbHeight: 768,
    frameSeq: 7,
    keyFrame: false,
    takeoverActive: true,
    rects: [
      { encoding: RECT_DEFLATE_RGBA, x: 40, y: 60, width: rectW, height: rectH, rgba },
      { encoding: RECT_COPYRECT, x: 200, y: 60, width: rectW, height: rectH, srcX: 40, srcY: 60 },
    ],
  });
  assert.equal(deltaPkt[0], DIRTY_FRAME_MAGIC);
  assert.ok(deltaPkt.length < 25 * 1024, `Expected <25 KB incremental packet, got ${deltaPkt.length} B`);

  const unpacked = unpackDirtyRectFrame(deltaPkt);
  assert.equal(unpacked.keyFrame, false);
  assert.equal(unpacked.takeoverActive, true);
  assert.equal(unpacked.frameSeq, 7);
  assert.equal(unpacked.fbWidth, 1024);
  assert.equal(unpacked.fbHeight, 768);
  assert.equal(unpacked.rects.length, 2);
  assert.equal(unpacked.rects[0].encoding, RECT_DEFLATE_RGBA);
  assert.deepEqual(unpacked.rects[0].rgba, rgba);
  assert.equal(unpacked.rects[1].encoding, RECT_COPYRECT);
  assert.equal(unpacked.rects[1].srcX, 40);
  assert.equal(unpacked.rects[1].srcY, 60);

  const copyOnly = packDirtyRectFrame({
    fbWidth: 1024,
    fbHeight: 768,
    frameSeq: 8,
    keyFrame: false,
    takeoverActive: false,
    rects: [{ encoding: RECT_COPYRECT, x: 10, y: 20, width: 300, height: 400, srcX: 10, srcY: 80 }],
  });
  assert.equal(copyOnly.length, 12 + 13);

  // 2. DOM KeyboardEvent.code -> AT Set-1 XT scancode mapping for Guest IME (Ctrl+Space, letters, digits)
  assert.equal(resolveDomCodeOrKey({ code: 'ControlLeft', key: 'Control' }).xtScancode, 0x1d);
  assert.equal(resolveDomCodeOrKey({ code: 'Space', key: ' ' }).xtScancode, 0x39);
  assert.equal(resolveDomCodeOrKey({ code: 'KeyN', key: 'n' }).xtScancode, 0x31);
  assert.equal(resolveDomCodeOrKey({ code: 'Digit1', key: '!', shiftKey: true }).xtScancode, 0x02);
  assert.equal(resolveDomCodeOrKey({ code: 'Digit1', key: '!', shiftKey: true }).keysym, 0x21);

  // 3. Binary client input packet round-trip (0x50 pointer, 0x57 wheel, 0x4b raw key)
  const ptrBuf = Buffer.alloc(8);
  ptrBuf[0] = CLIENT_POINTER_MAGIC;
  ptrBuf[1] = 0; // hover move
  ptrBuf[2] = 0;
  ptrBuf[3] = 0;
  ptrBuf.writeUInt16BE(512, 4);
  ptrBuf.writeUInt16BE(384, 6);
  assert.deepEqual(decodeClientBinaryInput(ptrBuf), {
    type: 'pointer',
    op: 0,
    buttonsMask: 0,
    clickCount: 1,
    norm1000X: 512,
    norm1000Y: 384,
    engageTakeover: false,
  });

  const wheelBuf = Buffer.alloc(10);
  wheelBuf[0] = CLIENT_WHEEL_MAGIC;
  wheelBuf.writeUInt16BE(400, 2);
  wheelBuf.writeUInt16BE(300, 4);
  wheelBuf.writeInt16BE(0, 6);
  wheelBuf.writeInt16BE(-120, 8);
  assert.deepEqual(decodeClientBinaryInput(wheelBuf), {
    type: 'wheel',
    norm1000X: 400,
    norm1000Y: 300,
    deltaX: 0,
    deltaY: -120,
    engageTakeover: true,
  });

  const codeBytes = Buffer.from('ControlLeft', 'utf8');
  const keyBytes = Buffer.from('Control', 'utf8');
  const keyBuf = Buffer.alloc(5 + codeBytes.length + keyBytes.length);
  keyBuf[0] = CLIENT_RAW_KEY_MAGIC;
  keyBuf[1] = 1; // keydown
  keyBuf[2] = 0;
  keyBuf[3] = codeBytes.length;
  codeBytes.copy(keyBuf, 4);
  keyBuf[4 + codeBytes.length] = keyBytes.length;
  keyBytes.copy(keyBuf, 5 + codeBytes.length);
  assert.deepEqual(decodeClientBinaryInput(keyBuf), {
    type: 'key',
    down: true,
    shiftKey: false,
    code: 'ControlLeft',
    key: 'Control',
    engageTakeover: true,
  });

  // 4. End-to-end live RFB server + previewService 0x02 stream + requestKeyframe + live input
  const serverFb = Buffer.alloc(64 * 48 * 4, 0x20);
  let lastPointerEvt = null;
  const receivedKeyEvts = [];
  let activeServerClient = null;
  const openSockets = new Set();
  const server = createRfbServer(
    { width: 64, height: 48, name: 'dirty-stream-vm', pixelFormat: RFB_PIXEL_FORMATS.bgrx },
    (conn) => {
      activeServerClient = conn;
      conn.on('updateRequest', (req) => {
        if (!req.incremental) {
          conn.sendUpdate([
            { type: 'pixels', x: 0, y: 0, width: 64, height: 48, data: serverFb },
          ]);
        }
      });
      conn.on('pointer', (ev) => {
        lastPointerEvt = ev;
      });
      conn.on('key', (ev) => {
        receivedKeyEvts.push(ev);
      });
      conn.on('error', () => {});
    },
  );
  server.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => {
    for (const s of openSockets) s.destroy();
    server.close(() => resolve());
  }));

  const stateDir = await makeTempDir(t, 'v040-stream-');
  const mockSys = createMockDriverFixture();
  mockSys.state.sessions = [];
  const rfbDriver = createRfbDriver();
  t.after(() => rfbDriver.dispose());
  const uuService = createUuRemoteService({
    stateDir,
    systemDriver: mockSys.driver,
    cliClient: { listDevices: async () => ({ ok: false, devices: [] }) },
    rfbDriver,
  });
  t.after(() => uuService.dispose());
  const preview = createUuPreviewService({ uuService });
  t.after(() => preview.dispose());

  const conn = await uuService.launchAction({ action: 'connect', vncHost: '127.0.0.1', vncPort: port });
  assert.equal(conn.ok, true);

  const binaryFrames = [];
  let onTextCb = null;
  let onBinaryCb = null;
  let closeCb = null;
  const hs = await preview.openPanelStream(
    'screen',
    { sessionId: `vnc:127.0.0.1:${port}`, fps: 30 },
    {
      sendBinary: (buf) => {
        binaryFrames.push(Buffer.from(buf));
        return true;
      },
      sendText: () => true,
      bufferedAmount: () => 0,
      onText: (fn) => { onTextCb = fn; },
      onBinary: (fn) => { onBinaryCb = fn; },
      onClose: (fn) => { closeCb = fn; },
    },
  );
  assert.equal(hs.dirtyRectSupported, true);
  assert.equal(hs.sessionId, `vnc:127.0.0.1:${port}`);

  // Wait for initial 0x02 keyframe
  for (let i = 0; i < 40 && binaryFrames.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(binaryFrames.length >= 1, 'Expected initial 0x02 keyframe');
  const kf0 = unpackDirtyRectFrame(binaryFrames[0]);
  assert.equal(kf0.keyFrame, true);
  assert.equal(kf0.fbWidth, 64);
  assert.equal(kf0.fbHeight, 48);

  // Push small dirty rect from RFB server -> should stream incremental 0x02 frame
  const patch = Buffer.alloc(10 * 10 * 4, 0xdd);
  activeServerClient.sendUpdate([{ type: 'pixels', x: 8, y: 12, width: 10, height: 10, data: patch }]);
  for (let i = 0; i < 40 && binaryFrames.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(binaryFrames.length >= 2, 'Expected incremental 0x02 dirty-rect frame');
  const inc1 = unpackDirtyRectFrame(binaryFrames[1]);
  assert.equal(inc1.keyFrame, false);
  assert.equal(inc1.frameSeq, (kf0.frameSeq + 1) >>> 0);
  assert.equal(inc1.rects[0].x, 8);
  assert.equal(inc1.rects[0].y, 12);

  // Simulate sequence gap recovery via requestKeyframe
  const countBeforeKf = binaryFrames.length;
  onTextCb(JSON.stringify({ type: 'requestKeyframe' }));
  for (let i = 0; i < 40 && binaryFrames.length <= countBeforeKf; i += 1) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const recoveredKf = unpackDirtyRectFrame(binaryFrames[binaryFrames.length - 1]);
  assert.equal(recoveredKf.keyFrame, true);

  // Send live 0x50 hover move and 0x4b raw key over stream binary channel
  onBinaryCb(ptrBuf);
  onBinaryCb(keyBuf);
  for (let i = 0; i < 30 && (!lastPointerEvt || receivedKeyEvts.length === 0); i += 1) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(lastPointerEvt, 'RFB server should receive live pointer hover move');
  assert.equal(lastPointerEvt.x, Math.round(0.512 * 63));
  assert.equal(lastPointerEvt.y, Math.round(0.384 * 47));
  assert.ok(receivedKeyEvts.length >= 1, 'RFB server should receive live raw keydown');

  closeCb?.();
});

test('v0.4.0: pve-qmp-driver uses mshta clipboard bridge on legacy Windows XP (NT 5.x) and uu-service avoids per-call disk readFile', async (t) => {
  // Verify Python bridge embeds mshta.exe fallback for Windows NT 5.x (XP/2003)
  assert.match(REMOTE_PYTHON_BRIDGE, /isLegacyNt5/);
  assert.match(REMOTE_PYTHON_BRIDGE, /mshta\.exe/);
  assert.match(REMOTE_PYTHON_BRIDGE, /windows_mshta_clipboard_set/);
  assert.match(REMOTE_PYTHON_BRIDGE, /windows_mshta_clipboard_get/);

  // Verify uu-service reads state files once during initial sync and does zero readFile on subsequent hot calls
  const stateDir = await makeTempDir(t, 'ram-state-');
  let diskReadCount = 0;
  const wrappedFs = {
    mkdir,
    writeFile,
    readFile: async (...args) => {
      diskReadCount += 1;
      return readFile(...args);
    },
  };

  const mockFixture = createMockDriverFixture();
  const svc = createUuRemoteService({
    stateDir,
    fsModule: wrappedFs,
    systemDriver: mockFixture.driver,
    cliClient: { listDevices: async () => ({ ok: true, devices: [] }) },
  });
  t.after(() => svc.dispose());

  await svc.manageSessions({ action: 'list' });
  const readsAfterWarm = diskReadCount;

  // Run 10 consecutive hot input calls — diskReadCount must remain unchanged (0 new fs.readFile calls!)
  for (let i = 0; i < 10; i += 1) {
    const res = await svc.controlSession({
      sessionId: 'uu:24780134',
      action: 'key',
      key: 'Enter',
    });
    assert.equal(res.ok, true);
  }
  assert.equal(diskReadCount, readsAfterWarm, 'Hot controlSession calls must not re-read state JSON from disk');
});
