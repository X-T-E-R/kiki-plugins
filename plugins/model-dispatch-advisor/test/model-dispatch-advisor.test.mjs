import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { definitions, register } from '../entry.mjs';
import * as advisorModule from '../lib/advisor.mjs';
import { createDispatchAdvisor } from '../lib/advisor.mjs';
import { getActiveWriteQueueCountForTesting, PreferenceStore, resolvePluginDataFile } from '../lib/store.mjs';
import { MagpieQuotaService } from '../../magpie-harness-quota/lib/magpie.mjs';

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
    // Seed synthetic local agent profile and config.toml to verify the plugin never touches or rewrites them.
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

    // Save preference under `implementation` scope.
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
    assert.match(saved.preference.source.userQuote, /现在GPT少用一点/);
    assert.equal(getActiveWriteQueueCountForTesting(), 0);

    // Reopen with a new advisor instance: `implementation` returns the saved preference, with NO `recommended` winner or candidate injection.
    const advisorB = createDispatchAdvisor();
    const implView = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(implView.ok, true);
    assert.equal(implView.informationOnly, true);
    assert.equal(Object.hasOwn(implView, 'recommended'), false);
    assert.equal(Object.hasOwn(implView, 'candidates'), false);
    assert.equal(implView.scope.group, 'implementation');
    assert.equal(implView.preference.source.sourceNote, 'session:main#t2121');
    assert.deepEqual(implView.preference.prefer, ['implementer-grokbuild', 'non-gpt']);

    // Querying other scopes (using 'writer' and 'think' purely as sample scope keys) shows `preference: null` —
    // the implementation preference does NOT bleed into them, and no special role table is needed.
    for (const sampleScope of ['writer', 'think', 'review']) {
      const otherView = await advisorB.recommend({ group: sampleScope }, context);
      assert.equal(otherView.scope.group, sampleScope);
      assert.equal(otherView.preference, null);
      assert.equal(Object.hasOwn(otherView, 'recommended'), false);
    }

    // Replacing `implementation` updates to the latest instruction and increments revision.
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
    assert.deepEqual(reread.preference.avoid, []);

    // Verify local agent profiles and config.toml were NEVER modified, and only `plugin-data` was added.
    assert.equal(await readFile(writerProfilePath, 'utf8'), originalWriterProfile);
    assert.equal(await readFile(thinkProfilePath, 'utf8'), originalThinkProfile);
    assert.equal(await readFile(configTomlPath, 'utf8'), originalConfig);
    const homeEntries = (await readdir(kikiHome)).sort();
    assert.deepEqual(homeEntries, ['agents', 'config.toml', 'plugin-data']);
    const storeRaw = JSON.parse(await readFile(resolvePluginDataFile({ kikiHome }), 'utf8'));
    assert.equal(storeRaw.revision, 2);

    // Clear removes the preference cleanly.
    const cleared = await advisorB.updatePreference({ action: 'clear', group: 'implementation' }, context);
    assert.deepEqual(cleared.clearedGroups, ['implementation']);
    const afterClear = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(afterClear.preference, null);
  });
});

