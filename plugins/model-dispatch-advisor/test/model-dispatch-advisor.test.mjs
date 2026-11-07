import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { z } from 'zod';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { definitions, register } from '../entry.mjs';
import * as advisorModule from '../lib/advisor.mjs';
import { createDispatchAdvisor } from '../lib/advisor.mjs';
import { getActiveWriteQueueCountForTesting, PreferenceStore, resolvePluginDataFile } from '../lib/store.mjs';
import { MagpieQuotaService } from '../../magpie-harness-quota/lib/magpie.mjs';

// Exact Host cache response schema from packages/plugin-sdk/src/harness-quota.ts
const identifier = z.string().min(1).max(1024).regex(/^[^\s\u0000]+$/);
const harnessQuotaReadingSchema = z.object({
  accountId: identifier,
  accountLabel: z.string().min(1).optional(),
  modelIds: z.array(identifier).optional(),
  pool: z.string().min(1).optional(),
  unit: z.enum(['percent', 'money', 'tokens', 'requests', 'credits', 'count']),
  window: z.string().min(1).optional(),
  remaining: z.number().finite().nonnegative().optional(),
  resetAt: z.string().datetime({ offset: true }).optional(),
  readAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const harnessQuotaSnapshotSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  engineIds: z.array(z.string().min(1)),
  minRefreshIntervalMs: z.number().int().positive(),
  readAt: z.string().datetime({ offset: true }).optional(),
  readings: z.array(harnessQuotaReadingSchema).optional(),
}).strict();
const harnessQuotaCacheResponseSchema = z.object({
  sources: z.array(harnessQuotaSnapshotSchema),
}).strict();

const SIBLING_TASK92_RUNNER = path.resolve(
  import.meta.dirname,
  '../../../../executor-instance-scheduling-20261107/packages/agent-core-v2/src/app/plugin/hostRunner.mjs',
);

async function resolveQuotaCapableRunner() {
  for (const candidate of [process.env.KIKI_TASK92_HOST_RUNNER, process.env.KIKI_HOST_RUNNER, SIBLING_TASK92_RUNNER].filter(Boolean)) {
    try {
      await access(candidate);
      const source = await readFile(candidate, 'utf8');
      if (source.includes('harness-quota-cached')) return path.resolve(candidate);
    } catch {
      // Try next
    }
  }
  return null;
}

