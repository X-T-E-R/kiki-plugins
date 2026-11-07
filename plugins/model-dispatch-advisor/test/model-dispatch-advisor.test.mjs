import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { definitions, register } from '../entry.mjs';
import { BUILTIN_GROUPS, createDispatchAdvisor } from '../lib/advisor.mjs';
import { getActiveWriteQueueCountForTesting, PreferenceStore, resolvePluginDataFile } from '../lib/store.mjs';
import { MagpieQuotaService } from '../../magpie-harness-quota/lib/magpie.mjs';

const SYNTHETIC_CATALOG = {
  models: [
    {
      id: 'openai/gpt-chat',
      provider_id: 'openai-conn',
      remote_id: 'gpt-chat',
      display_name: 'GPT Chat',
      max_context_size: 200_000,
      effective_protocol: 'openai_responses',
    },
    {
      id: 'xai/grok-code',
      provider_id: 'xai-conn',
      remote_id: 'grok-code',
      display_name: 'Grok Code',
      max_context_size: 262_144,
      effective_protocol: 'openai',
    },
    {
      id: 'google/gemini-argon',
      provider_id: 'google-conn',
      remote_id: 'gemini-argon',
      display_name: 'Gemini Argon',
      max_context_size: 1_048_576,
      effective_protocol: 'google-genai',
    },
    {
      id: 'deepseek/deepseek-chat',
      provider_id: 'deepseek-conn',
      remote_id: 'deepseek-chat',
      display_name: 'DeepSeek Chat',
      max_context_size: 131_072,
      effective_protocol: 'openai',
    },
  ],
  connections: [
    { id: 'openai-conn', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'xai-conn', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'google-conn', type: 'google', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'deepseek-conn', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
  ],
};

const ARGON_DS_CATALOG = {
  models: [
    {
      id: 'provider/gemini-argon',
      provider_id: 'conn-a',
      remote_id: 'gemini-argon',
      display_name: 'Argon',
      max_context_size: 1_000_000,
      effective_protocol: 'google-genai',
    },
    {
      id: 'provider/deepseek-v4',
      provider_id: 'conn-b',
      remote_id: 'deepseek-v4',
      display_name: 'DS',
      max_context_size: 128_000,
      effective_protocol: 'openai',
    },
  ],
  connections: [
    { id: 'conn-a', type: 'google', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'conn-b', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
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

test('manifest tools match lib/definitions.mjs field-for-field and BUILTIN_GROUPS ships zero hardcoded private model aliases', () => {
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  assert.equal(definitions.length, 2);
  for (const tool of definitions) {
    assert.equal(tool.schemaVersion, 1);
    assert.ok(tool.description.length > 0 && tool.description.length < 600);
    assert.equal(tool.disclosure, 'deferred');
  }
  for (const group of Object.values(BUILTIN_GROUPS)) {
    assert.equal(group.candidates, undefined);
  }
});

test('counterexample 1: Argon (0% quota) vs DS (80% quota) with zero saved preferences preserves writer role default and never swaps explicitTarget Argon to DS', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => ARGON_DS_CATALOG },
    };
    const advisor = createDispatchAdvisor({
      readQuotaSnapshot: async () => [
        {
          accountId: 'acct@example.test',
          modelIds: ['provider/gemini-argon'],
          unit: 'percent',
          remaining: 0,
          readAt: '2026-11-07T06:00:00Z',
        },
        {
          accountId: 'acct@example.test',
          modelIds: ['provider/deepseek-v4'],
          unit: 'percent',
          remaining: 80,
          readAt: '2026-11-07T06:00:00Z',
        },
      ],
    });

    // Case 1A: Zero preferences stored, `recommend({ role: 'writer' })` with only catalog models.
    // Must preserve profile inheritance (`profile:writer`) rather than recommending DS!
    const writerInherited = await advisor.recommend({ role: 'writer' }, context);
    assert.equal(writerInherited.preference, null);
    assert.equal(writerInherited.group.protectedRoleDefault, true);
    assert.equal(writerInherited.group.protectedDefaultPreserved, true);
    assert.equal(writerInherited.recommended.id, 'profile:writer');
    assert.equal(writerInherited.recommended.kind, 'profile');
    assert.equal(writerInherited.recommended.profile, 'writer');
    assert.notEqual(writerInherited.recommended.modelId, 'provider/deepseek-v4');

    // Case 1B: Zero preferences stored, caller supplies Argon as writer's roleDefaultModel (0% quota) vs DS (80% quota).
    // Protected role default must stay Argon and surface `exhausted` honestly instead of silently switching to DS!
    const writerArgonDefault = await advisor.recommend({
      role: 'writer',
      roleDefaultModel: 'provider/gemini-argon',
    }, context);
    assert.equal(writerArgonDefault.preference, null);
    assert.equal(writerArgonDefault.group.protectedDefaultPreserved, true);
    assert.equal(writerArgonDefault.recommended.modelId, 'provider/gemini-argon');
    assert.equal(writerArgonDefault.recommended.quota.status, 'exhausted');
    assert.equal(writerArgonDefault.recommended.quota.remaining, 0);

    // Case 1C: Zero preferences stored, `recommend({ role: 'writer', explicitTarget: 'Argon' })` (or in implementation group).
    // Both candidates[0] AND recommended MUST stay Argon with quota status `exhausted`—never silently swapped to DS!
    const explicitArgonWriter = await advisor.recommend({
      role: 'writer',
      explicitTarget: 'Argon',
    }, context);
    assert.equal(explicitArgonWriter.candidates[0].modelId, 'provider/gemini-argon');
    assert.equal(explicitArgonWriter.recommended.modelId, 'provider/gemini-argon');
    assert.equal(explicitArgonWriter.recommended.quota.status, 'exhausted');
    assert.equal(explicitArgonWriter.recommended.quota.remaining, 0);

    const explicitArgonImpl = await advisor.recommend({
      group: 'implementation',
      explicitTarget: 'Argon',
    }, context);
    assert.equal(explicitArgonImpl.candidates[0].modelId, 'provider/gemini-argon');
    assert.equal(explicitArgonImpl.recommended.modelId, 'provider/gemini-argon');
    assert.equal(explicitArgonImpl.recommended.quota.status, 'exhausted');
  });
});

