import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import {
  activate,
  deactivate,
  definitions,
  errorPulseReportTool,
  errorPulseServiceForTests,
  handlePanelRequest,
  register,
} from '../entry.mjs';
import { buildErrorSignature, redactSecrets } from '../lib/signature.mjs';

const pluginRoot = path.dirname(import.meta.dirname);
const repoRoot = path.resolve(pluginRoot, '..', '..');
const tmpBaseDir = path.join(repoRoot, '.tmp', 'error-pulse-suite');

async function withTempHome(fn) {
  await mkdir(tmpBaseDir, { recursive: true });
  const homeDir = await mkdtemp(path.join(tmpBaseDir, 'home-'));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }
}

function loopToolCall(toolCallId, name, args, time) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: {
      type: 'tool.call',
      toolCallId,
      name,
      args,
    },
  });
}

function loopToolResult(toolCallId, { output, isError = false, exitCode } = {}, time) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: {
      type: 'tool.result',
      toolCallId,
      result: {
        output,
        ...(isError ? { isError: true } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
    },
  });
}

test('manifest, sync-manifest, registration, icon budget, and zero-emoji panel contract', async () => {
  const manifestRaw = await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.equal(manifest.name, 'kiki-error-pulse');
  assert.equal(manifest['x-kiki'].activation, 'app');
  assert.equal(manifest['x-kiki'].engines.kiki, '>=0.4.1');
  assert.deepStrictEqual(manifest['x-kiki'].permissions, { fs: 'outside', uiPanel: true });
  assert.deepStrictEqual(manifest['x-kiki'].tools, definitions);

  const panel = manifest['x-kiki'].panels?.[0];
  assert.deepStrictEqual(panel, {
    schemaVersion: 1,
    id: 'pulse',
    label: '报错雷达',
    slot: 'workspace',
    path: './panel.html',
  });

  const props = manifest['x-kiki'].settings.schema.properties;
  assert.equal(props.autoScanEnabled.default, true);
  assert.equal(props.scanIntervalMinutes.type, 'number');
  assert.equal(props.scanIntervalMinutes.default, 30);
  assert.equal(props.maxScanMegabytesPerTick.type, 'number');
  assert.equal(props.maxScanMegabytesPerTick.default, 16);

  const syncCheck = spawnSync(
    process.execPath,
    [path.join(pluginRoot, 'scripts', 'sync-manifest.mjs'), '--check'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(syncCheck.status, 0, syncCheck.stderr || syncCheck.stdout);

  const iconStat = await stat(path.join(pluginRoot, 'icon.svg'));
  assert.ok(iconStat.size > 0 && iconStat.size <= 4096, `icon.svg size ${iconStat.size} exceeds 4 KB`);

  const skillText = await readFile(path.join(pluginRoot, 'skills', 'error-pulse', 'SKILL.md'), 'utf8');
  assert.ok(skillText.includes('error_pulse_report'));

  const panelHtml = await readFile(path.join(pluginRoot, 'panel.html'), 'utf8');
  assert.equal(/\p{Extended_Pictographic}/u.test(panelHtml), false, 'panel.html must contain zero Emoji');

  const registered = [];
  register({
    registerTool(def, fn) {
      registered.push({ def, fn });
    },
  });
  assert.equal(registered.length, 1);
  assert.deepStrictEqual(registered[0].def, errorPulseReportTool);
  assert.equal(typeof registered[0].fn, 'function');
});

test('activate never blocks or scans synchronously on cold start and cleans up on deactivate', async () => {
  await withTempHome(async (kikiHome) => {
    const sessionDir = path.join(kikiHome, 'sessions', 'ws_alpha', 'session_cold', 'agents', 'main');
    await mkdir(sessionDir, { recursive: true });
    const now = Date.now();
    await writeFile(
      path.join(sessionDir, 'wire.jsonl'),
      `${loopToolCall('c1', 'Read', { path: 'missing.txt' }, now)}\n${loopToolResult(
        'c1',
        { output: '<system>ERROR: Tool execution failed.</system>\nENOENT: missing.txt', isError: true },
        now + 5,
      )}\n`,
      'utf8',
    );

    const svc = errorPulseServiceForTests({
      kikiHome,
      startupDelayMs: 40,
      intervalMs: 10_000,
    });

    try {
      const t0 = performance.now();
      const act = await svc.activate({
        dataDir: path.join(kikiHome, 'plugins', 'data', 'kiki-error-pulse'),
        settings: { autoScanEnabled: true, scanIntervalMinutes: 30, maxScanMegabytesPerTick: 16 },
      });
      const elapsedMs = performance.now() - t0;

      assert.equal(act.ok, true);
      assert.ok(elapsedMs < 200, `activate took ${elapsedMs}ms`);

      // Immediately after activate(), cold summary must show indexed=false (zero synchronous disk scan).
      const beforeTimer = await svc.executeTool({ action: 'summary' });
      assert.equal(beforeTimer.indexed, false);
      assert.equal(beforeTimer.totals.calls, 0);

      // Wait for delayed startup scan to fire and persist index.
      let afterTimer = beforeTimer;
      const deadline = Date.now() + 2000;
      while (!afterTimer.indexed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        afterTimer = await svc.executeTool({ action: 'summary' });
      }
      assert.equal(afterTimer.indexed, true);
      assert.equal(afterTimer.totals.calls, 1);
      assert.equal(afterTimer.totals.errors, 1);
    } finally {
      await svc.deactivate();
    }
  });
});

test('incremental byte cursor, O(1) unchanged skip, Bash exit extraction, streaks, lifecycle errors, and secret redaction', async () => {
  await withTempHome(async (kikiHome) => {
    const now = Date.now();
    const mainSessionDir = path.join(kikiHome, 'sessions', 'bucket_1', 'session_01');
    const mainAgentDir = path.join(mainSessionDir, 'agents', 'main');
    const subAgentDir = path.join(mainSessionDir, 'agents', 'agent-2');
    await mkdir(mainAgentDir, { recursive: true });
    await mkdir(subAgentDir, { recursive: true });

    await writeFile(
      path.join(mainSessionDir, 'state.json'),
      JSON.stringify({ id: 'session_01', cwd: 'D:/work/acme-service' }),
      'utf8',
    );

    const fakeOpenAiKey = 'sk-proj_AbCdEfGhIjKlMnOpQr12345';
    const fakeGhToken = 'ghp_1234567890abcdefghijklmnop';
    const fakePat = 'github_pat_11AABBCCDDEE_secretvalue999';
    const fakeMdp = 'mdp_live_secret_token_987654321';
    const fakeJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    const mainLines = [
      // Unrelated streaming text delta (should be skipped by substring pre-filter without JSON.parse)
      JSON.stringify({ type: 'context.append_loop_event', time: now - 5000, event: { type: 'content.part', part: { type: 'text', text: 'hello world' } } }),
      // Bash streak of 3 consecutive failures
      loopToolCall('b1', 'Bash', { command: `curl -H "Authorization: Bearer ${fakeJwt}" https://example.test` }, now - 4000),
      loopToolResult(
        'b1',
        {
          isError: true,
          output: `<system>ERROR: Tool execution failed.</system>\n$ echo running\nError: request denied with key ${fakeOpenAiKey} at D:/work/acme-service/src/client.mjs:44 (id 550e8400-e29b-41d4-a716-446655440000, addr 0x7ffee3b2a0, ts 1763290001234)\ndone echo\nExit code: 28\n<tool-result-appendix><system-reminder>ignore Error here</system-reminder></tool-result-appendix>`,
        },
        now - 3900,
      ),
      loopToolCall('b2', 'Bash', { command: `gh auth --token ${fakeGhToken}` }, now - 3800),
      loopToolResult(
        'b2',
        {
          isError: true,
          output: `<system>ERROR: Tool execution failed.</system>\nError: request denied with key ${fakePat} at /var/log/acme/run.log:12 (id 123e4567-e89b-12d3-a456-426614174000, addr 0x99aabbc0, ts 9988776655)\nExit code: 28`,
        },
        now - 3700,
      ),
      loopToolCall('b3', 'Bash', { command: `deploy --key ${fakeMdp}` }, now - 3600),
      loopToolResult(
        'b3',
        {
          isError: true,
          output: '<system>ERROR: Tool execution failed.</system>\nSyntaxError: Unexpected token } in JSON\nExit code: 1',
        },
        now - 3500,
      ),
      // Bash success breaks the streak
      loopToolCall('b4', 'Bash', { command: 'npm test' }, now - 3400),
      loopToolResult('b4', { isError: false, output: 'All tests green' }, now - 3300),
      // CallTool expansion
      loopToolCall('m1', 'CallTool', { name: 'mcp_demo_fetch', arguments: { token: fakeOpenAiKey } }, now - 3200),
      loopToolResult(
        'm1',
        { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nTimeout waiting for upstream response' },
        now - 3100,
      ),
      // Provider & turn lifecycle errors
      JSON.stringify({ type: 'provider.error', code: 'rate_limit', message: `429 upstream quota with Bearer ${fakeMdp}`, time: now - 3000 }),
      JSON.stringify({ type: 'turn.failed', message: 'Turn aborted due to unrecoverable stream error', time: now - 2900 }),
    ];

    const mainWirePath = path.join(mainAgentDir, 'wire.jsonl');
    await writeFile(mainWirePath, `${mainLines.join('\n')}\n`, 'utf8');

    const subWirePath = path.join(subAgentDir, 'wire.jsonl');
    await writeFile(
      subWirePath,
      [
        JSON.stringify({ type: 'subagent.failed', message: 'Worker child exited unexpectedly during long pipeline step', time: now - 2500 }),
        JSON.stringify({ type: 'context.append_loop_event', time: now - 2400, event: { type: 'content.part', part: { type: 'text', text: 'padding_before_truncation_'.repeat(8) } } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const svc = errorPulseServiceForTests({ kikiHome });

    // 1. First scan
    const first = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(first.ok, true);
    assert.equal(first.filesScanned, 2);
    assert.equal(first.filesSkippedUnchanged, 0);
    assert.ok(first.bytesRead > 0);
    assert.equal(first.totals.calls, 5); // 4 Bash + 1 CallTool:mcp_demo_fetch
    assert.equal(first.totals.errors, 4); // 3 Bash + 1 CallTool:mcp_demo_fetch
    assert.equal(first.totals.streaks, 1); // 3 consecutive Bash failures = 1 streak episode (length 3)
    assert.equal(first.totals.lifecycleErrors, 3); // provider.error, turn.failed, subagent.failed

    const bashTool = first.highErrorTools.find((t) => t.tool === 'Bash');
    assert.ok(bashTool);
    assert.equal(bashTool.calls, 4);
    assert.equal(bashTool.errors, 3);
    assert.equal(bashTool.errorRate, 0.75);
    assert.equal(bashTool.streaks, 1);

    const mcpTool = first.highErrorTools.find((t) => t.tool === 'CallTool:mcp_demo_fetch');
    assert.ok(mcpTool);
    assert.equal(mcpTool.calls, 1);
    assert.equal(mcpTool.errors, 1);

    // b1 and b2 must normalize into the EXACT SAME signature despite different secrets, OS paths, UUIDs, hex, and timestamps!
    const exit28Sig = first.topSignatures.find((s) => s.tool === 'Bash' && s.signature.startsWith('[exit=28]'));
    assert.ok(exit28Sig, `Missing [exit=28] signature in ${JSON.stringify(first.topSignatures)}`);
    assert.equal(exit28Sig.count, 2);
    assert.ok(exit28Sig.signature.includes('<REDACTED>'));
    assert.ok(exit28Sig.signature.includes('<PATH>'));
    assert.ok(exit28Sig.signature.includes('<UUID>'));
    assert.ok(exit28Sig.signature.includes('<HEX>'));
    assert.ok(exit28Sig.signature.includes('<NUM>'));
    assert.equal(exit28Sig.signature.includes('done echo'), false);
    assert.equal(exit28Sig.signature.includes('ignore Error here'), false);

    // Check streak episode length === 3
    const streaksView = await svc.executeTool({ action: 'streaks', windowHours: 24 });
    assert.equal(streaksView.totalStreaks, 1);
    assert.equal(streaksView.episodes.length, 1);
    assert.equal(streaksView.episodes[0].tool, 'Bash');
    assert.equal(streaksView.episodes[0].length, 3);

    // Verify persisted index-v1.json on disk contains ZERO raw secrets anywhere!
    const indexPath = path.join(kikiHome, 'plugins', 'data', 'kiki-error-pulse', 'index-v1.json');
    const rawIndexJson = await readFile(indexPath, 'utf8');
    for (const secret of [fakeOpenAiKey, fakeGhToken, fakePat, fakeMdp, fakeJwt]) {
      assert.equal(rawIndexJson.includes(secret), false, `Secret leaked into index-v1.json: ${secret}`);
    }

    // Check samples action + max 5 sample ring cap
    const sampleView = await svc.executeTool({ action: 'samples', signatureId: exit28Sig.signatureId });
    assert.equal(sampleView.found, true);
    assert.equal(sampleView.samples.length, 2);
    assert.equal(sampleView.samples[0].workspace, 'work/acme-service');

    // 2. Second scan when files are unchanged -> 0 bytes read, O(1) skip!
    const second = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(second.bytesRead, 0);
    assert.equal(second.filesScanned, 0);
    assert.equal(second.filesSkippedUnchanged, 2);
    assert.equal(second.totals.calls, 5);
    assert.equal(second.totals.errors, 4);

    // 3. Append an unfinished half-line (no trailing \n) -> must not crash or lose event, then complete it!
    const nextCall = loopToolCall('r1', 'Read', { path: 'absent.json' }, now - 1000);
    const nextFail = loopToolResult(
      'r1',
      { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nFile absent.json does not exist' },
      now - 900,
    );
    const fullAppend = `${nextCall}\n${nextFail}\n`;
    const splitPoint = Math.floor(fullAppend.length / 2);
    const partA = fullAppend.slice(0, splitPoint); // Ends mid-JSON without newline!
    const partB = fullAppend.slice(splitPoint);

    await appendFile(mainWirePath, partA, 'utf8');
    const midScan = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(midScan.filesScanned, 1);
    assert.equal(midScan.filesSkippedUnchanged, 1);
    assert.equal(midScan.totals.calls, 6); // nextCall had a newline, nextFail did not yet!
    assert.equal(midScan.totals.errors, 4);

    await appendFile(mainWirePath, partB, 'utf8');
    const afterComplete = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(afterComplete.filesScanned, 1);
    assert.equal(afterComplete.filesSkippedUnchanged, 1);
    assert.ok(afterComplete.bytesRead <= Buffer.byteLength(fullAppend, 'utf8'));
    assert.equal(afterComplete.totals.calls, 6);
    assert.equal(afterComplete.totals.errors, 5);

    // 4. Truncate subWirePath to a smaller file (stat.size < saved.offset) -> cursor resets cleanly and reads new line
    const beforeTruncStat = await stat(subWirePath);
    await writeFile(subWirePath, `${loopToolCall('s1', 'Grep', { pattern: 'x' }, now - 500)}\n`, 'utf8');
    const afterTruncStat = await stat(subWirePath);
    assert.ok(afterTruncStat.size < beforeTruncStat.size);
    const afterTruncate = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(afterTruncate.filesScanned, 1);
    assert.equal(afterTruncate.totals.calls, 7);
  });
});

test('cold large file (5 MiB fixture) strictly reads <= 2.1 MiB from tail and skips head history', async () => {
  await withTempHome(async (kikiHome) => {
    const now = Date.now();
    const sessionDir = path.join(kikiHome, 'sessions', 'ws_large', 'session_5mb', 'agents', 'main');
    await mkdir(sessionDir, { recursive: true });
    const wirePath = path.join(sessionDir, 'wire.jsonl');

    // Build ~3.5 MiB of cold prefix containing an ancient head error (must NOT be scanned)
    const headError = `${loopToolCall('old_1', 'Edit', { path: 'ancient.js' }, now - 8000)}\n${loopToolResult(
      'old_1',
      { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nANCIENT_HEAD_ERROR_SHOULD_SKIP' },
      now - 7900,
    )}\n`;

    const fillerLine = `${JSON.stringify({
      type: 'context.append_loop_event',
      time: now - 7000,
      event: { type: 'content.part', part: { type: 'text', text: 'x'.repeat(900) } },
    })}\n`;
    const fillerLineBytes = Buffer.byteLength(fillerLine, 'utf8');

    const chunks = [headError];
    let totalSize = Buffer.byteLength(headError, 'utf8');
    while (totalSize < 3.6 * 1024 * 1024) {
      chunks.push(fillerLine);
      totalSize += fillerLineBytes;
    }

    // Append ~1.5 MiB of recent tail containing 2 real tail errors (total file ~5.15 MiB)
    while (totalSize < 5.15 * 1024 * 1024) {
      chunks.push(fillerLine);
      totalSize += fillerLineBytes;
    }
    const tailEvents = [
      loopToolCall('tail_1', 'Write', { path: 'recent1.js' }, now - 1000),
      loopToolResult(
        'tail_1',
        { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nRECENT_TAIL_WRITE_CONFLICT' },
        now - 950,
      ),
      loopToolCall('tail_2', 'Write', { path: 'recent2.js' }, now - 900),
      loopToolResult(
        'tail_2',
        { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nRECENT_TAIL_WRITE_CONFLICT' },
        now - 850,
      ),
    ].join('\n') + '\n';
    chunks.push(tailEvents);
    totalSize += Buffer.byteLength(tailEvents, 'utf8');

    await writeFile(wirePath, chunks.join(''), 'utf8');
    const finalStat = await stat(wirePath);
    assert.ok(finalStat.size > 5 * 1024 * 1024, `Fixture size is ${finalStat.size}`);

    const svc = errorPulseServiceForTests({ kikiHome });
    const scanRes = await svc.executeTool({ action: 'scan_now', windowHours: 24 });

    assert.equal(scanRes.filesScanned, 1);
    assert.ok(
      scanRes.bytesRead <= 2.1 * 1024 * 1024,
      `Expected bytesRead <= 2.1 MiB, got ${scanRes.bytesRead}`,
    );
    assert.ok(scanRes.bytesRead > 1.8 * 1024 * 1024);

    // Must have captured the 2 recent Write errors + 1 streak, and skipped ANCIENT_HEAD_ERROR_SHOULD_SKIP!
    assert.equal(scanRes.totals.calls, 2);
    assert.equal(scanRes.totals.errors, 2);
    assert.equal(scanRes.totals.streaks, 1);
    assert.equal(
      scanRes.topSignatures.some((s) => s.signature.includes('ANCIENT_HEAD_ERROR')),
      false,
    );
    assert.equal(
      scanRes.topSignatures.some((s) => s.signature.includes('RECENT_TAIL_WRITE_CONFLICT')),
      true,
    );

    // Subsequent scan skips the 5 MiB file in O(1) with 0 bytes read!
    const rescan = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(rescan.bytesRead, 0);
    assert.equal(rescan.filesSkippedUnchanged, 1);
  });
});

test('cooperative time-slicing across multi-byte UTF-8 chunk boundaries, byte budget pause, and single-flight lock', async () => {
  await withTempHome(async (kikiHome) => {
    const now = Date.now();
    // Create 7 session files with multi-byte CJK error lines straddling tiny 192-byte chunks.
    for (let i = 0; i < 7; i += 1) {
      const dir = path.join(kikiHome, 'sessions', 'ws_slice', `session_${i}`, 'agents', 'main');
      await mkdir(dir, { recursive: true });
      const lines = [];
      for (let j = 0; j < 8; j += 1) {
        const cid = `call_${i}_${j}`;
        lines.push(loopToolCall(cid, 'Edit', { path: `模块_${j}.mjs`, note: '中文参数边界测试'.repeat(4) }, now - 2000 + j));
        lines.push(
          loopToolResult(
            cid,
            {
              isError: true,
              output: `<system>ERROR: Tool execution failed.</system>\n中文跨块半行完整性校验错误：目标段落不唯一（序号=${j}）`,
            },
            now - 1900 + j,
          ),
        );
      }
      await writeFile(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    }

    let observedYields = 0;
    const svc = errorPulseServiceForTests({
      kikiHome,
      chunkBytes: 192, // Forces multi-chunk splits right through multi-byte UTF-8 JSON lines!
      maxBytesOverride: 12_000, // Forces mid-run byte budget pause on Tick 1!
      onYield() {
        observedYields += 1;
      },
    });

    // Test single-flight lock: launch 2 concurrent scans -> second reuses the in-flight scan!
    const [flightA, flightB] = await Promise.all([
      svc.scanIncremental({ reason: 'tick1' }),
      svc.scanIncremental({ reason: 'concurrent_panel' }),
    ]);
    assert.equal(flightA.reusedInFlight, false);
    assert.equal(flightB.reusedInFlight, true);
    assert.equal(flightA.scan.budgetPaused, true);
    assert.ok(observedYields >= 1, 'Expected cooperative setImmediate yields');

    // Tick 2 with larger budget finishes all remaining files cleanly without losing a single line!
    svc.deps.maxBytesOverride = 500_000;
    const tick2 = await svc.executeTool({ action: 'scan_now', windowHours: 24 });
    assert.equal(tick2.budgetPaused, false);
    assert.equal(tick2.totals.calls, 7 * 8); // All 56 calls accounted for!
    assert.equal(tick2.totals.errors, 7 * 8); // All 56 errors accounted for with zero corrupt JSON!

    const sig = tick2.topSignatures[0];
    assert.ok(sig.signature.includes('中文跨块半行完整性校验错误'));
    assert.equal(sig.signature.includes('\uFFFD'), false, 'UTF-8 replacement character detected across chunk split');
  });
});

test('panel RPC handler and standalone redaction helpers', async () => {
  await withTempHome(async (kikiHome) => {
    const dir = path.join(kikiHome, 'sessions', 'ws_p', 'session_p', 'agents', 'main');
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    await writeFile(
      path.join(dir, 'wire.jsonl'),
      `${loopToolCall('p1', 'FetchURL', { url: 'https://example.test' }, now - 500)}\n${loopToolResult(
        'p1',
        { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nHTTP 502 Bad Gateway' },
        now - 400,
      )}\n`,
      'utf8',
    );

    const ctx = { kikiHome, settings: {} };
    const refreshed = await handlePanelRequest('scan_now', { windowHours: 24 }, ctx);
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.totals.errors, 1);

    const state = await handlePanelRequest('state', { windowHours: 24 }, ctx);
    assert.equal(state.ok, true);
    assert.equal(state.topSignatures.length, 1);

    const samples = await handlePanelRequest(
      'samples',
      { signatureId: state.topSignatures[0].signatureId, windowHours: 24 },
      ctx,
    );
    assert.equal(samples.ok, true);
    assert.equal(samples.samples.length, 1);

    const invalid = await handlePanelRequest('nonexistent_action', {}, ctx);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'INVALID_PANEL_ACTION');

    await deactivate();
  });

  // Direct unit check on Python traceback Core Line selection (picks final exception over Traceback header)
  const pySig = buildErrorSignature({
    kind: 'tool',
    tool: 'Bash',
    rawError:
      '<system>ERROR: Tool execution failed.</system>\nTraceback (most recent call last):\n  File "/opt/app/run.py", line 19, in <module>\nModuleNotFoundError: No module named \'torch\'\nExit code: 1',
  });
  assert.equal(pySig.signature, "[exit=1] ModuleNotFoundError: No module named 'torch'");

  const redacted = redactSecrets('token=sk-abcdef1234567890XYZ header="Bearer secret_abc_123"');
  assert.equal(redacted, 'token=<REDACTED> header="<REDACTED>"');

  // WebSearch / FetchURL multiline nb-search JSON signature extraction (never lone "{")
  const wsPartialJson = JSON.stringify(
    {
      schema_version: '3.0',
      status: 'partial',
      lanes: ['exa.search', 'tavily.search'],
      lane_results: [
        { lane: 'exa.search', status: 'ok', hits: [{ title: 'doc' }] },
        { lane: 'tavily.search', status: 'failed', error: { code: 'provider_timeout', message: 'Timed out after 15s' } },
      ],
    },
    null,
    2,
  );
  const wsSig = buildErrorSignature({
    kind: 'tool',
    tool: 'WebSearch',
    rawError: `<system>ERROR: Tool execution failed.</system>\n${wsPartialJson}`,
  });
  assert.notEqual(wsSig.signature, '{');
  assert.equal(wsSig.signature, 'nb-search status=partial lanes=tavily.search code=provider_timeout');

  // Truncated >40KB FetchURL nb-search JSON fallback
  const truncatedFetchJson = `{\n  "schema_version": "3.0",\n  "status": "failed",\n  "pipeline": "jina.reader",\n  "error": {\n    "code": "upstream_403",\n    "message": "Blocked"\n  },\n  "raw_preview": "${'a'.repeat(40_000)}`;
  const fetchSig = buildErrorSignature({
    kind: 'tool',
    tool: 'FetchURL',
    rawError: truncatedFetchJson,
  });
  assert.notEqual(fetchSig.signature, '{');
  assert.equal(fetchSig.signature, 'nb-search status=failed lanes=jina.reader code=upstream_403');
});

test(
  'executes error_pulse_report end-to-end through pinned Kiki Host runner RPC',
  { skip: !process.env.KIKI_HOST_RUNNER, timeout: 20_000 },
  async () => {
    await withTempHome(async (kikiHome) => {
      const dir = path.join(kikiHome, 'sessions', 'ws_rpc', 'session_rpc', 'agents', 'main');
      await mkdir(dir, { recursive: true });
      const now = Date.now();
      await writeFile(
        path.join(dir, 'wire.jsonl'),
        `${loopToolCall('rpc_1', 'Bash', { command: 'false' }, now - 500)}\n${loopToolResult(
          'rpc_1',
          { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nCommand failed\nExit code: 1' },
          now - 450,
        )}\n`,
        'utf8',
      );

      const child = spawn(
        process.execPath,
        [path.resolve(process.env.KIKI_HOST_RUNNER), path.join(pluginRoot, 'entry.mjs')],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: pluginRoot,
          env: { ...process.env, KIKI_HOME: kikiHome },
        },
      );
      const closed = once(child, 'close');
      let reqSeq = 0;
      const waiting = new Map();
      const registered = [];
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'register') registered.push(msg.params.tool);
        if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
      });
      const rpc = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++reqSeq;
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new Error(`Host runner timeout on ${method}: ${stderr}`));
          }, 12_000);
          waiting.set(id, (msg) => {
            clearTimeout(timer);
            waiting.delete(id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });

      try {
        assert.deepStrictEqual(await rpc('handshake', { version: 1 }), { version: 1 });

        const execRes = await rpc('execute', {
          name: 'error_pulse_report',
          args: { action: 'scan_now', windowHours: 24, reason: 'Host runner end-to-end verification' },
          settings: {},
          kikiHome,
        });
        assert.deepStrictEqual(registered, definitions);
        assert.equal(execRes.isError, undefined);
        const textOut = typeof execRes.output === 'string' ? execRes.output : execRes.output[0].text;
        const parsed = JSON.parse(textOut);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.totals.calls, 1);
        assert.equal(parsed.totals.errors, 1);

        await rpc('shutdown', {});
      } finally {
        child.stdin.end();
        child.kill();
        await closed;
      }
    });
  },
);

test('bounded ring storage caps samples at 5 per signature and evicts >30d hourly buckets', async () => {
  await withTempHome(async (kikiHome) => {
    const dir = path.join(kikiHome, 'sessions', 'ws_ring', 'session_ring', 'agents', 'main');
    await mkdir(dir, { recursive: true });
    const baseNow = Date.now();
    const expiredTs = baseNow - 32 * 24 * 3600_000; // 32 days ago (> 30d retention)

    const lines = [
      // Expired event (>30d old)
      loopToolCall('old_1', 'Bash', { command: 'old_cmd' }, expiredTs),
      loopToolResult(
        'old_1',
        { isError: true, output: '<system>ERROR: Tool execution failed.</system>\nEXPIRED_32D_ERROR\nExit code: 2' },
        expiredTs + 10,
      ),
    ];

    // 8 recent identical errors -> must cap samples to latest 5
    for (let i = 1; i <= 8; i += 1) {
      lines.push(loopToolCall(`recent_${i}`, 'Read', { path: `sample_${i}.txt` }, baseNow - (10 - i) * 1000));
      lines.push(
        loopToolResult(
          `recent_${i}`,
          {
            isError: true,
            output: `<system>ERROR: Tool execution failed.</system>\nPermission denied reading D:/vault/sample_${i}.txt`,
          },
          baseNow - (10 - i) * 1000 + 50,
        ),
      );
    }

    await writeFile(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const svc = errorPulseServiceForTests({ kikiHome, now: () => baseNow });

    const scanned = await svc.executeTool({ action: 'scan_now', windowHours: 720 });
    assert.equal(scanned.totals.calls, 8);
    assert.equal(scanned.totals.errors, 8);
    assert.equal(
      scanned.topSignatures.some((s) => s.signature.includes('EXPIRED_32D_ERROR')),
      false,
    );

    const topOnly = await svc.executeTool({ action: 'top_signatures', windowHours: 720, toolFilter: 'Read' });
    assert.equal(topOnly.signatures.length, 1);
    assert.equal(topOnly.signatures[0].count, 8);
    assert.equal(topOnly.signatures[0].sampleCount, 5);

    const sampleRes = await svc.executeTool({
      action: 'samples',
      signatureId: topOnly.signatures[0].signatureId,
    });
    assert.equal(sampleRes.samples.length, 5);
    assert.ok(sampleRes.samples[0].argsPreview.includes('sample_8.txt'));
    assert.ok(sampleRes.samples[4].argsPreview.includes('sample_4.txt'));
  });
});

