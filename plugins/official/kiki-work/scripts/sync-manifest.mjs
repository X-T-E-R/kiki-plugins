import { readFile, writeFile } from 'node:fs/promises';
import { definitions } from '../lib/definitions.mjs';
const url = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(url, 'utf8'));
if (process.argv.includes('--check')) {
  if (JSON.stringify(manifest['x-kiki'].tools) !== JSON.stringify(definitions)) throw new Error('Manifest tool definitions differ');
} else { manifest['x-kiki'].tools = definitions; await writeFile(url, `${JSON.stringify(manifest, null, 2)}\n`); }
