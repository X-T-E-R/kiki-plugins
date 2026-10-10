import { readFile } from 'node:fs/promises';

export async function register(api) {
  const manifest = JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));
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
      api.registerMediaProvider(definition, wrapped);
    }
  }
  const { scriptAdapter } = await import('./lib/script.mjs');
  api.registerMediaProvider(manifest['x-kiki'].mediaProviders.find((item) => item.id === manifest['x-kiki'].mediaScriptProvider), scriptAdapter);
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
