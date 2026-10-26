import { readFile, writeFile } from 'node:fs/promises';
import { definitions } from '../lib/definitions.mjs';
const file = new URL('../kimi.plugin.json', import.meta.url);
const text = await readFile(file, 'utf8');
const manifest = JSON.parse(text);
manifest['x-kiki'].tools = definitions;
const next = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(text)['x-kiki'].tools) !== JSON.stringify(definitions)) throw new Error('Run scripts/sync-manifest.mjs');
} else await writeFile(file, next);