const SYNTHETIC_CATALOG = {
  models: [
    {
      id: 'example/chat-model',
      provider_id: 'example-conn',
      remote_id: 'chat-model',
      display_name: 'Example Chat',
      max_context_size: 200_000,
      effective_protocol: 'openai',
    },
    {
      id: 'xai/grok-code',
      provider_id: 'xai-conn',
      remote_id: 'grok-code',
      display_name: 'Grok Code',
      max_context_size: 262_144,
      effective_protocol: 'openai',
    },
  ],
  connections: [
    { id: 'example-conn', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'xai-conn', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
  ],
};

async function withIsolatedHome(fn) {
  const kikiHome = await mkdtemp(path.join(os.tmpdir(), 'advisor-plugin-home-'));
  try {
    return await fn(kikiHome);
  } finally {
    await rm(kikiHome, { recursive: true, force: true });
  }
}

test('manifest tools match lib/definitions.mjs and advisor exports no hardcoded roles, candidates, or winner selector', () => {
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  assert.equal(definitions.length, 2);
  assert.equal(manifest['x-kiki'].settings, undefined);
  assert.equal(advisorModule.PROTECTED_ROLES, undefined);
  assert.equal(advisorModule.BUILTIN_GROUPS, undefined);
  for (const tool of definitions) {
    assert.equal(tool.schemaVersion, 1);
    assert.ok(tool.description.length > 0 && tool.description.length < 600);
    assert.equal(tool.disclosure, 'deferred');
  }
});

test('persists explicit implementation preference, isolates functional scopes (e.g. writer/think examples stay untouched), survives reopen, never mutates local profiles/config, and clears cleanly', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const agentsDir = path.join(kikiHome, 'agents');
    await mkdir(agentsDir, { recursive: true });
    const writerProfilePath = path.join(agentsDir, 'writer.md');
    const thinkProfilePath = path.join(agentsDir, 'think.md');
    const configTomlPath = path.join(kikiHome, 'config.toml');
    const originalWriterProfile = '---\nmodel: example/writer-default\neffort: high\n---\nWriter profile.\n';
    const originalThinkProfile = '---\nmodel: example/think-default\neffort: xhigh\n---\nThink profile.\n';
    const originalConfig = 'default_model = "example/main-default"\n';
    await writeFile(writerProfilePath, originalWriterProfile, 'utf8');
    await writeFile(thinkProfilePath, originalThinkProfile, 'utf8');
    await writeFile(configTomlPath, originalConfig, 'utf8');

    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };

    const advisorA = createDispatchAdvisor({ now: () => '2026-11-07T10:00:00.000Z' });
    const saved = await advisorA.updatePreference({
      action: 'set',
      group: 'implementation',
      prefer: ['implementer-grokbuild', 'non-gpt'],
      avoid: ['gpt'],
      note: '同功能实现任务优先 Grok Build 或非 GPT',
      userAuthorized: true,
      userQuote: '现在GPT少用一点，用 Grok Build 或其他实现',
      sourceNote: 'session:main#t2121',
    }, context);

    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.preference.group, 'implementation');
    assert.deepEqual(saved.preference.prefer, ['implementer-grokbuild', 'non-gpt']);
    assert.deepEqual(saved.preference.avoid, ['gpt']);
    assert.equal(saved.preference.source.kind, 'explicit_user');
    assert.equal(getActiveWriteQueueCountForTesting(), 0);

    const advisorB = createDispatchAdvisor();
    const implView = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(implView.ok, true);
    assert.equal(implView.informationOnly, true);
    assert.equal(Object.hasOwn(implView, 'recommended'), false);
    assert.equal(Object.hasOwn(implView, 'candidates'), false);
    assert.equal(implView.scope.group, 'implementation');
    assert.deepEqual(implView.preference.prefer, ['implementer-grokbuild', 'non-gpt']);

    for (const sampleScope of ['writer', 'think', 'review']) {
      const otherView = await advisorB.recommend({ group: sampleScope }, context);
      assert.equal(otherView.scope.group, sampleScope);
      assert.equal(otherView.preference, null);
      assert.equal(Object.hasOwn(otherView, 'recommended'), false);
    }

    const updated = await advisorB.updatePreference({
      action: 'set',
      group: 'implementation',
      prefer: ['implementer-grokbuild'],
      avoid: [],
      userAuthorized: true,
      userQuote: '实现先优先看 Grok Build',
    }, context);
    assert.equal(updated.revision, 2);
    const reread = await advisorB.recommend({ group: 'implementation' }, context);
    assert.deepEqual(reread.preference.prefer, ['implementer-grokbuild']);

    assert.equal(await readFile(writerProfilePath, 'utf8'), originalWriterProfile);
    assert.equal(await readFile(thinkProfilePath, 'utf8'), originalThinkProfile);
    assert.equal(await readFile(configTomlPath, 'utf8'), originalConfig);
    const homeEntries = (await readdir(kikiHome)).sort();
    assert.deepEqual(homeEntries, ['agents', 'config.toml', 'plugin-data']);
    const storeRaw = JSON.parse(await readFile(resolvePluginDataFile({ kikiHome }), 'utf8'));
    assert.equal(storeRaw.revision, 2);

    const cleared = await advisorB.updatePreference({ action: 'clear', group: 'implementation' }, context);
    assert.deepEqual(cleared.clearedGroups, ['implementation']);
    const afterClear = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(afterClear.preference, null);
  });
});

