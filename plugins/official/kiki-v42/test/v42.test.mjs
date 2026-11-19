import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createV42Runtime, register } from '../entry.mjs';
import { resolveCuaProviderBusDir, V42CuaProviderServer } from '../lib/cua-provider.mjs';
import { V42DesktopControlSession } from '../lib/desktop-session.mjs';
import { decodePngToRgba, readPngDimensions } from '../lib/png-crop.mjs';
import { PortForwardManager } from '../lib/port-forward.mjs';
import {
  buildGlobalArgs,
  clearResolveV42BinaryCache,
  discoverCompanionRoots,
  flattenResourcesTerminals,
  pruneStaleTransferLocks,
  resolveV42Binary,
  V42Client,
} from '../lib/v42-client.mjs';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..', '..');
const mockV42Script = path.join(pluginRoot, 'test', 'fixtures', 'mock-v42.mjs');
const testScratchBase = path.join(repoRoot, '.tmp', 'kiki-v42-test');

async function makeIsolatedEnv(name) {
  const dir = path.join(testScratchBase, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const dataDir = path.join(dir, 'plugins', 'data', 'kiki-v42');
  const busDir = path.join(dir, 'plugins', 'data', 'kiki-cua', 'providers');
  const workspaceRoot = path.join(dir, 'workspace');
  const stateFile = path.join(dir, 'mock-v42-state.json');
  await mkdir(workspaceRoot, { recursive: true });

  const env = {
    ...process.env,
    KIKI_HOME: dir,
    KIKI_CUA_BUS_DIR: busDir,
    KIKI_V42_BIN: mockV42Script,
    KIKI_V42_AUTO_WAIT_MS: '1000',
    MOCK_V42_STATE_FILE: stateFile,
  };
  const runtime = createV42Runtime({ env, dataDir, heartbeatMs: 2000, ttlMs: 35000 });
  return { dir, dataDir, busDir, workspaceRoot, stateFile, env, runtime };
}

test('Gate 1: manifest sync, validateRegistration, packageFiles, and UI anti-slop checks', async () => {
  await execFileAsync(process.execPath, [path.join(pluginRoot, 'scripts', 'sync-manifest.mjs'), '--check']);

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
  const { validateRegistration } = await import(
    pathToFileURL(path.join(repoRoot, 'scripts', 'validate-registration.mjs')).href
  );
  const { packageFiles } = await import(
    pathToFileURL(path.join(repoRoot, 'scripts', 'package-files.mjs')).href
  );

  await validateRegistration(manifest, register);
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest['x-kiki'].tools.length, 5);
  assert.equal(manifest['x-kiki'].sessionSources.length, 1);
  assert.equal(manifest['x-kiki'].panels[0].slot, 'workspace');
  assert.equal(
    manifest['x-kiki'].guiSlots.some((s) => s.slot === 'sidebar-panel' || s.slot === 'inspector-tab'),
    false,
    'Manifest guiSlots must never crowd sidebar-nav or narrow inspector-tab',
  );
  assert.deepEqual(
    manifest['x-kiki'].guiSlots.map((s) => s.slot),
    ['composer-toolbar', 'slash-command', 'tool-card-renderer'],
  );

  const files = await packageFiles(pluginRoot);
  assert.ok(files.includes('kimi.plugin.json'));
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('entry.mjs'));
  assert.ok(files.includes('panel.html'));
  assert.ok(files.includes('icon.svg'));
  assert.ok(files.includes('lib/panel.css'));
  assert.ok(files.includes('lib/panel-app.js'));
  assert.ok(files.includes('skills/v42-fleet/SKILL.md'));
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('scripts/')));

  for (const file of files) {
    const content = await readFile(path.join(pluginRoot, file), 'utf8');
    assert.doesNotMatch(content, /C:\\Programs|C:\/Programs|C:\\Users|C:\/Users/, `No hardcoded local path in ${file}`);
  }

  const panelStat = await stat(path.join(pluginRoot, 'panel.html'));
  assert.ok(panelStat.size < 256 * 1024);

  const uiSources = await Promise.all([
    readFile(path.join(pluginRoot, 'panel.html'), 'utf8'),
    readFile(path.join(pluginRoot, 'lib', 'panel.css'), 'utf8'),
    readFile(path.join(pluginRoot, 'lib', 'panel-app.js'), 'utf8'),
  ]);
  const combinedUi = uiSources.join('\n');
  assert.equal(/\p{Extended_Pictographic}/u.test(combinedUi), false, 'UI must contain zero emojis');
  assert.equal(
    /数据可能已过期|结果可能不完整|仅供预览|data may be stale|results may be incomplete/i.test(combinedUi),
    false,
    'UI must contain zero defensive boundary disclaimers',
  );
  const combinedStyle = `${uiSources[0]}\n${uiSources[1]}`.toLowerCase();
  for (const token of ['#f6f4ef', '#fcfbf8', '#efece4', '#1b1a17', '#2c5e4f', '#141413', '#1c1b19', '#252320', '#edeae2', '#58a88f']) {
    assert.ok(combinedStyle.includes(token), `panel-kit + panel.css must define paper-and-ink token ${token}`);
  }
  assert.ok(uiSources[0].includes('@kiki-panel-kit:theme:start'), 'panel.html must embed shared panel-kit theme');
  assert.ok(uiSources[0].includes('@kiki-panel-kit:runtime:start'), 'panel.html must embed shared panel-kit runtime');
  assert.ok(uiSources[2].includes("document.execCommand('copy')"), 'panel-app.js must provide textarea execCommand clipboard fallback');
});

