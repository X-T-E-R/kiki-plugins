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
} from '../shared/panel-kit/index.mjs';
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
  const { themeCss, runtimeJs } = await buildPanelKitAssets();
  assert.match(themeCss, /--bg:\s*var\(--color-canvas,\s*#f6f4ef\)/);
  assert.match(themeCss, /--accent:\s*var\(--color-accent,\s*#2c5e4f\)/);
  assert.match(runtimeJs, /KikiPanelKit/);
  assert.match(runtimeJs, /execCommand\('copy'\)/);
  assert.equal(/\p{Extended_Pictographic}/u.test(themeCss + runtimeJs), false);

  const ctx = vm.createContext({ Map, Set, Promise, Error, Object, Array, String, Number, Boolean, Math, Date, URLSearchParams, Uint8Array });
  vm.runInContext(`${runtimeJs}\nthis.exportedKit = KikiPanelKit;`, ctx);
  assert.equal(typeof ctx.exportedKit.safeStorage.get, 'function');
  assert.equal(typeof ctx.exportedKit.copyTextSafe, 'function');
  assert.equal(typeof ctx.exportedKit.applyPresentation, 'function');
  assert.equal(typeof ctx.exportedKit.createPanelClient, 'function');
  assert.equal(typeof ctx.exportedKit.openManagedStream, 'function');

  const { synced } = await syncPanelKit({ check: true });
  assert.equal(synced.length, 14, `Expected all 14 business panels synced, got ${synced.length}`);
  assert.ok(synced.includes('plugins/official/kiki-v42/panel.html'));
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
