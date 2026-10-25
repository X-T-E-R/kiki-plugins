import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { toolDefinitions, officialAdapterDefinition, onebotAdapterDefinition } from '../lib/definitions.mjs';
const path = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
const imAdapters = [officialAdapterDefinition, onebotAdapterDefinition];
if (process.argv.includes('--check')) {
  assert.deepEqual(manifest['x-kiki'].tools, toolDefinitions, 'QQ tool definitions are out of sync');
  assert.deepEqual(manifest['x-kiki'].imAdapters, imAdapters, 'QQ IM adapter definitions are out of sync');
  assert.equal(manifest['x-kiki'].entry, './entry.mjs');
} else {
  manifest['x-kiki'].tools = toolDefinitions;
  manifest['x-kiki'].imAdapters = imAdapters;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
