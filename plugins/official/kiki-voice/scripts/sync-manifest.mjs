import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { tools } from '../lib/definitions.mjs';

const path = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
if (process.argv.includes('--check')) {
  if (!isDeepStrictEqual(manifest['x-kiki'].tools, tools)) throw new Error('Voice manifest tools differ from definitions');
} else {
  manifest['x-kiki'].tools = tools;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
