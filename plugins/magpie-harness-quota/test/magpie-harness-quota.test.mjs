import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import {
  antigravityAccountSourceDefinition,
  antigravityDirectQuotaService,
  antigravityQuotaSourceDefinition,
  grokQuotaSourceDefinition,
  harnessAccountSourceDefinitions,
  harnessQuotaSourceDefinitions,
  MAGPIE_CLI_AGENT_BY_SOURCE_ID,
  magpieQuotaService,
  register,
} from '../entry.mjs';
import {
  MagpieQuotaService,
  magpieRowMatchesAgent,
  mapMagpieAccountRows,
  normalizeMagpieAgentId,
  parseAccountBalanceString,
  parseModelWindows,
  resolveMagpieExecutable,
} from '../lib/magpie.mjs';

const declaredSources = manifest['x-kiki'].harnessQuotaSources;
const declaredAccountSources = manifest['x-kiki'].harnessAccountSources;

// Exact contract validators from packages/plugin-sdk/src/harness-quota.ts (zero external npm dependencies so standalone managed plugin tests run cleanly)
const ALLOWED_QUOTA_UNITS = new Set(['percent', 'money', 'tokens', 'requests', 'credits', 'count']);
const ISO_OFFSET_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function assertIdentifier(val, label = 'identifier') {
  assert.equal(typeof val, 'string', `${label} must be a string`);
  assert.ok(val.length >= 1 && val.length <= 1024 && /^[^\s\u0000]+$/.test(val), `Invalid ${label}: ${val}`);
}