test('consumes context.harnessQuota.cached() ({ sources }) exclusively without polling Magpie, rejects top-level readings or legacy guesses, and preserves unknown/exhausted/Gemini-vs-Argon distinctions', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const advisor = createDispatchAdvisor();

    // 1. Old runtime lacking `context.harnessQuota`: reports `unavailable` cleanly and NEVER touches rejected context properties.
    const unavailableRes = await advisor.recommend(
      { group: 'implementation', includeModels: true, modelCandidates: ['xai/grok-code'] },
      {
        kikiHome,
        settings: {},
        models: {
          list: async (opts) => {
            assert.deepEqual(opts, { candidates: ['xai/grok-code'] });
            return {
              models: SYNTHETIC_CATALOG.models.filter((m) => opts.candidates.includes(m.id)),
              connections: SYNTHETIC_CATALOG.connections,
            };
          },
        },
        quotas: { list: async () => { throw new Error('must not touch rejected context.quotas'); } },
        harnessQuotas: { list: async () => { throw new Error('must not touch rejected context.harnessQuotas'); } },
      },
    );
    assert.equal(unavailableRes.quota.status, 'unavailable');
    assert.deepEqual(unavailableRes.quota.sources, []);
    assert.equal(unavailableRes.connectedModels.length, 1);
    assert.equal(unavailableRes.connectedModels[0].id, 'xai/grok-code');

    // 2. Build a genuine multi-source Host cache snapshot from Magpie batch outputs (Antigravity + plugin-served Grok + Codex
    //    validated against harnessQuotaCacheResponseSchema), plus an unpopulated/failed source whose `readings` is omitted (`undefined`).
    let magpieCliCalls = 0;
    const magpie = new MagpieQuotaService({
      execCommand: async (_exe, args) => {
        magpieCliCalls += 1;
        const agent = args[1];
        if (agent === 'antigravity') {
          return {
            stdout: JSON.stringify([
              {
                agent: 'antigravity',
                user: 'acct-active@example.test',
                alias: 'AGY Active',
                readAt: '2026-11-07T05:00:00Z',
                windows: [
                  { name: 'Gemini 4 Argon · 7 days', pool: 'Gemini 4 Argon', remaining: 40, resetsAt: '2026-11-12T00:00:00Z' },
                  { name: 'Gemini · 7 days', pool: 'Gemini', remaining: 85, resetsAt: '2026-11-12T00:00:00Z' },
                  { name: 'Claude & GPT · 5 hours', pool: 'Claude & GPT', remaining: 0, resetsAt: '2026-11-07T09:00:00Z' },
                ],
              },
              {
                agent: 'antigravity',
                user: 'acct-stale@example.test',
                error: 'quota request failed',
                readAt: '2026-11-06T00:00:00Z',
                asOf: '2026-11-06T00:00:00Z',
                windows: [
                  { name: 'Gemini 4 Argon · 7 days', pool: 'Gemini 4 Argon', remaining: 88, resetsAt: '2026-11-10T00:00:00Z' },
                ],
              },
            ]),
            stderr: '',
          };
        }
        if (agent === 'grok') {
          return {
            stdout: JSON.stringify([
              {
                agent: 'plugin:grok',
                user: 'grok-seat-1@example.test',
                alias: 'Grok Seat 1',
                readAt: '2026-11-08T01:00:00Z',
                windows: [
                  { name: '7 days', used: 79, remaining: 21, resetsAt: '2026-11-14T12:00:00Z' },
                ],
              },
            ]),
            stderr: '',
          };
        }
        throw new Error(`Unexpected CLI agent: ${agent}`);
      },
    });

    // Host populates its cache once per source; subsequent tool calls only read `context.harnessQuota.cached()` and never touch Magpie.
    const { readings: magpieReadings } = await magpie.adapterFor('antigravity').read({
      kikiHome,
      settings: {
        modelWindows: JSON.stringify({
          antigravity: {
            'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
            'claude-opus-5-5-high': { pool: 'Claude & GPT' },
          },
        }),
      },
    });
    const { readings: grokReadings } = await magpie.adapterFor('grok').read({
      kikiHome,
      settings: {},
    });
    assert.equal(magpieCliCalls, 2);

    const cachedPayload = harnessQuotaCacheResponseSchema.parse({
      sources: [
        {
          id: 'plugin:magpie-harness-quota/antigravity',
          label: 'Magpie · Antigravity',
          engineIds: ['agy-cli', 'antigravity-acp'],
          minRefreshIntervalMs: 300_000,
          readAt: '2026-11-07T05:00:05.000Z',
          readings: magpieReadings,
        },
        {
          id: 'plugin:magpie-harness-quota/grok',
          label: 'Magpie · Grok Build',
          engineIds: ['grok-acp'],
          minRefreshIntervalMs: 300_000,
          readAt: '2026-11-08T01:00:03.000Z',
          readings: grokReadings,
        },
        {
          id: 'plugin:magpie-harness-quota/codex',
          label: 'Magpie · Codex',
          engineIds: ['codex-app-server', 'codex-acp'],
          minRefreshIntervalMs: 300_000,
          // `readings` omitted: cache not yet populated or failed read inside interval -> must be `unknown`
        },
      ],
    });

    const hostContext = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
      harnessQuota: {
        cached: async () => structuredClone(cachedPayload),
      },
    };

    const viewA = await advisor.recommend({ group: 'implementation' }, hostContext);
    const viewB = await advisor.recommend({ group: 'implementation' }, hostContext);
    // Advisor never triggered Magpie CLI again!
    assert.equal(magpieCliCalls, 2);
    assert.equal(viewA.quota.status, 'ok');
    assert.equal(Object.hasOwn(viewA.quota, 'readings'), false); // No top-level readings
    assert.equal(viewA.quota.sources.length, 3);
    assert.equal(viewB.quota.sources.length, 3);

    const agySource = viewA.quota.sources.find((s) => s.id === 'plugin:magpie-harness-quota/antigravity');
    assert.equal(agySource.status, 'cached');
    assert.equal(agySource.cached, true);
    assert.equal(agySource.readAt, '2026-11-07T05:00:05.000Z');
    assert.equal(agySource.readings.length, 4);

    // Argon 7d has modelIds ['gemini-4-argon-high'] & 40%; ordinary Gemini 7d has empty modelIds & 85% (never confused with Argon).
    const argonActive = agySource.readings.find((r) => r.accountId === 'acct-active@example.test' && r.pool === 'Gemini 4 Argon');
    assert.equal(argonActive.status, 'known');
    assert.equal(argonActive.remaining, 40);
    assert.equal(argonActive.resetAt, '2026-11-12T00:00:00.000Z');
    assert.deepEqual(argonActive.modelIds, ['gemini-4-argon-high']);

    const ordinaryGemini7d = agySource.readings.find((r) => r.accountId === 'acct-active@example.test' && r.pool === 'Gemini');
    assert.deepEqual(ordinaryGemini7d.modelIds, []);
    assert.equal(ordinaryGemini7d.remaining, 85);

    const exhaustedClaude = agySource.readings.find((r) => r.accountId === 'acct-active@example.test' && r.pool === 'Claude & GPT');
    assert.equal(exhaustedClaude.status, 'exhausted');
    assert.equal(exhaustedClaude.remaining, 0);

    const staleArgon = agySource.readings.find((r) => r.accountId === 'acct-stale@example.test');
    assert.equal(staleArgon.status, 'unknown');
    assert.equal(staleArgon.remaining, null);
    assert.equal(staleArgon.readAt, '2026-11-06T00:00:00.000Z');

    // Cached Grok source reports known 21% remaining without any fabricated pool or modelIds.
    const grokSource = viewA.quota.sources.find((s) => s.id === 'plugin:magpie-harness-quota/grok');
    assert.equal(grokSource.status, 'cached');
    assert.equal(grokSource.cached, true);
    assert.equal(grokSource.readings.length, 1);
    assert.equal(grokSource.readings[0].accountId, 'grok-seat-1@example.test');
    assert.equal(grokSource.readings[0].remaining, 21);
    assert.equal(grokSource.readings[0].window, '7 days');
    assert.equal(grokSource.readings[0].pool, null);
    assert.deepEqual(grokSource.readings[0].modelIds, []);

    // Unpopulated/failed Codex source without `readings` reports `status: "unknown"`, `cached: false`, `readings: null`.
    const codexSource = viewA.quota.sources.find((s) => s.id === 'plugin:magpie-harness-quota/codex');
    assert.equal(codexSource.status, 'unknown');
    assert.equal(codexSource.cached, false);
    assert.equal(codexSource.readings, null);

    // Filtering by exact model target `gemini-4-argon-high` keeps cached Antigravity Argon readings AND preserves
    // uncached Codex source as `status: "unknown"`, `readings: null` (since model membership inside an uncached source
    // cannot be ruled out without guessing model lists), while omitting cached non-matching Grok!
    const filteredArgon = await advisor.recommend({
      group: 'implementation',
      targets: ['gemini-4-argon-high'],
    }, hostContext);
    assert.equal(filteredArgon.quota.status, 'ok');
    assert.deepEqual(
      filteredArgon.quota.sources.map((s) => ({ id: s.id, status: s.status })),
      [
        { id: 'plugin:magpie-harness-quota/antigravity', status: 'cached' },
        { id: 'plugin:magpie-harness-quota/codex', status: 'unknown' },
      ],
    );
    assert.equal(filteredArgon.quota.sources[0].readings.length, 2);
    assert.ok(filteredArgon.quota.sources[0].readings.every((r) => r.pool === 'Gemini 4 Argon'));
    assert.equal(filteredArgon.quota.sources[1].readings, null);

    // Explicit `engineIds: ["agy-cli"]` scopes known relevant sources to Antigravity only, omitting uncached Codex.
    const filteredArgonScopedEngine = await advisor.recommend({
      group: 'implementation',
      engineIds: ['agy-cli'],
      targets: ['gemini-4-argon-high'],
    }, hostContext);
    assert.equal(filteredArgonScopedEngine.quota.sources.length, 1);
    assert.equal(filteredArgonScopedEngine.quota.sources[0].id, 'plugin:magpie-harness-quota/antigravity');

    // Counterexample 1: When Antigravity is not yet read (`readings` omitted), querying `targets: ["gemini-4-argon-high"]`
    // MUST NOT drop the uncached Antigravity source and return `status: "ok", sources: []` — it preserves `status: "unknown"`!
    const uncachedAgyContext = {
      ...hostContext,
      harnessQuota: {
        cached: async () => ({
          sources: [
            {
              id: 'plugin:magpie-harness-quota/antigravity',
              label: 'Magpie · Antigravity',
              engineIds: ['agy-cli', 'antigravity-acp'],
              minRefreshIntervalMs: 300_000,
            },
            {
              id: 'plugin:magpie-harness-quota/grok',
              label: 'Magpie · Grok Build',
              engineIds: ['grok-acp'],
              minRefreshIntervalMs: 300_000,
              readAt: '2026-11-08T01:00:03.000Z',
              readings: grokReadings,
            },
          ],
        }),
      },
    };
    const coldArgonLookup = await advisor.recommend({
      group: 'implementation',
      targets: ['gemini-4-argon-high'],
    }, uncachedAgyContext);
    assert.equal(coldArgonLookup.quota.status, 'unknown');
    assert.equal(coldArgonLookup.quota.sources.length, 1);
    assert.equal(coldArgonLookup.quota.sources[0].id, 'plugin:magpie-harness-quota/antigravity');
    assert.equal(coldArgonLookup.quota.sources[0].status, 'unknown');
    assert.equal(coldArgonLookup.quota.sources[0].readings, null);

    // Counterexample 2: Querying `accountIds: ["acct-unseen@example.test"]` when an engine source has not been read yet
    // MUST NOT drop the uncached source and claim `status: "ok", sources: []` — it preserves `status: "unknown"` without fabricating account ownership!
    const coldAccountLookup = await advisor.recommend({
      group: 'implementation',
      accountIds: ['acct-unseen@example.test'],
    }, uncachedAgyContext);
    assert.equal(coldAccountLookup.quota.status, 'unknown');
    assert.equal(coldAccountLookup.quota.sources.length, 1);
    assert.equal(coldAccountLookup.quota.sources[0].id, 'plugin:magpie-harness-quota/antigravity');
    assert.equal(coldAccountLookup.quota.sources[0].status, 'unknown');
    assert.equal(coldAccountLookup.quota.sources[0].readings, null);

    // Filtering by `targets: ["grok"]` or `engineIds: ["grok-acp"]` isolates Grok cleanly.
    const filteredGrokByTarget = await advisor.recommend({
      group: 'implementation',
      engineIds: ['grok-acp'],
      targets: ['grok'],
    }, hostContext);
    assert.equal(filteredGrokByTarget.quota.sources.length, 1);
    assert.equal(filteredGrokByTarget.quota.sources[0].id, 'plugin:magpie-harness-quota/grok');
    assert.equal(filteredGrokByTarget.quota.sources[0].readings[0].remaining, 21);

    // Filtering by `targets: ["codex"]` preserves uncached Codex source's honest `unknown` status and marks top-level `quota.status = "unknown"`!
    const filteredUncachedCodex = await advisor.recommend({
      group: 'implementation',
      targets: ['codex'],
    }, hostContext);
    assert.equal(filteredUncachedCodex.quota.status, 'unknown');
    assert.equal(filteredUncachedCodex.quota.sources.length, 1);
    assert.equal(filteredUncachedCodex.quota.sources[0].id, 'plugin:magpie-harness-quota/codex');
    assert.equal(filteredUncachedCodex.quota.sources[0].status, 'unknown');
    assert.equal(filteredUncachedCodex.quota.sources[0].readings, null);
  });
});

