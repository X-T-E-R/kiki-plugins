import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { definitions, register } from '../entry.mjs';
import { createDispatchAdvisor } from '../lib/advisor.mjs';
import { PreferenceStore, resolvePluginDataFile } from '../lib/store.mjs';
import { MagpieQuotaService } from '../../magpie-harness-quota/lib/magpie.mjs';

const FIXTURE_CATALOG = {
  models: [
    {
      id: 'axon/gpt-6.1-sol',
      provider_id: 'axon',
      remote_id: 'gpt-6.1-sol',
      display_name: 'GPT-6.1 Sol',
      max_context_size: 400_000,
      effective_protocol: 'openai_responses',
    },
    {
      id: 'axon/gpt-6-astra',
      provider_id: 'axon',
      remote_id: 'gpt-6-astra',
      display_name: 'GPT-6 Astra',
      max_context_size: 400_000,
      effective_protocol: 'openai_responses',
    },
    {
      id: 'axon-message/gemini-4-argon',
      provider_id: 'axon-message',
      remote_id: 'gemini-4-argon',
      display_name: 'Gemini 4 Argon',
      max_context_size: 1_048_576,
      effective_protocol: 'anthropic',
    },
    {
      id: 'axon-message/gemini-3.8-flash',
      provider_id: 'axon-message',
      remote_id: 'gemini-3.8-flash',
      display_name: 'Gemini 3.8 Flash',
      max_context_size: 1_048_576,
      effective_protocol: 'anthropic',
    },
    {
      id: 'grok-4.7',
      provider_id: 'xai',
      remote_id: 'grok-4.7',
      display_name: 'Grok 4.7',
      max_context_size: 262_144,
      effective_protocol: 'openai',
    },
    {
      id: 'deepseek-v4-flash',
      provider_id: 'deepseek',
      remote_id: 'deepseek-v4-flash',
      display_name: 'DeepSeek V4 Flash',
      max_context_size: 131_072,
      effective_protocol: 'openai',
    },
    {
      id: 'anthropic/claude-opus-5-5',
      provider_id: 'anthropic',
      remote_id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      max_context_size: 250_000,
      effective_protocol: 'anthropic',
    },
    {
      id: 'kimi-code/k3-256k',
      provider_id: 'managed:kimi-code',
      remote_id: 'k3-256k',
      display_name: 'K3 256K',
      max_context_size: 262_144,
      effective_protocol: 'anthropic',
    },
  ],
  connections: [
    { id: 'axon', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'axon-message', type: 'anthropic', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'xai', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'deepseek', type: 'openai', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'anthropic', type: 'anthropic', status: 'connected', service: 'chat', authentication: 'api-key' },
    { id: 'managed:kimi-code', type: 'kimi', status: 'connected', service: 'chat', authentication: 'oauth' },
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

test('manifest tools match lib/definitions.mjs field-for-field and fit description budgets', () => {
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  assert.equal(definitions.length, 2);
  for (const tool of definitions) {
    assert.equal(tool.schemaVersion, 1);
    assert.ok(tool.description.length > 0 && tool.description.length < 600);
    assert.equal(tool.disclosure, 'deferred');
  }
});

test('persists explicit implementation preference ("现在GPT少用一点"), survives reopen, isolates groups, and supports clear', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => FIXTURE_CATALOG },
    };

    // First instance writes preference.
    const advisorA = createDispatchAdvisor({ now: () => '2026-11-07T10:00:00.000Z' });
    const saved = await advisorA.updatePreference({
      action: 'set',
      group: 'implementation',
      prefer: ['implementer-grokbuild', 'implementer-argon', 'non-gpt'],
      avoid: ['gpt'],
      userAuthorized: true,
      userQuote: '现在GPT少用一点，实现优先用 Grok Build 或 Argon 等非 GPT',
      sourceNote: 'session:main#t2121',
    }, context);

    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.preference.source.kind, 'explicit_user');
    assert.match(saved.preference.source.userQuote, /现在GPT少用一点/);

    // Verify only plugin's own data folder was written (no agents/, config.toml, or credentials/ created).
    const homeEntries = await readdir(kikiHome);
    assert.deepEqual(homeEntries, ['plugin-data']);
    const storeFile = resolvePluginDataFile({ kikiHome });
    const rawDisk = JSON.parse(await readFile(storeFile, 'utf8'));
    assert.equal(rawDisk.revision, 1);

    // Fresh reopen (second instance, simulating restart) reads back state and ranks Grok Build / Argon ahead of GPT Sol.
    const advisorB = createDispatchAdvisor();
    const rec = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(rec.ok, true);
    assert.equal(rec.advisoryOnly, true);
    assert.equal(rec.preference.applied, true);
    assert.equal(rec.preference.source.sourceNote, 'session:main#t2121');

    // Grok Build (external harness) is preserved (not dropped) and ranked #1; Argon #2; GPT Sol/Astra pushed to bottom.
    assert.equal(rec.recommended.id, 'implementer-grokbuild:grok-4.7');
    assert.equal(rec.candidates[0].id, 'implementer-grokbuild:grok-4.7');
    assert.equal(rec.candidates[0].catalog.source, 'external-harness');
    assert.equal(rec.candidates[1].id, 'implementer-argon:axon-message/gemini-4-argon');

    const solEntry = rec.candidates.find((c) => c.id === 'implementer:axon/gpt-6.1-sol');
    assert.equal(solEntry.preferenceEffect, 'avoided');
    assert.ok(solEntry.rank > rec.candidates[1].rank);

    // Functional group isolation: review & research have NO preference applied, keeping their baseline order.
    const reviewRec = await advisorB.recommend({ group: 'review' }, context);
    assert.equal(reviewRec.preference, null);
    assert.equal(reviewRec.recommended.id, 'reviewer:axon/gpt-6.1-sol');

    // Clear removes the preference cleanly and restores baseline default ranking.
    const cleared = await advisorB.updatePreference({
      action: 'clear',
      group: 'implementation',
    }, context);
    assert.deepEqual(cleared.clearedGroups, ['implementation']);

    const afterClear = await advisorB.recommend({ group: 'implementation' }, context);
    assert.equal(afterClear.preference, null);
    assert.equal(afterClear.recommended.id, 'implementer:axon/gpt-6.1-sol');
  });
});

