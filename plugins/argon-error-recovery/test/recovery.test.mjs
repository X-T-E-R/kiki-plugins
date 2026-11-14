import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { recoveryFor } from '../lib/recovery.mjs';

const input = { hook_event_name: 'StopFailure', error_code: 'provider.api_error', upstream_error_code: 'antigravity_missing_terminal', recoverable: true, recovery_attempts: 0 };
const inputCodelessSse = {
  hook_event_name: 'StopFailure',
  error_code: 'provider.api_error',
  upstream_error_code: undefined,
  error_message: 'Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer. [type=api_error]',
  recoverable: true,
  recovery_attempts: 0,
};
const gateway = { ...input, model_alias: 'example-model', upstream_error_code: 'gateway_stream_terminal_error', error_details: { retry: false } };
const gatewayLegacy = { ...gateway, model_alias: 'legacy-example-model' };
const disconnected = { ...gateway, error_code: 'provider.connection_error', upstream_error_code: undefined, error_details: { retry: false, retry_exhausted: true } };
const expectedContinue = { hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } };
const expectedRetry = { hookSpecificOutput: { recovery: { action: 'retry' } } };
const matchingEvents = [input, inputCodelessSse];

for (const [name, event] of Object.entries({ missingTerminal: input, missingTerminalCodelessSse: inputCodelessSse })) {
  test(`chooses recovery for ${name} from retained partial output`, () => {
    assert.deepEqual(recoveryFor(event), expectedRetry);
    assert.deepEqual(recoveryFor({ ...event, has_partial_output: false }), expectedRetry);
    assert.deepEqual(recoveryFor({ ...event, has_partial_output: true }), expectedContinue);
    for (const attempts of [1, 2, undefined]) assert.equal(recoveryFor({ ...event, recovery_attempts: attempts }), undefined);
    assert.equal(recoveryFor({ ...event, recoverable: false }), undefined);
    assert.equal(recoveryFor({ ...event, hook_event_name: 'Stop' }), undefined);
  });
}

test('keeps deployment-specific model aliases disabled in the public build', () => {
  for (const event of [gateway, gatewayLegacy, disconnected]) {
    for (const model_alias of ['example-model', 'other-example-model', undefined]) {
      assert.equal(recoveryFor({ ...event, model_alias, error_message: 'example-model', profile_name: 'generic' }), undefined);
    }
  }
  assert.equal(recoveryFor({ ...disconnected, error_details: { retry: false } }), undefined);
});

test('does not guess from arbitrary messages or override an explicit non-matching upstream_error_code', () => {
  for (const code of ['antigravity_thinking_only', 'antigravity_empty_response', 'antigravity_max_tokens', 'antigravity_safety', 'antigravity_malformed_function_call', 'antigravity_malformed_response', 'antigravity_upstream_terminal_error', 'antigravity_stream_read_error', 'authentication_error', 'insufficient_quota']) {
    assert.equal(recoveryFor({ ...gateway, upstream_error_code: code, error_message: 'Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer.' }), undefined);
  }
  assert.equal(recoveryFor({ ...gateway, upstream_error_code: undefined, error_message: 'something mentioned antigravity_missing_terminal mid-sentence' }), undefined);
});

test('ships an installable dependency-free hook and exercises real stdin/stdout', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'argon-error-recovery');
  assert.equal(manifest.version, '0.3.0');
  assert.equal(pkg.version, manifest.version);
  assert.match(manifest.interface.displayName, /Unofficial/);
  assert.deepEqual(manifest.hooks, [{ event: 'StopFailure', command: 'node ./runtime.mjs', timeout: 5 }]);
  for (const event of matchingEvents) {
    for (const { event: inputEvent, expected } of [
      { event: { ...event, has_partial_output: true }, expected: expectedContinue },
      { event: { ...event, has_partial_output: false }, expected: expectedRetry },
      { event, expected: expectedRetry },
    ]) {
      const result = spawnSync(process.execPath, ['./runtime.mjs'], { cwd: root, input: JSON.stringify(inputEvent), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
  }
  for (const event of [{ ...gateway, recoverable: false }, { ...gateway, recovery_attempts: 1 }, { ...gateway, model_alias: 'example-model' }]) {
    const result = spawnSync(process.execPath, ['./runtime.mjs'], { cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});
