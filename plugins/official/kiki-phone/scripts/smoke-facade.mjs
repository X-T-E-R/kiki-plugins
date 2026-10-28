// No device or service calls: discover fixed upstream schemas, then exercise the
// facade against a mock upstream through the official MCP SDK and real stdio.
// Usage: node scripts/smoke-facade.mjs <prepared-runtime-data> <sdk-package> <scratch>
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { facadeTools, createPhoneFacade } from '../lib/mobile-facade.mjs';
const [data, sdkPackage, scratch] = process.argv.slice(2).map(value => resolve(value));
if (!scratch) throw new Error('Provide upstream data, SDK package and isolated scratch directories.');
await mkdir(scratch, { recursive: true });
const sdkRoot = join(sdkPackage, 'dist/esm');
const sdkFiles = ['client/index.js', 'client/stdio.js', 'server/index.js', 'server/stdio.js', 'types.js', 'validation/ajv-provider.js'];
const sdk = Object.assign({}, ...await Promise.all(sdkFiles.map(file => import(pathToFileURL(join(sdkRoot, file))))));
const raw = new sdk.Client({ name: 'kiki-phone-schema-smoke', version: '0.1.0' });
const transport = new sdk.StdioClientTransport({ command: process.execPath,
  args: [join(data, 'runtime/node_modules/@mobilenext/mobile-mcp/lib/index.js'), '--stdio'],
  env: { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: '1', MOBILECLI_HOME: join(scratch, 'unused-mobilecli'), LOG_FILE: '', npm_config_ignore_scripts: 'true' }, stderr: 'pipe',
});
let stderr = '';
transport.stderr.on('data', value => { stderr += value; });
let tools;
try {
  await raw.connect(transport);
  tools = (await raw.listTools()).tools;
} finally { await raw.close(); }
assert.equal(tools.length, 33);
await writeFile(join(scratch, 'upstream-tools.json'), JSON.stringify(tools, null, 2) + '\n');

const validator = new sdk.AjvJsonSchemaValidator();
const forwarded = [];
const mock = { async listTools() { return { tools }; }, async callTool(params) { forwarded.push(params); return { content: [{ type: 'text', text: params.name }] }; }, async close() {} };
const facade = createPhoneFacade({ validator, connect: async () => ({ client: mock }) });
const index = JSON.parse((await facade.execute('phone_help')).content[0].text);
assert.deepEqual(index.operations.map(item => item.name), tools.map(item => item.name));
assert.ok(index.operations.every(item => !item.inputSchema && !item.description));
function example(schema) {
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf || schema.oneOf) return example((schema.anyOf || schema.oneOf)[0]);
  if (schema.type === 'object') return Object.fromEntries((schema.required || []).map(key => [key, example(schema.properties[key])]));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 1 }, () => example(schema.items));
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return false;
  return 'mock-phone';
}
for (const tool of tools) {
  const help = await facade.execute('phone_help', { name: tool.name });
  assert.deepEqual(JSON.parse(help.content[0].text), tool);
  const args = example(tool.inputSchema);
  if (tool.name === 'mobile_batch_commands') args.steps = [{ name: 'mobile_get_orientation', arguments: {} }];
  const call = await facade.execute('phone_call', { name: tool.name, arguments: args });
  assert.notEqual(call.isError, true, JSON.stringify(call));
  assert.equal(call.content[0].text, tool.name);
}
assert.equal(forwarded.length, 33);
const beforeInvalid = forwarded.length;
for (const args of [{ name: 'not_an_operation', arguments: {} }, { name: 'mobile_launch_app', arguments: { device: 'mock-phone' } }, { name: 'mobile_batch_commands', arguments: { device: 'mock-phone', steps: [] } }]) {
  assert.equal((await facade.execute('phone_call', args)).isError, true);
}
assert.equal(forwarded.length, beforeInvalid);
await facade.close();

