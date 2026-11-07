import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { antigravityQuotaSourceDefinition, magpieQuotaService, register } from '../entry.mjs';
import {
  MagpieQuotaService,
  mapMagpieAccountRows,
  parseModelWindows,
  resolveMagpieExecutable,
} from '../lib/magpie.mjs';

const declaredSource = manifest['x-kiki'].harnessQuotaSources[0];

const FIXTURE_MAGPIE_ACCOUNTS = [
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
    asOf: '2026-11-07T02:58:00Z',
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

test('manifest and entry registration match the exact harnessQuotaSources contract without reading quota on register', () => {
  assert.deepEqual(declaredSource, antigravityQuotaSourceDefinition);
  assert.deepEqual(declaredSource, {
    schemaVersion: 1,
    id: 'antigravity',
    label: 'Magpie · Antigravity',
    engineIds: ['agy-cli'],
    minRefreshIntervalMs: 300_000,
  });

  const registered = [];
  register({
    registerHarnessQuotaSource(definition, adapter) {
      registered.push({ definition, adapter });
    },
  });
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].definition, declaredSource);
  assert.equal(typeof registered[0].adapter.read, 'function');
  assert.equal(magpieQuotaService.cache, undefined);
});

test('maps pooled Magpie windows via explicit modelWindows, preserves 0 vs unknown, and keeps unmapped pools display-only', () => {
  const modelWindows = JSON.stringify({
    'claude-opus-5-5-high': { pool: 'Claude & GPT', name: '5 hours' },
    'claude-sonnet-4-6': { pool: 'Claude & GPT', name: '5 hours' },
    'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
    'gemini-4-argon-medium': { pool: 'Gemini 4 Argon' },
  });

  const readings = mapMagpieAccountRows(FIXTURE_MAGPIE_ACCOUNTS, {
    engineId: 'agy-cli',
    agent: 'antigravity',
    modelWindows,
  });

  // Non-antigravity row is filtered out.
  assert.equal(readings.some((r) => r.accountId === 'other-agent@example.test'), false);

  // Mapped 5h pool carries exact modelIds, remaining, resetsAt, readAt, accountLabel.
  const opus5h = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Claude & GPT' && r.window === '5 hours');
  assert.deepEqual(opus5h, {
    engineId: 'agy-cli',
    accountId: 'work-a@example.test',
    accountLabel: 'Work A',
    pool: 'Claude & GPT',
    modelIds: ['claude-opus-5-5-high', 'claude-sonnet-4-6'],
    unit: 'percent',
    window: '5 hours',
    remaining: 80,
    resetsAt: '2026-11-07T08:00:00.000Z',
    readAt: '2026-11-07T03:00:00.000Z',
  });

  // Unmapped 7d Claude & GPT window and Gemini 5h window omit modelIds so they display without misrouting.
  const opus7d = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Claude & GPT' && r.window === '7 days');
  assert.equal(opus7d.modelIds, undefined);
  assert.equal(opus7d.remaining, 35);

  const gemini5h = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini');
  assert.equal(gemini5h.modelIds, undefined);
  assert.equal(gemini5h.remaining, 90);

  // Exhausted Argon pool on work-a keeps genuine 0 remaining, while work-b has 75 remaining and uses asOf/seat fallback.
  const argonA = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini 4 Argon');
  assert.equal(argonA.remaining, 0);
  assert.deepEqual(argonA.modelIds, ['gemini-4-argon-high', 'gemini-4-argon-medium']);

  const argonB = readings.find((r) => r.accountId === 'work-b@example.test' && r.pool === 'Gemini 4 Argon');
  assert.equal(argonB.remaining, 75);
  assert.equal(argonB.accountLabel, 'Seat 2');
  assert.equal(argonB.readAt, '2026-11-07T02:58:00.000Z');

  // Text-only and unlimited windows never fabricate numeric remaining (neither 100 nor 0).
  const promo = readings.find((r) => r.accountId === 'work-b@example.test' && r.window === 'Promo Note');
  assert.equal(promo.remaining, undefined);
  const unlimited = readings.find((r) => r.accountId === 'work-b@example.test' && r.window === 'Gateway Key');
  assert.equal(unlimited.remaining, undefined);

  // Lapsed and unreachable accounts keep remaining undefined (unknown).
  const lapsed = readings.find((r) => r.accountId === 'lapsed@example.test');
  assert.equal(lapsed.remaining, undefined);
  const unreachable = readings.find((r) => r.accountId === 'unreachable@example.test');
  assert.deepEqual(unreachable, {
    engineId: 'agy-cli',
    accountId: 'unreachable@example.test',
  });
});

