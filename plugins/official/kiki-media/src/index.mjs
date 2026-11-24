import { readFile } from 'node:fs/promises';
import { createProviderLimiter } from './provider-concurrency.mjs';
import { scriptAdapter } from './script.mjs';
import * as agnesSource from '../../kiki-media-agnes/src/adapters.mjs';
import * as arkSource from '../../kiki-media-ark/src/adapters.mjs';
import * as comfyuiSource from '../../kiki-media-comfyui/src/adapters.mjs';
import * as googleSource from '../../kiki-media-google/src/adapters.mjs';
import * as minimaxSource from '../../kiki-media-minimax/src/adapters.mjs';
import * as newapiSource from '../../kiki-media-newapi/src/adapters.mjs';
import * as novitaSource from '../../kiki-media-novita/src/adapters.mjs';
import * as openaiSource from '../../kiki-media-openai/src/adapters.mjs';
import * as stepfunSource from '../../kiki-media-stepfun/src/adapters.mjs';
import * as xaiSource from '../../kiki-media-xai/src/adapters.mjs';

const SOURCE_MODULES = {
  openai: openaiSource,
  google: googleSource,
  ark: arkSource,
  xai: xaiSource,
  minimax: minimaxSource,
  stepfun: stepfunSource,
  novita: novitaSource,
  agnes: agnesSource,
  newapi: newapiSource,
  comfyui: comfyuiSource,
};

function getSourceModule(sourceId) {
  const mod = SOURCE_MODULES[sourceId];
  if (!mod) throw new Error(`Unknown media source module: ${sourceId}`);
  return mod;
}

const BUILTIN_VOICES = {
  openai: [
    { id: 'alloy', label: 'Alloy' },
    { id: 'ash', label: 'Ash' },
    { id: 'ballad', label: 'Ballad' },
    { id: 'coral', label: 'Coral' },
    { id: 'echo', label: 'Echo' },
    { id: 'nova', label: 'Nova' },
    { id: 'onyx', label: 'Onyx' },
    { id: 'sage', label: 'Sage' },
    { id: 'shimmer', label: 'Shimmer' },
    { id: 'verse', label: 'Verse' },
  ],
  stepfun: [
    { id: 'cixingnansheng', label: '磁性男声' },
    { id: 'wenrounvsheng', label: '温柔女声' },
    { id: 'yuanqishaonv', label: '元气少女' },
    { id: 'qingniandaxuesheng', label: '青年大学生' },
    { id: 'boyinnansheng', label: '播音男声' },
  ],
};

async function readManifest() {
  return JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
}

function sourceSettings(source, manifest, stored = {}, includeSecrets = false) {
  const values = {};
  for (const [key, property] of Object.entries(manifest['x-kiki'].settings.schema.properties)) {
    if (!key.startsWith(source.settingsPrefix)) continue;
    if (!includeSecrets && property.secret === true) continue;
    const localKey = key.slice(source.settingsPrefix.length);
    values[localKey] = stored[key] ?? stored[localKey] ?? property.default;
  }
  return values;
}