test('counterexample 2: zero-config first use derives candidates from context.models.list(), while external harnesses require explicit readiness facts', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };
    const advisor = createDispatchAdvisor();

    // First-run call with zero custom group and zero caller candidates: concise & ready out of the box from models.list().
    const firstRun = await advisor.recommend({}, context);
    assert.equal(firstRun.ok, true);
    assert.equal(firstRun.group.id, 'implementation');
    assert.equal(firstRun.candidates.length, 4);
    assert.equal(firstRun.recommended.id, 'openai/gpt-chat');

    // External harness supplied WITHOUT `available: true` cannot be proved ready by models.list() alone -> eligible: false.
    const unverifiedHarness = await advisor.recommend({
      group: 'implementation',
      candidates: [
        {
          id: 'grok-build',
          label: 'Grok Build',
          kind: 'external-harness',
          profile: 'implementer-grokbuild',
          executorId: 'grok-acp',
          modelId: 'grok-code',
          family: 'grok',
        },
        {
          id: 'native-argon',
          modelId: 'google/gemini-argon',
        },
      ],
    }, context);
    const grokUnverified = unverifiedHarness.candidates.find((c) => c.id === 'grok-build');
    assert.equal(grokUnverified.catalog.status, 'external_unverified_by_model_catalog');
    assert.equal(grokUnverified.catalog.available, false);
    assert.equal(grokUnverified.eligible, false);
    assert.equal(unverifiedHarness.recommended.id, 'native-argon');

    // Once caller or custom group confirms profile/harness readiness (`available: true`), external harness participates.
    const verifiedHarness = await advisor.recommend({
      group: 'implementation',
      candidates: [
        {
          id: 'grok-build',
          label: 'Grok Build',
          kind: 'external-harness',
          profile: 'implementer-grokbuild',
          executorId: 'grok-acp',
          modelId: 'grok-code',
          family: 'grok',
          available: true,
        },
        {
          id: 'native-argon',
          modelId: 'google/gemini-argon',
        },
      ],
    }, context);
    const grokVerified = verifiedHarness.candidates.find((c) => c.id === 'grok-build');
    assert.equal(grokVerified.eligible, true);
    assert.equal(verifiedHarness.recommended.id, 'grok-build');
  });
});

