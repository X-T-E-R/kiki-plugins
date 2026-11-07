import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { z } from 'zod';

import manifest from '../kimi.plugin.json' with { type: 'json' };
import { antigravityQuotaSourceDefinition, register } from '../entry.mjs';
import {
  MagpieQuotaService,
  mapMagpieAccountRows,
  parseModelWindows,
  resolveMagpieExecutable,
} from '../lib/magpie.mjs';

const declaredSource = manifest['x-kiki'].harnessQuotaSources[0];

// Exact contract schemas from packages/plugin-sdk/src/harness-quota.ts
const identifier = z.string().min(1).max(1024).regex(/^[^\s\u0000]+$/);
const harnessQuotaUnitSchema = z.enum(['percent', 'money', 'tokens', 'requests', 'credits', 'count']);
const harnessQuotaSourceDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().min(1),
  engineIds: z.array(identifier).min(1).refine((ids) => new Set(ids).size === ids.length, 'Duplicate engine id'),
  minRefreshIntervalMs: z.number().int().min(300_000).optional(),
}).strict();
const harnessQuotaReadingSchema = z.object({
  accountId: identifier,
  accountLabel: z.string().min(1).optional(),
  modelIds: z.array(identifier).optional(),
  pool: z.string().min(1).optional(),
  unit: harnessQuotaUnitSchema,
  window: z.string().min(1).optional(),
  remaining: z.number().finite().nonnegative().optional(),
  resetAt: z.string().datetime({ offset: true }).optional(),
  readAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const harnessQuotaBatchSchema = z.union([
  z.array(harnessQuotaReadingSchema).max(500),
  z.object({ readings: z.array(harnessQuotaReadingSchema).max(500) }).strict(),
]);

const TASK92_HOST_RUNNER = process.env.KIKI_TASK92_HOST_RUNNER
  ?? 'E:/kiki-wt/executor-instance-scheduling-20261107/packages/agent-core-v2/src/app/plugin/hostRunner.mjs';

async function resolveQuotaCapableRunner() {
  for (const candidate of [TASK92_HOST_RUNNER, process.env.KIKI_HOST_RUNNER].filter(Boolean)) {
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

test('manifest and entry registration match strict harnessQuotaSourceDefinitionSchema without reading quota on register', () => {
  harnessQuotaSourceDefinitionSchema.parse(declaredSource);
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
});

test('maps pooled Magpie windows strictly to harnessQuotaReadingSchema, never confuses ordinary Gemini weekly window with Argon, and keeps stale/failed readings unknown', () => {
  const modelWindows = JSON.stringify({
    'claude-opus-5-5-high': { pool: 'Claude & GPT', name: '5 hours' },
    'claude-sonnet-4-6': { pool: 'Claude & GPT', name: '5 hours' },
    'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
    'gemini-4-argon-medium': { pool: 'Gemini 4 Argon' },
  });

  const readings = mapMagpieAccountRows(FIXTURE_MAGPIE_ACCOUNTS, {
    agent: 'antigravity',
    modelWindows,
  });

  // Every emitted reading strictly passes the official SDK zod schema (no extra engineId/resetsAt fields, valid unit).
  harnessQuotaBatchSchema.parse({ readings });

  // Non-antigravity row is filtered out.
  assert.equal(readings.some((r) => r.accountId === 'other-agent@example.test'), false);

  // Mapped 5h pool carries exact modelIds, remaining, resetAt, readAt, accountLabel, unit.
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

  // Exhausted Argon pool on work-a keeps genuine 0 remaining, while healthy work-b has 75 remaining.
  const argonA = readings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini 4 Argon');
  assert.equal(argonA.remaining, 0);
  assert.deepEqual(argonA.modelIds, ['gemini-4-argon-high', 'gemini-4-argon-medium']);

  const argonB = readings.find((r) => r.accountId === 'work-b@example.test' && r.pool === 'Gemini 4 Argon');
  assert.equal(argonB.remaining, 75);
  assert.equal(argonB.accountLabel, 'Seat 2');
  assert.equal(argonB.readAt, '2026-11-07T02:58:00.000Z');

  // Magpie login_usage.go:43-55 contract: error + readAt + asOf retains timestamp, but old 88% window omits remaining (unknown).
  const staleAsOf = readings.find((r) => r.accountId === 'stale-asof@example.test');
  assert.equal(staleAsOf.remaining, undefined);
  assert.equal(staleAsOf.unit, 'percent');
  assert.equal(staleAsOf.readAt, '2026-11-06T00:00:00.000Z');
  assert.equal(staleAsOf.resetAt, '2026-11-12T00:00:00.000Z');
  assert.deepEqual(staleAsOf.modelIds, ['gemini-4-argon-high', 'gemini-4-argon-medium']);

  const asOfOnly = readings.find((r) => r.accountId === 'asof-only@example.test');
  assert.equal(asOfOnly.remaining, undefined);
  assert.equal(asOfOnly.readAt, '2026-11-06T05:00:00.000Z');

  // Text-only, unlimited, lapsed, and unreachable accounts omit remaining (unknown).
  assert.equal(readings.find((r) => r.accountId === 'work-b@example.test' && r.window === 'Promo Note').remaining, undefined);
  assert.equal(readings.find((r) => r.accountId === 'work-b@example.test' && r.window === 'Gateway Key').remaining, undefined);
  assert.equal(readings.find((r) => r.accountId === 'lapsed@example.test').remaining, undefined);
  assert.deepEqual(readings.find((r) => r.accountId === 'unreachable@example.test'), {
    accountId: 'unreachable@example.test',
    unit: 'percent',
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

test('adapter.read({ signal, settings, kikiHome }) returns { readings } in one batch CLI call and propagates AbortSignal', async () => {
  let calls = 0;
  const seenInvocations = [];

  const service = new MagpieQuotaService({
    execCommand: async (executable, args, options) => {
      calls += 1;
      seenInvocations.push({ executable, args, cwd: options.cwd });
      if (options.signal?.aborted) {
        const err = new Error('aborted');
        err.code = 'ABORT_ERR';
        throw err;
      }
      return { stdout: JSON.stringify(FIXTURE_MAGPIE_ACCOUNTS), stderr: '' };
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
        'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
      }),
    },
  };

  const batch = await service.adapter.read(context);
  harnessQuotaBatchSchema.parse(batch);
  assert.equal(Array.isArray(batch.readings), true);
  assert.equal(calls, 1);
  assert.deepEqual(seenInvocations[0], {
    executable: magpiePath,
    args: ['accounts', 'antigravity', '--json'],
    cwd: kikiHome,
  });

  const abortedController = new AbortController();
  abortedController.abort();
  await assert.rejects(
    service.adapter.read({ ...context, signal: abortedController.signal }),
    { code: 'ABORT_ERR' },
  );
  assert.equal(calls, 1);
});

test('executes synthetic Magpie CLI through official hostRunner harness-quota-request RPC and passes harnessQuotaBatchSchema', async (t) => {
  const runner = await resolveQuotaCapableRunner();
  if (!runner) {
    t.skip('No harness-quota-capable hostRunner available in environment');
    return;
  }

  assert.throws(() => resolveMagpieExecutable({ magpiePath: 'relative/magpie' }), /absolute path/);
  assert.throws(() => parseModelWindows('{bad json'), /Invalid modelWindows JSON/);
  assert.throws(() => parseModelWindows('{"m1":{}}'), /at least pool or name/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'magpie-hostrunner-fixture-'));
  try {
    // Place an `accounts` script inside `dir` (set as kikiHome/cwd): when `magpiePath` points to a real binary
    // executing `accounts antigravity --json`, Node executes `./accounts` directly on both Windows and POSIX!
    const accountsScript = path.join(dir, 'accounts');
    await writeFile(accountsScript, [
      'import assert from "node:assert/strict";',
      'assert.deepEqual(process.argv.slice(2), ["antigravity", "--json"]);',
      `process.stdout.write(${JSON.stringify(JSON.stringify(FIXTURE_MAGPIE_ACCOUNTS))});`,
    ].join('\n'), 'utf8');
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8');

    const executablePath = process.execPath;

    const pluginRoot = path.dirname(import.meta.dirname);
    const child = spawn(process.execPath, [runner, path.join(pluginRoot, 'entry.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const incoming = createInterface({ input: child.stdout });
    const send = (payload) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    const registeredSources = [];

    try {
      const rpcResponse = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hostRunner RPC timed out')), 10_000);
        incoming.on('line', (line) => {
          const msg = JSON.parse(line);
          if (msg.method === 'register-harness-quota-source') {
            registeredSources.push(msg.params.definition);
          } else if (msg.method === 'ready') {
            send({
              id: 1,
              method: 'harness-quota-request',
              params: {
                sourceId: 'antigravity',
                kikiHome: dir,
                settings: {
                  magpiePath: executablePath,
                  modelWindows: JSON.stringify({
                    'gemini-4-argon-high': { pool: 'Gemini 4 Argon' },
                  }),
                },
              },
            });
          } else if (msg.id === 1) {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        child.once('error', reject);
        send({ id: 0, method: 'handshake', params: { version: 1 } });
      });

      assert.deepEqual(registeredSources, [declaredSource]);
      assert.equal(rpcResponse.error, undefined);
      const parsedReadings = harnessQuotaBatchSchema.parse(rpcResponse.result);
      assert.equal(Array.isArray(parsedReadings), true);
      const argonWorkB = parsedReadings.find((r) => r.accountId === 'work-b@example.test' && r.pool === 'Gemini 4 Argon');
      assert.equal(argonWorkB.remaining, 75);
      assert.deepEqual(argonWorkB.modelIds, ['gemini-4-argon-high']);

      // Ordinary Gemini 7-day window in the same batch has NO modelIds.
      const ordinaryGemini7d = parsedReadings.find((r) => r.accountId === 'work-a@example.test' && r.pool === 'Gemini' && r.window === '7 days');
      assert.equal(ordinaryGemini7d.modelIds, undefined);

      // Stale `asOf` fallback in the same batch omits `remaining`.
      const stale = parsedReadings.find((r) => r.accountId === 'stale-asof@example.test');
      assert.equal(stale.remaining, undefined);
      assert.equal(stale.readAt, '2026-11-06T00:00:00.000Z');
    } finally {
      child.kill();
      incoming.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
