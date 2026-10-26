// Explicit integration smoke using the official MCP SDK, not a plugin runtime.
// Install the fixed packages and official SDK in ignored scratch directories.
// Usage: node scripts/smoke-upstream.mjs <upstream-root> <client-root> <scratch> <android-sdk-root>
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
const [upstreamRoot, clientRoot, scratchRoot, androidHome] = process.argv.slice(2).map(value => resolve(value));
if (!androidHome) throw new Error('Provide upstream, official client, scratch and Android SDK roots.');
await mkdir(scratchRoot, { recursive: true });
const { Client } = await import(pathToFileURL(join(clientRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(join(clientRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
const mcpRoot = join(upstreamRoot, 'node_modules/@mobilenext/mobile-mcp');
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const binaryName = `mobilecli-${platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
const mobilecli = join(upstreamRoot, `node_modules/@mobilenext/mobilecli-${platform}-${arch}`, binaryName);
const env = { ...process.env, ...manifest.mcpServers.mobile.env, MOBILECLI_HOME: join(scratchRoot, 'mc'), ANDROID_HOME: androidHome };
const before = await exec(mobilecli, ['daemon', 'status'], { env, encoding: 'utf8' });
assert.equal(JSON.parse(before.stdout).running, false, 'Use a fresh scratch directory; do not disturb an existing daemon.');
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(mcpRoot, 'lib/index.js'), '--stdio'],
  env, cwd: scratchRoot, stderr: 'pipe',
});
let stderr = '';
transport.stderr.on('data', value => { stderr += value; });
const client = new Client({ name: 'kiki-phone-upstream-smoke', version: '0.1.0' });
const evidence = { at: new Date().toISOString(), node: process.version,
  package: JSON.parse(await readFile(join(mcpRoot, 'package.json'), 'utf8')).version,
  mobilecliVersion: (await exec(mobilecli, ['--version'], { env, encoding: 'utf8' })).stdout.trim(),
  daemonBefore: JSON.parse(before.stdout),
};
try {
  await client.connect(transport);
  evidence.server = client.getServerVersion();
  evidence.capabilities = client.getServerCapabilities();
  const tools = await client.listTools();
  evidence.tools = tools.tools;
  assert.ok(tools.tools.some(tool => tool.name === 'mobile_list_available_devices'));
  assert.ok(tools.tools.some(tool => tool.name === 'mobile_start_screen_recording'));
  evidence.devices = await client.callTool({ name: 'mobile_list_available_devices', arguments: {} }, undefined, { timeout: 30_000 });
  assert.notEqual(evidence.devices.isError, true);
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await client.close();
  evidence.stderr = stderr;
  const stop = await exec(mobilecli, ['daemon', 'stop'], { env, encoding: 'utf8' });
  evidence.ownDaemonStop = stop.stdout.trim();
  evidence.daemonAfter = JSON.parse((await exec(mobilecli, ['daemon', 'status'], { env, encoding: 'utf8' })).stdout);
  await writeFile(join(scratchRoot, 'upstream-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ...evidence, tools: evidence.tools?.map(tool => tool.name) }, null, 2));
}
