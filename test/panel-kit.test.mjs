import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createSafeStorage,
  copyTextSafe,
  randomId,
  applyThemeName,
  initThemeFromUrl,
  applyPresentation,
  PANEL_CHANNEL,
  DEFAULT_RPC_TIMEOUT_MS,
  createPanelClient,
  openManagedStream,
  computeVirtualPinchPair,
  attachRemotePointer,
  copyTextSyncGesture,
  attachSandboxClipboard,
  sanitizeDropFileName,
  attachRemoteDropZone,
  createRemoteLeaseBar,
  attachRemoteMagnifier,
} from '../shared/panel-kit/index.mjs';
import { createRemoteLeaseStore } from '../shared/panel-kit/remote-lease.mjs';
import { buildPanelKitAssets, syncPanelKit } from '../scripts/sync-panel-kit.mjs';

test('safeStorage survives opaque sandbox SecurityError and falls back to in-memory Map', () => {
  const brokenWin = {};
  Object.defineProperty(brokenWin, 'localStorage', {
    get() {
      throw new Error('SecurityError: sandboxed iframe');
    },
  });
  const storage = createSafeStorage(brokenWin);
  assert.equal(storage.get('missing'), null);
  storage.set('tab', 'dns');
  assert.equal(storage.get('tab'), 'dns');
  storage.remove('tab');
  assert.equal(storage.get('tab'), null);

  const backing = new Map();
  const workingWin = {
    localStorage: {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, v),
      removeItem: (k) => backing.delete(k),
    },
  };
  const persisted = createSafeStorage(workingWin);
  persisted.set('lang', 'zh');
  assert.equal(backing.get('lang'), 'zh');
  assert.equal(persisted.get('lang'), 'zh');
});

test('copyTextSafe prefers Clipboard API and falls back to hidden textarea + execCommand(copy)', async () => {
  let clipboardWritten = '';
  const okClipboard = await copyTextSafe('hello-clip', {
    navigatorObj: {
      clipboard: {
        writeText: async (text) => {
          clipboardWritten = text;
        },
      },
    },
  });
  assert.equal(okClipboard, true);
  assert.equal(clipboardWritten, 'hello-clip');

  const appended = [];
  let removed = false;
  let selected = false;
  const fakeDoc = {
    body: { append: (node) => appended.push(node) },
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      select() { selected = true; },
      remove() { removed = true; },
    }),
    execCommand: (cmd) => cmd === 'copy',
  };
  const okFallback = await copyTextSafe('fallback-text', {
    navigatorObj: { clipboard: { writeText: async () => { throw new Error('blocked'); } } },
    documentObj: fakeDoc,
  });
  assert.equal(okFallback, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].value, 'fallback-text');
  assert.equal(selected, true);
  assert.equal(removed, true);
});

test('randomId generates non-empty unique identifiers with optional prefix', () => {
  const a = randomId('req-');
  const b = randomId('req-');
  assert.ok(a.startsWith('req-'));
  assert.notEqual(a, b);
});

test('applyPresentation synchronizes theme, host --color-* tokens only, and locale callback', () => {
  const attrs = new Map();
  const styleProps = new Map();
  const root = {
    dataset: {},
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    style: { setProperty: (k, v) => styleProps.set(k, v) },
  };

  assert.equal(initThemeFromUrl({ search: '?theme=dark', root }), 'dark');
  assert.equal(attrs.get('data-theme'), 'dark');
  assert.equal(root.dataset.theme, 'dark');

  let receivedLocale = '';
  const res = applyPresentation(
    {
      theme: 'light',
      locale: 'zh-CN',
      tokens: {
        '--color-canvas': '#f6f4ef',
        '--color-accent': '#1e5a49',
        '--not-allowed': 'red',
        '--color-empty': '   ',
      },
    },
    {
      root,
      onLocale: (loc) => { receivedLocale = loc; },
    },
  );
  assert.equal(res.theme, 'light');
  assert.equal(res.locale, 'zh-CN');
  assert.equal(receivedLocale, 'zh-CN');
  assert.deepEqual(res.appliedTokens, ['--color-canvas', '--color-accent']);
  assert.equal(styleProps.get('--color-canvas'), '#f6f4ef');
  assert.equal(styleProps.get('--color-accent'), '#1e5a49');
  assert.equal(styleProps.has('--not-allowed'), false);
  assert.equal(attrs.get('data-theme'), 'light');

  applyThemeName('auto', root);
  assert.equal(attrs.has('data-theme'), false);
  assert.equal(root.dataset.theme, undefined);
});

