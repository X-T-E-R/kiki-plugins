import { readFile, writeFile } from 'node:fs/promises';
import {
  harnessQuotaSourceDefinitions,
  magpieToolDefinitions,
} from '../lib/definitions.mjs';

const path = new URL('../kimi.plugin.json', import.meta.url);
const check = process.argv.includes('--check');
const raw = await readFile(path, 'utf8');
const manifest = JSON.parse(raw);

manifest['x-kiki'] = {
  ...manifest['x-kiki'],
  tools: magpieToolDefinitions,
  harnessQuotaSources: harnessQuotaSourceDefinitions,
};
const expected = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  if (raw !== expected) {
    throw new Error('plugins/magpie-harness-quota/kimi.plugin.json is out of sync with lib/definitions.mjs');
  }
} else {
  await writeFile(path, expected, 'utf8');
}