test('counterexample 3: explicit empty allowlists (allowedProfiles: [] / allowedModels: []) block all candidates, and PreferenceStore cleans up writeQueues', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };
    const advisor = createDispatchAdvisor();

    // Even with Grok Build marked available and preferred, `allowedProfiles: []` admits nothing!
    await advisor.updatePreference({
      action: 'define_group',
      group: 'implementation',
      candidates: [
        {
          id: 'grok-build',
          kind: 'external-harness',
          profile: 'implementer-grokbuild',
          executorId: 'grok-acp',
          available: true,
        },
        {
          id: 'native-grok',
          kind: 'native-model',
          modelId: 'xai/grok-code',
        },
      ],
    }, context);

    const emptyProfiles = await advisor.recommend({
      group: 'implementation',
      constraints: { allowedProfiles: [] },
    }, context);
    assert.equal(emptyProfiles.recommended, null);
    for (const c of emptyProfiles.candidates) {
      assert.equal(c.eligible, false);
      assert.equal(c.admittedByProfileConstraints, false);
      assert.match(c.blockedReasons[0], /allowedProfiles.*empty/i);
    }

    const emptyModels = await advisor.recommend({
      group: 'implementation',
      constraints: { allowedModels: [] },
    }, context);
    assert.equal(emptyModels.recommended, null);
    for (const c of emptyModels.candidates) {
      assert.equal(c.eligible, false);
      assert.equal(c.admittedByProfileConstraints, false);
      assert.match(c.blockedReasons[0], /allowedModels.*empty/i);
    }

    // Verify concurrent mutations serialize atomically AND writeQueues has zero leaked entries once settled.
    const store = new PreferenceStore({ kikiHome });
    await Promise.all([
      store.setPreference({
        group: 'implementation',
        avoid: ['gpt'],
        userAuthorized: true,
        userQuote: 'u1',
      }),
      store.setPreference({
        group: 'frontend',
        prefer: ['gemini'],
        userAuthorized: true,
        userQuote: 'u2',
      }),
      store.clearPreference({ group: 'frontend' }),
    ]);
    assert.equal(getActiveWriteQueueCountForTesting(), 0);
    const finalState = await store.read();
    assert.ok(finalState.revision >= 3);
    assert.equal(finalState.preferences.frontend, undefined);
    assert.deepEqual(finalState.preferences.implementation.avoid, ['gpt']);
  });
});