const harnessQuotaSourceDefinitionSchema = {
  parse(source) {
    assert.ok(source && typeof source === 'object' && !Array.isArray(source));
    const allowed = new Set(['schemaVersion', 'id', 'label', 'engineIds', 'minRefreshIntervalMs']);
    for (const k of Object.keys(source)) assert.ok(allowed.has(k), `Unexpected source key: ${k}`);
    assert.equal(source.schemaVersion, 1);
    assert.match(source.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(typeof source.label === 'string' && source.label.length >= 1);
    assert.ok(Array.isArray(source.engineIds) && source.engineIds.length >= 1);
    for (const id of source.engineIds) assertIdentifier(id, 'engineId');
    assert.equal(new Set(source.engineIds).size, source.engineIds.length, 'Duplicate engine id');
    if (source.minRefreshIntervalMs !== undefined) {
      assert.ok(Number.isInteger(source.minRefreshIntervalMs) && source.minRefreshIntervalMs >= 300_000);
    }
    return source;
  },
};

const harnessQuotaReadingSchema = {
  parse(reading) {
    assert.ok(reading && typeof reading === 'object' && !Array.isArray(reading));
    const allowed = new Set(['accountId', 'accountLabel', 'modelIds', 'pool', 'unit', 'window', 'remaining', 'resetAt', 'readAt']);
    for (const k of Object.keys(reading)) assert.ok(allowed.has(k), `Unexpected reading key: ${k}`);
    assertIdentifier(reading.accountId, 'accountId');
    if (reading.accountLabel !== undefined) assert.ok(typeof reading.accountLabel === 'string' && reading.accountLabel.length >= 1);
    if (reading.modelIds !== undefined) {
      assert.ok(Array.isArray(reading.modelIds));
      for (const id of reading.modelIds) assertIdentifier(id, 'modelId');
    }
    if (reading.pool !== undefined) assert.ok(typeof reading.pool === 'string' && reading.pool.length >= 1);
    assert.ok(ALLOWED_QUOTA_UNITS.has(reading.unit), `Invalid unit: ${reading.unit}`);
    if (reading.window !== undefined) assert.ok(typeof reading.window === 'string' && reading.window.length >= 1);
    if (reading.remaining !== undefined) {
      assert.ok(typeof reading.remaining === 'number' && Number.isFinite(reading.remaining) && reading.remaining >= 0);
    }
    if (reading.resetAt !== undefined) {
      assert.match(reading.resetAt, ISO_OFFSET_DATETIME_RE);
      assert.ok(Number.isFinite(Date.parse(reading.resetAt)));
    }
    if (reading.readAt !== undefined) {
      assert.match(reading.readAt, ISO_OFFSET_DATETIME_RE);
      assert.ok(Number.isFinite(Date.parse(reading.readAt)));
    }
    return reading;
  },
};

const harnessQuotaBatchSchema = {
  parse(batch) {
    if (Array.isArray(batch)) {
      assert.ok(batch.length <= 500);
      for (const item of batch) harnessQuotaReadingSchema.parse(item);
      return batch;
    }
    assert.ok(batch && typeof batch === 'object');
    assert.deepEqual(Object.keys(batch), ['readings']);
    assert.ok(Array.isArray(batch.readings) && batch.readings.length <= 500);
    for (const item of batch.readings) harnessQuotaReadingSchema.parse(item);
    return batch;
  },
};

// Exact built-in external executor IDs from Kiki packages/agent-core-v2/src/app/agentExecutor/builtinDescriptorData.ts
const BUILTIN_EXTERNAL_EXECUTOR_IDS = new Set([
  'antigravity-acp',
  'agy-cli',
  'grok-acp',
  'codex-app-server',
  'codex-acp',
  'cursor-acp',
  'claude-acp',
  'gemini-acp',
  'kimi-acp',
  'opencode-acp',
  'openclaw-acp',
  'cline-acp',
  'codebuddy-acp',
  'pi-acp',
  'deepseek-acp',
  'qoder-acp',
]);

const SIBLING_TASK92_RUNNER = path.resolve(
  import.meta.dirname,
  '../../../../executor-instance-scheduling-20261107/packages/agent-core-v2/src/app/plugin/hostRunner.mjs',
);

async function resolveQuotaCapableRunner() {
  for (const candidate of [process.env.KIKI_TASK92_HOST_RUNNER, process.env.KIKI_HOST_RUNNER, SIBLING_TASK92_RUNNER].filter(Boolean)) {
    try {
      await access(candidate);
      const source = await readFile(candidate, 'utf8');
      if (source.includes('harness-quota-request')) return path.resolve(candidate);
    } catch {
      // Try next candidate
    }
  }
  return null;
}

const FIXTURE_MAGPIE_ANTIGRAVITY_ACCOUNTS = [
  {
    agent: 'antigravity',
    user: 'work-a@example.test',
    plan: 'Pro',
    active: true,
    on: true,
    alias: 'Work A',
    readAt: '2026-11-07T03:00:00Z',
    windows: [
      {
        name: 'Claude & GPT · 5 hours',
        pool: 'Claude & GPT',
        used: 20,
        remaining: 80,
        resetsAt: '2026-11-07T08:00:00Z',
      },
      {
        name: 'Claude & GPT · 7 days',
        pool: 'Claude & GPT',
        used: 65,
        remaining: 35,
        resetsAt: '2026-11-12T00:00:00Z',
      },
      {
        name: 'Gemini 4 Argon · 7 days',
        pool: 'Gemini 4 Argon',
        used: 100,
        remaining: 0,
        resetsAt: '2026-11-10T00:00:00Z',
      },
      {
        name: 'Gemini · 7 days',
        pool: 'Gemini',
        used: 15,
        remaining: 85,
        resetsAt: '2026-11-12T00:00:00Z',
      },
      {
        name: 'Gemini · 5 hours',
        pool: 'Gemini',
        used: 10,
        remaining: 90,
        resetsAt: '2026-11-07T07:30:00Z',
      },
    ],
  },
  {
    agent: 'antigravity',
    user: 'work-b@example.test',
    plan: 'Ultra',
    active: false,
    on: true,
    seat: 'Seat 2',
    readAt: '2026-11-07T02:58:00Z',
    windows: [
      {
        name: 'Gemini 4 Argon · 7 days',
        pool: 'Gemini 4 Argon',
        used: 25,
        remaining: 75,
        resetsAt: '2026-11-13T00:00:00Z',
      },
      {
        name: 'Promo Note',
        text: true,
        used: 0,
        remaining: 100,
        display: 'Bonus active',
      },
      {
        name: 'Gateway Key',
        unlimited: true,
        used: 0,
        remaining: 100,
      },
    ],
  },
  {
    agent: 'antigravity',
    user: 'stale-asof@example.test',
    active: false,
    on: true,
    error: 'quota request failed',
    readAt: '2026-11-06T00:00:00Z',
    asOf: '2026-11-06T00:00:00Z',
    windows: [
      {
        name: 'Gemini 4 Argon · 7 days',
        pool: 'Gemini 4 Argon',
        used: 12,
        remaining: 88,
        resetsAt: '2026-11-12T00:00:00Z',
      },
    ],
  },
  {
    agent: 'antigravity',
    user: 'asof-only@example.test',
    active: false,
    on: true,
    asOf: '2026-11-06T05:00:00Z',
    windows: [
      {
        name: 'Gemini · 5 hours',
        pool: 'Gemini',
        used: 10,
        remaining: 90,
      },
    ],
  },
  {
    agent: 'antigravity',
    user: 'lapsed@example.test',
    active: false,
    on: false,
    lapsed: 'sign in again',
    windows: [
      {
        name: 'Gemini · 5 hours',
        pool: 'Gemini',
        used: 0,
        remaining: 100,
      },
    ],
  },
  {
    agent: 'antigravity',
    user: 'unreachable@example.test',
    active: false,
    on: true,
    error: 'context deadline exceeded',
    windows: [],
  },
  {
    agent: 'codex',
    user: 'other-agent@example.test',
    active: true,
    on: true,
    windows: [{ name: '5 hours', used: 50, remaining: 50 }],
  },
];

// Mirrors real `magpie accounts grok --json` output where plugin-served Grok emits `agent: "plugin:grok"`.
const FIXTURE_MAGPIE_GROK_ACCOUNTS = [
  {
    agent: 'plugin:grok',
    user: 'grok-primary@example.test',
    active: true,
    on: true,
    readAt: '2026-11-08T01:00:00Z',
    windows: [
      {
        name: '7 days',
        used: 79,
        remaining: 21,
        resetsAt: '2026-11-14T12:00:00Z',
      },
    ],
  },
  {
    agent: 'plugin:grok',
    user: 'grok-secondary@example.test',
    alias: 'Grok Backup',
    active: false,
    on: true,
    readAt: '2026-11-08T01:00:02Z',
    windows: [
      {
        name: '7 days',
        used: 0,
        remaining: 100,
        resetsAt: '2026-11-15T00:00:00Z',
      },
    ],
  },
  {
    agent: 'plugin:grok',
    user: 'grok-stale@example.test',
    active: false,
    on: true,
    error: '429 Too Many Requests',
    asOf: '2026-11-07T20:00:00Z',
    readAt: '2026-11-07T20:00:00Z',
    windows: [
      {
        name: '7 days',
        used: 15,
        remaining: 85,
        resetsAt: '2026-11-14T00:00:00Z',
      },
    ],
  },
  {
    agent: 'plugin:grok',
    user: 'grok-disabled@example.test',
    alias: 'Grok Off',
    active: false,
    on: false,
    readAt: '2026-11-08T01:00:04Z',
    windows: [
      {
        name: '7 days',
        used: 5,
        remaining: 95,
        resetsAt: '2026-11-15T00:00:00Z',
      },
    ],
  },
];

const FIXTURE_MAGPIE_OTHER_SOURCES = {
  codex: [
    {
      agent: 'codex',
      user: 'codex-team@example.test',
      plan: 'Team',
      active: true,
      on: true,
      readAt: '2026-11-08T01:10:00Z',
      windows: [
        { name: '5 hours', used: 30, remaining: 70, resetsAt: '2026-11-08T06:10:00Z' },
        { name: '7 days', used: 45, remaining: 55, resetsAt: '2026-11-14T00:00:00Z' },
      ],
    },
  ],
  'workbuddy-ai': [
    {
      agent: 'plugin:workbuddy-ai',
      user: 'wb-seat@example.test',
      plan: 'Pro',
      active: true,
      on: true,
      readAt: '2026-11-08T01:12:00Z',
      windows: [
        {
          name: 'Credits',
          unit: 'credits',
          amount: 120,
          limit: 1200,
          used: 10,
          remaining: 90,
          runsOutAt: '2026-11-20T00:00:00Z',
        },
      ],
    },
  ],
  'qoder-cn': [
    {
      agent: 'plugin:qoder-cn',
      user: 'qoder-seat@example.test',
      alias: 'Qoder CN Seat',
      plan: 'personal_standard',
      active: true,
      on: true,
      readAt: '2026-11-08T01:15:00Z',
      windows: [
        {
          name: 'Credits',
          used: 22,
          remaining: 78,
          resetsAt: '2026-11-30T00:00:00Z',
        },
      ],
    },
  ],
  zcode: [
    {
      agent: 'plugin:zcode',
      user: 'zcode-wallet@example.test',
      active: true,
      on: true,
      readAt: '2026-11-08T01:18:00Z',
      balance: '2100 credits (monthly 100 · long-term 2000)',
      windows: [],
    },
    {
      agent: 'plugin:zcode',
      user: 'zcode-ambiguous@example.test',
      active: false,
      on: true,
      readAt: '2026-11-08T01:18:00Z',
      balance: 'custom enterprise quota tier',
      windows: [],
    },
  ],
};

test('manifest and entry registration declare verified 1:1 Magpie harness quota sources without speculative catch-all engine bindings or reading quota on register', () => {
  assert.equal(manifest.version, '0.1.4');
  assert.deepEqual(declaredAccountSources, harnessAccountSourceDefinitions);
  assert.deepEqual(antigravityAccountSourceDefinition, {
    schemaVersion: 1,
    id: 'antigravity',
    label: 'Magpie · Antigravity',
    engineIds: ['agy-cli'],
  });
  assert.equal(declaredSources.length, harnessQuotaSourceDefinitions.length);
  assert.deepEqual(declaredSources, harnessQuotaSourceDefinitions);

  const seenSourceIds = new Set();
  const coveredEngines = new Set();
  for (const source of declaredSources) {
    harnessQuotaSourceDefinitionSchema.parse(source);
    assert.equal(seenSourceIds.has(source.id), false);
    seenSourceIds.add(source.id);
    assert.equal(source.minRefreshIntervalMs, 300_000);
    assert.equal(typeof MAGPIE_CLI_AGENT_BY_SOURCE_ID[source.id], 'string');
    for (const engineId of source.engineIds) {
      assert.equal(BUILTIN_EXTERNAL_EXECUTOR_IDS.has(engineId), true, `Unknown Kiki engineId: ${engineId}`);
      coveredEngines.add(engineId);
    }
  }

  // Verified 1:1 external harnesses are covered, and unrelated engines without a Magpie source (`kimi-acp`, `opencode-acp`, etc.)
  // are never given speculative catch-all bindings.
  assert.deepEqual(
    [...coveredEngines].sort(),
    [
      'agy-cli',
      'antigravity-acp',
      'claude-acp',
      'codebuddy-acp',
      'codex-acp',
      'codex-app-server',
      'cursor-acp',
      'gemini-acp',
      'grok-acp',
      'qoder-acp',
    ],
  );

  assert.deepEqual(antigravityQuotaSourceDefinition, {
    schemaVersion: 1,
    id: 'antigravity',
    label: 'Magpie · Antigravity',
    engineIds: ['agy-cli', 'antigravity-acp'],
    minRefreshIntervalMs: 300_000,
  });
  assert.deepEqual(grokQuotaSourceDefinition, {
    schemaVersion: 1,
    id: 'grok',
    label: 'Magpie · Grok Build',
    engineIds: ['grok-acp'],
    minRefreshIntervalMs: 300_000,
  });

  const registered = [];
  const registeredAccounts = [];
  const registeredTools = [];
  register({
    registerTool(definition, handler) {
      registeredTools.push({ definition, handler });
    },
    registerHarnessQuotaSource(definition, adapter) {
      registered.push({ definition, adapter });
    },
    registerHarnessAccountSource(definition, adapter) {
      registeredAccounts.push({ definition, adapter });
    },
  });
  assert.equal(registeredTools.length, 1);
  assert.equal(registeredTools[0].definition.name, 'magpie_manage');
  assert.equal(typeof registeredTools[0].handler, 'function');
  assert.equal(registered.length, declaredSources.length);
  assert.deepEqual(registered.map((item) => item.definition), declaredSources);
  for (const item of registered) {
    assert.equal(typeof item.adapter.read, 'function');
  }
  assert.deepEqual(registeredAccounts.map((item) => item.definition), declaredAccountSources);
  assert.deepEqual(Object.keys(registeredAccounts[0].adapter).sort(), ['list', 'prepare', 'release']);
});

test('maps pooled Antigravity windows strictly to harnessQuotaReadingSchema, never confuses ordinary Gemini weekly window with Argon, and keeps stale/failed readings unknown', () => {
  const modelWindows = JSON.stringify({
    'claude-opus-5-5-high': { pool: 'Claude & GPT', name: '5 hours' },
    'claude-sonnet-4-6': { pool: 'Claude & GPT', name: '5 hours' },
    'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
    'gemini-4-argon-medium': { pool: 'Gemini 4 Argon' },
  });

  const readings = mapMagpieAccountRows(FIXTURE_MAGPIE_ANTIGRAVITY_ACCOUNTS, {
    agent: 'antigravity',
    modelWindows,
  });

  harnessQuotaBatchSchema.parse({ readings });
  assert.equal(readings.some((r) => r.accountId === 'other-agent@example.test'), false);

  const opus5h = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Claude & GPT' && r.window === '5 hours');
  assert.deepEqual(opus5h, {
    accountId: 'work-a@example.test',
    accountLabel: 'Work A',
    pool: 'Claude & GPT',
    modelIds: ['claude-opus-5-5-high', 'claude-sonnet-4-6'],
    unit: 'percent',
    window: '5 hours',
    remaining: 80,
    resetAt: '2026-11-07T08:00:00.000Z',
    readAt: '2026-11-07T03:00:00.000Z',
  });

  // Ordinary Gemini 7-day window ("Gemini · 7 days", 85%) NEVER masquerades as "Gemini 4 Argon" (0% on work-a)!
  const gemini7d = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini' && r.window === '7 days');
  assert.equal(gemini7d.modelIds, undefined);
  assert.equal(gemini7d.remaining, 85);

  const gemini5h = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini' && r.window === '5 hours');
  assert.equal(gemini5h.modelIds, undefined);
  assert.equal(gemini5h.remaining, 90);

  const argonA = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini 4 Argon');
  assert.equal(argonA.remaining, 0);
  assert.deepEqual(argonA.modelIds, ['gemini-4-argon-high', 'gemini-4-argon-medium']);

  const argonB = readings.find((r) => r.accountId === 'work-b@example.test' && r.pool === 'Gemini 4 Argon');
  assert.equal(argonB.remaining, 75);
  assert.equal(argonB.accountLabel, 'Seat 2');
  assert.equal(argonB.readAt, '2026-11-07T02:58:00.000Z');

  const staleAsOf = readings.find((r) => r.accountId === 'stale-asof@example.test');
  assert.equal(staleAsOf.remaining, undefined);
  assert.equal(staleAsOf.unit, 'percent');
  assert.equal(staleAsOf.readAt, '2026-11-06T00:00:00.000Z');
  assert.equal(staleAsOf.resetAt, '2026-11-12T00:00:00.000Z');
  assert.deepEqual(staleAsOf.modelIds, ['gemini-4-argon-high', 'gemini-4-argon-medium']);

  const asOfOnly = readings.find((r) => r.accountId === 'asof-only@example.test');
  assert.equal(asOfOnly.remaining, undefined);
  assert.equal(asOfOnly.readAt, '2026-11-06T05:00:00.000Z');

  assert.equal(readings.find((r) => r.accountId === 'work-b@example.test' && r.window === 'Promo Note').remaining, undefined);
  assert.equal(readings.find((r) => r.accountId === 'work-b@example.test' && r.window === 'Gateway Key').remaining, undefined);
  assert.equal(readings.find((r) => r.accountId === 'lapsed@example.test').remaining, undefined);
  assert.deepEqual(readings.find((r) => r.accountId === 'unreachable@example.test'), {
    accountId: 'unreachable@example.test',
    unit: 'percent',
  });
});

test('maps plugin-served Grok (`agent: "plugin:grok"`), Codex, WorkBuddy AI, Qoder CN, and wallet balances accurately without fabricating modelIds on generic window labels', () => {
  assert.equal(normalizeMagpieAgentId('plugin:grok'), 'grok');
  assert.equal(normalizeMagpieAgentId('qoder-cn-plugin'), 'qoder-cn');
  assert.equal(magpieRowMatchesAgent('plugin:grok', 'grok'), true);
  assert.equal(magpieRowMatchesAgent('plugin:codex', 'grok'), false);

  const grokReadings = mapMagpieAccountRows(FIXTURE_MAGPIE_GROK_ACCOUNTS, { agent: 'grok' });
  harnessQuotaBatchSchema.parse({ readings: grokReadings });
  assert.equal(grokReadings.length, 4);

  assert.deepEqual(grokReadings[0], {
    accountId: 'grok-primary@example.test',
    unit: 'percent',
    window: '7 days',
    remaining: 21,
    resetAt: '2026-11-14T12:00:00.000Z',
    readAt: '2026-11-08T01:00:00.000Z',
  });
  assert.deepEqual(grokReadings[1], {
    accountId: 'grok-secondary@example.test',
    accountLabel: 'Grok Backup',
    unit: 'percent',
    window: '7 days',
    remaining: 100,
    resetAt: '2026-11-15T00:00:00.000Z',
    readAt: '2026-11-08T01:00:02.000Z',
  });
  // Failed/cached Grok row keeps readAt/resetAt and omits remaining (unknown).
  assert.equal(grokReadings[2].accountId, 'grok-stale@example.test');
  assert.equal(grokReadings[2].remaining, undefined);
  assert.equal(grokReadings[2].readAt, '2026-11-07T20:00:00.000Z');

  // Disabled CLI row (`on: false`) NEVER emits positive `remaining` (95%) into `auto` scheduling, and marks accountLabel `(disabled)`.
  assert.deepEqual(grokReadings[3], {
    accountId: 'grok-disabled@example.test',
    accountLabel: 'Grok Off (disabled)',
    unit: 'percent',
    window: '7 days',
    resetAt: '2026-11-15T00:00:00.000Z',
    readAt: '2026-11-08T01:00:04.000Z',
  });
  assert.equal(grokReadings[3].remaining, undefined);

  // Paused account (`paused: true`) without windows/alias also omits `remaining` and surfaces `accountLabel: "disabled"`.
  const pausedWalletReadings = mapMagpieAccountRows([
    {
      agent: 'codex',
      user: 'codex-paused@example.test',
      active: true,
      on: true,
      paused: true,
      readAt: '2026-11-08T01:05:00Z',
      balance: '$25.00',
      windows: [],
    },
  ], { agent: 'codex' });
  harnessQuotaBatchSchema.parse({ readings: pausedWalletReadings });
  assert.deepEqual(pausedWalletReadings, [
    {
      accountId: 'codex-paused@example.test',
      accountLabel: 'disabled',
      unit: 'percent',
      readAt: '2026-11-08T01:05:00.000Z',
    },
  ]);

  // Qoder CN single-word window `"Credits"` must NOT be misclassified as `modelIds: ["Credits"]`!
  const qoderReadings = mapMagpieAccountRows(FIXTURE_MAGPIE_OTHER_SOURCES['qoder-cn'], { agent: 'qoder-cn' });
  harnessQuotaBatchSchema.parse({ readings: qoderReadings });
  assert.deepEqual(qoderReadings, [
    {
      accountId: 'qoder-seat@example.test',
      accountLabel: 'Qoder CN Seat',
      unit: 'percent',
      window: 'Credits',
      remaining: 78,
      resetAt: '2026-11-30T00:00:00.000Z',
      readAt: '2026-11-08T01:15:00.000Z',
    },
  ]);

  // WorkBuddy AI uses runsOutAt when resetsAt is absent and preserves `unit: "credits"` with share percentage or count.
  const wbReadings = mapMagpieAccountRows(FIXTURE_MAGPIE_OTHER_SOURCES['workbuddy-ai'], { agent: 'workbuddy-ai' });
  harnessQuotaBatchSchema.parse({ readings: wbReadings });
  assert.deepEqual(wbReadings, [
    {
      accountId: 'wb-seat@example.test',
      unit: 'credits',
      window: 'Credits',
      remaining: 90,
      resetAt: '2026-11-20T00:00:00.000Z',
      readAt: '2026-11-08T01:12:00.000Z',
    },
  ]);

  // Wallet-only rows parse unambiguous numeric balances (`2100 credits (...)`) and keep ambiguous strings unknown (`remaining: undefined`).
  assert.deepEqual(parseAccountBalanceString('$14.25'), { unit: 'money', remaining: 14.25, window: 'Balance' });
  assert.deepEqual(parseAccountBalanceString('1.5K credits'), { unit: 'credits', remaining: 1500, window: 'Balance' });
  assert.equal(parseAccountBalanceString('custom enterprise quota tier'), undefined);

  const zcodeReadings = mapMagpieAccountRows(FIXTURE_MAGPIE_OTHER_SOURCES.zcode, { agent: 'zcode' });
  harnessQuotaBatchSchema.parse({ readings: zcodeReadings });
  assert.deepEqual(zcodeReadings, [
    {
      accountId: 'zcode-wallet@example.test',
      unit: 'credits',
      window: 'Balance',
      remaining: 2100,
      readAt: '2026-11-08T01:18:00.000Z',
    },
    {
      accountId: 'zcode-ambiguous@example.test',
      unit: 'percent',
      readAt: '2026-11-08T01:18:00.000Z',
    },
  ]);

  // Source-keyed `modelWindows` isolates rules per source while merging optional `*` defaults.
  const sourceKeyedModelWindows = JSON.stringify({
    '*': { 'shared-model-1': { name: '7 days' } },
    antigravity: { 'gemini-4-argon-high': { pool: 'Gemini 4 Argon' } },
    grok: { 'grok-4.7': { name: '7 days' } },
  });
  const grokMapped = mapMagpieAccountRows(FIXTURE_MAGPIE_GROK_ACCOUNTS.slice(0, 1), {
    agent: 'grok',
    modelWindows: sourceKeyedModelWindows,
  });
  assert.deepEqual(grokMapped[0].modelIds, ['shared-model-1', 'grok-4.7']);
});

test('preserves unpooled per-model fallback windows on Antigravity when retrieveUserQuotaSummary is unavailable', () => {
  const unpooledRows = [
    {
      agent: 'antigravity',
      user: 'solo@example.test',
      readAt: '2026-11-07T04:00:00Z',
      windows: [
        {
          name: 'gemini-3.8-flash-high',
          used: 40,
          remaining: 60,
          resetsAt: '2026-11-07T09:00:00Z',
        },
      ],
    },
  ];
  const readings = mapMagpieAccountRows(unpooledRows, { agent: 'antigravity' });
  harnessQuotaBatchSchema.parse({ readings });
  assert.deepEqual(readings, [
    {
      accountId: 'solo@example.test',
      modelIds: ['gemini-3.8-flash-high'],
      unit: 'percent',
      window: 'gemini-3.8-flash-high',
      remaining: 60,
      resetAt: '2026-11-07T09:00:00.000Z',
      readAt: '2026-11-07T04:00:00.000Z',
    },
  ]);
});

test('supports per-source batch CLI reads (`grok`, `codex`, `antigravity`), AbortSignal cancellation, and pluggable per-source accuracy override (e.g. AGY direct override without affecting Grok)', async () => {
  const seenInvocations = [];

  const service = new MagpieQuotaService({
    execCommand: async (executable, args, options) => {
      seenInvocations.push({ executable, args, cwd: options.cwd });
      if (options.signal?.aborted) {
        const err = new Error('aborted');
        err.code = 'ABORT_ERR';
        throw err;
      }
      const which = args[1];
      if (which === 'grok') return { stdout: JSON.stringify(FIXTURE_MAGPIE_GROK_ACCOUNTS), stderr: '' };
      if (which === 'codex') return { stdout: JSON.stringify(FIXTURE_MAGPIE_OTHER_SOURCES.codex), stderr: '' };
      if (which === 'antigravity') return { stdout: JSON.stringify(FIXTURE_MAGPIE_ANTIGRAVITY_ACCOUNTS), stderr: '' };
      throw new Error(`Unexpected CLI agent: ${which}`);
    },
  });

  const magpiePath = path.resolve('/opt/magpie/bin/magpie');
  const kikiHome = path.resolve('/var/kiki-home');
  const context = {
    kikiHome,
    signal: new AbortController().signal,
    settings: {
      magpiePath,
      modelWindows: JSON.stringify({
        antigravity: { 'gemini-4-argon-high': { pool: 'Gemini 4 Argon' } },
      }),
    },
  };

  // 1. Read Grok via Magpie CLI (`accounts grok --json`)
  const grokBatch = await service.adapterFor('grok').read(context);
  harnessQuotaBatchSchema.parse(grokBatch);
  assert.equal(grokBatch.readings.length, 4);
  assert.equal(grokBatch.readings[0].accountId, 'grok-primary@example.test');
  assert.equal(grokBatch.readings[0].remaining, 21);
  assert.equal(grokBatch.readings[3].accountId, 'grok-disabled@example.test');
  assert.equal(grokBatch.readings[3].remaining, undefined);

  // 2. Read Codex via Magpie CLI (`accounts codex --json`)
  const codexBatch = await service.adapterFor('codex').read(context);
  harnessQuotaBatchSchema.parse(codexBatch);
  assert.equal(codexBatch.readings.length, 2);

  // 3. Plug in an external AGY override service (matching agent-1300's `{ adapter: { read(ctx) } }` shape):
  //    `antigravity` delegates to the override without spawning Magpie CLI, while `grok` continues reading Magpie CLI!
  let agyOverrideCalls = 0;
  service.setSourceOverride('antigravity', {
    adapter: {
      async read(ctx) {
        agyOverrideCalls += 1;
        assert.equal(ctx.kikiHome, kikiHome);
        return {
          readings: [
            {
              accountId: 'ultra-direct@example.test',
              accountLabel: 'Ultra Direct',
              modelIds: ['gemini-3.8-flash', 'gemini-4-argon-high'],
              pool: 'Gemini',
              unit: 'percent',
              window: '7 days',
              remaining: 86.4,
              resetAt: '2026-11-14T02:05:06.000Z',
              readAt: '2026-11-08T01:20:00.000Z',
            },
          ],
        };
      },
    },
  });

  const agyDirectBatch = await service.adapterFor('antigravity').read(context);
  harnessQuotaBatchSchema.parse(agyDirectBatch);
  assert.equal(agyOverrideCalls, 1);
  assert.equal(seenInvocations.length, 2); // Only grok + codex invoked CLI; antigravity used the override!
  assert.deepEqual(agyDirectBatch.readings[0].modelIds, ['gemini-3.8-flash', 'gemini-4-argon-high']);

  // Clearing the override falls back cleanly to Magpie CLI `accounts antigravity --json`.
  service.setSourceOverride('antigravity', null);
  const agyCliBatch = await service.adapterFor('antigravity').read(context);
  harnessQuotaBatchSchema.parse(agyCliBatch);
  assert.equal(seenInvocations.length, 3);
  assert.deepEqual(seenInvocations.map((i) => i.args), [
    ['accounts', 'grok', '--json'],
    ['accounts', 'codex', '--json'],
    ['accounts', 'antigravity', '--json'],
  ]);

  // Verify entry.mjs wires `antigravityDirectQuotaService` onto `antigravity` ONLY, leaving `grok` on Magpie CLI.
  assert.equal(magpieQuotaService.sourceOverrides.get('antigravity'), antigravityDirectQuotaService);
  assert.equal(magpieQuotaService.sourceOverrides.has('grok'), false);
  assert.equal(magpieQuotaService.sourceOverrides.has('codex'), false);

  const abortedController = new AbortController();
  abortedController.abort();
  await assert.rejects(
    service.adapterFor('grok').read({ ...context, signal: abortedController.signal }),
    { code: 'ABORT_ERR' },
  );
  assert.equal(seenInvocations.length, 3);
});

test('executes official hostRunner harness-quota-request RPC end-to-end: grok reads Magpie CLI (`plugin:grok`) while antigravity reads built-in direct collector via bound proxy', async (t) => {
  const runner = await resolveQuotaCapableRunner();
  if (!runner) {
    t.skip('No harness-quota-capable hostRunner available in environment');
    return;
  }

  assert.throws(() => resolveMagpieExecutable({ magpiePath: 'relative/magpie' }), /absolute path/);
  assert.throws(() => parseModelWindows('{bad json'), /Invalid modelWindows JSON/);
  assert.throws(() => parseModelWindows('{"m1":{}}'), /at least pool or name/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'magpie-hostrunner-fixture-'));
  const proxySockets = new Set();
  const upstreamSockets = new Set();

  // Local HTTP forward proxy + local Code Assist HTTP upstream (zero external network traffic)
  const expectedProxyAuth = `Basic ${Buffer.from('agyProxy:p@ss1', 'utf8').toString('base64')}`;
  const proxyForwards = [];
  const codeAssistUpstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1internal:loadCodeAssist') {
      res.writeHead(200).end(JSON.stringify({
        cloudaicompanionProject: 'aicode-consumers',
        currentTier: { id: 'standard-tier', name: 'Antigravity' },
        paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      }));
      return;
    }
    if (req.url === '/v1internal:fetchAvailableModels') {
      res.writeHead(200).end(JSON.stringify({
        models: {
          'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-08T06:00:00Z' } },
          'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-08T06:00:00Z' } },
          'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (Thinking)', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-08T06:00:00Z' } },
        },
      }));
      return;
    }
    if (req.url === '/v1internal:retrieveUserQuotaSummary') {
      res.writeHead(200).end(JSON.stringify({
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Gemini Flash',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-11-14T00:00:00Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-11-08T06:00:00Z' },
            ],
          },
          {
            displayName: 'Gemini 4 Argon',
            description: 'Argon weekly pool',
            buckets: [
              { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-13T00:00:00Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Claude Opus',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.6, resetTime: '2026-11-12T00:00:00Z' },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-08T06:00:00Z' },
            ],
          },
        ],
      }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  codeAssistUpstream.on('connection', (s) => {
    upstreamSockets.add(s);
    s.on('close', () => upstreamSockets.delete(s));
  });

  const forwardHttpProxy = http.createServer((req, res) => {
    const authHeader = req.headers['proxy-authorization'] || '';
    proxyForwards.push({ url: req.url, authHeader });
    if (authHeader !== expectedProxyAuth) {
      res.writeHead(407).end('Proxy auth required');
      return;
    }
    const targetUrl = new URL(req.url);
    const upstreamReq = http.request({
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port) || 80,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: req.method,
      headers: req.headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    req.pipe(upstreamReq);
  });
  forwardHttpProxy.on('connection', (s) => {
    proxySockets.add(s);
    s.on('close', () => proxySockets.delete(s));
  });

  await Promise.all([
    new Promise((resolve) => codeAssistUpstream.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => forwardHttpProxy.listen(0, '127.0.0.1', resolve)),
  ]);

  try {
    const upstreamOrigin = `http://127.0.0.1:${codeAssistUpstream.address().port}`;
    const proxyPort = forwardHttpProxy.address().port;

    // Synthetic Magpie CLI (`accounts grok --json` only; rejects `antigravity` to prove AGY uses direct collector!)
    const payloadsByAgent = {
      grok: FIXTURE_MAGPIE_GROK_ACCOUNTS,
    };
    const accountsScript = path.join(dir, 'accounts');
    await writeFile(accountsScript, [
      'import assert from "node:assert/strict";',
      `const payloads = ${JSON.stringify(payloadsByAgent)};`,
      'const [agent, flag] = process.argv.slice(2);',
      'assert.equal(flag, "--json");',
      'assert.ok(Object.hasOwn(payloads, agent), `Unexpected CLI agent (antigravity must use direct collector): ${agent}`);',
      'process.stdout.write(JSON.stringify(payloads[agent]));',
    ].join('\n'), 'utf8');
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8');

    // Synthetic Magpie config directory for the built-in AGY direct collector
    const magpieConfigDir = path.join(dir, 'magpie-cfg');
    await mkdir(magpieConfigDir, { recursive: true });
    await writeFile(path.join(magpieConfigDir, 'logins.json'), JSON.stringify([
      {
        agent: 'antigravity',
        user: 'work-b@example.test',
        plan: 'Pro',
        auth: {
          access_token: 'valid-cached-at',
          refresh_token: 'rt-work-b',
          expiry_date: Date.now() + 3600_000,
        },
      },
    ]), 'utf8');
    await writeFile(path.join(magpieConfigDir, 'providers.json'), JSON.stringify({
      providers: [
        {
          id: 'antigravity',
          accountNames: { 'work-b@example.test': 'Seat 2' },
          accountProxies: {
            'work-b@example.test': `http://agyProxy:${encodeURIComponent('p@ss1')}@127.0.0.1:${proxyPort}`,
          },
        },
      ],
    }), 'utf8');

    const executablePath = process.execPath;
    const pluginRoot = path.dirname(import.meta.dirname);
    const child = spawn(process.execPath, [runner, path.join(pluginRoot, 'entry.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GATEWAY_ANTIGRAVITY_FORWARD_BASE_URL: upstreamOrigin,
      },
    });
    const incoming = createInterface({ input: child.stdout });
    const send = (payload) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    const registeredSources = [];

    const settings = {
      magpiePath: executablePath,
      magpieConfigDir,
    };

    try {
      const responses = await new Promise((resolve, reject) => {
        const collected = new Map();
        const timer = setTimeout(() => reject(new Error('hostRunner RPC timed out')), 10_000);
        incoming.on('line', (line) => {
          const msg = JSON.parse(line);
          if (msg.method === 'register-harness-quota-source') {
            registeredSources.push(msg.params.definition);
          } else if (msg.method === 'ready') {
            send({
              id: 1,
              method: 'harness-quota-request',
              params: { sourceId: 'grok', kikiHome: dir, settings },
            });
            send({
              id: 2,
              method: 'harness-quota-request',
              params: { sourceId: 'antigravity', kikiHome: dir, settings },
            });
          } else if (msg.id === 1 || msg.id === 2) {
            collected.set(msg.id, msg);
            if (collected.size === 2) {
              clearTimeout(timer);
              resolve(collected);
            }
          }
        });
        child.once('error', reject);
        send({ id: 0, method: 'handshake', params: { version: 1 } });
      });

      assert.deepEqual(registeredSources, declaredSources);

      // Verify Grok RPC response (`plugin:grok` rows from Magpie CLI)
      const grokRpc = responses.get(1);
      assert.equal(grokRpc.error, undefined);
      const parsedGrok = harnessQuotaBatchSchema.parse(grokRpc.result);
      assert.equal(parsedGrok.length, 4);
      assert.deepEqual(parsedGrok.find((r) => r.accountId === 'grok-primary@example.test'), {
        accountId: 'grok-primary@example.test',
        unit: 'percent',
        window: '7 days',
        remaining: 21,
        resetAt: '2026-11-14T12:00:00.000Z',
        readAt: '2026-11-08T01:00:00.000Z',
      });
      assert.equal(parsedGrok.find((r) => r.accountId === 'grok-stale@example.test').remaining, undefined);
      assert.equal(parsedGrok.find((r) => r.accountId === 'grok-disabled@example.test').remaining, undefined);

      // Verify Antigravity RPC response came from built-in direct collector via authenticated proxy
      const agyRpc = responses.get(2);
      assert.equal(agyRpc.error, undefined);
      const parsedAgy = harnessQuotaBatchSchema.parse(agyRpc.result);
      assert.equal(proxyForwards.length, 3); // loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary
      assert.ok(proxyForwards.every((f) => f.authHeader === expectedProxyAuth));

      const argon7d = parsedAgy.find((r) => r.accountId === 'work-b@example.test' && r.pool === 'Gemini 4 Argon' && r.window === '7 days');
      assert.equal(argon7d.remaining, 75);
      assert.equal(argon7d.accountLabel, 'Seat 2');
      assert.deepEqual(argon7d.modelIds, ['gemini-4-argon-high']);

      // Ordinary Gemini 7d claims only gemini-3.8-flash-high, never Argon!
      const ordinaryGemini7d = parsedAgy.find((r) => r.accountId === 'work-b@example.test' && r.pool === 'Gemini' && r.window === '7 days');
      assert.equal(ordinaryGemini7d.remaining, 85);
      assert.deepEqual(ordinaryGemini7d.modelIds, ['gemini-3.8-flash-high']);
    } finally {
      child.kill();
      incoming.close();
    }
  } finally {
    for (const s of proxySockets) s.destroy();
    for (const s of upstreamSockets) s.destroy();
    await Promise.all([
      new Promise((resolve) => forwardHttpProxy.close(resolve)),
      new Promise((resolve) => codeAssistUpstream.close(resolve)),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});
