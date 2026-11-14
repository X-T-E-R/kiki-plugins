import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardMailDigest } from '../lib/im.mjs';

const revision = 'ab'.repeat(32);

function bridge() {
  const calls = [];
  return {
    calls,
    async capabilities() { return { outbound: true, inbound: false }; },
    async listRoutes() { return [{ channelId: 'telegram:desk', providerId: 'telegram', label: 'Desk', routeRevision: revision }]; },
    async send(request) { calls.push(request); return { status: 'accepted', retryable: false }; },
  };
}

function input(text, extra = {}) {
  return {
    enabled: true,
    channelId: 'telegram:desk',
    routeRevision: revision,
    accountRef: 'ada',
    idempotencyKey: extra.idempotencyKey || 'digest-key',
    text,
    ...extra,
  };
}

test('digest send keeps the public fields and the 16384-byte boundary', async () => {
  const signal = new AbortController().signal;
  const host = bridge();
  const exact = await forwardMailDigest(host, input('a'.repeat(16384), { idempotencyKey: 'exact-bytes' }), signal);
  assert.equal(exact.status, 'accepted');
  assert.deepEqual(Object.keys(host.calls[0]).sort(), ['accountRef', 'channelId', 'idempotencyKey', 'routeRevision', 'text']);
  assert.equal(host.calls[0].pluginId, undefined);
  assert.equal(Buffer.byteLength(host.calls[0].text), 16384);

  const over = await forwardMailDigest(host, input(`${'é'.repeat(8192)}x`, { idempotencyKey: 'over-bytes' }), signal);
  assert.equal(over.diagnosticCode, 'too_long');
  assert.equal(over.errorKind, 'too_long');
  assert.equal(over.retryable, true);
  assert.equal(over.sent, false);
  assert.equal(host.calls.length, 1);
  const again = await forwardMailDigest(host, input(`${'é'.repeat(8192)}x`, { idempotencyKey: 'over-bytes' }), signal);
  assert.equal(again.diagnosticCode, 'too_long');
  assert.equal(again.duplicate, undefined);
  assert.equal(host.calls.length, 1);

  const shorter = await forwardMailDigest(host, input('shorter notice', { idempotencyKey: 'over-bytes' }), signal);
  assert.equal(shorter.status, 'accepted');
  assert.equal(host.calls.length, 2);
  assert.equal(host.calls[1].text, 'shorter notice');

  const blank = await forwardMailDigest(host, input(' \n\t ', { idempotencyKey: 'blank' }), signal);
  assert.equal(blank.diagnosticCode, 'bad_format');
  assert.equal(blank.retryable, true);
  assert.equal(blank.sent, false);
  assert.equal(host.calls.length, 2);
});