test('persists explicit implementation preference ("现在GPT少用一点"), survives reopen, isolates groups, and supports clear', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };

    const advisorA = createDispatchAdvisor({ now: () => '2026-11-07T10:00:00.000Z' });
    const saved = await advisorA.updatePreference({
      action: 'set',
      group: 'implementation',
      prefer: ['grok', 'gemini', 'non-gpt'],
      avoid: ['gpt'],
      userAuthorized: true,
      userQuote: '现在GPT少用一点，实现优先用 Grok 或非 GPT',
      sourceNote: 'session:main#t2121',
    }, context);

    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.preference.source.kind, 'explicit_user');
    assert.match(saved.preference.source.userQuote, /现在GPT少用一点/);
    assert.equal(getActiveWriteQueueCountForTesting(), 0);

    // Verify only plugin's own data folder was written (no agents/, config.toml, or credentials/ created).
    const homeEntries = await readdir(kikiHome);
    assert.deepEqual(homeEntries, ['plugin-data']);
    const storeFile = resolvePluginDataFile({ kikiHome });
    const rawDisk = JSON.parse(await readFile(storeFile, 'utf8'));
    assert.equal(rawDisk.revision, 1);

    // Fresh reopen ranks Grok / Argon ahead of GPT on zero-config catalog models.
    const advisorB = createDispatchAdvisor();
    const rec = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(rec.ok, true);
    assert.equal(rec.advisoryOnly, true);
    assert.equal(rec.preference.applied, true);
    assert.equal(rec.recommended.id, 'xai/grok-code');
    assert.equal(rec.candidates[0].id, 'xai/grok-code');
    assert.equal(rec.candidates[1].id, 'google/gemini-argon');

    const gptEntry = rec.candidates.find((c) => c.id === 'openai/gpt-chat');
    assert.equal(gptEntry.preferenceEffect, 'avoided');
    assert.equal(gptEntry.rank, 4);

    // Functional group isolation: review has NO preference applied, keeping catalog order.
    const reviewRec = await advisorB.recommend({ group: 'review' }, context);
    assert.equal(reviewRec.preference, null);
    assert.equal(reviewRec.recommended.id, 'openai/gpt-chat');

    // Clear removes the preference cleanly and restores baseline catalog ranking.
    const cleared = await advisorB.updatePreference({
      action: 'clear',
      group: 'implementation',
    }, context);
    assert.deepEqual(cleared.clearedGroups, ['implementation']);

    const afterClear = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(afterClear.preference, null);
    assert.equal(afterClear.recommended.id, 'openai/gpt-chat');
  });
});

test('protects writer, think, and director role defaults unless the user explicitly authorizes changing that role', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };
    const advisor = createDispatchAdvisor();

    await advisor.updatePreference({
      action: 'set',
      group: 'implementation',
      avoid: ['gpt'],
      prefer: ['grok'],
      userAuthorized: true,
      userQuote: '现在GPT少用一点',
    }, context);

    // Without roleDefaultModel, protected roles preserve profile:<role> inheritance.
    const thinkRec = await advisor.recommend({ role: 'think' }, context);
    assert.equal(thinkRec.group.id, 'thinking');
    assert.equal(thinkRec.group.protectedDefaultPreserved, true);
    assert.equal(thinkRec.recommended.id, 'profile:think');

    // With caller-supplied roleDefaultModel ('openai/gpt-chat'), even a `thinking` preference lacking `authorizedRoles: ['think']` cannot displace it.
    await advisor.updatePreference({
      action: 'set',
      group: 'thinking',
      avoid: ['gpt'],
      prefer: ['grok'],
      userAuthorized: true,
      userQuote: '省点GPT额度',
    }, context);

    const thinkStillProtected = await advisor.recommend({
      role: 'think',
      roleDefaultModel: 'openai/gpt-chat',
    }, context);
    assert.equal(thinkStillProtected.group.protectedDefaultPreserved, true);
    assert.equal(thinkStillProtected.preference.applied, false);
    assert.equal(thinkStillProtected.recommended.id, 'openai/gpt-chat');

    // Only when the user explicitly authorizes `think` (`authorizedRoles: ['think']`) does it switch to Grok.
    await advisor.updatePreference({
      action: 'set',
      group: 'thinking',
      avoid: ['gpt'],
      prefer: ['grok'],
      authorizedRoles: ['think'],
      userAuthorized: true,
      userQuote: 'think 角色也改用 Grok，少用 GPT',
    }, context);

    const thinkAuthorized = await advisor.recommend({
      role: 'think',
      roleDefaultModel: 'openai/gpt-chat',
    }, context);
    assert.equal(thinkAuthorized.group.protectedDefaultPreserved, false);
    assert.equal(thinkAuthorized.preference.applied, true);
    assert.equal(thinkAuthorized.recommended.id, 'xai/grok-code');
  });
});

