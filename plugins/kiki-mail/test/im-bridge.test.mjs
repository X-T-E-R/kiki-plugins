import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { forwardMailDigest, inspectIm, summaryText } from '../lib/im.mjs';
import { idempotencyKey, messageIdentity } from '../lib/identity.mjs';

const revision = 'ab'.repeat(32);
const otherRevision = 'cd'.repeat(32);

function signal() {
  return new AbortController().signal;
}

function bridge(hooks = {}) {
  const calls = { capabilities: 0, listRoutes: 0, send: [] };
  return {
    calls,
    async capabilities(current) {
      calls.capabilities += 1;
      if (current?.aborted) throw new Error('cancelled');
      return hooks.capabilities ? hooks.capabilities(calls.capabilities) : { outbound: true, inbound: false };
    },
    async listRoutes(current) {
      calls.listRoutes += 1;
      if (current?.aborted) throw new Error('cancelled');
      return hooks.listRoutes ? hooks.listRoutes() : [{
        channelId: 'telegram:desk', providerId: 'telegram', label: 'Desk', routeRevision: revision, botToken: 'secret-token',
      }];
    },
    async send(request, current) {
      calls.send.push(structuredClone(request));
      if (current?.aborted) return { status: 'cancelled', retryable: false, diagnosticCode: 'cancelled' };
      return hooks.send ? hooks.send(request, calls.send.length) : { status: 'accepted', retryable: false };
    },
  };
}

function input(extra = {}) {
  const identity = messageIdentity(extra.accountRef || 'ada', 'INBOX', '7', extra.uid || '4');
  return {
    enabled: true,
    channelId: 'telegram:desk',
    routeRevision: revision,
    accountRef: identity.accountId,
    idempotencyKey: extra.idempotencyKey || idempotencyKey(identity),
    text: extra.text || 'New mail · Ada\nSubject: Ping',
    ...extra,
  };
}

test('old host omits im and mail state stays usable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-im-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const service = mailServiceForTests();
  const counts = bridge();
  const context = {
    settings,
    dataDir: dir,
    userHome: dir,
    kikiHome: dir,
    signal: signal(),
    async updateSettings(patch) { Object.assign(settings, patch); },
    onActivity() {},
    focusSession() {},
  };
  try {
    const activated = await service.activate(context);
    assert.equal(activated.imBridge.probed, false);
    assert.equal(counts.calls.capabilities, 0);
    const present = mailServiceForTests();
    const seen = bridge();
    await present.activate({ ...context, im: seen, dataDir: dir });
    assert.equal(seen.calls.capabilities, 0);
    assert.equal(seen.calls.listRoutes, 0);
    assert.equal(seen.calls.send.length, 0);
    await present.deactivate();
    const state = await service.panel('state', {}, context);
    assert.equal(state.ok, true);
    assert.equal(state.imBridge.supported, false);
    assert.equal(state.imBridge.reason, 'unsupported');
    assert.equal(state.imBridge.inbound, false);
    const routes = await service.panel('routes', {}, context);
    assert.equal(routes.supported, false);
    assert.equal(routes.routes.length, 0);
    const skipped = await forwardMailDigest(undefined, input(), signal());
    assert.equal(skipped.diagnosticCode, 'im_unsupported');
    assert.equal(skipped.sent, false);
  } finally {
    await service.deactivate();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forwarding off, outbound false, and an empty route list stay distinct', async () => {
  const off = bridge();
  const disabled = await forwardMailDigest(off, input({ enabled: false, uid: '20' }), signal());
  assert.equal(disabled.reason, 'disabled');
  assert.equal(off.calls.send.length, 0);

  let probes = 0;
  const late = bridge({
    capabilities(count) {
      probes = count;
      return { outbound: count > 1, inbound: true };
    },
  });
  const early = await forwardMailDigest(late, input({ uid: '21' }), signal());
  assert.equal(early.diagnosticCode, 'im_unsupported');
  assert.equal(late.calls.send.length, 0);
  const ready = await forwardMailDigest(late, input({ uid: '21' }), signal());
  assert.equal(ready.status, 'accepted');
  assert.equal(late.calls.send.length, 1);
  assert.equal(probes, 2);
  const viewed = await inspectIm(late, signal(), { list: true });
  assert.equal(viewed.inbound, false);
  assert.equal(viewed.outbound, true);

  const quiet = bridge({
    capabilities() { return { outbound: true, inbound: false }; },
    listRoutes() { return []; },
  });
  const listed = await inspectIm(quiet, signal(), { list: true });
  assert.equal(listed.reason, 'no-route');
  const down = await inspectIm(bridge({ capabilities() { return { outbound: false, inbound: false }; } }), signal());
  assert.equal(down.reason, 'outbound-unavailable');
  assert.notEqual(listed.reason, down.reason);
});