test('presents raw quota readings, sources, readAt/resetsAt, filters by identifier, and reports unavailable/unknown/stale states honestly without fabricating 0 or infinite', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };

    // 1. When no quota snapshot source is bound, status is honestly `unavailable` with empty readings,
    //    and unapproved guessed context fields (`quotas` / `harnessQuotas`) are never probed.
    const noQuotaAdvisor = createDispatchAdvisor();
    const unavailableRes = await noQuotaAdvisor.recommend(
      { group: 'implementation', includeModels: true, targets: ['grok-code'] },
      {
        ...context,
        quotas: { list: async () => { throw new Error('must not probe guessed context.quotas'); } },
        harnessQuotas: { list: async () => { throw new Error('must not probe guessed context.harnessQuotas'); } },
      },
    );
    assert.equal(unavailableRes.quota.status, 'unavailable');
    assert.deepEqual(unavailableRes.quota.readings, []);
    assert.equal(unavailableRes.connectedModels.length, 1);
    assert.equal(unavailableRes.connectedModels[0].id, 'xai/grok-code');
    assert.equal(Object.hasOwn(unavailableRes, 'recommended'), false);

    // 2. With Magpie batch output (including known remaining, true 0 exhausted, and stale `asOf`/`error` fallback),
    //    readings preserve source, timestamps, and exact unknown vs exhausted states.
    const magpie = new MagpieQuotaService({
      execCommand: async () => ({
        stdout: JSON.stringify([
          {
            agent: 'antigravity',
            user: 'acct-active@example.test',
            alias: 'AGY Active',
            readAt: '2026-11-07T05:00:00Z',
            windows: [
              { name: 'Gemini 4 Argon · 7 days', pool: 'Gemini 4 Argon', remaining: 40, resetsAt: '2026-11-12T00:00:00Z' },
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
      }),
    });

    const magpieSettings = {
      modelWindows: JSON.stringify({
        'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
        'claude-opus-5-5-high': { pool: 'Claude & GPT' },
      }),
    };

    const advisor = createDispatchAdvisor({
      readQuotaSnapshot: async ({ signal }) => ({
        sources: [
          {
            id: 'plugin:magpie-harness-quota/antigravity',
            label: 'Magpie · Antigravity',
            engineIds: ['agy-cli'],
            readAt: '2026-11-07T05:00:00Z',
            readings: await magpie.adapter.read({ signal, settings: magpieSettings }),
          },
        ],
      }),
    });

    const fullQuota = await advisor.recommend({ group: 'implementation' }, context);
    assert.equal(fullQuota.quota.status, 'ok');
    assert.equal(fullQuota.quota.sources.length, 1);
    assert.equal(fullQuota.quota.sources[0].id, 'plugin:magpie-harness-quota/antigravity');
    assert.equal(fullQuota.quota.sources[0].readAt, '2026-11-07T05:00:00.000Z');
    assert.equal(fullQuota.quota.readings.length, 3);

    const activeArgon = fullQuota.quota.readings.find(
      (r) => r.accountId === 'acct-active@example.test' && r.pool === 'Gemini 4 Argon',
    );
    assert.equal(activeArgon.status, 'known');
    assert.equal(activeArgon.remaining, 40);
    assert.equal(activeArgon.unit, 'percent');
    assert.deepEqual(activeArgon.modelIds, ['gemini-4-argon-high']);

    const exhaustedClaude = fullQuota.quota.readings.find(
      (r) => r.accountId === 'acct-active@example.test' && r.pool === 'Claude & GPT',
    );
    assert.equal(exhaustedClaude.status, 'exhausted');
    assert.equal(exhaustedClaude.remaining, 0);

    const staleArgon = fullQuota.quota.readings.find(
      (r) => r.accountId === 'acct-stale@example.test',
    );
    assert.equal(staleArgon.status, 'unknown');
    assert.equal(staleArgon.remaining, null);
    assert.equal(staleArgon.readAt, '2026-11-06T00:00:00.000Z');

    // Filter by target model ID + account ID returns only matching readings.
    const filtered = await advisor.recommend({
      group: 'implementation',
      targets: ['gemini-4-argon-high'],
      accountIds: ['acct-active@example.test'],
    }, context);
    assert.equal(filtered.quota.totalCachedReadings, 3);
    assert.equal(filtered.quota.matchedReadingCount, 1);
    assert.equal(filtered.quota.readings[0].remaining, 40);
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

test('entry.mjs registers exact tools and pinned Kiki hostRunner executes preference persistence + information query end-to-end', { skip: !process.env.KIKI_HOST_RUNNER }, async () => {
  await withIsolatedHome(async (kikiHome) => {
    const pluginRoot = path.dirname(import.meta.dirname);
    const runner = path.resolve(process.env.KIKI_HOST_RUNNER);
    const child = spawn(process.execPath, [runner, path.join(pluginRoot, 'entry.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const incoming = createInterface({ input: child.stdout });
    const send = (payload) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    const registeredTools = [];

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
                args: { group: 'implementation', includeModels: true },
              },
            });
          } else if (message.method === 'model-call' && message.params?.action === 'list') {
            send({
              method: 'model-result',
              params: {
                callId: message.params.callId,
                result: SYNTHETIC_CATALOG,
              },
            });
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
      assert.notEqual(result.result.isError, true);
      const body = JSON.parse(result.result.output);
      assert.equal(body.informationOnly, true);
      assert.equal(Object.hasOwn(body, 'recommended'), false);
      assert.deepEqual(body.preference.prefer, ['implementer-grokbuild', 'non-gpt']);
      assert.deepEqual(body.preference.avoid, ['gpt']);
      assert.equal(body.connectedModels.length, 2);
    } finally {
      child.kill();
      incoming.close();
    }
  });
});