test('rejects model-inferred preferences lacking userAuthorized=true or provenance quote', async () => {
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
  });
});

test('handles unknown quota without fabricating 0 or infinite and sorts comparable same-unit Magpie readings cleanly', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const magpie = new MagpieQuotaService({
      execCommand: async () => ({
        stdout: JSON.stringify([
          {
            agent: 'antigravity',
            user: 'acct-1@example.test',
            alias: 'AGY 1',
            readAt: '2026-11-07T05:00:00Z',
            windows: [
              { name: 'Gemini 4 Argon · 7 days', pool: 'Gemini 4 Argon', used: 60, remaining: 40, resetsAt: '2026-11-12T00:00:00Z' },
              { name: 'Gemini · 5 hours', pool: 'Gemini', used: 15, remaining: 85, resetsAt: '2026-11-07T10:00:00Z' },
            ],
          },
        ]),
        stderr: '',
      }),
    });

    const magpieSettings = {
      modelWindows: JSON.stringify({
        'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
        'gemini-3.8-flash-high': { pool: 'Gemini', name: '5 hours' },
      }),
    };

    const advisor = createDispatchAdvisor({
      readQuotaSnapshot: ({ signal }) => magpie.adapter.read({ signal, settings: magpieSettings }),
    });

    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => SYNTHETIC_CATALOG },
    };

    await advisor.updatePreference({
      action: 'define_group',
      group: 'agy-frontend-pool',
      groupLabel: 'AGY Frontend Candidates',
      candidates: [
        {
          id: 'agy-argon',
          label: 'AGY Argon High',
          kind: 'external-harness',
          executorId: 'agy-cli',
          modelId: 'gemini-4-argon-high',
          available: true,
          defaultRank: 10,
        },
        {
          id: 'agy-flash',
          label: 'AGY 3.8 Flash High',
          kind: 'external-harness',
          executorId: 'agy-cli',
          modelId: 'gemini-3.8-flash-high',
          available: true,
          defaultRank: 20,
        },
        {
          id: 'native-unknown-quota',
          label: 'Native Argon (No Quota Source)',
          kind: 'native-model',
          modelId: 'google/gemini-argon',
          defaultRank: 30,
        },
      ],
    }, context);

    const rec = await advisor.recommend({ group: 'agy-frontend-pool' }, context);
    assert.equal(rec.quotaSummary.status, 'ok');
    assert.equal(rec.candidates[0].id, 'agy-flash');
    assert.equal(rec.candidates[0].quota.remaining, 85);
    assert.equal(rec.candidates[1].id, 'agy-argon');
    assert.equal(rec.candidates[1].quota.remaining, 40);

    const unknownEntry = rec.candidates.find((c) => c.id === 'native-unknown-quota');
    assert.equal(unknownEntry.quota.status, 'unknown');
    assert.equal(unknownEntry.quota.remaining, null);

    // Without injected quota reader, context guesses are NOT probed; status reports 'unavailable' cleanly.
    const uninjectedAdvisor = createDispatchAdvisor();
    const uninjectedRec = await uninjectedAdvisor.recommend({
      group: 'agy-frontend-pool',
    }, {
      ...context,
      quotas: { list: async () => { throw new Error('must not probe unapproved guessed context fields'); } },
      harnessQuotas: { list: async () => { throw new Error('must not probe unapproved guessed context fields'); } },
    });
    assert.equal(uninjectedRec.quotaSummary.status, 'unavailable');
  });
});

test('entry.mjs registers exact tools and pinned Kiki hostRunner executes model-call + preference persistence end-to-end', { skip: !process.env.KIKI_HOST_RUNNER }, async () => {
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
                  prefer: ['grok', 'gemini'],
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
                args: { group: 'implementation' },
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
      assert.equal(body.recommended.id, 'xai/grok-code');
      assert.equal(body.preference.applied, true);
    } finally {
      child.kill();
      incoming.close();
    }
  });
});
