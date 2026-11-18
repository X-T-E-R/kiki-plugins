import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { configuration, defaultPresets } from '../lib/configuration.mjs';
import { register, handlePanelRequest } from '../entry.mjs';

const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));

test('output-layer manifest 0.1.3 and settings.html honor paper-and-ink tokens and zero UI emoji', () => {
  assert.equal(manifest.version, '0.1.3');
  assert.equal(manifest['x-kiki'].tools, undefined);
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), false);
  assert.equal(html.includes('⌄'), false);
  assert.match(html, /--bg:\s*#f6f4ef/i);
  assert.match(html, /--bg:\s*#141413/i);
  assert.match(html, /--accent:\s*#2c5e4f/i);
  assert.match(html, /--accent:\s*#58a88f/i);
  register({ registerTool() { assert.fail('display layer must not register a model tool'); } });
  assert.deepEqual(handlePanelRequest('configuration', {}, { settings: {} }), configuration());
});

test('correlates numeric bridge request IDs and supports live rule preview, Ctrl+S save, one-click reset, and sandbox safeStorage', async () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const elements = new Map();
  const docListeners = {};
  let execCopied = false;
  const element = (id) => ({
    id, value: '', disabled: false, hidden: true, textContent: '', className: '', validity: {}, style: {},
    replaceChildren() {}, append() {}, addEventListener() {}, checkValidity: () => true, focus() {}, select() {}, remove() {}, setAttribute() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const type = (id, value) => {
    const field = get(id);
    field.value = value;
    field.oninput({ currentTarget: field });
  };
  const requests = [];
  let receive;
  let failCatalog = true;
  let failSave = true;
  const parent = {
    postMessage(request) {
      assert.ok(Number.isSafeInteger(request.id));
      assert.equal(request.channel, 'kiki.panel.v1');
      requests.push(request);
      let result;
      let error;
      if (request.method === 'plugin.call') result = structuredClone(configuration());
      else if (request.method === 'plugin.models.list') {
        if (failCatalog) error = 'Catalog unavailable';
        else result = { models: [{ id: 'claude-sonnet', display_name: 'Claude Sonnet' }], connections: [] };
      } else if (request.method === 'plugin.settings.patch') {
        if (failSave) error = 'Write refused';
        else result = { values: request.values, secretsConfigured: [] };
      } else if (request.method === 'plugin.dirty') result = true;
      else assert.fail(`Unexpected bridge method ${request.method}`);
      queueMicrotask(() => receive({
        source: parent,
        data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: error === undefined, result, error },
      }));
    },
  };
  const win = {
    addEventListener: (kind, listener) => {
      assert.equal(kind, 'message');
      receive = listener;
    },
  };
  Object.defineProperty(win, 'localStorage', {
    get() { throw new Error('SecurityError'); },
  });

  const docRoot = { lang: 'zh-CN', dataset: {}, style: { setProperty() {} } };
  runInNewContext(script, {
    document: {
      documentElement: docRoot,
      body: element('body'),
      getElementById: get,
      createElement: (tag) => element(tag),
      execCommand: (cmd) => { if (cmd === 'copy') { execCopied = true; return true; } return false; },
      addEventListener(typeName, fn) { (docListeners[typeName] ??= []).push(fn); },
    },
    window: win,
    location: { search: '?theme=dark' },
    URLSearchParams,
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    parent,
    setTimeout,
    clearTimeout,
    structuredClone,
    crypto: { randomUUID: () => 'example-preset' },
  });

  assert.equal(docRoot.dataset.theme, 'dark');
  receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'init' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(get('editor').disabled, false);
  assert.equal(get('catalog-error').hidden, false);
  assert.equal(get('label').value, configuration().presets[0].label);
  assert.match(get('rule-summary').textContent, /每组 600 字/);

  failCatalog = false;
  get('retry-models').onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('catalog-error').hidden, true);
  assert.equal(get('maxOutputTokens').value, '');

  // Live preview updates immediately on groupChars edit, and discard resets cleanly
  type('groupChars', '900');
  assert.match(get('rule-summary').textContent, /每组 900 字/);
  assert.equal(get('discard').hidden, false);
  get('discard').onclick();
  assert.equal(get('discard').hidden, true);
  assert.match(get('rule-summary').textContent, /每组 600 字/);

  // Copy prompt uses execCommand fallback
  await get('copy-prompt').onclick();
  assert.equal(execCopied, true);

  const instruction = '  Translate into Japanese\n\n';
  type('instruction', instruction);
  type('maxOutputTokens', '512');
  await get('save').onclick();
  assert.equal(get('status').textContent, 'Write refused');
  assert.equal(get('save').disabled, false);
  assert.equal(requests.filter((request) => request.method === 'plugin.dirty').at(-1).dirty, true);

  // Ctrl+S shortcut saves when dirty
  failSave = false;
  for (const fn of docListeners.keydown ?? []) {
    fn({ ctrlKey: true, key: 's', preventDefault() {} });
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const lastPatch = () => requests.filter((request) => request.method === 'plugin.settings.patch').at(-1).values;
  let saved = JSON.parse(lastPatch().presets);
  assert.equal(get('status').textContent, '已保存');
  assert.deepEqual(Object.keys(lastPatch()), ['presets']);
  assert.equal(saved[0].instruction, instruction);
  assert.equal(saved[0].modelId, undefined);
  assert.equal(saved[0].maxOutputTokens, 512);

  get('template').value = defaultPresets.at(-1).id;
  get('add').onclick();
  assert.equal(get('maxOutputTokens').value, '');
  await get('save').onclick();
  saved = JSON.parse(lastPatch().presets);
  assert.equal(saved.length, defaultPresets.length + 1);
  assert.deepEqual(requests.map((request) => request.id), requests.map((_, index) => index + 1));
});