test('createPanelClient enforces RPC timeout, cleans up pending requests, and manages openStream lifecycle', async () => {
  const listeners = [];
  const posted = [];
  const parentObj = {
    postMessage(msg, targetOrigin) {
      posted.push({ msg, targetOrigin });
    },
  };
  const winObj = {
    parent: parentObj,
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener(type, fn) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  let inited = false;
  let presented = null;
  const client = createPanelClient({
    windowObj: winObj,
    parentObj,
    defaultTimeoutMs: 40,
    autoApplyPresentation: false,
    onInit: () => { inited = true; },
    onPresentation: (pres) => { presented = pres; },
  });

  assert.equal(DEFAULT_RPC_TIMEOUT_MS, 20_000);
  assert.equal(client.isReady(), false);

  // Deliver init with presentation + origin
  for (const fn of listeners) {
    fn({
      source: parentObj,
      origin: 'https://kiki.local',
      data: { channel: PANEL_CHANNEL, kind: 'init', presentation: { theme: 'dark', tokens: { '--color-canvas': '#141413' } } },
    });
  }
  assert.equal(inited, true);
  assert.equal(client.isReady(), true);
  assert.equal(client.getOrigin(), 'https://kiki.local');
  assert.equal(presented.theme, 'dark');

  // Successful RPC
  const callPromise = client.call('status', { probe: true });
  assert.equal(client.pendingCount(), 1);
  assert.equal(posted[0].targetOrigin, 'https://kiki.local');
  assert.equal(posted[0].msg.method, 'plugin.call');
  for (const fn of listeners) {
    fn({
      source: parentObj,
      data: { channel: PANEL_CHANNEL, kind: 'response', id: posted[0].msg.id, ok: true, result: { alive: true } },
    });
  }
  assert.deepEqual(await callPromise, { alive: true });
  assert.equal(client.pendingCount(), 0);

  // Timeout cleanup — never leaks pending map
  await assert.rejects(
    () => client.call('slowAction', {}, { timeoutMs: 25, timeoutMessage: 'Timed out cleanly' }),
    (err) => err.message === 'Timed out cleanly' && err.code === 'timeout',
  );
  assert.equal(client.pendingCount(), 0);

  // Managed stream subscription & clean close
  const portSent = [];
  let portClosed = false;
  const fakePort = {
    onmessage: null,
    onmessageerror: null,
    postMessage: (m) => portSent.push(m),
    close: () => { portClosed = true; },
  };
  const receivedFrames = [];
  let closeReason = '';
  const streamPromise = openManagedStream(client, 'preview', { targetId: 'local:primary' }, {
    onMessage: (d) => receivedFrames.push(d),
    onClose: (r) => { closeReason = r; },
  });
  const streamReq = posted.at(-1).msg;
  assert.equal(streamReq.method, 'plugin.openStream');
  for (const fn of listeners) {
    fn({
      source: parentObj,
      ports: [fakePort],
      data: { channel: PANEL_CHANNEL, kind: 'response', id: streamReq.id, ok: true, result: { ok: true } },
    });
  }
  const stream = await streamPromise;
  fakePort.onmessage({ data: { frame: 1 } });
  assert.deepEqual(receivedFrames, [{ frame: 1 }]);
  stream.close();
  assert.deepEqual(portSent, [{ __kikiStreamControl: 'close' }]);
  assert.equal(portClosed, true);
  assert.equal(closeReason, '');

  client.dispose();
  assert.equal(listeners.length, 0);
});

test('buildPanelKitAssets produces classic-JS inline bundle with zero Emoji and sync-panel-kit --check passes', async () => {
  const { themeCss, runtimeJs, remoteCss, remoteJs } = await buildPanelKitAssets();
  assert.match(themeCss, /--bg:\s*var\(--color-canvas,\s*#f6f4ef\)/);
  assert.match(themeCss, /--accent:\s*var\(--color-accent,\s*#2c5e4f\)/);
  assert.match(runtimeJs, /KikiPanelKit/);
  assert.match(runtimeJs, /execCommand\('copy'\)/);
  assert.match(remoteJs, /KikiRemoteKit/);
  assert.equal(/\p{Extended_Pictographic}/u.test(themeCss + runtimeJs + remoteCss + remoteJs), false);

  const ctx = vm.createContext({ Map, Set, Promise, Error, Object, Array, String, Number, Boolean, Math, Date, URLSearchParams, Uint8Array, setTimeout, clearTimeout });
  vm.runInContext(`${runtimeJs}\n${remoteJs}\nthis.exportedKit = KikiPanelKit;\nthis.exportedRemote = KikiRemoteKit;`, ctx);
  assert.equal(typeof ctx.exportedKit.safeStorage.get, 'function');
  assert.equal(typeof ctx.exportedKit.copyTextSafe, 'function');
  assert.equal(typeof ctx.exportedKit.applyPresentation, 'function');
  assert.equal(typeof ctx.exportedKit.createPanelClient, 'function');
  assert.equal(typeof ctx.exportedKit.openManagedStream, 'function');
  assert.equal(typeof ctx.exportedRemote.attachRemotePointer, 'function');
  assert.equal(typeof ctx.exportedRemote.attachSandboxClipboard, 'function');
  assert.equal(typeof ctx.exportedRemote.attachRemoteDropZone, 'function');
  assert.equal(typeof ctx.exportedRemote.createRemoteLeaseBar, 'function');
  assert.equal(typeof ctx.exportedRemote.attachRemoteMagnifier, 'function');

  const { synced } = await syncPanelKit({ check: true });
  assert.equal(synced.length, 13, `Expected all 13 business panels synced, got ${synced.length}`);
  assert.ok(synced.includes('plugins/official/kiki-uu-remote/panel.html'));
});

test('createRemoteLeaseStore isolates targets, aborts in-flight agent ops on takeover, and omits plaintext from human summary', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kiki-lease-test-'));
  try {
    let clock = 1000;
    const store = createRemoteLeaseStore({ dataDir: tmpDir, debounceMs: 80, nowFn: () => clock });
    await store.ensureLoaded();

    const opA = store.registerAbortableOp('device-a');
    const opB = store.registerAbortableOp('device-b');
    assert.equal(opA.signal.aborted, false);

    // Engage takeover on device-a: aborts device-a immediately, leaves device-b untouched
    const locked = store.setTakeover('device-a', { active: true, holder: 'human', reason: 'Captcha input' });
    assert.equal(locked.active, true);
    assert.equal(opA.signal.aborted, true);
    assert.equal(opB.signal.aborted, false);
    assert.equal(store.checkAgentAllowed('device-a').allowed, false);
    assert.equal(store.checkAgentAllowed('device-a').code, 'human_takeover_active');
    assert.equal(store.checkAgentAllowed('device-b').allowed, true);

    // Record human actions: typed secret MUST never appear in summary
    store.recordHumanAction('device-a', { kind: 'tap', x: 540, y: 1200 });
    store.recordHumanAction('device-a', { kind: 'type', text: 's3cr3tPass!' });
    clock += 500;
    store.recordHumanAction('device-a', { kind: 'paste', text: '1234' });
    const summaryJson = JSON.stringify(store.getHumanSummary('device-a'));
    assert.equal(summaryJson.includes('s3cr3tPass!'), false);
    assert.match(summaryJson, /typed 15 chars/);
    assert.match(summaryJson, /tap@\(540,1200\)/);

    const released = store.setTakeover('device-a', { active: false });
    assert.equal(released.active, false);
    assert.equal(released.lastHumanSummary.length, 2);
    assert.equal(store.checkAgentAllowed('device-a').allowed, true);

    store.upsertLease('device-a', { pinned: true, label: 'Test Phone' });
    await store.flush();
    const persisted = JSON.parse(await readFile(path.join(tmpDir, 'remote-leases.json'), 'utf8'));
    assert.equal(persisted.leases['device-a'].pinned, true);

    opA.cleanup();
    opB.cleanup();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('attachRemotePointer coalesces pointermove/wheel via rAF without delaying pointerdown or dropping pointerup, plus Ctrl+Drag pinch', () => {
  const handlers = new Map();
  let rafQueue = [];
  let nextRafId = 1;
  const winObj = {
    requestAnimationFrame(fn) {
      const id = nextRafId++;
      rafQueue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      rafQueue = rafQueue.filter((item) => item.id !== id);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const surface = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 1000 }),
    addEventListener: (k, fn) => handlers.set(k, fn),
    removeEventListener: (k) => handlers.delete(k),
    setPointerCapture() {},
    focus() {},
  };

  const events = [];
  let clock = 100;
  const ptr = attachRemotePointer(surface, {
    windowObj: winObj,
    nowFn: () => clock,
    enableVirtualPinch: true,
    getLogicalSize: () => ({ width: 1000, height: 2000 }),
    onPointerDown: (pt, meta) => events.push({ type: 'down', x: pt.targetX, y: pt.targetY, clickCount: meta.clickCount }),
    onPointerMove: (pt, meta) => events.push({ type: 'move', x: pt.targetX, y: pt.targetY, dragging: meta.dragging }),
    onPointerUp: (pt, meta) => events.push({ type: 'up', x: pt.targetX, y: pt.targetY, clickCount: meta.clickCount }),
    onWheel: (_pt, meta) => events.push({ type: 'wheel', dx: meta.deltaX, dy: meta.deltaY }),
    onPinch: (pinch) => events.push({ type: 'pinch', phase: pinch.phase, p1: pinch.primary, p2: pinch.secondary }),
  });

  // Immediate click + burst of 4 moves before rAF ticks -> coalesced into 1 move flushed before pointerup
  handlers.get('pointerdown')({ pointerId: 1, button: 0, buttons: 1, clientX: 250, clientY: 500 });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'down', x: 500, y: 1000, clickCount: 1 });

  handlers.get('pointermove')({ pointerId: 1, button: 0, buttons: 1, clientX: 260, clientY: 510 });
  handlers.get('pointermove')({ pointerId: 1, button: 0, buttons: 1, clientX: 270, clientY: 520 });
  handlers.get('pointermove')({ pointerId: 1, button: 0, buttons: 1, clientX: 300, clientY: 600 });
  assert.equal(rafQueue.length, 1);
  handlers.get('pointerup')({ pointerId: 1, button: 0, buttons: 0, clientX: 300, clientY: 600 });
  assert.equal(events.length, 3);
  assert.equal(events[1].type, 'move');
  assert.equal(events[1].x, 599);
  assert.equal(events[2].type, 'up');

  // Double-click within 500ms on stationary spot increments clickCount immediately on pointerdown (never after a drag)
  clock = 200;
  handlers.get('pointerdown')({ pointerId: 2, button: 0, buttons: 1, clientX: 300, clientY: 600 });
  assert.equal(events.at(-1).clickCount, 1);
  handlers.get('pointerup')({ pointerId: 2, button: 0, buttons: 0, clientX: 300, clientY: 600 });
  clock = 340;
  handlers.get('pointerdown')({ pointerId: 3, button: 0, buttons: 1, clientX: 301, clientY: 601 });
  assert.equal(events.at(-1).clickCount, 2);
  handlers.get('pointerup')({ pointerId: 3, button: 0, buttons: 0, clientX: 301, clientY: 601 });

  // Coalesced wheel
  handlers.get('wheel')({ clientX: 250, clientY: 500, deltaX: 0, deltaY: 40, preventDefault() {} });
  handlers.get('wheel')({ clientX: 250, clientY: 500, deltaX: 5, deltaY: 60, preventDefault() {} });
  assert.equal(rafQueue.length, 1);
  rafQueue.shift().fn();
  assert.deepEqual(events.at(-1), { type: 'wheel', dx: 5, dy: 100 });

  // Ctrl+Drag virtual two-finger pinch symmetric around (0.5, 0.5)
  const pair = computeVirtualPinchPair(0.2, 0.3, 0.5, 0.5);
  assert.ok(Math.abs(pair.secondary.normX - 0.8) < 1e-6);
  assert.ok(Math.abs(pair.secondary.normY - 0.7) < 1e-6);
  handlers.get('pointerdown')({ pointerId: 4, button: 0, buttons: 1, ctrlKey: true, clientX: 100, clientY: 200 });
  assert.equal(events.at(-1).type, 'pinch');
  assert.equal(events.at(-1).phase, 'down');
  handlers.get('pointerup')({ pointerId: 4, button: 0, buttons: 0, ctrlKey: true, clientX: 100, clientY: 200 });
  assert.equal(events.at(-1).phase, 'up');

  ptr.dispose();
});

test('attachSandboxClipboard handles 60ms pasteHold window and synchronous Remote->Host pill copy without navigator.clipboard', async () => {
  const winListeners = new Map();
  const docListeners = new Map();
  const winObj = {
    navigator: { language: 'zh-CN' },
    addEventListener: (k, fn) => winListeners.set(k, fn),
    removeEventListener: (k) => winListeners.delete(k),
  };
  let copiedViaExec = '';
  const pillHandlers = new Map();
  const pillEl = {
    hidden: true,
    textContent: '',
    addEventListener: (k, fn) => pillHandlers.set(k, fn),
    removeEventListener: (k) => pillHandlers.delete(k),
  };
  const hiddenHandlers = new Map();
  const hiddenInput = {
    value: '',
    tagName: 'TEXTAREA',
    focus() { docObj.activeElement = hiddenInput; },
    addEventListener: (k, fn) => hiddenHandlers.set(k, fn),
  };
  const docObj = {
    activeElement: null,
    body: { append() {} },
    addEventListener: (k, fn) => docListeners.set(k, fn),
    removeEventListener: (k) => docListeners.delete(k),
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      focus() {},
      select() {},
      remove() {},
    }),
    execCommand(cmd) {
      if (cmd !== 'copy') return false;
      const copyFn = docListeners.get('copy');
      if (copyFn) {
        copyFn({
          clipboardData: { setData: (_m, v) => { copiedViaExec = v; } },
          preventDefault() {},
        });
      }
      return true;
    },
  };

  const pasted = [];
  let fallbackCount = 0;
  const clip = attachSandboxClipboard({
    windowObj: winObj,
    documentObj: docObj,
    hiddenInputEl: hiddenInput,
    pillEl,
    pasteHoldMs: 25,
    onHostPaste: (txt, meta) => pasted.push({ txt, source: meta.source }),
    onFallbackPasteChord: () => { fallbackCount += 1; },
  });

  // 1) Ctrl+V followed by trusted paste event inside 60ms window -> forwards text, zero fallback chord
  let preventedOnKeyDown = false;
  const held = clip.handleKeyDownForPasteHold({
    key: 'v',
    ctrlKey: true,
    preventDefault() { preventedOnKeyDown = true; },
  });
  assert.equal(held, true);
  assert.equal(preventedOnKeyDown, false);
  winListeners.get('paste')({
    clipboardData: { getData: () => '来自宿主的剪贴板文本' },
    preventDefault() {},
  });
  assert.deepEqual(pasted, [{ txt: '来自宿主的剪贴板文本', source: 'paste_hold' }]);
  assert.equal(fallbackCount, 0);

  // 2) Ctrl+V with no paste event -> triggers fallback paste chord after holdMs
  clip.handleKeyDownForPasteHold({ key: 'v', ctrlKey: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fallbackCount, 1);

  // 3) Remote clipboard update -> renders pill and copies synchronously on user click
  clip.notifyRemoteClipboard('OTP-884219');
  assert.equal(pillEl.hidden, false);
  assert.match(pillEl.textContent, /远端剪贴板已更新/);
  pillHandlers.get('click')({ stopPropagation() {} });
  assert.equal(copiedViaExec, 'OTP-884219');

  assert.equal(copyTextSyncGesture('direct-sync', { documentObj: docObj }), true);
  assert.equal(copiedViaExec, 'direct-sync');

  clip.dispose();
});

test('sanitizeDropFileName and attachRemoteDropZone stream file chunks via RPC without touching interactive stream', async () => {
  assert.equal(sanitizeDropFileName('..\\..\\evil/CON.apk'), '_CON.apk');
  assert.equal(sanitizeDropFileName('photo:01?.jpg'), 'photo_01_.jpg');

  const stageHandlers = new Map();
  const stageEl = {
    appendChild() {},
    addEventListener: (k, fn) => stageHandlers.set(k, fn),
    removeEventListener: (k) => stageHandlers.delete(k),
  };
  const rpcCalls = [];
  let completed = null;
  const dz = attachRemoteDropZone(stageEl, {
    overlayEl: { hidden: true },
    chunkBytes: 4,
    getTargetMeta: () => ({ serial: 'test-serial-01' }),
    callRpc: async (method, payload) => {
      rpcCalls.push({ method, payload });
      if (method === 'uploadInit') return { ok: true, uploadId: 'up-1' };
      if (method === 'uploadChunk') return { ok: true };
      if (method === 'uploadFinish') return { ok: true, action: 'install_apk', fileName: 'demo.apk' };
      return { ok: false };
    },
    onComplete: (res) => { completed = res; },
  });

  const payloadBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  await stageHandlers.get('drop')({
    preventDefault() {},
    dataTransfer: {
      files: [{
        name: 'demo.apk',
        arrayBuffer: async () => payloadBytes.buffer,
      }],
    },
  });

  assert.deepEqual(rpcCalls.map((c) => c.method), ['uploadInit', 'uploadChunk', 'uploadChunk', 'uploadFinish']);
  assert.equal(rpcCalls[0].payload.mode, 'install_apk');
  assert.equal(rpcCalls[0].payload.serial, 'test-serial-01');
  assert.equal(completed.length, 1);
  dz.dispose();
});

test('createRemoteLeaseBar and attachRemoteMagnifier manage per-target takeover state and nearest-neighbor lens', async () => {
  const btnHandlers = new Map();
  const btn = {
    disabled: false,
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener: (k, fn) => btnHandlers.set(k, fn),
    removeEventListener: (k) => btnHandlers.delete(k),
  };
  const label = { textContent: '' };
  const toggled = [];
  const bar = createRemoteLeaseBar({
    isZh: true,
    buttonEl: btn,
    labelEl: label,
    onToggleBackend: async (req) => {
      toggled.push(req);
      return { takeoverActive: req.active };
    },
  });

  bar.setTarget('vm-alpha', { isOnline: true, initialActive: false });
  assert.equal(label.textContent, 'AI 控制中 · 接管');
  await bar.setTakeover(true);
  assert.equal(label.textContent, '人工接管中 · 交还 AI');

  // Switching to sibling target shows independent state
  bar.setTarget('vm-beta', { isOnline: true, initialActive: false });
  assert.equal(label.textContent, 'AI 控制中 · 接管');
  assert.equal(bar.isTakeoverActive('vm-alpha'), true);
  assert.equal(bar.isTakeoverActive('vm-beta'), false);
  bar.dispose();

  // Magnifier nearest-neighbor rendering
  const drawCalls = [];
  const fakeCtx = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect() {},
    drawImage: (...args) => drawCalls.push(args),
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  const docObj = {
    activeElement: null,
    createElement: (tag) => {
      if (tag === 'canvas') return { width: 0, height: 0, className: '', getContext: () => fakeCtx };
      return { hidden: true, style: {}, className: '', textContent: '', append() {}, remove() {} };
    },
  };
  const mag = attachRemoteMagnifier({
    documentObj: docObj,
    stageEl: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }), appendChild() {} },
    sourceCanvas: { width: 1024, height: 768 },
    zoomFactor: 3,
  });
  mag.toggle();
  assert.equal(mag.isActive(), true);
  mag.updateFromPointer({ inside: true, normX: 0.5, normY: 0.5, targetX: 512, targetY: 384 }, { clientX: 200, clientY: 150 });
  assert.equal(fakeCtx.imageSmoothingEnabled, false);
  assert.equal(drawCalls.length, 1);
  mag.dispose();
});