async function inspectSource(manifest, args = {}, context = {}) {
  const source = manifest['x-kiki'].mediaSources.find((item) => item.id === args.sourceId) ?? manifest['x-kiki'].mediaSources[0];
  if (!source) return { error: 'unknown source' };
  const props = manifest['x-kiki'].settings.schema.properties;
  const effective = sourceSettings(source, manifest, context.settings, true);
  if (args.overrides && typeof args.overrides === 'object') {
    for (const [fullKey, val] of Object.entries(args.overrides)) {
      if (!fullKey.startsWith(source.settingsPrefix)) continue;
      if (props[fullKey]?.secret === true) continue;
      const localKey = fullKey.slice(source.settingsPrefix.length);
      effective[localKey] = val === '' ? undefined : val;
    }
  }
  const nonSecret = { ...effective };
  delete nonSecret.apiKey;

  const missing = source.required.filter(
    (key) => !effective[key] && !(effective.connectionId && ['apiKey', 'baseUrl'].includes(key)),
  );

  const { adapters, createAdapters } = getSourceModule(source.id);
  const fetchFn = typeof context.fetchImpl === 'function' ? context.fetchImpl : globalThis.fetch;
  const activeAdapters = typeof createAdapters === 'function' && context.fetchImpl ? createAdapters(fetchFn) : adapters;

  const capabilities = [];
  let liveVoices = null;
  let voiceAdapter = null;
  for (const providerId of source.providerIds) {
    const provider = manifest['x-kiki'].mediaProviders.find((item) => item.id === providerId);
    const localId = providerId.slice(source.id.length + 1);
    const adapter = activeAdapters[localId];
    if (!provider || !adapter) continue;
    if (typeof adapter.voices === 'function') voiceAdapter = adapter;
    let models = [];
    let optionKeys = [];
    if (typeof adapter.describe === 'function') {
      try {
        const desc = await adapter.describe({}, {
          settings: nonSecret,
          signal: context.signal ?? new AbortController().signal,
        });
        models = (desc.models ?? []).filter((m) => typeof m.id === 'string' && m.id).map((m) => ({ id: m.id, kind: m.kind }));
        optionKeys = Object.keys(desc.optionsSchema?.properties ?? {});
      } catch {}
    }
    capabilities.push({ id: provider.id, label: provider.label, kinds: provider.kinds, models, optionKeys });
  }

  let probe = {
    state: missing.length === 0 ? 'configured' : 'unconfigured',
  };

  if (args.probeNetwork === true) {
    if (missing.length > 0) {
      probe = { state: 'unconfigured', missing };
    } else if (effective.connectionId && typeof context.connection !== 'function') {
      probe = { state: 'connection_managed', connectionId: String(effective.connectionId) };
    } else {
      const started = Date.now();
      const timeoutSignal = AbortSignal.timeout(15_000);
      const probeSignal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
      try {
        if (voiceAdapter) {
          const vRes = await voiceAdapter.voices({}, {
            settings: effective,
            connection: context.connection,
            signal: probeSignal,
          });
          liveVoices = (vRes.voices ?? []).slice(0, 24).map((v) => ({ id: String(v.id), label: String(v.label || v.id) }));
          probe = { state: 'ok', latencyMs: Date.now() - started, detail: `${liveVoices.length} voices` };
        } else {
          let base = String(effective.baseUrl ?? '').replace(/\/+$/, '');
          let headers = {};
          if (effective.connectionId && typeof context.connection === 'function') {
            const conn = await context.connection();
            if (conn?.baseUrl) base = String(conn.baseUrl).replace(/\/+$/, '');
            if (conn?.headers) headers = { ...conn.headers };
          } else if (effective.apiKey) {
            if (source.id === 'google') headers['x-goog-api-key'] = String(effective.apiKey);
            else headers.Authorization = `Bearer ${effective.apiKey}`;
          }
          if (!/^https?:\/\//.test(base)) {
            probe = { state: 'failed', detail: 'Invalid base URL' };
          } else {
            const path = source.id === 'comfyui'
              ? '/system_stats'
              : source.id === 'google'
                ? '/models?pageSize=4'
                : '/models';
            const res = await fetchFn(`${base}${path}`, {
              method: 'GET',
              headers,
              redirect: 'manual',
              signal: probeSignal,
            });
            const latencyMs = Date.now() - started;
            await res.body?.cancel().catch(() => {});
            if (res.ok) {
              probe = { state: 'ok', status: res.status, latencyMs };
            } else {
              probe = { state: 'failed', status: res.status, latencyMs, detail: `HTTP ${res.status}` };
            }
          }
        }
      } catch (err) {
        probe = {
          state: 'failed',
          latencyMs: Date.now() - started,
          detail: context.signal?.aborted
            ? 'Cancelled'
            : timeoutSignal.aborted
              ? 'Timed out'
              : (err instanceof Error ? err.message : 'Unreachable'),
        };
      }
    }
  }

  const voices = liveVoices ?? BUILTIN_VOICES[source.id] ?? [];
  return {
    sourceId: source.id,
    enabled: effective.enabled !== false,
    configured: missing.length === 0,
    authMode: effective.connectionId ? 'connection' : effective.apiKey ? 'apiKey' : 'none',
    missing,
    capabilities,
    voices,
    probe,
  };
}

export async function handlePanelRequest(action, args = {}, context = {}) {
  if (action === 'inspect') {
    const manifest = await readManifest();
    return inspectSource(manifest, args, context);
  }
  if (action !== 'catalog') return { error: 'unknown action' };
  const manifest = await readManifest();
  const providers = await Promise.all(manifest['x-kiki'].mediaProviders.map(async (provider) => {
    const source = manifest['x-kiki'].mediaSources.find((item) => item.providerIds.includes(provider.id));
    let models = [];
    if (source) {
      try {
        const { adapters } = getSourceModule(source.id);
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
    const { adapters } = getSourceModule(source.id);
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
  api.registerMediaProvider(manifest['x-kiki'].mediaProviders.find((item) => item.id === manifest['x-kiki'].mediaScriptProvider), limitProvider(scriptAdapter, 'custom-script'));
  for (const definition of manifest['x-kiki'].tools) {
    api.registerTool(definition, async (input, context) => {
      if (definition.name === 'generate') {
        const key = { image: 'defaultImageProvider', video: 'defaultVideoProvider', tts: 'defaultTtsProvider', '3d': 'default3dProvider' }[input.request?.kind];
        const provider = input.provider ?? (context.settings[key] || undefined);
        const job = await context.media.generate({ ...input, provider });
        return { output: JSON.stringify({ type: 'media_generation', job }), isError: ['failed', 'unknown'].includes(job.state) };
      }
      const result = await context.media.media(input);
      return { output: JSON.stringify(result.job_id ? { type: 'media_generation', job: result } : result) };
    });
  }
}
