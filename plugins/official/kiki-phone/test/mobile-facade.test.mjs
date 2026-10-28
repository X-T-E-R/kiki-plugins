import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createPhoneFacade, facadeTools } from '../lib/mobile-facade.mjs';

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const operations = [
  { name: 'mobile_list_available_devices', title: 'Devices', description: 'List devices.', inputSchema: schema({}) },
  { name: 'mobile_get_orientation', title: 'Orientation', description: 'Read orientation.', inputSchema: schema({ device: string }, ['device']) },
  { name: 'mobile_start_screen_recording', title: 'Start Recording', description: 'Start recording.', inputSchema: schema({ device: string }, ['device']) },
  { name: 'mobile_stop_screen_recording', title: 'Stop Recording', description: 'Stop recording.', inputSchema: schema({ device: string }, ['device']) },
  { name: 'mobile_allocate_remote_device', title: 'Allocate Remote', description: 'Requires explicit user request and cost authorization.', inputSchema: schema({ platform: { type: 'string', enum: ['android', 'ios'] } }, ['platform']) },
  { name: 'mobile_batch_commands', title: 'Batch', description: 'Run steps.', inputSchema: schema({ device: string, steps: { type: 'array', minItems: 1, items: schema({ name: string, arguments: { type: 'object' } }, ['name', 'arguments']) } }, ['device', 'steps']) },
];
const validator = { getValidator(json) {
  const parser = z.fromJSONSchema(json);
  return value => { const result = parser.safeParse(value); return { valid: result.success, errorMessage: result.error?.message }; };
} };
function setup(callTool = async params => ({ content: [{ type: 'text', text: params.name }] })) {
  let connections = 0, closed = 0;
  const calls = [];
  const facade = createPhoneFacade({ validator, connect: async () => {
    connections++;
    return { client: {
      async listTools({ cursor }) { return cursor ? { tools: operations.slice(3) } : { tools: operations.slice(0, 3), nextCursor: 'page2' }; },
      async callTool(params, _, options) { calls.push(params); return callTool(params, options); },
      async close() { closed++; },
    } };
  } });
  return { facade, calls, get connections() { return connections; }, get closed() { return closed; } };
}

test('compact discovery has two bounded schemas; help index omits operation schemas and full descriptions', async () => {
  assert.deepEqual(facadeTools.map(tool => tool.name), ['phone_help', 'phone_call']);
  assert.ok(Buffer.byteLength(JSON.stringify(facadeTools)) < 2000);
  const fixture = setup();
  assert.equal(fixture.connections, 0);
  const index = JSON.parse((await fixture.facade.execute('phone_help')).content[0].text);
  assert.equal(index.operations.length, operations.length);
  assert.ok(index.operations.every(item => Object.keys(item).every(key => ['name', 'title'].includes(key))));
  const filtered = JSON.parse((await fixture.facade.execute('phone_help', { query: 'recording' })).content[0].text);
  assert.deepEqual(filtered.operations.map(item => item.name), ['mobile_start_screen_recording', 'mobile_stop_screen_recording']);
  const exact = JSON.parse((await fixture.facade.execute('phone_help', { name: 'mobile_allocate_remote_device' })).content[0].text);
  assert.deepEqual(exact, operations[4]);
  assert.equal(fixture.calls.length, 0);
  await fixture.facade.close();
});

test('invalid names and operation schemas are rejected before side effects', async () => {
  const fixture = setup();
  for (const [name, args] of [
    ['mobile_get_orientation', { device: 'phone' }],
    ['phone_call', { name: 'invented', arguments: {} }],
    ['phone_call', { name: 'mobile_get_orientation', arguments: {} }],
    ['phone_call', { name: 'mobile_get_orientation', arguments: { device: 2 } }],
    ['phone_call', { name: 'mobile_get_orientation', arguments: { device: 'phone', surprise: true } }],
    ['phone_call', { name: 'mobile_batch_commands', arguments: { device: 'phone', steps: [] } }],
  ]) assert.equal((await fixture.facade.execute(name, args)).isError, true);
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.facade.execute('phone_call', { name: 'mobile_batch_commands', arguments: { device: 'phone', steps: [{ name: 'mobile_get_orientation', arguments: {} }] } })).isError, undefined);
  assert.equal(fixture.calls.length, 1);
  await fixture.facade.close();
});