test('rejects model-inferred preferences lacking userAuthorized=true or provenance, and cleans up writeQueues after concurrent writes', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const store = new PreferenceStore({ kikiHome });
    const advisor = createDispatchAdvisor({ store });

    await assert.rejects(
      advisor.updatePreference({
        action: 'set',
        group: 'implementation',
        avoid: ['gpt'],
        userAuthorized: false,
        userQuote: 'agent guessed GPT might be busy',
      }),
      { code: 'ADVISOR_USER_AUTHORIZATION_REQUIRED' },
    );

    await assert.rejects(
      advisor.updatePreference({
        action: 'set',
        group: 'implementation',
        avoid: ['gpt'],
        userAuthorized: true,
      }),
      { code: 'ADVISOR_PROVENANCE_REQUIRED' },
    );

    await Promise.all([
      store.setPreference({ group: 'implementation', avoid: ['gpt'], userAuthorized: true, userQuote: 'q1' }),
      store.setPreference({ group: 'frontend', prefer: ['gemini'], userAuthorized: true, userQuote: 'q2' }),
      store.clearPreference({ group: 'frontend' }),
    ]);
    assert.equal(getActiveWriteQueueCountForTesting(), 0);
    const state = await store.read();
    assert.equal(state.revision, 3);
    assert.equal(state.preferences.frontend, undefined);
    assert.deepEqual(state.preferences.implementation.avoid, ['gpt']);
  });
});