test('Gate 2: Security gate — v42_seat_resolve strictly blocks self-approval in schema and runtime', async () => {
  const ctx = await makeIsolatedEnv('security-gate');
  try {
    await ctx.runtime.activate({ dataDir: ctx.dataDir });

    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
    const resolveDef = manifest['x-kiki'].tools.find((t) => t.name === 'v42_seat_resolve');
    const kindEnum = resolveDef.parameters.properties.resolution.properties.kind.enum;
    assert.deepEqual(kindEnum, ['answers', 'dismiss']);

    const runRes = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      {
        action: 'dispatch',
        computer: 'mac-studio',
        agent: 'claude-code',
        prompt: 'TRIGGER_APPROVAL',
        wait_mode: 'auto',
      },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    const runPayload = JSON.parse(runRes.output);
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.status, 'blocked');
    assert.equal(runPayload.pending.kind, 'approval');

    for (const badKind of ['approval', 'always']) {
      const attempt = await ctx.runtime.orchestrator.executeTool(
        'v42_seat_resolve',
        {
          seat_ref: runPayload.seat_ref,
          resolution: { kind: badKind, decision: 'allow_once' },
        },
        { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
      );
      assert.equal(attempt.isError, true);
      const errBody = JSON.parse(attempt.output);
      assert.equal(errBody.code, 'approval_forbidden_for_model');
    }

    const disguiseAttempt = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_resolve',
      {
        seat_ref: runPayload.seat_ref,
        resolution: { kind: 'answers', answers: { confirm: 'yes' } },
      },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(disguiseAttempt.isError, true);
    assert.equal(JSON.parse(disguiseAttempt.output).code, 'human_approval_required');

    const humanOk = await ctx.runtime.workbenchService.handlePanelRequest(
      'humanApprovePending',
      { seatRef: runPayload.seat_ref, pendingId: 'pend-rm-1', decision: 'allow_once' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(humanOk.ok, true);

    await ctx.runtime.workbenchService.handlePanelRequest(
      'takeover',
      { targetKey: `seat:${runPayload.seat_ref}`, active: false },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      { action: 'steer', seat_ref: runPayload.seat_ref, prompt: 'TRIGGER_QUESTION', wait_mode: 'auto' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    const questionOk = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_resolve',
      {
        seat_ref: runPayload.seat_ref,
        resolution: { kind: 'answers', answers: { env: 'staging' } },
      },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(Boolean(questionOk.isError), false);
    assert.equal(JSON.parse(questionOk.output).resolved_kind, 'answers');
  } finally {
    await ctx.runtime.deactivate();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('Gate 3: Route C pinned-only visibility — 50 unmanaged panes stay hidden until pinned', async () => {
  const ctx = await makeIsolatedEnv('route-c');
  try {
    await ctx.runtime.activate({ dataDir: ctx.dataDir });

    const fleetAll = JSON.parse(
      (await ctx.runtime.orchestrator.executeTool(
        'v42_fleet',
        { scope: 'seats', include_unmanaged: true },
        { kikiHome: ctx.dir },
      )).output,
    );
    assert.equal(fleetAll.total_seats, 50);

    const e5Empty = await ctx.runtime.slots['E5:prompt-context']({}, { kikiHome: ctx.dir });
    assert.deepEqual(e5Empty.sections, []);

    const e12Empty = await ctx.runtime.slots['E12:server-gui-slots']({ kind: 'describe' }, { kikiHome: ctx.dir });
    assert.equal(e12Empty.guiSlots.some((s) => s.slot === 'status-capsule'), false);
    assert.equal(e12Empty.guiSlots.some((s) => s.slot === 'sidebar-panel' || s.slot === 'inspector-tab'), false);

    await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      { action: 'pin', seat_ref: 'mac-studio:%3', title: 'Pinned Seat 3' },
      { kikiHome: ctx.dir },
    );
    await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      { action: 'pin', seat_ref: 'mac-studio:%9', title: 'Pinned Seat 9' },
      { kikiHome: ctx.dir },
    );

    const e5Pinned = await ctx.runtime.slots['E5:prompt-context']({}, { kikiHome: ctx.dir });
    assert.equal(e5Pinned.sections.length, 1);
    const xml = e5Pinned.sections[0].content;
    assert.ok(Buffer.byteLength(xml, 'utf8') <= 2048);
    assert.match(xml, /mac-studio:%3/);
    assert.match(xml, /mac-studio:%9/);
    assert.doesNotMatch(xml, /mac-studio:%1\b/);
    assert.doesNotMatch(xml, /mac-studio:%50\b/);

    const e12Pinned = await ctx.runtime.slots['E12:server-gui-slots']({ kind: 'describe' }, { kikiHome: ctx.dir });
    const capsule = e12Pinned.guiSlots.find((s) => s.slot === 'status-capsule');
    assert.ok(capsule);
    assert.equal(capsule.valueText, '2 leased');
  } finally {
    await ctx.runtime.deactivate();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('Gate 4: Idempotency ring buffer, 409 human_controlling, session_changed, and auto wait timeout', async () => {
  const ctx = await makeIsolatedEnv('idempotency-takeover');
  try {
    await ctx.runtime.activate({ dataDir: ctx.dataDir });

    const r1 = JSON.parse(
      (await ctx.runtime.orchestrator.executeTool(
        'v42_seat_run',
        {
          action: 'dispatch',
          computer: 'mac-studio',
          agent: 'codex',
          prompt: 'Run unit suite',
          idempotency_key: 'idem-alpha-1',
          wait_mode: 'auto',
        },
        { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
      )).output,
    );
    assert.equal(r1.ok, true);
    assert.equal(Boolean(r1.deduplicated), false);

    const r2 = JSON.parse(
      (await ctx.runtime.orchestrator.executeTool(
        'v42_seat_run',
        {
          action: 'steer',
          seat_ref: r1.seat_ref,
          prompt: 'Run unit suite',
          idempotency_key: 'idem-alpha-1',
          wait_mode: 'auto',
        },
        { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
      )).output,
    );
    assert.equal(r2.deduplicated, true);
    assert.equal(r2.seat_ref, r1.seat_ref);

    const mockState1 = JSON.parse(await readFile(ctx.stateFile, 'utf8'));
    assert.equal(mockState1.sentLog.length, 1, 'Duplicate idempotency_key must send to v42 exactly once');

    await ctx.runtime.workbenchService.handlePanelRequest(
      'humanSeatSend',
      { seatRef: r1.seat_ref, text: 'Manual tweak' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );

    const blockedRun = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      { action: 'steer', seat_ref: r1.seat_ref, prompt: 'Agent follow-up' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(blockedRun.isError, true);
    assert.equal(JSON.parse(blockedRun.output).status, 409);
    assert.equal(JSON.parse(blockedRun.output).code, 'human_controlling');

    const mockState2 = JSON.parse(await readFile(ctx.stateFile, 'utf8'));
    assert.equal(mockState2.sentLog.length, 2, 'Blocked agent steer must not reach v42');

    await ctx.runtime.workbenchService.handlePanelRequest(
      'takeover',
      { targetKey: `seat:${r1.seat_ref}`, active: false },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );

    const wrongSession = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      {
        action: 'steer',
        seat_ref: r1.seat_ref,
        expected_session: 'stale_session_id',
        prompt: 'Should reject',
      },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(wrongSession.isError, true);
    assert.equal(JSON.parse(wrongSession.output).code, 'session_changed');

    const longTurn = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      {
        action: 'steer',
        seat_ref: r1.seat_ref,
        prompt: 'TRIGGER_LONG_TURN',
        wait_mode: 'auto',
      },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(Boolean(longTurn.isError), false);
    const longBody = JSON.parse(longTurn.output);
    assert.equal(longBody.background, true);
    assert.equal(longBody.wait_timed_out, true);
    assert.equal(longBody.status, 'working');

    const failIsolated = await ctx.runtime.orchestrator.executeTool(
      'v42_seat_run',
      {
        action: 'dispatch',
        computer: 'mac-studio',
        workspace: 'ws-no-isolation',
        isolated_copy: true,
        prompt: 'Must never execute on unisolated workspace',
      },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(failIsolated.isError, true);
    assert.equal(JSON.parse(failIsolated.output).code, 'isolated_copy_unavailable');
  } finally {
    await ctx.runtime.deactivate();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('Gate 5: Desktop NDJSON session, mobile bridge, file transfer admission, port forwards, and sessionSource', async () => {
  const ctx = await makeIsolatedEnv('env-bridges');
  try {
    await ctx.runtime.activate({ dataDir: ctx.dataDir });

    const localArtifact = path.join(ctx.workspaceRoot, 'hello.txt');
    await writeFile(localArtifact, 'hello remote fleet', 'utf8');

    const pushRes = JSON.parse(
      (await ctx.runtime.orchestrator.executeTool(
        'v42_env_transfer',
        { action: 'push', computer: 'mac-studio', local_path: 'hello.txt', remote_path: '/tmp/hello.txt' },
        { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
      )).output,
    );
    assert.equal(pushRes.ok, true);

    const outsideAttempt = await ctx.runtime.orchestrator.executeTool(
      'v42_env_transfer',
      { action: 'pull', computer: 'mac-studio', remote_path: '/tmp/hello.txt', local_path: '../escaped.txt' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
    );
    assert.equal(outsideAttempt.isError, true);
    assert.equal(JSON.parse(outsideAttempt.output).code, 'path_not_admitted');

    const deskShot = await ctx.runtime.orchestrator.executeTool(
      'v42_env_transfer',
      { action: 'desktop_screenshot', computer: 'mac-studio' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir, imageIn: true },
    );
    assert.equal(Array.isArray(deskShot.output), true);
    assert.equal(deskShot.output[1].type, 'image_url');
    assert.match(deskShot.output[1].imageUrl.url, /^data:image\/png;base64,/);

    const mobShot = await ctx.runtime.orchestrator.executeTool(
      'v42_env_transfer',
      { action: 'mobile_screenshot', computer: 'mac-studio', mobile_device_id: 'adb:pixel9' },
      { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir, imageIn: true },
    );
    assert.equal(Array.isArray(mobShot.output), true);
    assert.match(mobShot.output[1].imageUrl.url, /^data:image\/png;base64,/);

    const fwdStart = JSON.parse(
      (await ctx.runtime.orchestrator.executeTool(
        'v42_env_transfer',
        { action: 'port_forward_start', computer: 'mac-studio', remote_port: 3080 },
        { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
      )).output,
    );
    assert.equal(fwdStart.ok, true);
    const localPort = fwdStart.tunnel.localPort;
    const tunneled = await (await fetch(`http://127.0.0.1:${localPort}/`)).json();
    assert.deepEqual(tunneled, { forwarded: true, computer: 'mac-studio', remotePort: 3080 });

    const fwdStop = JSON.parse(
      (await ctx.runtime.orchestrator.executeTool(
        'v42_env_transfer',
        { action: 'port_forward_stop', computer: 'mac-studio', local_port: localPort },
        { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir },
      )).output,
    );
    assert.equal(Boolean(fwdStop.stopped), true);

    const snapshotsDir = path.join(ctx.dir, 'exported-seats');
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(
      path.join(snapshotsDir, 'seat-1.json'),
      JSON.stringify({
        id: 'seat-1',
        title: 'Router refactor seat',
        rows: [
          { id: 'r1', kind: 'user', text: 'Fix router.rs' },
          { id: 'r2', kind: 'assistant', text: 'Updated router.rs and ran cargo test.' },
        ],
      }),
      'utf8',
    );
    const discovered = await ctx.runtime.sessionSourceAdapter.discover({ home: snapshotsDir });
    assert.equal(discovered.entries.length, 1);
    const probed = await ctx.runtime.sessionSourceAdapter.probe({ home: snapshotsDir, externalId: 'seat-1.json' });
    assert.equal(probed.status, 'preserved');
    const parsed = await ctx.runtime.sessionSourceAdapter.parse({
      home: snapshotsDir,
      externalId: 'seat-1.json',
      revision: probed.revision,
    });
    assert.equal(parsed.records.length, 2);
  } finally {
    await ctx.runtime.deactivate();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('Gate 6: kiki.cua.provider.v1 loopback Provider Bus full round-trip + zoom crop + takeover', async () => {
  const ctx = await makeIsolatedEnv('cua-bus');
  try {
    const resolvedBus = resolveCuaProviderBusDir({ env: ctx.env });
    assert.equal(resolvedBus, ctx.busDir);

    const actInfo = await ctx.runtime.activate({ dataDir: ctx.dataDir });
    const leaseRaw = JSON.parse(await readFile(actInfo.cuaLeaseFile, 'utf8'));
    assert.equal(leaseRaw.protocol, 'kiki.cua.provider.v1');
    assert.equal(leaseRaw.providerId, 'kiki-v42');
    assert.match(leaseRaw.endpoint, /^http:\/\/127\.0\.0\.1:\d{2,5}$/);
    assert.equal(leaseRaw.authToken.length, 64);
    assert.equal(leaseRaw.ttlMs, 35000);

    const unauth = await fetch(`${leaseRaw.endpoint}/v1/health`);
    assert.equal(unauth.status, 401);

    const headers = {
      Authorization: `Bearer ${leaseRaw.authToken}`,
      'Content-Type': 'application/json',
    };

    const health = await (await fetch(`${leaseRaw.endpoint}/v1/health`, { headers })).json();
    assert.equal(health.ok, true);
    assert.equal(health.providerId, 'kiki-v42');

    const targetsRes = await (await fetch(`${leaseRaw.endpoint}/v1/targets`, { headers })).json();
    assert.equal(targetsRes.ok, true);
    assert.ok(targetsRes.targets.some((t) => t.id === 'v42:mac-studio:desktop'));
    assert.ok(targetsRes.targets.some((t) => t.id === 'v42:mac-studio:mobile:adb:pixel9'));

    const obsZoom = await (
      await fetch(`${leaseRaw.endpoint}/v1/observe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetId: 'v42:mac-studio:desktop',
          coordinateMode: 'normalized_1000',
          zoom: { x: 500, y: 500, width: 500, height: 500 },
          maxWidth: 120,
          maxHeight: 90,
        }),
      })
    ).json();
    assert.equal(obsZoom.ok, true);
    assert.deepEqual(obsZoom.logicalSize, { width: 1600, height: 900 });
    assert.deepEqual(obsZoom.cropBounds, { x: 800, y: 450, width: 800, height: 450 });
    const zoomedBuf = Buffer.from(obsZoom.imageBase64, 'base64');
    const zoomedDims = readPngDimensions(zoomedBuf);
    assert.ok(zoomedDims.width <= 120 && zoomedDims.height <= 90);
    const decodedZoom = decodePngToRgba(zoomedBuf);
    assert.equal(decodedZoom.rgba[0], (160 * 5 + 7 * 13) & 0xff);
    assert.equal(decodedZoom.rgba[1], (90 * 7 + 7 * 17) & 0xff);
    assert.equal(decodedZoom.rgba[2], ((160 + 90) * 3 + 7 * 29) & 0xff);

    const actDesktopFullScreen = await (
      await fetch(`${leaseRaw.endpoint}/v1/act`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetId: 'v42:mac-studio:desktop',
          coordinateMode: 'normalized_1000',
          actions: [
            { kind: 'click', x: 500, y: 500, button: 'left', count: 1 },
            { kind: 'scroll', x: 250, y: 250, deltaX: 0, deltaY: -120 },
          ],
        }),
      })
    ).json();
    assert.equal(actDesktopFullScreen.ok, true);
    assert.equal(actDesktopFullScreen.executed, 2);
    assert.equal(actDesktopFullScreen.lastPoint.x, 400);
    assert.equal(actDesktopFullScreen.lastPoint.y, 225);

    const actDesktopZoomRelative = await (
      await fetch(`${leaseRaw.endpoint}/v1/act`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetId: 'v42:mac-studio:desktop',
          coordinateMode: 'normalized_1000',
          zoomRelative: true,
          actions: [
            { kind: 'scroll', x: 250, y: 250, deltaX: 0, deltaY: -120 },
          ],
        }),
      })
    ).json();
    assert.equal(actDesktopZoomRelative.ok, true);
    assert.equal(actDesktopZoomRelative.lastPoint.x, 1000);
    assert.equal(actDesktopZoomRelative.lastPoint.y, 562);

    const actMobile = await (
      await fetch(`${leaseRaw.endpoint}/v1/act`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetId: 'v42:mac-studio:mobile:adb:pixel9',
          coordinateMode: 'normalized_1000',
          actions: [{ kind: 'click', x: 500, y: 500 }],
        }),
      })
    ).json();
    assert.equal(actMobile.ok, true);
    assert.equal(actMobile.lastPoint.x, 540);
    assert.equal(actMobile.lastPoint.y, 1200);

    const tkOn = await (
      await fetch(`${leaseRaw.endpoint}/v1/takeover`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ targetId: 'v42:mac-studio:desktop', active: true, holder: 'human' }),
      })
    ).json();
    assert.equal(tkOn.takeoverActive, true);
    assert.equal(tkOn.controlledBy, 'human');

    const blockedActResp = await fetch(`${leaseRaw.endpoint}/v1/act`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        targetId: 'v42:mac-studio:desktop',
        actions: [{ kind: 'click', x: 100, y: 100 }],
      }),
    });
    assert.equal(blockedActResp.status, 409);
    const blockedActBody = await blockedActResp.json();
    assert.equal(blockedActBody.code, 'human_takeover_active');
    assert.equal(blockedActBody.takeoverActive, true);
  } finally {
    await ctx.runtime.deactivate();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('Gate 7: Real Kiki hostRunner.mjs subprocess round-trip (handshake, activate, execute, panel, shutdown)', async () => {
  const ctx = await makeIsolatedEnv('host-runner');
  await ctx.runtime.deactivate();
  const hostRunnerPath = path.resolve(process.env.KIKI_HOST_RUNNER || path.join(repoRoot, '.tmp', 'hostRunner.mjs'));
  const hostRunnerSrc = await readFile(hostRunnerPath, 'utf8');
  const supportsCordisSlot = hostRunnerSrc.includes("'cordis-slot'") || hostRunnerSrc.includes('"cordis-slot"');
  const entryPath = path.join(pluginRoot, 'entry.mjs');

  const child = spawn(process.execPath, [hostRunnerPath, entryPath], {
    env: ctx.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const events = [];
  const pendingRpc = new Map();
  let nextId = 1;

  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pendingRpc.has(msg.id)) {
      const { resolve, reject, timer } = pendingRpc.get(msg.id);
      clearTimeout(timer);
      pendingRpc.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else {
      events.push(msg);
    }
  });

  const rpc = (method, params = {}, timeoutMs = 8_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`hostRunner RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pendingRpc.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };

  try {
    const hs = await rpc('handshake', { version: 1 });
    assert.equal(hs.version, 1);

    for (let i = 0; i < 40 && !events.some((e) => e.method === 'ready'); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(events.some((e) => e.method === 'ready'));
    assert.equal(events.filter((e) => e.method === 'register').length, 5);
    assert.equal(events.filter((e) => e.method === 'register-source').length, 1);

    const actRes = await rpc('activate', { dataDir: ctx.dataDir, settings: {} });
    assert.equal(actRes.ok, true);

    if (supportsCordisSlot) {
      const slotE12 = await rpc('cordis-slot', {
        pluginId: 'kiki-v42',
        generation: 1,
        slot: 'E12:server-gui-slots',
        payload: { kind: 'describe' },
        settings: {},
      });
      assert.equal(slotE12.ok, true);
      assert.equal(slotE12.value.guiSlots.some((s) => s.slot === 'status-capsule'), false);
    }

    const execPin = await rpc('execute', {
      name: 'v42_seat_run',
      args: { action: 'pin', seat_ref: 'mac-studio:%6', title: 'HostRunner Seat' },
      kikiHome: ctx.dir,
      workspaceRoot: ctx.workspaceRoot,
    });
    assert.equal(JSON.parse(execPin.output).ok, true);

    const panelState = await rpc('panel-request', {
      action: 'state',
      args: { includeUnmanaged: false },
      kikiHome: ctx.dir,
    });
    assert.equal(panelState.leased.seats.length, 1);
    assert.equal(panelState.leased.seats[0].seatRef, 'mac-studio:%6');
    assert.equal(panelState.workspaces.length, 1);

    const shut = await rpc('shutdown', {});
    assert.equal(shut, true);
  } finally {
    rl.close();
    child.kill();
    await rm(ctx.dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Gate 8: Sandbox SecurityError resilience, contained canvas coordinate math, direct Desktop/Mobile ops, and Port Pin', async () => {
  const panelJs = await readFile(path.join(pluginRoot, 'lib', 'panel-app.js'), 'utf8');
  const dummyEl = () => ({
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });

  const sandboxWindow = {
    location: { search: '?theme=dark&surface=desktop' },
    origin: 'null',
    parent: { postMessage() {} },
    addEventListener() {},
    navigator: { platform: 'Win32' },
    URLSearchParams,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 1,
    clearTimeout() {},
  };
  Object.defineProperty(sandboxWindow, 'localStorage', {
    get() {
      const err = new Error('Blocked a frame at "null" from accessing localStorage');
      err.name = 'SecurityError';
      throw err;
    },
  });
  sandboxWindow.window = sandboxWindow;
  sandboxWindow.document = {
    documentElement: dummyEl(),
    activeElement: null,
    getElementById: () => dummyEl(),
    querySelector: () => dummyEl(),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => dummyEl(),
    execCommand: () => true,
    body: dummyEl(),
  };

  vm.runInNewContext(panelJs, sandboxWindow);
  const hooks = sandboxWindow.__V42_PANEL_TEST_HOOKS__;
  assert.ok(hooks, 'panel-app.js must boot cleanly inside origin=null sandbox when localStorage throws SecurityError');

  hooks.safeStorage.set('k1', 'v1');
  assert.equal(hooks.safeStorage.get('k1'), 'v1');
  assert.equal(await hooks.copyTextSafe('hello-clipboard'), true);

  // 1600x900 desktop frame contained inside 800x600 viewport -> 800x450 content box with 75px top/bottom letterbox
  const deskRect = { left: 100, top: 50, width: 800, height: 600 };
  assert.equal(
    hooks.mapContainedCanvasPoint(deskRect, 1600, 900, 1600, 900, 500, 80, { clampToContent: false }),
    null,
    'Clicks inside top letterbox bar must be ignored rather than mis-clicking remote top edge',
  );
  const topLeft = hooks.mapContainedCanvasPoint(deskRect, 1600, 900, 1600, 900, 100, 125, { clampToContent: false });
  assert.deepEqual({ x: topLeft.x, y: topLeft.y }, { x: 0, y: 0 });
  const center = hooks.mapContainedCanvasPoint(deskRect, 1600, 900, 1600, 900, 500, 350, { clampToContent: false });
  assert.deepEqual({ x: center.x, y: center.y }, { x: 800, y: 450 });
  const bottomRight = hooks.mapContainedCanvasPoint(deskRect, 1600, 900, 1600, 900, 900, 575, { clampToContent: false });
  assert.deepEqual({ x: bottomRight.x, y: bottomRight.y }, { x: 1599, y: 899 });

  // 1080x2400 mobile frame contained inside 540x600 viewport -> 270x600 content box with 135px left/right pillarbox
  const mobRect = { left: 0, top: 0, width: 540, height: 600 };
  assert.equal(
    hooks.mapContainedCanvasPoint(mobRect, 1080, 2400, 1080, 2400, 60, 300, { clampToContent: false }),
    null,
    'Taps inside left pillarbox bar must be ignored',
  );
  const clampedSwipeEnd = hooks.mapContainedCanvasPoint(mobRect, 1080, 2400, 1080, 2400, 520, 300, { clampToContent: true });
  assert.deepEqual({ x: clampedSwipeEnd.x, y: clampedSwipeEnd.y }, { x: 1079, y: 1200 });

  // Verify workbenchService direct canvas actions, forward pinning, and ENOENT recovery state
  const ctx = await makeIsolatedEnv('canvas-direct');
  try {
    await ctx.runtime.activate({ dataDir: ctx.dataDir });
    const reqCtx = { workspaceRoot: ctx.workspaceRoot, kikiHome: ctx.dir };

    const missingState = await ctx.runtime.workbenchService.handlePanelRequest(
      'state',
      { includeUnmanaged: false },
      { ...reqCtx, settings: { v42BinPath: path.join(ctx.dir, 'nonexistent-v42.exe') } },
    );
    assert.equal(missingState.ok, true);
    assert.equal(missingState.connection.configured, false);
    assert.equal(missingState.connection.code, 'ENOENT');

    const dblClickRes = await ctx.runtime.workbenchService.handlePanelRequest(
      'desktopAct',
      { computer: 'mac-studio', op: 'click', x: 640, y: 360, button: 'left', count: 2, includeFrame: true, settleMs: 0 },
      reqCtx,
    );
    assert.equal(dblClickRes.ok, true);
    assert.equal(dblClickRes.takeover.controlledBy, 'human');
    assert.match(dblClickRes.frame.dataUrl, /^data:image\/png;base64,/);

    await ctx.runtime.workbenchService.handlePanelRequest(
      'desktopAct',
      { computer: 'mac-studio', op: 'drag', x1: 100, y1: 120, x2: 420, y2: 340, button: 'left' },
      reqCtx,
    );
    await ctx.runtime.workbenchService.handlePanelRequest(
      'desktopAct',
      { computer: 'mac-studio', op: 'scroll', x: 500, y: 400, dx: 0, dy: -160 },
      reqCtx,
    );
    await ctx.runtime.workbenchService.handlePanelRequest(
      'desktopAct',
      { computer: 'mac-studio', op: 'paste', text: 'Clipboard direct payload' },
      reqCtx,
    );

    const longPressRes = await ctx.runtime.workbenchService.handlePanelRequest(
      'mobileAct',
      {
        computer: 'mac-studio',
        deviceId: 'adb:pixel9',
        op: 'longPress',
        x: 540,
        y: 1200,
        durationMs: 650,
        includeFrame: true,
        settleMs: 0,
      },
      reqCtx,
    );
    assert.equal(longPressRes.ok, true);
    assert.equal(longPressRes.takeover.controlledBy, 'human');
    assert.match(longPressRes.frame.dataUrl, /^data:image\/png;base64,/);

    await ctx.runtime.workbenchService.handlePanelRequest(
      'mobileAct',
      {
        computer: 'mac-studio',
        deviceId: 'adb:pixel9',
        op: 'scroll',
        x: 540,
        y: 1400,
        dx: 0,
        dy: 320,
        screenWidth: 1080,
        screenHeight: 2400,
      },
      reqCtx,
    );
    await ctx.runtime.workbenchService.handlePanelRequest(
      'mobileAct',
      { computer: 'mac-studio', deviceId: 'adb:pixel9', op: 'paste', text: 'Mobile clipboard text' },
      reqCtx,
    );

    const mockState = JSON.parse(await readFile(ctx.stateFile, 'utf8'));
    assert.ok(mockState.desktopOps.some((o) => o.op === 'click' && o.count === 2 && o.x === 640 && o.y === 360));
    assert.ok(mockState.desktopOps.some((o) => o.op === 'drag' && o.x1 === 100 && o.x2 === 420));
    assert.ok(mockState.desktopOps.some((o) => o.op === 'scroll' && o.dy === -160));
    assert.ok(mockState.desktopOps.some((o) => o.op === 'clipboard_set' && o.text === 'Clipboard direct payload'));
    assert.ok(mockState.mobileOps.some((o) => o.op === 'long-press' && o.args.includes('650')));
    assert.ok(mockState.mobileOps.some((o) => o.op === 'swipe' && o.args.includes('1080')));
    assert.ok(mockState.mobileOps.some((o) => o.op === 'type' && o.stdinText === 'Mobile clipboard text'));

    const fwdCreated = await ctx.runtime.workbenchService.handlePanelRequest(
      'forwardStart',
      { computer: 'mac-studio', remotePort: 3080 },
      reqCtx,
    );
    assert.equal(fwdCreated.ok, true);
    const lp = fwdCreated.tunnel.localPort;

    await ctx.runtime.workbenchService.handlePanelRequest(
      'pin',
      { kind: 'forward', computer: 'mac-studio', remotePort: 3080, localPort: lp },
      reqCtx,
    );
    const statePinned = await ctx.runtime.workbenchService.handlePanelRequest('state', {}, reqCtx);
    assert.equal(statePinned.forwards[0].pinned, true);

    await ctx.runtime.workbenchService.handlePanelRequest(
      'unpin',
      { kind: 'forward', computer: 'mac-studio', remotePort: 3080 },
      reqCtx,
    );
    const stateUnpinned = await ctx.runtime.workbenchService.handlePanelRequest('state', {}, reqCtx);
    assert.equal(stateUnpinned.forwards[0].pinned, false);
  } finally {
    await ctx.runtime.deactivate();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('P0-2 & P2-2: V42CuaProviderServer SWR caches collectTargets + parallelizes mobileDevices, and resolveV42Binary caches 60s', async () => {
  let listComputersCalls = 0;
  let mobileCalls = 0;
  let listComputersDelayMs = 20;

  const mockV42Client = {
    async listComputers() {
      listComputersCalls += 1;
      await new Promise((r) => setTimeout(r, listComputersDelayMs));
      return [
        { id: 'c1', name: 'Comp 1', online: true, featureset: ['desktop.v1', 'mobile.v1'] },
        { id: 'c2', name: 'Comp 2', online: true, featureset: ['desktop.v1', 'mobile.v1'] },
        { id: 'c3', name: 'Comp 3', online: true, featureset: ['desktop.v1', 'mobile.v1'] },
      ];
    },
    async mobileDevices({ computer }) {
      mobileCalls += 1;
      await new Promise((r) => setTimeout(r, 120));
      if (computer === 'c2') throw new Error('simulated transient offline');
      return [{ id: `dev-${computer}`, name: `Phone ${computer}`, platform: 'android', state: 'online', width: 1080, height: 2400 }];
    },
  };
  const mockLeaseStore = {
    async load() {},
    getManagedDesktops: () => [],
    getManagedMobiles: () => [],
    getTakeover: () => ({ active: false, controlledBy: 'agent' }),
  };

  const provider = new V42CuaProviderServer({
    v42Client: mockV42Client,
    desktopSessions: { acquire() {} },
    leaseStore: mockLeaseStore,
    pluginRoot,
  });

  // Concurrent cold calls deduplicate single-flight AND parallelize 3x120ms mobileDevices via Promise.allSettled
  const t0 = performance.now();
  const [res1, res2] = await Promise.all([provider.collectTargets(), provider.collectTargets()]);
  const parallelElapsed = performance.now() - t0;
  assert.equal(listComputersCalls, 1, 'Concurrent collectTargets must deduplicate single-flight');
  assert.equal(mobileCalls, 3);
  assert.ok(parallelElapsed < 320, `3x120ms mobileDevices must run in parallel (<320ms), took ${parallelElapsed.toFixed(1)}ms`);
  assert.equal(res1.length, 5); // 3 desktops + 2 online mobiles (c2 failed gracefully)
  assert.equal(res2.length, 5);

  // Within 15s TTL, returns cached immediately without touching CLI
  const cached = await provider.collectTargets();
  assert.equal(listComputersCalls, 1);
  assert.equal(cached.length, 5);

  // Expired cache returns stale immediately (SWR) while refreshing in background
  provider.targetsCache.at = Date.now() - 20_000;
  listComputersDelayMs = 400;
  const tStale = performance.now();
  const stale = await provider.collectTargets();
  const staleMs = performance.now() - tStale;
  assert.ok(staleMs < 80, `Stale collectTargets SWR must return immediately, took ${staleMs.toFixed(1)}ms`);
  assert.equal(stale.length, 5);

  // P2-2: resolveV42Binary caches by (v42BinPath, PATH) for 60s
  clearResolveV42BinaryCache();
  const dir = path.join(testScratchBase, `bin-cache-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const fakeBin = path.join(dir, 'v42-fake.mjs');
  await writeFile(fakeBin, 'console.log("{}");\n', 'utf8');
  try {
    const first = await resolveV42Binary({ settings: { v42BinPath: fakeBin }, env: { PATH: '' } });
    assert.equal(first, path.resolve(fakeBin));
    // Delete the file on disk; cached entry still returns within 60s TTL
    await rm(fakeBin, { force: true });
    const cachedBin = await resolveV42Binary({ settings: { v42BinPath: fakeBin }, env: { PATH: '' } });
    assert.equal(cachedBin, path.resolve(fakeBin));
    // Different PATH key bypasses cache and sees ENOENT
    await assert.rejects(
      () => resolveV42Binary({ settings: { v42BinPath: fakeBin }, env: { PATH: '/other' } }),
      { code: 'ENOENT' },
    );
  } finally {
    clearResolveV42BinaryCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('P0-6: PortForwardManager uses stdio ignore for stdin and handles child spawn error without crashing host', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const spawnCalls = [];

  const mgr = new PortForwardManager({
    resolveBin: async () => '/mock/missing-v42',
    spawnFn: (bin, argv, opts) => {
      spawnCalls.push({ bin, argv, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = undefined;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; };
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn /mock/missing-v42 ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    },
  });

  await assert.rejects(
    () => mgr.start({ computer: 'mac-studio', remotePort: 8080 }),
    /Failed to spawn v42 forward process/,
  );
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('P1-3: V42DesktopControlSession kills child and resets on open/command timeout, and panel-app.js closes streamPort on pagehide', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const spawned = [];

  // 1. openTimer timeout kills hung child and resets this.child = null
  const openTimeoutSession = new V42DesktopControlSession({
    computer: 'mac-studio',
    openTimeoutMs: 60,
    idleTimeoutMs: 0,
    resolveBin: async () => '/mock/v42',
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 1;
        child.emit('exit', 1);
      };
      spawned.push(child);
      return child;
    },
  });
  await assert.rejects(() => openTimeoutSession.ensureStarted(), /Timed out opening desktop control session/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].killed, true);
  assert.equal(openTimeoutSession.child, null);

  // 2. command() timeout kills hung child, resets this.child = null, and next command spawns fresh worker
  const cmdChildren = [];
  const cmdSession = new V42DesktopControlSession({
    computer: 'mac-studio',
    openTimeoutMs: 2_000,
    idleTimeoutMs: 0,
    resolveBin: async () => '/mock/v42',
    spawnFn: () => {
      const idx = cmdChildren.length;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 1;
        child.emit('exit', 1);
      };
      cmdChildren.push(child);
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ event: 'status', display: { width: 1920, height: 1080 } }) + '\n');
      });
      if (idx >= 1) {
        child.stdin.on('data', (chunk) => {
          for (const line of chunk.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            const req = JSON.parse(line);
            if (req.op === 'close') { child.kill(); return; }
            child.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { alive: true } }) + '\n');
          }
        });
      }
      return child;
    },
  });

  await assert.rejects(() => cmdSession.command('status', {}, { timeoutMs: 60 }), /timed out/);
  assert.equal(cmdChildren.length, 1);
  assert.equal(cmdChildren[0].killed, true);
  assert.equal(cmdSession.child, null);

  const recovered = await cmdSession.command('status', {}, { timeoutMs: 1_000 });
  assert.equal(cmdChildren.length, 2);
  assert.deepEqual(recovered, { alive: true });
  await cmdSession.close();

  // 3. panel-app.js registers pagehide cleanup for streamPort
  const panelJs = await readFile(path.join(pluginRoot, 'lib', 'panel-app.js'), 'utf8');
  assert.match(panelJs, /addEventListener\(['"]pagehide['"]/);
  assert.match(panelJs, /__kikiStreamControl:\s*['"]close['"]/);
});

test('Gate 9: Companion-root auto-discovery, --agent-name kiki, resources terminal flattening, and stale transfer lock pruning', async () => {
  const scratch = path.join(testScratchBase, `companion-discovery-${Date.now()}`);
  const fakeHome = path.join(scratch, 'home');
  const winCompRoot = path.join(fakeHome, 'AppData', 'Local', 'ai.vibecafe.v42.companion');
  const cliDir = path.join(winCompRoot, 'cli');
  await mkdir(path.join(winCompRoot, 'data'), { recursive: true });
  await mkdir(cliDir, { recursive: true });
  await writeFile(path.join(cliDir, 'delegated-session-default.json'), '{"tokens":{}}\n', 'utf8');
  await writeFile(path.join(cliDir, 'profile-default.lock'), '', 'utf8');

  const staleLock = path.join(cliDir, 'transfer-0123456789abcdef.lock');
  const freshLock = path.join(cliDir, 'transfer-fedcba9876543210.lock');
  const nonEmptyLock = path.join(cliDir, 'transfer-aaaaaaaaaaaaaaaa.lock');
  await writeFile(staleLock, '', 'utf8');
  await writeFile(freshLock, '', 'utf8');
  await writeFile(nonEmptyLock, 'busy', 'utf8');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  await utimes(staleLock, twoHoursAgo, twoHoursAgo);

  try {
    // Stripped Windows env (missing LOCALAPPDATA) still discovers companion root via USERPROFILE
    const roots = await discoverCompanionRoots({
      env: { USERPROFILE: fakeHome },
      platform: 'win32',
    });
    assert.ok(roots.includes(path.resolve(winCompRoot)), 'Must discover Windows companion root even when LOCALAPPDATA is stripped');

    // Global args always identify as kiki and pass --companion-root
    const globalArgs = buildGlobalArgs({}, { companionRoot: winCompRoot });
    assert.deepEqual(globalArgs, ['--format', 'json', '--agent-name', 'kiki', '--companion-root', winCompRoot]);

    // Stale 0-byte transfer locks are pruned while fresh, non-empty, and profile locks are kept
    const pruned = await pruneStaleTransferLocks(winCompRoot);
    assert.equal(pruned.removed, 1);
    await assert.rejects(() => stat(staleLock));
    assert.ok((await stat(freshLock)).isFile());
    assert.ok((await stat(nonEmptyLock)).isFile());
    assert.ok((await stat(path.join(cliDir, 'profile-default.lock'))).isFile());

    // Grouped v42 resources.terminals flattens cleanly for v42 0.0.0 compatibility
    const flat = flattenResourcesTerminals({
      computers: [
        { id: 'i-mac', name: 'Studio Mac Mini', online: true, platform: 'macos' },
        { id: 'i-win', name: 'dev-laptop', online: true, platform: 'windows' },
      ],
      workspaces: [
        { id: 'ws-1', name: 'example-app', computer_id: 'i-mac', path: '/Users/dev/example-app' },
      ],
      terminals: [
        {
          computer_id: 'i-mac',
          status: 'ok',
          terminals: [
            {
              id: '@2',
              name: 'OMP',
              active: false,
              workspaceId: 'ws-1',
              panes: [{ id: '%2', active: true, currentCommand: 'omp', currentPath: '/Users/dev/example-app', title: 'task' }],
            },
            {
              id: '@3',
              name: 'zsh',
              active: true,
              panes: [{ id: '%3', active: true, currentCommand: 'zsh', currentPath: '/Users/dev', title: '~' }],
            },
          ],
        },
      ],
    }, { computer: 'Studio Mac Mini', workspace: 'example-app' });
    assert.equal(flat.terminals.length, 1);
    assert.equal(flat.terminals[0].computer_id, 'i-mac');
    assert.equal(flat.terminals[0].window_id, '@2');
    assert.equal(flat.terminals[0].pane_id, '%2');
    assert.equal(flat.terminals[0].agent.app, 'omp');
    assert.equal(flat.terminals[0].idle, false);

    // terminalSend puts flags (--key, --enter) BEFORE -- <text>
    const capturedArgvs = [];
    const client = new V42Client({ env: { KIKI_V42_BIN: mockV42Script } });
    client.runJson = async (argv) => {
      capturedArgvs.push(argv);
      return { sent: true };
    };
    await client.terminalSend('mac-studio', '@3', { text: 'echo hi', keys: ['tab'], enter: true });
    assert.deepEqual(capturedArgvs[0], ['term', 'send', '--key', 'tab', '--enter', 'mac-studio', '@3', '--', 'echo hi']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('P1: copyTransfer/syncTransfer immediately unlink newly created 0-byte transfer locks without racing concurrent transfers, and startup resolveTarget prunes stale locks', async () => {
  const scratch = path.join(testScratchBase, `transfer-lock-cleanup-${Date.now()}`);
  const compRoot = path.join(scratch, 'companion');
  const cliDir = path.join(compRoot, 'cli');
  await mkdir(path.join(compRoot, 'data'), { recursive: true });
  await mkdir(cliDir, { recursive: true });

  const listLocks = async () => (await readdir(cliDir)).filter((name) => /^transfer-[0-9a-f]+\.lock$/i.test(name)).sort();

  try {
    // 1. One-shot startup / v42_fleet resolveTarget prunes pre-existing stale (>60s) locks without calling cp/sync
    const startupStale = path.join(cliDir, 'transfer-0000111122223333.lock');
    await writeFile(startupStale, '', 'utf8');
    const twoMinAgo = new Date(Date.now() - 120_000);
    await utimes(startupStale, twoMinAgo, twoMinAgo);

    const client = new V42Client({
      env: { KIKI_V42_BIN: mockV42Script, V42_COMPANION_ROOT: compRoot },
    });
    const resolved = await client.resolveTarget({ skipWhoamiProbe: true });
    assert.equal(path.resolve(resolved.companionRoot), path.resolve(compRoot));
    // Wait briefly for the one-shot async startup prune
    for (let i = 0; i < 20; i += 1) {
      if ((await listLocks()).length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(await listLocks(), [], 'resolveTarget must prune stale >60s transfer locks on first resolution');

    // 2. Successful copyTransfer immediately leaves 0 newly created transfer-*.lock files
    client.runJson = async (argv) => {
      if (argv[0] === 'cp') {
        await writeFile(path.join(cliDir, 'transfer-a1b2c3d4e5f60001.lock'), '', 'utf8');
        return { copied: 1 };
      }
      if (argv[0] === 'sync') {
        await writeFile(path.join(cliDir, 'transfer-a1b2c3d4e5f60002.lock'), '', 'utf8');
        throw new Error('simulated sync failure');
      }
      return {};
    };
    const cpRes = await client.copyTransfer('local/a.txt', 'mac-studio:/tmp/a.txt', { skipWhoamiProbe: true });
    assert.deepEqual(cpRes, { copied: 1 });
    assert.deepEqual(await listLocks(), [], 'copyTransfer must leave 0 residual transfer-*.lock files immediately after settling');

    // 3. Failed/aborted syncTransfer also immediately leaves 0 newly created transfer-*.lock files
    await assert.rejects(
      () => client.syncTransfer('local/dir', 'mac-studio:/tmp/dir', { skipWhoamiProbe: true }),
      /simulated sync failure/,
    );
    assert.deepEqual(await listLocks(), [], 'failed syncTransfer must leave 0 residual transfer-*.lock files immediately after settling');

    // 4. Concurrent cp + sync do not delete each other's active lock while the second is in flight,
    //    and preserve a pre-existing fresh (<60s) external lock while cleaning both newly created locks once active hits 0
    const externalFreshLock = 'transfer-eeeeeeeeeeeeeeee.lock';
    await writeFile(path.join(cliDir, externalFreshLock), '', 'utf8');

    let releaseSecond;
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    const lockA = 'transfer-1111111111111111.lock';
    const lockB = 'transfer-2222222222222222.lock';
    let firstCreated;
    const bothStarted = new Promise((resolve) => { firstCreated = resolve; });
    let startedCount = 0;

    client.runJson = async (argv) => {
      if (argv[0] === 'cp') {
        await writeFile(path.join(cliDir, lockA), '', 'utf8');
        startedCount += 1;
        if (startedCount === 2) firstCreated();
        await bothStarted;
        return { ok: 'cp' };
      }
      await writeFile(path.join(cliDir, lockB), '', 'utf8');
      startedCount += 1;
      if (startedCount === 2) firstCreated();
      await secondGate;
      return { ok: 'sync' };
    };

    const pCp = client.copyTransfer('local/1', 'mac-studio:/tmp/1', { skipWhoamiProbe: true });
    const pSync = client.syncTransfer('local/2', 'mac-studio:/tmp/2', { skipWhoamiProbe: true });
    await pCp;
    // While pSync is still active, lockB MUST remain untouched!
    assert.ok((await listLocks()).includes(lockB), 'Active concurrent transfer lock must not be deleted before active count hits 0');
    releaseSecond();
    await pSync;
    // Once active count hits 0, both lockA and lockB are gone, while external fresh lock remains safe
    assert.deepEqual(await listLocks(), [externalFreshLock], 'All newly created locks must be unlinked once concurrent batch hits active=0');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
