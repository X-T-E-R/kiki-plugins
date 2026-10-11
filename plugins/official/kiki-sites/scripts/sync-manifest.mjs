import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { definitions } from '../lib/definitions.mjs';
const file = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
if (process.argv.includes('--check')) assert.deepEqual(manifest['x-kiki'].tools, definitions);
else { manifest['x-kiki'].tools = definitions; await writeFile(file, JSON.stringify(manifest, null, 2) + '\n'); }
