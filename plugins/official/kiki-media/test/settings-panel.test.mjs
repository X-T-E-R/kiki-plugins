import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { handlePanelRequest } from '../entry.mjs';

test('ships a settings panel and a catalog of real provider ids', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.2.3');
  assert.equal(manifest['x-kiki'].engines.kiki, '>=0.4.3');
  assert.equal(manifest['x-kiki'].permissions.uiPanel, true);
  const panel = manifest['x-kiki'].panels.find((item) => item.id === 'settings');
  assert.deepEqual(panel, { schemaVersion: 1, id: 'settings', label: 'Settings', slot: 'settings', path: './settings.html' });
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  assert.match(html, /kiki\.panel\.v1/);
  assert.match(html, /plugin\.settings\.patch/);
  assert.match(html, /plugin\.settings\.get/);
  assert.match(html, /plugin\.models\.list/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /type\s*=\s*['"]time['"]/);
  assert.match(html, /minmax\(min\(100%, 11rem\), 1fr\)/);
  assert.match(html, /appearance:\s*none/);
  assert.match(html, /\.restore-row\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  // The panel follows the host's presentation: optional locale/theme/tokens on
  // the init message and live `presentation` updates, all with in-document
  // defaults so an old host (or none) still gets a working page.
  assert.match(html, /data\.kind === 'presentation'/);
  assert.match(html, /applyPresentation\(data\.presentation\)/);
  assert.match(html, /\[data-theme='dark'\]/);
  assert.match(html, /--color-accent-deep/);
  // Panel chrome ships its own zh copy; manifest titles stay the manifest's.
  assert.match(html, /放弃更改/);
  assert.match(html, /已保存在 Kiki 凭据中/);
  // Booleans are the Kiki switch, not a native checkbox; the visible heading
  // stays out of the frame because the host header already names the page.
  assert.match(html, /className = 'track'/);
  assert.match(html, /<h1 class="sr-only"/);
  // The guard only hears dirty on the boolean edge; a long value typed in one
  // go must not spend the host's per-window request budget needed by the save.
  assert.match(html, /const transitioned = dirty !== next/);
  assert.match(html, /if \(transitioned\) void ask\('plugin\.dirty'/);
  // Secrets follow the generic form's write-only contract: the stored value is
  // never rendered, a pending draft is the typist's own and survives re-renders
  // (source switch, locale/theme flips), Clear stages a null patch, Undo drops it.
  assert.match(html, /if \(typeof pending === 'string'\) input\.value = pending/);
  assert.match(html, /secrets\[key\] = null;\s*mark\(true\);\s*render\(\);/);
  assert.match(html, /if \(text === null\) values\[key\] = null/);
  assert.match(html, /保存后将移除/);
  assert.match(html, /Will be removed when you save/);
  // A save in flight locks every control, so the async success path can clear
  // the draft without swallowing an edit made after the patch was read.
  assert.match(html, /function applyBusy\(\)/);
  assert.match(html, /control\.disabled = saving \|\| control\.dataset\.locked === '1' \|\| control\.dataset\.connectionLocked === '1'/);
  const properties = manifest['x-kiki'].settings.schema.properties;
  assert.equal(properties.openai__cleared.hidden, true);
  assert.equal(properties.openai__removed.hidden, true);
  assert.equal(properties.openai__enabled.title, 'Enabled');
  assert.equal(properties.openai__enabled.group, 'openai');
  assert.ok(properties.defaultImageProvider.enum.includes('openai-image'));
  const catalog = await handlePanelRequest('catalog');
  const source = catalog.sources.find((item) => item.id === 'openai');
  assert.deepEqual(source.providerIds, manifest['x-kiki'].mediaSources.find((item) => item.id === 'openai').providerIds);
  assert.ok(catalog.providers.some((item) => item.id === 'openai-image' && item.kinds.includes('image')));
  assert.ok(catalog.providers.find((item) => item.id === 'openai-image').models.some((model) => model.id === 'gpt-image-1.5'));
  const custom = await handlePanelRequest('catalog', {}, { settings: { ark__imageModel: 'endpoint-wire-model' } });
  assert.deepEqual(custom.providers.find((item) => item.id === 'ark-image').models, [{ id: 'endpoint-wire-model', kind: 'image' }]);
  assert.deepEqual(await handlePanelRequest('nope'), { error: 'unknown action' });
});

test('marks only connection-replaceable required fields in every provider and prefixes them in unified Media', async () => {
  const unified = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const unifiedProperties = unified['x-kiki'].settings.schema.properties;
  const annotated = [];
  for (const vendor of ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui']) {
    const manifest = JSON.parse(await readFile(new URL(`../../kiki-media-${vendor}/kimi.plugin.json`, import.meta.url), 'utf8'));
    const properties = manifest['x-kiki'].settings.schema.properties;
    const required = manifest['x-kiki'].settings.schema.required ?? [];
    for (const [key, property] of Object.entries(properties)) {
      const expected = required.includes(key) && ['apiKey', 'baseUrl'].includes(key) && properties.connectionId ? 'connectionId' : undefined;
      assert.equal(property.requiredUnless, expected, `${manifest.name}.${key}`);
      if (expected) {
        assert.equal(manifest.version, '0.1.2');
        assert.equal(manifest['x-kiki'].engines.kiki, '>=0.4.3');
        const fullKey = `${vendor}__${key}`;
        assert.equal(unifiedProperties[fullKey].requiredUnless, `${vendor}__connectionId`);
        annotated.push(fullKey);
      }
    }
  }
  assert.equal(annotated.length, 9);
  assert.deepEqual(Object.entries(unifiedProperties).filter(([, property]) => property.requiredUnless).map(([key]) => key).sort(), annotated.sort());
});

test('carries Chinese text for every field, and the panel reads it per locale', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const properties = manifest['x-kiki'].settings.schema.properties;
  // A field the settings page draws needs a Chinese title, and a grouped one
  // needs a Chinese heading: a provider added or renamed without a translation
  // fails here instead of shipping an English field into a Chinese page.
  const untranslated = Object.entries(properties).flatMap(([key, property]) => {
    const zh = property.localizations?.zh;
    const needsTitle = property.hidden !== true;
    if (zh === undefined || (needsTitle && zh.title === undefined) || (property.group !== undefined && zh.groupTitle === undefined)) return [key];
    return [];
  });
  assert.deepEqual(untranslated, []);
  // The English string the provider wrote stays the fallback, untouched.
  assert.equal(properties.openai__apiKey.title, 'API key');
  assert.deepEqual(properties.openai__apiKey.localizations.zh, { title: 'API 密钥', groupTitle: 'OpenAI 媒体' });
  assert.equal(properties.ark__videoModel.localizations.zh.description, '填写你实际使用的 Seedance 2.0 模型/端点。2.5 不属于此协议配置。');
  assert.equal(properties.ark__videoModel.title, 'Seedance 2.0 model or endpoint ID');
  assert.equal(properties.openai__baseUrl.localizations.zh.description, undefined);
  assert.equal(properties.openai__baseUrl.description, undefined);
  assert.equal(properties.defaultImageProvider.localizations.zh.title, '默认图像来源');
  assert.equal(properties.openai__enabled.localizations.zh.title, '启用');
  assert.equal(properties.defaultVideoProvider.enum.length, manifest['x-kiki'].mediaProviders.filter((provider) => provider.kinds.includes('video')).length);
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  assert.match(html, /function localizedText\(property, field\)/);
  assert.match(html, /let text = localizations\[locale\]/);
  assert.match(html, /name\.textContent = localizedText\(property, 'title'\) \?\? key\.slice\(source\.prefix\.length\)/);
  assert.match(html, /help\.textContent = localizedText\(property, 'description'\)/);
  assert.match(html, /switchRow\(key, localizedText\(property, 'title'\)/);
  assert.match(html, /function sourceLabel\(source\)/);
  assert.match(html, /button\.textContent = sourceLabel\(item\)/);
});

test('verifies contract and bridge protocol alignment with host', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const catalog = await handlePanelRequest('catalog');

  // Verify manifest panels and permissions
  assert.equal(manifest['x-kiki'].permissions.uiPanel, true);
  assert.equal(manifest['x-kiki'].permissions.secrets, true);
  const panel = manifest['x-kiki'].panels.find((item) => item.id === 'settings');
  assert.ok(panel);
  assert.equal(panel.slot, 'settings');
  assert.equal(panel.path, './settings.html');

  // Every catalog source prefix matches manifest properties
  const properties = manifest['x-kiki'].settings.schema.properties;
  for (const source of catalog.sources) {
    assert.ok(source.prefix.endsWith('__'));
    const enabledKey = source.prefix + 'enabled';
    assert.ok(properties[enabledKey], `Missing ${enabledKey}`);
    assert.equal(properties[enabledKey].type, 'boolean');

    // Every required field for this source exists in properties
    for (const reqField of source.required) {
      const fullKey = source.prefix + reqField;
      assert.ok(properties[fullKey], `Required field ${fullKey} missing in schema`);
    }
  }

  // settings.html contains exact bridge methods and contracts
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  assert.match(html, /'kiki\.panel\.v1'/);
  assert.match(html, /ask\('plugin\.call',\s*\{\s*action:\s*'catalog'/);
  assert.match(html, /ask\('plugin\.settings\.get'\)/);
  assert.match(html, /ask\('plugin\.settings\.patch',\s*\{\s*values\s*\}\)/);
  assert.match(html, /ask\('plugin\.dirty',\s*\{\s*dirty:\s*next\s*\}\)/);
});

class MockElement {
  constructor(tag = 'div', elementsMap = null) {
    this.tagName = tag.toUpperCase();
    this._id = '';
    this._elementsMap = elementsMap;
    this.className = '';
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.checked = false;
    this.disabled = false;
    this.placeholder = '';
    this.autocomplete = '';
    this.role = '';
    this.dataset = {};
    this.htmlFor = '';
    this.children = [];
    this.parentElement = null;
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this._attrs = new Map();
    this.classList = {
      add: (c) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        classes.add(c);
        this.className = Array.from(classes).join(' ');
      },
      remove: (c) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        classes.delete(c);
        this.className = Array.from(classes).join(' ');
      },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }

  get id() { return this._id; }
  set id(val) {
    if (this._id && this._elementsMap) this._elementsMap.delete(this._id);
    this._id = val;
    if (val && this._elementsMap) this._elementsMap.set(val, this);
  }

  get offsetWidth() { return 100; }

  setAttribute(name, val) { this._attrs.set(name, String(val)); }
  getAttribute(name) { return this._attrs.get(name) ?? null; }

  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new MockElement('span');
        t.textContent = n;
        this.children.push(t);
      } else if (n instanceof MockElement) {
        n.parentElement = this;
        this.children.push(n);
      }
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (matches(child, selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function matches(el, sel) {
  const parts = sel.split(',').map((s) => s.trim());
  for (const part of parts) {
    const tokens = part.split(/\s+/);
    if (tokens.length === 1) {
      const t = tokens[0];
      if (t === el.tagName.toLowerCase()) return true;
      if (t.startsWith('.') && el.classList.contains(t.slice(1))) return true;
      if (t.startsWith('#') && el.id === t.slice(1)) return true;
    } else if (tokens.length === 2 && tokens[0] === '#content') {
      const t = tokens[1];
      if (t === el.tagName.toLowerCase()) return true;
      if (t.startsWith('.') && el.classList.contains(t.slice(1))) return true;
    }
  }
  return false;
}

function createDomHarness(htmlSource) {
  const elements = new Map();
  function getOrCreate(id, tag = 'div') {
    if (!elements.has(id)) {
      const el = new MockElement(tag, elements);
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  }

  const staticIds = [
    'title', 'loading', 'boot-error', 'boot-error-text', 'boot-retry',
    'content', 'defaults-label', 'defaults', 'chips', 'source',
    'dock', 'error', 'savebar', 'save', 'discard', 'status', 'saved', 'saved-text'
  ];
  for (const id of staticIds) getOrCreate(id);
  getOrCreate('loading', 'p');
  getOrCreate('content').hidden = true;
  getOrCreate('dock').hidden = true;
  getOrCreate('savebar').hidden = true;
  getOrCreate('saved').hidden = true;
  getOrCreate('error').hidden = true;
  getOrCreate('boot-error').hidden = true;

  const content = getOrCreate('content');
  content.append(getOrCreate('defaults'), getOrCreate('chips'), getOrCreate('source'));

  const messageListeners = [];
  const postedMessages = [];

  const documentMock = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new MockElement(tag, elements),
    querySelectorAll: (sel) => {
      const all = [];
      for (const el of elements.values()) {
        if (matches(el, sel)) all.push(el);
        for (const desc of el.querySelectorAll(sel)) all.push(desc);
      }
      return all;
    },
    documentElement: {
      dataset: {},
      style: { setProperty: () => {} },
    },
  };

  const windowMock = {
    addEventListener: (ev, handler) => {
      if (ev === 'message') messageListeners.push(handler);
    },
    removeEventListener: (ev, handler) => {
      const idx = messageListeners.indexOf(handler);
      if (idx >= 0) messageListeners.splice(idx, 1);
    },
    dispatchMessage: (data) => {
      for (const l of [...messageListeners]) l({ data });
    },
  };

  const parentMock = {
    postMessage: (msg) => {
      postedMessages.push(msg);
    },
  };

  const navigatorMock = { language: 'en-US' };

  const sandbox = {
    document: documentMock,
    window: windowMock,
    parent: parentMock,
    navigator: navigatorMock,
    setTimeout,
    clearTimeout,
    console,
    Map,
    Set,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Date,
  };

  const scriptMatch = htmlSource.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('No script found in settings.html');
  const context = vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], context);

  return {
    elements,
    postedMessages,
    dispatchMessage: windowMock.dispatchMessage,
    context,
  };
}

function answerConnections(h, result = { models: [], connections: [] }) {
  const request = h.postedMessages.find((message) => message.method === 'plugin.models.list');
  assert.ok(request, 'connection catalog request');
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: true, result });
  return request;
}

test('executes real settings.html script in simulated DOM: boot, render, save, error retention, secret undo, control lock, and retry', async () => {
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const catalogFixture = await handlePanelRequest('catalog');
  const viewFixture = {
    schema: manifest['x-kiki'].settings,
    values: {
      defaultImageProvider: 'openai-image',
      openai__enabled: true,
      openai__baseUrl: 'https://api.openai.com/v1',
    },
    secretsConfigured: ['openai__apiKey'],
  };

  // Case 1: Successful boot, plain save, draft clearing
  {
    const h = createDomHarness(html);
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });

    const callReq = h.postedMessages.find((m) => m.method === 'plugin.call');
    const getReq = h.postedMessages.find((m) => m.method === 'plugin.settings.get');
    assert.ok(callReq && getReq);

    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: true, result: catalogFixture });
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: getReq.id, ok: true, result: viewFixture });
    await new Promise((r) => setTimeout(r, 0));
    answerConnections(h);

    assert.equal(h.elements.get('loading').hidden, true);
    assert.equal(h.elements.get('content').hidden, false);
    assert.equal(h.elements.get('dock').hidden, true);

    const input = h.elements.get('openai__baseUrl');
    assert.ok(input);
    assert.equal(input.value, 'https://api.openai.com/v1');
    input.value = 'https://custom.endpoint.test/v1';
    input.oninput();

    assert.equal(h.elements.get('savebar').hidden, false);

    const savePromise = h.elements.get('save').onclick();
    const patchReq = h.postedMessages.find((m) => m.method === 'plugin.settings.patch');
    assert.ok(patchReq);
    assert.deepEqual({ ...patchReq.values }, { openai__baseUrl: 'https://custom.endpoint.test/v1' });

    const updatedView = {
      ...viewFixture,
      values: { ...viewFixture.values, openai__baseUrl: 'https://custom.endpoint.test/v1' },
    };
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: patchReq.id, ok: true, result: updatedView });
    await savePromise;

    assert.equal(h.elements.get('savebar').hidden, true);
  }

  // Case 2: Host error (e.g. required missing) preserves draft & allows retry
  {
    const h = createDomHarness(html);
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });
    const callReq = h.postedMessages.find((m) => m.method === 'plugin.call');
    const getReq = h.postedMessages.find((m) => m.method === 'plugin.settings.get');
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: true, result: catalogFixture });
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: getReq.id, ok: true, result: viewFixture });
    await new Promise((r) => setTimeout(r, 0));
    answerConnections(h);

    const input = h.elements.get('openai__baseUrl');
    input.value = 'https://custom.endpoint.test/v1';
    input.oninput();

    const savePromise = h.elements.get('save').onclick();
    const patchReq = h.postedMessages.find((m) => m.method === 'plugin.settings.patch');
    assert.ok(patchReq);
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: patchReq.id, ok: false, error: 'Validation failed: invalid url' });
    await savePromise;

    assert.equal(h.elements.get('error').hidden, false);
    assert.equal(h.elements.get('error').textContent, 'Validation failed: invalid url');
    assert.equal(input.value, 'https://custom.endpoint.test/v1');
    assert.equal(h.elements.get('savebar').hidden, false);
  }

  // Case 3: Secret clear -> Undo doesn't lose current drafts
  {
    const h = createDomHarness(html);
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });
    const callReq = h.postedMessages.find((m) => m.method === 'plugin.call');
    const getReq = h.postedMessages.find((m) => m.method === 'plugin.settings.get');
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: true, result: catalogFixture });
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: getReq.id, ok: true, result: viewFixture });
    await new Promise((r) => setTimeout(r, 0));
    answerConnections(h);

    const input = h.elements.get('openai__baseUrl');
    input.value = 'https://my-endpoint.example.com';
    input.oninput();

    const clearBtn = h.elements.get('content').querySelectorAll('button').find((b) => b.dataset.secretClear === 'openai__apiKey');
    assert.ok(clearBtn);
    clearBtn.onclick();

    const undoBtn = h.elements.get('content').querySelectorAll('button').find((b) => b.textContent === 'Undo');
    assert.ok(undoBtn);
    assert.equal(h.elements.get('openai__baseUrl').value, 'https://my-endpoint.example.com');

    undoBtn.onclick();
    assert.equal(h.elements.get('openai__baseUrl').value, 'https://my-endpoint.example.com');

    const savePromise = h.elements.get('save').onclick();
    const patchReq = h.postedMessages.find((m) => m.method === 'plugin.settings.patch');
    assert.ok(patchReq);
    assert.deepEqual({ ...patchReq.values }, { openai__baseUrl: 'https://my-endpoint.example.com' });
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: patchReq.id, ok: true, result: viewFixture });
    await savePromise;
  }

  // Case 4: Control locking during in-flight save and unlock on complete
  {
    const h = createDomHarness(html);
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });
    const callReq = h.postedMessages.find((m) => m.method === 'plugin.call');
    const getReq = h.postedMessages.find((m) => m.method === 'plugin.settings.get');
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: true, result: catalogFixture });
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: getReq.id, ok: true, result: viewFixture });
    await new Promise((r) => setTimeout(r, 0));
    answerConnections(h);

    const input = h.elements.get('openai__baseUrl');
    input.value = 'https://lock-test.example.com';
    input.oninput();

    const savePromise = h.elements.get('save').onclick();
    const patchReq = h.postedMessages.find((m) => m.method === 'plugin.settings.patch');
    assert.ok(patchReq);

    const contentControls = h.elements.get('content').querySelectorAll('input, select, textarea, button');
    assert.ok(contentControls.length > 0);
    for (const c of contentControls) {
      assert.equal(c.disabled, true, `Control ${c.id || c.tagName} should be disabled during saving`);
    }

    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: patchReq.id, ok: true, result: viewFixture });
    await savePromise;

    const liveControls = h.elements.get('content').querySelectorAll('input, select, textarea, button');
    for (const c of liveControls) {
      if (c.dataset.locked !== '1') {
        assert.equal(c.disabled, false, `Control ${c.id || c.tagName} should be unlocked after save`);
      }
    }
  }

  // Case 5: Boot failure and retry
  {
    const h = createDomHarness(html);
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });
    const callReq = h.postedMessages.find((m) => m.method === 'plugin.call');
    h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: false, error: 'catalog failed' });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(h.elements.get('loading').hidden, true);
    assert.equal(h.elements.get('content').hidden, true);
    assert.equal(h.elements.get('boot-error').hidden, false);
    assert.equal(h.elements.get('boot-error-text').textContent, 'catalog failed');

    const retryBtn = h.elements.get('boot-retry');
    assert.ok(retryBtn);
    assert.equal(retryBtn.textContent, 'Retry');

    h.postedMessages.length = 0;
    retryBtn.onclick();

    assert.equal(h.elements.get('loading').hidden, false);
    assert.equal(h.elements.get('boot-error').hidden, true);
    assert.equal(h.postedMessages.length, 2);
  }
});