test('protects writer, think, and director role defaults unless the user explicitly authorizes changing that role', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => FIXTURE_CATALOG },
    };
    const advisor = createDispatchAdvisor();

    // Even if implementation avoids GPT, `think` (whose default is GPT-6 Astra) and `writer` / `director` stay untouched.
    await advisor.updatePreference({
      action: 'set',
      group: 'implementation',
      avoid: ['gpt'],
      prefer: ['grok'],
      userAuthorized: true,
      userQuote: '现在GPT少用一点',
    }, context);

    const thinkRec = await advisor.recommend({ role: 'think' }, context);
    assert.equal(thinkRec.group.id, 'thinking');
    assert.equal(thinkRec.recommended.id, 'think:axon/gpt-6-astra');

    const writerRec = await advisor.recommend({ role: 'writer' }, context);
    assert.equal(writerRec.group.id, 'writing');
    assert.equal(writerRec.recommended.id, 'writer:axon-message/gemini-4-argon');

    const directorRec = await advisor.recommend({ role: 'director' }, context);
    assert.equal(directorRec.group.id, 'director');
    assert.equal(directorRec.recommended.id, 'director:axon-message/gemini-4-argon');

    // Even if someone writes a preference under `thinking` WITHOUT `authorizedRoles: ['think']`,
    // `think` default is still protected!
    await advisor.updatePreference({
      action: 'set',
      group: 'thinking',
      avoid: ['gpt'],
      prefer: ['grok'],
      userAuthorized: true,
      userQuote: '省点GPT额度',
    }, context);

    const thinkStillProtected = await advisor.recommend({ role: 'think' }, context);
    assert.equal(thinkStillProtected.group.protectedDefaultPreserved, true);
    assert.equal(thinkStillProtected.preference.applied, false);
    assert.equal(thinkStillProtected.recommended.id, 'think:axon/gpt-6-astra');

    // Only when the user explicitly authorizes changing `think` (`authorizedRoles: ['think']`) does it shift.
    await advisor.updatePreference({
      action: 'set',
      group: 'thinking',
      avoid: ['gpt'],
      prefer: ['grok'],
      authorizedRoles: ['think'],
      userAuthorized: true,
      userQuote: 'think 角色也改用 Grok 4.7，少用 Astra',
    }, context);

    const thinkAuthorized = await advisor.recommend({ role: 'think' }, context);
    assert.equal(thinkAuthorized.group.protectedDefaultPreserved, false);
    assert.equal(thinkAuthorized.preference.applied, true);
    assert.equal(thinkAuthorized.recommended.id, 'think:grok-4.7');
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