// A real client connects to the production launcher. Only the inner upstream is
// replaced by a mock server, using fixed public request handlers and schemas.
const runtime = join(scratch, 'runtime/node_modules');
for (const [name, version] of [['@mobilenext/mobile-mcp', '1.0.13'], ['mobilecli', '1.0.21'], ['mobilewright', '0.0.67'], ['@modelcontextprotocol/sdk', '1.27.1']]) {
  const location = join(runtime, name);
  await mkdir(location, { recursive: true });
  await writeFile(join(location, 'package.json'), JSON.stringify({ version }));
}
// A junction/symlink would couple scratch lifetime to another owner's tree.
// The fixture imports the already-admitted SDK by absolute file URL instead.
await mkdir(join(runtime, '@modelcontextprotocol/sdk/dist/esm'), { recursive: true });
for (const file of sdkFiles) {
  const location = join(runtime, '@modelcontextprotocol/sdk/dist/esm', file);
  await mkdir(resolve(location, '..'), { recursive: true });
  const source = pathToFileURL(join(sdkRoot, file));
  await writeFile(location, `export * from ${JSON.stringify(source.href)};\n`);
}
await writeFile(join(runtime, '@modelcontextprotocol/sdk/package.json'), JSON.stringify({ version: '1.27.1', type: 'module' }));
const fixture = fileURLToPath(new URL('../test/fixtures/mock-mobile-server.mjs', import.meta.url));
const fixtureUrl = pathToFileURL(fixture).href;
await mkdir(join(runtime, '@mobilenext/mobile-mcp/lib'), { recursive: true });
await writeFile(join(runtime, '@mobilenext/mobile-mcp/lib/index.js'), `import(${JSON.stringify(fixtureUrl)});`);
const client = new sdk.Client({ name: 'kiki-phone-facade-consumer', version: '0.1.0' });
const facadeTransport = new sdk.StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../lib/launch-mobile-mcp.mjs', import.meta.url)), '--compact'],
  env: { ...process.env, KIKI_PHONE_DATA_DIR: scratch, KIKI_PHONE_MOCK_SDK: scratch, KIKI_PHONE_MOCK_TOOLS: join(scratch, 'upstream-tools.json'), KIKI_PHONE_MOCK_LIFECYCLE: join(scratch, 'lifecycle.json') }, stderr: 'pipe',
});
let bridgeStderr = '';
facadeTransport.stderr.on('data', value => { bridgeStderr += value; });
let wire;
try {
  await client.connect(facadeTransport);
  wire = (await client.listTools()).tools;
  assert.deepEqual(wire, facadeTools);
  assert.deepEqual((await client.callTool({ name: 'phone_call', arguments: { name: 'mobile_take_screenshot', arguments: { device: 'mock-phone' } } })).content,
    [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);
  const start = await client.callTool({ name: 'phone_call', arguments: { name: 'mobile_start_screen_recording', arguments: { device: 'mock-phone' } } });
  assert.equal(start.isError, undefined);
  // The fixture advances its upstream clock by 120 s without closing either MCP.
  const stop = await client.callTool({ name: 'phone_call', arguments: { name: 'mobile_stop_screen_recording', arguments: { device: 'mock-phone' } } });
  assert.deepEqual(stop.content, [{ type: 'resource_link', uri: 'file:///mock/recording.mp4', name: 'recording.mp4', mimeType: 'video/mp4' }, { type: 'text', text: 'recorded 120000ms' }]);
  const failed = await client.callTool({ name: 'phone_call', arguments: { name: 'mobile_launch_app', arguments: { device: 'mock-phone', packageName: 'mock.error' } } });
  assert.equal(failed.isError, true);
  const controller = new AbortController();
  const pending = client.callTool({ name: 'phone_call', arguments: { name: 'mobile_get_device_logs', arguments: { device: 'mock-phone' } } }, undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending);
  // A following read waits for the same connection; cancellation did not retry.
  assert.notEqual((await client.callTool({ name: 'phone_help', arguments: { name: 'mobile_get_device_logs' } })).isError, true);
} finally { await client.close(); }
const lifecycle = JSON.parse(await readFile(join(scratch, 'lifecycle.json'), 'utf8'));
assert.equal(lifecycle.connections, 1);
assert.equal(lifecycle.recordingElapsed, 120000);
assert.equal(lifecycle.logCalls, 1);
assert.equal(lifecycle.cancelled, true);
assert.equal(lifecycle.closed, true);
assert.throws(() => process.kill(lifecycle.pid, 0), /ESRCH|no such process|not found/i);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const schema = tool => ({ name: tool.name, description: tool.description || '', parameters: tool.inputSchema });
const evidence = { upstreamVersion: '1.0.13', sdkVersion: '1.27.1', upstreamCount: tools.length,
  facadeCount: wire.length, rawDefinitionBytes: bytes(tools), facadeDefinitionBytes: bytes(wire),
  rawSchemaBytes: bytes(tools.map(schema)), facadeSchemaBytes: bytes(wire.map(schema)),
  nativeCount: 4, forwardedMockOperations: forwarded.length, preciseHelpSchemas: tools.length,
  lifecycle, stderr, bridgeStderr };
await writeFile(join(scratch, 'facade-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
