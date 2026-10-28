import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { toolDefinitions, officialAdapterDefinition, onebotAdapterDefinition } from '../lib/definitions.mjs';
const path = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
const imAdapters = [officialAdapterDefinition, onebotAdapterDefinition];
const panels = [{ schemaVersion: 1, id: 'qq-connection', label: 'QQ connection', slot: 'settings', path: './settings.html' }];
if (process.argv.includes('--check')) {
  assert.deepEqual(manifest['x-kiki'].tools, toolDefinitions, 'QQ tool definitions are out of sync');
  assert.deepEqual(manifest['x-kiki'].imAdapters, imAdapters, 'QQ IM adapter definitions are out of sync');
  assert.equal(manifest['x-kiki'].entry, './entry.mjs');
  assert.equal(manifest['x-kiki'].activation, 'app');
  assert.equal(manifest['x-kiki'].permissions.uiPanel, true);
  assert.deepEqual(manifest['x-kiki'].panels, panels);
} else {
  manifest['x-kiki'].tools = toolDefinitions;
  manifest['x-kiki'].imAdapters = imAdapters;
  manifest['x-kiki'].activation = 'app';
  manifest['x-kiki'].permissions.uiPanel = true;
  manifest['x-kiki'].panels = panels;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