async function bootWithConnections(html, catalog, view, connections) {
  const h = createDomHarness(html);
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });
  const callReq = h.postedMessages.find((message) => message.method === 'plugin.call');
  const getReq = h.postedMessages.find((message) => message.method === 'plugin.settings.get');
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: true, result: catalog });
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: getReq.id, ok: true, result: view });
  await new Promise((resolve) => setTimeout(resolve, 0));
  answerConnections(h, { models: [], connections });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return h;
}

test('connection choice locks but preserves local credentials, survives source tabs and saves only edited keys', async () => {
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const catalog = await handlePanelRequest('catalog');
  const view = {
    schema: manifest['x-kiki'].settings,
    values: {
      openai__enabled: true,
      openai__baseUrl: 'https://own-openai.example.test/v1',
      openai__imageModel: 'gpt-image-1.5',
      google__baseUrl: 'https://own-google.example.test/v1beta',
    },
    secretsConfigured: ['openai__apiKey', 'google__apiKey'],
  };
  const h = await bootWithConnections(html, catalog, view, [
    { id: 'openai-main', type: 'openai', status: 'ready', service: 'chat', authentication: 'api-key' },
  ]);

  const select = h.elements.get('openai__connectionId');
  assert.equal(select.value, '');
  assert.equal(select.children[0].textContent, 'Use my own endpoint and key');
  select.value = 'openai-main';
  select.onchange();
  assert.equal(h.elements.get('openai__apiKey').disabled, true);
  assert.equal(h.elements.get('openai__baseUrl').disabled, true);
  assert.equal(h.elements.get('openai__imageModel').getAttribute('list'), 'openai__imageModel-models');
  assert.ok(h.elements.get('openai__imageModel-models').children.some((option) => option.value === 'gpt-image-1.5'));

  h.elements.get('chips').children.find((button) => button.textContent === 'Google Media').onclick();
  assert.equal(h.elements.get('google__baseUrl').disabled, false);
  h.elements.get('chips').children.find((button) => button.textContent === 'OpenAI Media').onclick();
  assert.equal(h.elements.get('openai__connectionId').value, 'openai-main');
  assert.equal(h.elements.get('openai__baseUrl').value, 'https://own-openai.example.test/v1');

  const firstSave = h.elements.get('save').onclick();
  const firstPatch = h.postedMessages.find((message) => message.method === 'plugin.settings.patch');
  assert.deepEqual({ ...firstPatch.values }, { openai__connectionId: 'openai-main' });
  const connectedView = { ...view, values: { ...view.values, openai__connectionId: 'openai-main' } };
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: firstPatch.id, ok: true, result: connectedView });
  await firstSave;
  assert.equal(h.elements.get('openai__baseUrl').disabled, true);

  h.elements.get('openai__connectionId').value = '';
  h.elements.get('openai__connectionId').onchange();
  assert.equal(h.elements.get('openai__apiKey').disabled, false);
  assert.equal(h.elements.get('openai__baseUrl').disabled, false);
  const secondSave = h.elements.get('save').onclick();
  const patches = h.postedMessages.filter((message) => message.method === 'plugin.settings.patch');
  const secondPatch = patches.at(-1);
  assert.deepEqual({ ...secondPatch.values }, { openai__connectionId: null });
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: secondPatch.id, ok: true, result: view });
  await secondSave;
  assert.equal(JSON.stringify(h.postedMessages).includes('fixture-secret'), false);
});

