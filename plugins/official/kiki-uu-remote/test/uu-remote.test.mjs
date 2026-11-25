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
import { decodePng, encodePng } from '../lib/png-codec.mjs';
import {
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
import { createUuPreviewService } from '../lib/preview-service.mjs';
import { createUuSlotHandlers } from '../lib/slots.mjs';
import { createUuRemoteService } from '../lib/uu-service.mjs';
import { createUuycCliClient, discoverUuycCli, parseCliJsonOutput } from '../lib/uuyc-cli.mjs';
import { createWin32SystemDriver } from '../lib/win32-driver.mjs';
import { classifyUuWindows, computeRescueBounds } from '../lib/window-topology.mjs';

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
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest['x-kiki'].activation, 'app');
  assert.deepEqual(manifest['x-kiki'].tools, definitions);

  await validateRegistration(manifest, entryModule.register);

  const files = await packageFiles(PLUGIN_ROOT);
  assert.ok(files.includes('kimi.plugin.json'));
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('entry.mjs'));
  assert.ok(files.includes('panel.html'));
  assert.ok(files.includes('icon.svg'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('skills/uu-remote/SKILL.md'));
  assert.ok(files.includes('lib/win32-worker.ps1'));
  assert.ok(files.includes('lib/pve-qmp-driver.mjs'));
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
    return origCapture(...args);
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
  const parsed = parsePveTargetId('PVE:assistant-pve-campus:103', { strict: true });
  assert.deepEqual(parsed, {
    id: 'pve:assistant-pve-campus:103',
    sshHost: 'assistant-pve-campus',
    vmid: 103,
  });
  assert.equal(buildPveTargetId('Node_01.lan', 42), 'pve:Node_01.lan:42');

  const sshArgs = buildSshBridgeArgs('assistant-pve-campus');
  const sepIdx = sshArgs.indexOf('--');
  assert.ok(sepIdx > 0);
  assert.equal(sshArgs[sepIdx + 1], 'assistant-pve-campus');
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
              result: { vmid: req.vmid, vmStatus: 'running', running: true, vmName: 'kaimu-pdm-xp', width: 160, height: 120 },
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

  const st = await pveDriver.probeStatus('pve:assistant-pve-campus:103', { probeResolution: true });
  assert.equal(st.running, true);
  assert.equal(st.vmName, 'kaimu-pdm-xp');
  assert.equal(spawned.length, 1);

  // Second call reuses the same SSH child process
  const cap = await pveDriver.captureScreen('pve:assistant-pve-campus:103');
  assert.equal(spawned.length, 1);
  assert.equal(cap.width, 160);
  assert.equal(cap.height, 120);
  assert.deepEqual([...cap.image.data.subarray(0, 4)], [220, 40, 50, 255]);

  // Simulate wedged SSH worker -> timeout tears it down and next RPC spawns a clean worker
  wedgeNext = true;
  await assert.rejects(
    pveDriver.probeStatus('pve:assistant-pve-campus:103', { timeoutMs: 500 }),
    /timed out/i,
  );
  assert.equal(spawned[0].proc.killed, true);

  wedgeNext = false;
  const recovered = await pveDriver.probeStatus('pve:assistant-pve-campus:103');
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
        vmName: 'kaimu-pdm-xp',
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
    deviceId: 'pve:assistant-pve-campus:103',
  });
  assert.equal(connected.ok, true);
  assert.equal(connected.provider, 'pve-qmp');
  assert.equal(connected.sessionId, 'pve:assistant-pve-campus:103');
  assert.equal(connected.selectedSessionId, 'pve:assistant-pve-campus:103');
  assert.equal(connected.session.vmStatus, 'running');
  assert.equal(connected.session.label, 'kaimu-pdm-xp');

  // Verify persistence in pve-targets.json across fresh service instance
  const persisted = JSON.parse(await readFile(path.join(stateDir, 'pve-targets.json'), 'utf8'));
  assert.equal(persisted.targets.length, 1);
  assert.equal(persisted.targets[0].id, 'pve:assistant-pve-campus:103');

  const restartedService = createUuRemoteService({
    systemDriver: winDriver,
    pveDriver: mockPveDriver,
    stateDir,
  });

  // 2. uu_sessions(action="list") merges Win32 + PVE targets seamlessly
  const listed = await restartedService.manageSessions({ action: 'list', includeDevices: false });
  assert.equal(listed.selectedSessionId, 'pve:assistant-pve-campus:103');
  const pveSess = listed.sessions.find((s) => s.id === 'pve:assistant-pve-campus:103');
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
  assert.equal(zoomShot.sessionId, 'pve:assistant-pve-campus:103');
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
  assert.equal(actRes.executed, 4);
  assert.equal(sentQmpBatches.length, 4);
  assert.equal(winState.sentBatches.length, 0, 'Win32 SendInput must not be called for PVE targets');

  // 5. Explicit Human Takeover lock blocks agent control on PVE target with 409
  await restartedService.manageSessions({
    action: 'takeover',
    sessionId: 'pve:assistant-pve-campus:103',
    active: true,
    reason: 'User operating KaMu PDM',
  });
  const blocked = await restartedService.controlSession({
    sessionId: 'pve:assistant-pve-campus:103',
    action: 'click',
    x: 500,
    y: 500,
    observeAfter: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, 'human_takeover_active');
  assert.equal(sentQmpBatches.length, 4);
  await restartedService.manageSessions({
    action: 'takeover',
    sessionId: 'pve:assistant-pve-campus:103',
    active: false,
  });

  // 6. Preview Panel binary stream works natively on PVE session
  const previewService = createUuPreviewService({ uuService: restartedService });
  t.after(() => previewService.dispose());
  const packets = [];
  let closeStream = null;
  const hs = await previewService.openPanelStream(
    'screen',
    { sessionId: 'pve:assistant-pve-campus:103', fps: 15, maxWidth: 640 },
    {
      bufferedAmount: () => 0,
      sendBinary(buf) { packets.push(buf); return true; },
      sendText() {},
      onClose(fn) { closeStream = fn; },
      onText() {},
    },
    {},
  );
  assert.equal(hs.sessionId, 'pve:assistant-pve-campus:103');
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
  const cuaPve = targetsRes.targets.find((item) => item.id === 'pve:assistant-pve-campus:103');
  assert.ok(cuaPve);
  assert.equal(cuaPve.online, true);
  assert.equal(cuaPve.provider, 'pve-qmp');

  const cuaObs = await (
    await fetch(`${lease.endpoint}/v1/observe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targetId: 'pve:assistant-pve-campus:103' }),
    })
  ).json();
  assert.equal(cuaObs.ok, true);
  assert.equal(cuaObs.targetId, 'pve:assistant-pve-campus:103');

  // 8. Disconnect via pveHost + vmid removes target from pve-targets.json and closes host worker
  const disc = await restartedService.launchAction({
    action: 'disconnect',
    pveHost: 'assistant-pve-campus',
    vmid: 103,
  });
  assert.equal(disc.ok, true);
  assert.equal(disc.removed, true);
  assert.ok(disconnectedHosts.includes('assistant-pve-campus'));
  const afterDisc = JSON.parse(await readFile(path.join(stateDir, 'pve-targets.json'), 'utf8'));
  assert.equal(afterDisc.targets.length, 0);
});