test('explicit user target beats soft preferences, while hard profile constraints remain strictly enforced', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => FIXTURE_CATALOG },
    };
    const advisor = createDispatchAdvisor();

    await advisor.updatePreference({
      action: 'set',
      group: 'implementation',
      prefer: ['implementer-grokbuild', 'implementer-argon'],
      avoid: ['gpt'],
      userAuthorized: true,
      userQuote: '现在GPT少用一点',
    }, context);

    // Explicit user target "axon/gpt-6.1-sol" wins over soft "avoid gpt" preference.
    const explicitSol = await advisor.recommend({
      group: 'implementation',
      explicitTarget: 'axon/gpt-6.1-sol',
    }, context);
    assert.equal(explicitSol.recommended.id, 'implementer:axon/gpt-6.1-sol');
    assert.equal(explicitSol.candidates[0].explicitMatch, true);

    // Hard profile constraint (`allowedModels` excluding GPT Sol) blocks even an explicit or preferred model.
    const constrained = await advisor.recommend({
      group: 'implementation',
      explicitTarget: 'axon/gpt-6.1-sol',
      constraints: {
        allowedModels: ['axon-message/gemini-4-argon', 'grok-4.7'],
      },
    }, context);
    assert.notEqual(constrained.recommended.modelId, 'axon/gpt-6.1-sol');
    const blockedSol = constrained.candidates.find((c) => c.modelId === 'axon/gpt-6.1-sol');
    assert.equal(blockedSol.eligible, false);
    assert.equal(blockedSol.admittedByProfileConstraints, false);
  });
});

