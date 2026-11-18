import { readFile, writeFile } from 'node:fs/promises';
import { CUA_SETTINGS_SCHEMA, definitions } from '../lib/definitions.mjs';

const file = new URL('../kimi.plugin.json', import.meta.url);
const text = await readFile(file, 'utf8');
const manifest = JSON.parse(text);

manifest['x-kiki'].settings = CUA_SETTINGS_SCHEMA;
manifest['x-kiki'].tools = definitions;

const next = JSON.stringify(manifest, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = JSON.parse(text);
  const toolsMatch = JSON.stringify(current['x-kiki']?.tools) === JSON.stringify(definitions);
  const settingsMatch = JSON.stringify(current['x-kiki']?.settings) === JSON.stringify(CUA_SETTINGS_SCHEMA);
  if (!toolsMatch || !settingsMatch) {
    process.stderr.write('Manifest out of sync with lib/definitions.mjs. Run scripts/sync-manifest.mjs\n');
    process.exit(1);
  }
} else {
  await writeFile(file, next, 'utf8');
}
