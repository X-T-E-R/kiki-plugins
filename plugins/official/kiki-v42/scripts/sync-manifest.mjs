import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { definitions, sessionSourceDefinition } from '../lib/definitions.mjs';
import { buildV42GuiSlots, KIKI_V42_PLUGIN_ID, V42_HTTP_ROUTES } from '../lib/slots.mjs';

const root = path.dirname(import.meta.dirname);
const file = path.join(root, 'kimi.plugin.json');
const manifest = JSON.parse(await readFile(file, 'utf8'));
const nextManifest = {
  ...manifest,
  'x-kiki': {
    ...manifest['x-kiki'],
    guiSlots: buildV42GuiSlots(KIKI_V42_PLUGIN_ID, null),
    routes: V42_HTTP_ROUTES,
    sessionSources: [sessionSourceDefinition],
    tools: definitions,
  },
};
const serialized = JSON.stringify(nextManifest, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = await readFile(file, 'utf8');
  if (current !== serialized) {
    throw new Error('kiki-v42 manifest guiSlots/routes/tools/sessionSources differ from lib/*');
  }
} else {
  await writeFile(file, serialized, 'utf8');
}