test('kiki-cua handles dynamic presentation tokens and kiki-cloudflare enforces RPC timeout', async () => {
  const { readFile } = await import('node:fs/promises');
  const cuaHtml = await readFile(new URL('../plugins/official/kiki-cua/panel.html', import.meta.url), 'utf8');
  assert.match(cuaHtml, /--bg:\s*var\(--color-canvas,\s*#f6f4ef\)/);
  assert.match(cuaHtml, /applyPresentation/);
  assert.match(cuaHtml, /createPanelClient/);

  const cfHtml = await readFile(new URL('../plugins/official/kiki-cloudflare/panel.html', import.meta.url), 'utf8');
  assert.match(cfHtml, /createPanelClient\(/);
  assert.match(cfHtml, /defaultTimeoutMs:\s*20000/);
  assert.match(cfHtml, /applyPresentation/);
});

test('attachSandboxClipboard rejects unknown option keys and all 3 remote panels wire canonical onHostPaste + onCommittedText + focusInteractiveTarget', async () => {
  assert.throws(
    () => attachSandboxClipboard({ onPasteText: () => {} }),
    /attachSandboxClipboard received unknown option "onPasteText"/,
  );

  const { readFile } = await import('node:fs/promises');
  for (const rel of [
    '../plugins/official/kiki-phone/panel.html',
    '../plugins/official/kiki-uu-remote/panel.html',
    '../plugins/official/kiki-cua/panel.html',
  ]) {
    const html = await readFile(new URL(rel, import.meta.url), 'utf8');
    // Extract the consumer call site (after @kiki-panel-kit:remote:end)
    const afterKit = html.split('/* @kiki-panel-kit:remote:end */')[1] || html;
    assert.match(afterKit, /attachSandboxClipboard\(\{[\s\S]*?\bonHostPaste\s*:/, `${rel} must wire onHostPaste`);
    assert.match(afterKit, /attachSandboxClipboard\(\{[\s\S]*?\bonCommittedText\s*:/, `${rel} must wire onCommittedText`);
    assert.doesNotMatch(afterKit, /\bonPasteText\s*:/, `${rel} must not pass dead onPasteText option`);
    assert.doesNotMatch(afterKit, /\.focusTrap\s*\(/, `${rel} must not call non-existent focusTrap()`);
    assert.doesNotMatch(afterKit, /\b(?:clipboardBridge|sandboxClipboard)\.hiddenInput\b/, `${rel} must use getHiddenInput() or onHiddenKeyDown`);
  }
});
