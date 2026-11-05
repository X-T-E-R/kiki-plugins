import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configuration, defaultPresets } from '../plugins/official/kiki-output-layer/lib/configuration.mjs';
import { register, handlePanelRequest } from '../plugins/official/kiki-output-layer/entry.mjs';
import { packageFiles } from '../scripts/package-files.mjs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

test('output layer package contains no model tools and provides editable defaults through its panel backend', async () => {
  const root = fileURLToPath(new URL('../plugins/official/kiki-output-layer/', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../plugins/official/kiki-output-layer/kimi.plugin.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../plugins/marketplace.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.2');
  assert.equal(catalog.plugins.find(item => item.id === manifest.name).version, manifest.version);
  assert.equal(manifest['x-kiki'].tools, undefined);
  assert.equal(manifest['x-kiki'].commands, undefined);
  assert.equal(manifest['x-kiki'].systemPrompt, undefined);
  assert.equal(manifest['x-kiki'].permissions.secrets, undefined);
  register({ registerTool() { assert.fail('display layer must not register a model tool'); } });
  assert.deepEqual(handlePanelRequest('configuration', {}, { settings: {} }), configuration());
  assert.deepEqual(configuration().settings, { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 });
  assert.deepEqual(configuration().presets.map(preset => preset.id), ['translate', 'translate-en', 'plain', 'catgirl', 'tsundere', 'custom']);
  for (const preset of configuration().presets) {
    assert.equal(preset.modelId, undefined);
    assert.equal(preset.maxOutputTokens, undefined);
  }
  const edited = [{ ...defaultPresets[0], instruction: 'Translate into Japanese', connectionId: 'existing-connection', customModelId: 'remote/model', maxOutputTokens: 512 }];
  const configured = configuration({ presets: JSON.stringify(edited), historyTokens: 0, groupChars: 800 });
  assert.deepEqual(configured.presets, edited);
  assert.deepEqual(configured.templates, defaultPresets);
  assert.equal(configuration({ historyTokens: 0 }).settings.historyTokens, 0);
  assert.throws(() => configuration({ presets: 'bad json' }));
  assert.throws(() => configuration({ presets: JSON.stringify([edited[0], edited[0]]) }), /不能重复/);
  const files = await packageFiles(root);
  assert.ok(files.includes('entry.mjs'));
  assert.ok(files.includes('lib/configuration.mjs'));
  assert.ok(files.includes('settings.html'));
});


test('settings panel correlates numeric bridge request and response IDs when loading and saving', async () => {
  const html = await readFile(new URL('../plugins/official/kiki-output-layer/settings.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const elements = new Map();
  const element = (id) => ({ id, value: '', disabled: false, hidden: true, textContent: '', className: '', validity: {},
    replaceChildren() {}, append() {}, addEventListener() {}, checkValidity: () => true, focus() {}, setAttribute() {} });
  const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const type = (id, value) => { const field = get(id); field.value = value; field.oninput({ currentTarget: field }); };
  const requests = [];
  let receive;
  let failCatalog = true;
  let failSave = true;
  const parent = { postMessage(request) {
    assert.ok(Number.isSafeInteger(request.id));
    assert.equal(request.channel, 'kiki.panel.v1');
    requests.push(request);
    let result, error;
    if (request.method === 'plugin.call') result = structuredClone(configuration());
    else if (request.method === 'plugin.models.list') {
      if (failCatalog) error = 'Catalog unavailable';
      else result = { models: [], connections: [] };
    } else if (request.method === 'plugin.settings.patch') {
      if (failSave) error = 'Write refused';
      else result = { values: request.values, secretsConfigured: [] };
    } else if (request.method === 'plugin.dirty') result = true;
    else assert.fail(`Unexpected bridge method ${request.method}`);
    queueMicrotask(() => receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: error === undefined, result, error } }));
  } };
  runInNewContext(script, { document: { getElementById: get, addEventListener() {} },
    window: { addEventListener: (kind, listener) => { assert.equal(kind, 'message'); receive = listener; } },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    parent, setTimeout, clearTimeout, structuredClone, crypto: { randomUUID: () => 'example-preset' } });
  receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'init' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('editor').disabled, false);
  assert.equal(get('catalog-error').hidden, false);
  assert.equal(get('label').value, configuration().presets[0].label);
  failCatalog = false;
  get('retry-models').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('catalog-error').hidden, true);
  assert.equal(get('maxOutputTokens').value, '');
  const instruction = '  Translate into Japanese\n\n';
  type('instruction', instruction);
  type('maxOutputTokens', '512');
  await get('save').onclick();
  assert.equal(get('status').textContent, 'Write refused');
  assert.equal(get('save').disabled, false);
  assert.equal(requests.filter(request => request.method === 'plugin.dirty').at(-1).dirty, true);
  failSave = false;
  await get('save').onclick();
  const lastPatch = () => requests.filter(request => request.method === 'plugin.settings.patch').at(-1).values;
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
  assert.equal(saved.at(-1).instruction, defaultPresets.at(-1).instruction);
  assert.equal(saved.at(-1).modelId, undefined);
  assert.equal(saved.at(-1).maxOutputTokens, undefined);
  assert.equal(saved[0].instruction, instruction);
  assert.deepEqual(requests.map(request => request.id), requests.map((_, index) => index + 1));
});