test('MCP image, video resource, structured result and upstream errors pass through unchanged', async () => {
  for (const result of [
    { content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] },
    { content: [{ type: 'resource_link', uri: 'file:///mock/recording.mp4', name: 'recording.mp4', mimeType: 'video/mp4' }], structuredContent: { path: '/mock/recording.mp4' } },
    { isError: true, content: [{ type: 'text', text: 'Inspect the modifying outcome before retrying.' }] },
  ]) {
    const fixture = setup(async () => result);
    assert.strictEqual(await fixture.facade.execute('phone_call', { name: 'mobile_get_orientation', arguments: { device: 'phone' } }), result);
    assert.equal(fixture.calls.length, 1);
    await fixture.facade.close();
  }
});

test('one MCP connection retains recording and cloud ownership over a 120-second simulated idle gap', async () => {
  const clock = { now: 0 };
  let recording, remote;
  const fixture = setup(async params => {
    if (params.name === 'mobile_allocate_remote_device') remote = 'same-reservation';
    if (params.name === 'mobile_start_screen_recording') recording = clock.now;
    if (params.name === 'mobile_stop_screen_recording') return { content: [{ type: 'text', text: JSON.stringify({ elapsed: clock.now - recording, remote }) }] };
    return { content: [{ type: 'text', text: 'accepted' }] };
  });
  await fixture.facade.execute('phone_call', { name: 'mobile_allocate_remote_device', arguments: { platform: 'android' } });
  await fixture.facade.execute('phone_call', { name: 'mobile_start_screen_recording', arguments: { device: 'phone' } });
  clock.now += 120000;
  const result = await fixture.facade.execute('phone_call', { name: 'mobile_stop_screen_recording', arguments: { device: 'phone' } });
  assert.deepEqual(JSON.parse(result.content[0].text), { elapsed: 120000, remote: 'same-reservation' });
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.closed, 0);
  await fixture.facade.close();
  await fixture.facade.close();
  assert.equal(fixture.closed, 1);
  assert.equal((await fixture.facade.execute('phone_help')).isError, true);
});

test('cancellation forwards the original signal, never retries or drops the MCP connection', async () => {
  const controller = new AbortController();
  const fixture = setup(async (_, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    options.signal.throwIfAborted();
  });
  const result = await fixture.facade.execute('phone_call', { name: 'mobile_get_orientation', arguments: { device: 'phone' } }, { signal: controller.signal });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Observe the device/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.closed, 0);
  assert.equal((await fixture.facade.execute('phone_help')).isError, undefined);
  await fixture.facade.close();
});


test('batch ordering, stopOnError and per-step outcomes remain upstream-owned', async () => {
  const args = { device: 'phone', stopOnError: false, steps: [{ name: 'mobile_get_orientation', arguments: {} }, { name: 'upstream-invalid-step', arguments: {} }] };
  const batch = { ...operations[5], inputSchema: { ...operations[5].inputSchema, properties: { ...operations[5].inputSchema.properties, stopOnError: { type: 'boolean' } } } };
  let received;
  const result = { isError: true, content: [{ type: 'text', text: 'Step 1 completed; step 2 failed.' }] };
  const facade = createPhoneFacade({ validator, connect: async () => ({ client: {
    async listTools() { return { tools: [batch] }; },
    async callTool(params) { received = params.arguments; return result; },
    async close() {},
  } }) });
  assert.strictEqual(await facade.execute('phone_call', { name: batch.name, arguments: args }), result);
  assert.strictEqual(received, args);
  await facade.close();
});
