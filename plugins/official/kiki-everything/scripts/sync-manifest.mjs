import { readFile, writeFile } from 'node:fs/promises';
import { definition } from '../lib/definitions.mjs';
const file = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
const expected = structuredClone(manifest);
expected['x-kiki'].tools = [definition];
const text = JSON.stringify(expected, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (JSON.stringify(manifest['x-kiki'].tools) !== JSON.stringify([definition])) throw new Error('Tool manifest differs from definitions.mjs');
} else await writeFile(file, text);