test('send uses a listed route and does not repeat accepted or unknown results', async () => {
  const host = bridge();
  const first = await forwardMailDigest(host, input({ uid: '30', text: `Hello\u0000 there ${'x'.repeat(3000)}` }), signal());
  assert.equal(first.status, 'accepted');
  assert.equal(first.attempts, 1);
  assert.equal(host.calls.send.length, 1);
  const request = host.calls.send[0];
  assert.equal(request.channelId, 'telegram:desk');
  assert.equal(request.routeRevision, revision);
  assert.equal(request.accountRef, 'ada');
  assert.equal(request.sessionId, undefined);
  assert.equal(request.text.includes('\u0000'), false);
  assert.equal(request.pluginId, undefined);
  assert.equal(Buffer.byteLength(request.text) <= 16384, true);
  assert.equal(request.text.length > 2000, true);
  assert.equal(request.idempotencyKey.includes(revision), false);
  assert.equal(request.idempotencyKey.includes(request.text), false);
  assert.match(request.idempotencyKey, /^[A-Za-z0-9_.:-]{1,200}$/);
  const again = await forwardMailDigest(host, input({ uid: '30' }), signal());
  assert.equal(again.duplicate, true);
  assert.equal(host.calls.send.length, 1);

  const unknown = bridge({
    send() { return { status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' }; },
  });
  const unclear = await forwardMailDigest(unknown, input({ uid: '31' }), signal());
  assert.equal(unclear.status, 'unknown');
  assert.equal(unclear.attempts, 1);
  const lookup = await forwardMailDigest(unknown, input({ uid: '31' }), signal());
  assert.equal(lookup.duplicate, true);
  assert.equal(unknown.calls.send.length, 1);
});

test('timeout looks up the same key once, and a changed route is not retargeted', async () => {
  let attempts = 0;
  const timed = bridge({
    send() {
      attempts += 1;
      if (attempts === 1) throw new Error('IM bridge timed out');
      return { status: 'accepted', retryable: false };
    },
  });
  const looked = await forwardMailDigest(timed, input({ uid: '40' }), signal());
  assert.equal(looked.status, 'accepted');
  assert.equal(looked.lookedUp, true);
  assert.equal(timed.calls.send.length, 2);
  assert.equal(timed.calls.send[0].idempotencyKey, timed.calls.send[1].idempotencyKey);
  assert.equal(timed.calls.send[0].text, timed.calls.send[1].text);
  const third = await forwardMailDigest(timed, input({ uid: '40' }), signal());
  assert.equal(third.duplicate, true);
  assert.equal(timed.calls.send.length, 2);

  const moved = bridge({
    send() { return { status: 'failed', retryable: false, diagnosticCode: 'route_changed', errorKind: 'configuration' }; },
    listRoutes() { return [{ channelId: 'telegram:other', providerId: 'telegram', label: 'Other', routeRevision: otherRevision }]; },
  });
  const changed = await forwardMailDigest(moved, input({ uid: '41' }), signal());
  assert.equal(changed.diagnosticCode, 'route_changed');
  assert.equal(changed.resent, false);
  assert.equal(changed.attempts, 1);
  assert.equal(moved.calls.send.length, 1);
  assert.equal(moved.calls.send[0].channelId, 'telegram:desk');
  assert.equal(moved.calls.send[0].routeRevision, revision);
  assert.equal(changed.routes[0].channelId, 'telegram:other');
  assert.equal(changed.routes[0].routeRevision, otherRevision);
  assert.equal(changed.routes[0].botToken, undefined);
});

test('the same key under two mail accounts is sent separately, and routes expose labels only', async () => {
  const host = bridge();
  const key = 'shared-message-key';
  const ada = await forwardMailDigest(host, input({ accountRef: 'ada', idempotencyKey: key, uid: '50' }), signal());
  const bea = await forwardMailDigest(host, input({ accountRef: 'bea', idempotencyKey: key, uid: '50' }), signal());
  assert.equal(ada.status, 'accepted');
  assert.equal(bea.status, 'accepted');
  assert.equal(host.calls.send.length, 2);
  assert.deepEqual(host.calls.send.map((item) => item.accountRef), ['ada', 'bea']);
  const listed = await inspectIm(host, signal(), { list: true });
  assert.equal(listed.routes[0].label, 'Desk');
  assert.equal(listed.routes[0].botToken, undefined);
  assert.equal(JSON.stringify(listed).includes('secret-token'), false);
  const identity = messageIdentity('ada', 'INBOX', '7', '50');
  const summary = summaryText({ accountId: 'ada', mailbox: 'INBOX', from: 'bea@example.test', subject: 'Ping', identity });
  assert.equal(summary.includes('secret-token'), false);
  assert.equal(Buffer.byteLength(summary) <= 16384, true);
});