test('handles unknown quota without fabricating 0 or infinite, sorts comparable same-unit quotas, and shares low-frequency cached Magpie source', async () => {
  await withIsolatedHome(async (kikiHome) => {
    let cliCalls = 0;
    let clock = 500_000;
    const magpie = new MagpieQuotaService({
      now: () => clock,
      minRefreshIntervalMs: 300_000,
      execCommand: async () => {
        cliCalls += 1;
        return {
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
        };
      },
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
      models: { list: async () => FIXTURE_CATALOG },
    };

    // Custom functional group with two comparable AGY candidates (percent) + one credits candidate + one unknown candidate.
    await advisor.updatePreference({
      action: 'define_group',
      group: 'agy-Frontend-pool',
      groupLabel: 'AGY Frontend Candidates',
      candidates: [
        {
          id: 'agy-argon',
          label: 'AGY Argon High',
          kind: 'external-harness',
          executorId: 'agy-cli',
          modelId: 'gemini-4-argon-high',
          defaultRank: 10,
        },
        {
          id: 'agy-flash',
          label: 'AGY 3.8 Flash High',
          kind: 'external-harness',
          executorId: 'agy-cli',
          modelId: 'gemini-3.8-flash-high',
          defaultRank: 20,
        },
        {
          id: 'native-unknown-quota',
          label: 'Native Argon (No Quota Source)',
          kind: 'native-model',
          modelId: 'axon-message/gemini-4-argon',
          defaultRank: 30,
        },
      ],
    }, context);

    // Call recommend twice within 5 minutes -> shared Magpie cache only executes CLI once!
    const first = await advisor.recommend({ group: 'agy-Frontend-pool' }, context);
    const second = await advisor.recommend({ group: 'agy-Frontend-pool' }, context);
    assert.equal(cliCalls, 1);
    assert.equal(second.quotaSummary.status, 'ok');

    // Both AGY candidates have known `percent` quota: 85% > 40%, so agy-flash sorts ahead of agy-argon.
    assert.equal(first.candidates[0].id, 'agy-flash');
    assert.equal(first.candidates[0].quota.remaining, 85);
    assert.equal(first.candidates[0].quota.unit, 'percent');
    assert.equal(first.candidates[1].id, 'agy-argon');
    assert.equal(first.candidates[1].quota.remaining, 40);

    // Unknown quota candidate is neither fabricated as 0 nor infinite (100+): its remaining is null and status is 'unknown',
    // keeping its relative baseline position with agy-argon (neither promoted above 85% nor marked exhausted).
    const unknownEntry = first.candidates.find((c) => c.id === 'native-unknown-quota');
    assert.equal(unknownEntry.quota.status, 'unknown');
    assert.equal(unknownEntry.quota.remaining, null);

    // Also verify when no quota source is attached at all, preferences still work cleanly.
    const quotaFreeAdvisor = createDispatchAdvisor();
    const fallbackRec = await quotaFreeAdvisor.recommend({ group: 'agy-Frontend-pool' }, context);
    assert.equal(fallbackRec.quotaSummary.status, 'unavailable');
    for (const c of fallbackRec.candidates) {
      assert.equal(c.quota.status, 'unknown');
      assert.equal(c.quota.remaining, null);
    }
  });
});

test('entry.mjs registers exact tools and returns structured JSON outputs and errors', async () => {
  await withIsolatedHome(async (kikiHome) => {
    const registered = new Map();
    register({
      registerTool(def, execute) {
        registered.set(def.name, { def, execute });
      },
    });
    assert.equal(registered.size, 2);

    const context = {
      kikiHome,
      settings: {},
      models: { list: async () => FIXTURE_CATALOG },
    };

    const badWrite = await registered.get('dispatch_preference_update').execute({
      action: 'set',
      group: 'implementation',
      avoid: ['gpt'],
      userAuthorized: false,
    }, context);
    assert.equal(badWrite.isError, true);
    assert.equal(JSON.parse(badWrite.output).error.code, 'ADVISOR_USER_AUTHORIZATION_REQUIRED');

    const okWrite = await registered.get('dispatch_preference_update').execute({
      action: 'set',
      group: 'implementation',
      prefer: ['implementer-grokbuild'],
      avoid: ['gpt'],
      userAuthorized: true,
      userQuote: '现在GPT少用一点',
    }, context);
    assert.notEqual(okWrite.isError, true);
    assert.equal(JSON.parse(okWrite.output).ok, true);

    const rec = await registered.get('dispatch_advisor_recommend').execute({
      group: 'implementation',
    }, context);
    assert.notEqual(rec.isError, true);
    const parsedRec = JSON.parse(rec.output);
    assert.equal(parsedRec.recommended.id, 'implementer-grokbuild:grok-4.7');
  });
});

test('pinned Kiki hostRunner registers both advisor tools and executes model-call + preference persistence end-to-end', { skip: !process.env.KIKI_HOST_RUNNER }, async () => {
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
                  prefer: ['implementer-grokbuild', 'implementer-argon'],
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
                result: FIXTURE_CATALOG,
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
      assert.equal(body.recommended.id, 'implementer-grokbuild:grok-4.7');
      assert.equal(body.preference.applied, true);
    } finally {
      child.kill();
      incoming.close();
    }
  });
});
