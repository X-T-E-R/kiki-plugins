import { readFile } from 'node:fs/promises';
import { createProviderLimiter } from './lib/provider-concurrency.mjs';

async function readManifest() {
  return JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));
}

function sourceSettings(source, manifest, stored = {}) {
  const values = {};
  for (const [key, property] of Object.entries(manifest['x-kiki'].settings.schema.properties)) {
    if (!key.startsWith(source.settingsPrefix) || property.secret === true) continue;
    const localKey = key.slice(source.settingsPrefix.length);
    values[localKey] = stored[key] ?? stored[localKey] ?? property.default;
  }
  return values;
}

export async function handlePanelRequest(action, _args = {}, context = {}) {
  if (action !== 'catalog') return { error: 'unknown action' };
  const manifest = await readManifest();
  const providers = await Promise.all(manifest['x-kiki'].mediaProviders.map(async (provider) => {
    const source = manifest['x-kiki'].mediaSources.find((item) => item.providerIds.includes(provider.id));
    let models = [];
    if (source) {
      try {
        const { adapters } = await import(`./lib/sources/${source.id}.mjs`);
        const adapter = adapters[provider.id.slice(source.id.length + 1)];
        if (typeof adapter?.describe === 'function') {
          const capabilities = await adapter.describe({}, {
            settings: sourceSettings(source, manifest, context.settings),
            signal: context.signal ?? new AbortController().signal,
          });
          models = (capabilities.models ?? []).filter((model) => typeof model.id === 'string' && model.id)
            .map((model) => ({ id: model.id, kind: model.kind }));
        }
      } catch {
        // Model suggestions are optional; a capability error must not block the
        // source's saved connection, credentials or custom model ID from editing.
      }
    }
    return { id: provider.id, label: provider.label, kinds: provider.kinds, models };
  }));
  return {
    sources: manifest['x-kiki'].mediaSources.map((source) => ({
      id: source.id,
      label: source.label,
      prefix: source.settingsPrefix,
      providerIds: source.providerIds,
      required: source.required,
    })),
    providers,
  };
}

export async function register(api) {
  const manifest = await readManifest();
  const limitProvider = createProviderLimiter();
  for (const source of manifest['x-kiki'].mediaSources) {
    const { adapters } = await import(`./lib/sources/${source.id}.mjs`);
    for (const id of source.providerIds) {
      const definition = manifest['x-kiki'].mediaProviders.find((item) => item.id === id);
      const adapter = adapters[id.slice(source.id.length + 1)];
      const wrapped = {};
      for (const action of ['describe', 'submit', 'poll', 'cancel', 'voices']) {
        if (typeof adapter[action] !== 'function') continue;
        wrapped[action] = (input, context) => {
          if (action === 'submit') {
            const missing = source.required.find((key) => !context.settings[key] && !(context.settings.connectionId && ['apiKey', 'baseUrl'].includes(key)));
            if (missing) return Promise.resolve({ state: 'failed', artifacts: [], error: { code: 'needs_configuration', message: `Configure ${missing} for ${source.label}`, submission: 'not_sent' } });
          }
          return adapter[action](input, context);
        };
      }
      api.registerMediaProvider(definition, limitProvider(wrapped, id));
    }
  }
  const { scriptAdapter } = await import('./lib/script.mjs');
  api.registerMediaProvider(manifest['x-kiki'].mediaProviders.find((item) => item.id === manifest['x-kiki'].mediaScriptProvider), limitProvider(scriptAdapter, 'custom-script'));
  for (const definition of manifest['x-kiki'].tools) {
    api.registerTool(definition, async (input, context) => {
      if (definition.name === 'generate') {
        const key = { image: 'defaultImageProvider', video: 'defaultVideoProvider', tts: 'defaultTtsProvider' }[input.request?.kind];
        const provider = input.provider ?? (context.settings[key] || undefined);
        const job = await context.media.generate({ ...input, provider });
        return { output: JSON.stringify({ type: 'media_generation', job }), isError: ['failed', 'unknown'].includes(job.state) };
      }
      const result = await context.media.media(input);
      return { output: JSON.stringify(result.job_id ? { type: 'media_generation', job: result } : result) };
    });
  }
}