test('preserves unpooled per-model fallback windows when retrieveUserQuotaSummary is unavailable', () => {
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
  const readings = mapMagpieAccountRows(unpooledRows);
  assert.deepEqual(readings, [
    {
      engineId: 'agy-cli',
      accountId: 'solo@example.test',
      modelIds: ['gemini-3.8-flash-high'],
      unit: 'percent',
      window: 'gemini-3.8-flash-high',
      remaining: 60,
      resetsAt: '2026-11-07T09:00:00.000Z',
      readAt: '2026-11-07T04:00:00.000Z',
    },
  ]);
});

test('batches all accounts into one CLI invocation, coalesces concurrent reads (single-flight), and respects the 5-minute refresh interval', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const seenArgs = [];
  const seenHomes = [];

  const service = new MagpieQuotaService({
    now: () => clock,
    minRefreshIntervalMs: 300_000,
    execCommand: async (executable, args, options) => {
      calls += 1;
      seenArgs.push({ executable, args });
      seenHomes.push(options.env.HOME);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { stdout: JSON.stringify(FIXTURE_MAGPIE_ACCOUNTS), stderr: '' };
    },
  });

  const magpiePath = path.resolve('/opt/magpie/bin/magpie');
  const context = {
    osHome: path.resolve('/home/tester'),
    settings: {
      magpiePath,
      modelWindows: JSON.stringify({
        'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
      }),
    },
  };

  // Three concurrent callers share one single-flight CLI read.
  const [r1, r2, r3] = await Promise.all([
    service.adapter.read(context),
    service.adapter.read(context),
    service.adapter.read(context),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(seenArgs[0], {
    executable: magpiePath,
    args: ['accounts', 'antigravity', '--json'],
  });
  assert.equal(seenHomes[0], path.resolve('/home/tester'));
  assert.deepEqual(r1, r2);
  assert.deepEqual(r2, r3);

  // Within 5 minutes, returns cached snapshot without invoking CLI again.
  clock += 299_999;
  const cached = await service.adapter.read(context);
  assert.equal(calls, 1);
  assert.deepEqual(cached, r1);

  // Mutating returned array does not corrupt internal cache.
  cached[0].remaining = 999;
  const cachedAgain = await service.adapter.read(context);
  assert.notEqual(cachedAgain[0].remaining, 999);

  // After 5 minutes, refreshes once.
  clock += 2;
  await service.adapter.read(context);
  assert.equal(calls, 2);
});

test('executes a synthetic CLI script once in a temporary directory and validates settings errors cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'magpie-quota-fixture-'));
  try {
    const cliScript = path.join(dir, 'fake-magpie.mjs');
    await writeFile(cliScript, [
      'import assert from "node:assert/strict";',
      'assert.deepEqual(process.argv.slice(2), ["accounts", "antigravity", "--json"]);',
      `process.stdout.write(${JSON.stringify(JSON.stringify(FIXTURE_MAGPIE_ACCOUNTS.slice(0, 1)))});`,
    ].join('\n'));

    const service = new MagpieQuotaService({
      execCommand: (executable, args, options) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [executable, ...args], {
          env: options.env,
          signal: options.signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(stderr || `exit ${code}`));
        });
      }),
    });

    const result = await service.adapter.read({
      osHome: dir,
      settings: {
        magpiePath: cliScript,
        modelWindows: '{"gemini-4-argon-high":{"pool":"Gemini 4 Argon"}}',
      },
    });
    assert.equal(result.length, 4);
    assert.deepEqual(
      result.find((item) => item.pool === 'Gemini 4 Argon')?.modelIds,
      ['gemini-4-argon-high'],
    );

    assert.throws(() => resolveMagpieExecutable({ magpiePath: 'relative/magpie' }), /absolute path/);
    assert.throws(() => parseModelWindows('{bad json'), /Invalid modelWindows JSON/);
    assert.throws(() => parseModelWindows('{"m1":{}}'), /at least pool or name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