test('executes end-to-end over Task92 hostRunner RPC (harness-quota-cached + models.list({ candidates }) + preference persistence)', async (t) => {
  const runner = await resolveQuotaCapableRunner();
  if (!runner) {
    t.skip('No harness-quota-cached hostRunner available in environment');
    return;
  }

  await withIsolatedHome(async (kikiHome) => {
    const pluginRoot = path.dirname(import.meta.dirname);
    const child = spawn(process.execPath, [runner, path.join(pluginRoot, 'entry.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const incoming = createInterface({ input: child.stdout });
    const send = (payload) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    const registeredTools = [];
    const seenModelActions = [];

    const hostCacheFixture = harnessQuotaCacheResponseSchema.parse({
      sources: [
        {
          id: 'plugin:magpie-harness-quota/antigravity',
          label: 'Magpie · Antigravity',
          engineIds: ['agy-cli', 'antigravity-acp'],
          minRefreshIntervalMs: 300_000,
          readAt: '2026-11-07T06:00:00.000Z',
          readings: [
            {
              accountId: 'work-a@example.test',
              accountLabel: 'Work A',
              modelIds: ['gemini-4-argon-high'],
              pool: 'Gemini 4 Argon',
              unit: 'percent',
              window: '7 days',
              remaining: 72,
              resetAt: '2026-11-13T00:00:00.000Z',
              readAt: '2026-11-07T06:00:00.000Z',
            },
          ],
        },
        {
          id: 'plugin:magpie-harness-quota/grok',
          label: 'Magpie · Grok Build',
          engineIds: ['grok-acp'],
          minRefreshIntervalMs: 300_000,
          readAt: '2026-11-08T01:00:00.000Z',
          readings: [
            {
              accountId: 'grok-seat-1@example.test',
              unit: 'percent',
              window: '7 days',
              remaining: 21,
              resetAt: '2026-11-14T12:00:00.000Z',
              readAt: '2026-11-08T01:00:00.000Z',
            },
          ],
        },
      ],
    });

    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Host runner RPC timed out')), 10_000);
        incoming.on('line', (line) => {
          const message = JSON.parse(line);
          if (message.method === 'register') {
            registeredTools.push(message.params.tool);
          } else if (message.method === 'ready') {
            send({
              id: 1,
              method: 'execute',
              params: {
                name: 'dispatch_preference_update',
                kikiHome,
                settings: {},
                args: {
                  action: 'set',
                  group: 'implementation',
                  prefer: ['implementer-grokbuild', 'non-gpt'],
                  avoid: ['gpt'],
                  userAuthorized: true,
                  userQuote: '现在GPT少用一点',
                },
              },
            });
          } else if (message.id === 1) {
            send({
              id: 2,
              method: 'execute',
              params: {
                name: 'dispatch_advisor_recommend',
                kikiHome,
                settings: {},
                args: {
                  group: 'implementation',
                  includeModels: true,
                  modelCandidates: ['xai/grok-code'],
                },
              },
            });
          } else if (message.method === 'model-call') {
            seenModelActions.push({ action: message.params?.action, input: message.params?.input });
            if (message.params?.action === 'harness-quota-cached') {
              send({
                method: 'model-result',
                params: {
                  callId: message.params.callId,
                  result: hostCacheFixture,
                },
              });
            } else if (message.params?.action === 'list') {
              send({
                method: 'model-result',
                params: {
                  callId: message.params.callId,
                  result: {
                    models: SYNTHETIC_CATALOG.models.filter((m) => message.params.input?.candidates?.includes(m.id)),
                    connections: SYNTHETIC_CATALOG.connections,
                  },
                },
              });
            }
          } else if (message.id === 2) {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        child.once('error', reject);
        send({ id: 0, method: 'handshake', params: { version: 1 } });
      });

      assert.equal(registeredTools.length, 2);
      assert.deepEqual(registeredTools, definitions);
      assert.deepEqual(seenModelActions, [
        { action: 'harness-quota-cached', input: undefined },
        { action: 'list', input: { candidates: ['xai/grok-code'] } },
      ]);
      assert.notEqual(result.result.isError, true);
      const body = JSON.parse(result.result.output);
      assert.equal(body.informationOnly, true);
      assert.equal(Object.hasOwn(body, 'recommended'), false);
      assert.deepEqual(body.preference.prefer, ['implementer-grokbuild', 'non-gpt']);
      assert.equal(body.quota.status, 'ok');
      assert.equal(Object.hasOwn(body.quota, 'readings'), false);
      assert.equal(body.quota.sources.length, 2);
      assert.equal(body.quota.sources[0].id, 'plugin:magpie-harness-quota/antigravity');
      assert.equal(body.quota.sources[0].readings[0].remaining, 72);
      assert.equal(body.quota.sources[1].id, 'plugin:magpie-harness-quota/grok');
      assert.equal(body.quota.sources[1].readings[0].remaining, 21);
      assert.equal(body.connectedModels.length, 1);
      assert.equal(body.connectedModels[0].id, 'xai/grok-code');
    } finally {
      child.kill();
      incoming.close();
    }
  });
});
