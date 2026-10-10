import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const target = new URL('../', import.meta.url);
const vendors = ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui'];
const manifest = JSON.parse(await readFile(new URL('kimi.plugin.json', target), 'utf8'));
const properties = Object.fromEntries(Object.entries(manifest['x-kiki'].settings.schema.properties).filter(([key]) => key.startsWith('default')));
const providers = [];
const sources = [];
async function output(url, content) {
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== content) throw new Error(`Unified media source drift: ${url}`);
  } else { await mkdir(new URL('./', url), { recursive: true }); await writeFile(url, content); }
}
for (const vendor of vendors) {
  const donor = new URL(`kiki-media-${vendor}/`, root);
  const original = JSON.parse(await readFile(new URL('kimi.plugin.json', donor), 'utf8'));
  const prefix = `${vendor}__`;
  for (const [key, property] of Object.entries(original['x-kiki'].settings.schema.properties)) properties[prefix + key] = property;
  properties[prefix + 'enabled'] = { type: 'boolean', default: true };
  properties[prefix + 'removed'] = { type: 'boolean', default: false };
  properties[prefix + 'cleared'] = { type: 'string', default: '[]' };
  sources.push({ id: vendor, label: original.interface.displayName, providerIds: original['x-kiki'].mediaProviders.map((definition) => `${vendor}-${definition.id}`), settingsPrefix: prefix, legacyPluginId: original.name, required: original['x-kiki'].settings.schema.required ?? [] });
  for (const definition of original['x-kiki'].mediaProviders) providers.push({ ...definition, id: `${vendor}-${definition.id}`, connectionSetting: prefix + definition.connectionSetting });
  await output(new URL(`lib/sources/${vendor}.mjs`, target), (await readFile(new URL('adapters.mjs', donor), 'utf8')).replace("'./runtime.mjs'", "'../runtime.mjs'"));
}
await output(new URL('lib/runtime.mjs', target), await readFile(new URL('media-runtime/runtime.mjs', root), 'utf8'));
providers.push({ schemaVersion: 1, id: 'custom-script', label: 'Custom script', kinds: ['image', 'video', 'tts'], resumeVersion: 1 });
properties.scriptSources = { type: 'string', default: '[]', title: 'Custom media scripts' };
manifest['x-kiki'].mediaProviders = providers;
manifest['x-kiki'].mediaSources = sources;
manifest['x-kiki'].mediaScriptProvider = 'custom-script';
manifest['x-kiki'].settings.schema.properties = properties;
manifest['x-kiki'].permissions.secrets = true;
manifest['x-kiki'].permissions.exec = ['*'];
await output(new URL('kimi.plugin.json', target), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Unified ${sources.length} sources / ${providers.length - 1} adapters`);