test('connection catalog failure keeps own credentials usable and retries without losing drafts', async () => {
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const catalog = await handlePanelRequest('catalog');
  const view = {
    schema: manifest['x-kiki'].settings,
    values: { openai__enabled: true, openai__baseUrl: 'https://own.example.test/v1' },
    secretsConfigured: ['openai__apiKey'],
  };
  const h = createDomHarness(html);
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'init', presentation: { locale: 'en' } });
  const callReq = h.postedMessages.find((message) => message.method === 'plugin.call');
  const getReq = h.postedMessages.find((message) => message.method === 'plugin.settings.get');
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: callReq.id, ok: true, result: catalog });
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: getReq.id, ok: true, result: view });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failed = h.postedMessages.find((message) => message.method === 'plugin.models.list');
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: failed.id, ok: false, error: 'Connection catalog unavailable' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(h.elements.get('content').hidden, false);
  assert.equal(h.elements.get('openai__apiKey').disabled, false);
  assert.equal(h.elements.get('openai__connectionId-error').textContent, 'Connection catalog unavailable');
  h.elements.get('openai__baseUrl').value = 'https://draft.example.test/v1';
  h.elements.get('openai__baseUrl').oninput();
  h.elements.get('openai__connectionId-retry').onclick();
  const retried = h.postedMessages.filter((message) => message.method === 'plugin.models.list').at(-1);
  h.dispatchMessage({
    channel: 'kiki.panel.v1', kind: 'response', id: retried.id, ok: true,
    result: { models: [], connections: [{ id: 'recovered', type: 'openai', authentication: 'oauth' }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.elements.get('openai__baseUrl').value, 'https://draft.example.test/v1');
  assert.equal(h.elements.get('openai__connectionId').children.some((option) => option.value === 'recovered'), true);
  assert.equal(h.elements.get('source').querySelectorAll('button').some((button) => button.id === 'openai__connectionId-retry'), false);
});

test('secret clear and replacement are explicit patches and never reveal the stored value', async () => {
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const catalog = await handlePanelRequest('catalog');
  const view = {
    schema: manifest['x-kiki'].settings,
    values: { openai__enabled: true, openai__baseUrl: 'https://own.example.test/v1' },
    secretsConfigured: ['openai__apiKey'],
  };
  const h = await bootWithConnections(html, catalog, view, []);
  h.elements.get('content').querySelectorAll('button').find((button) => button.dataset.secretClear === 'openai__apiKey').onclick();
  const clearingSave = h.elements.get('save').onclick();
  const clearing = h.postedMessages.filter((message) => message.method === 'plugin.settings.patch').at(-1);
  assert.deepEqual({ ...clearing.values }, { openai__apiKey: null });
  const clearedView = { ...view, secretsConfigured: [] };
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: clearing.id, ok: true, result: clearedView });
  await clearingSave;

  const input = h.elements.get('openai__apiKey');
  assert.equal(input.value, '');
  input.value = 'fixture-replacement-secret';
  input.oninput();
  const replacingSave = h.elements.get('save').onclick();
  const replacing = h.postedMessages.filter((message) => message.method === 'plugin.settings.patch').at(-1);
  assert.deepEqual({ ...replacing.values }, { openai__apiKey: 'fixture-replacement-secret' });
  h.dispatchMessage({ channel: 'kiki.panel.v1', kind: 'response', id: replacing.id, ok: true, result: view });
  await replacingSave;
  assert.equal(h.elements.get('openai__apiKey').value, '');
});
