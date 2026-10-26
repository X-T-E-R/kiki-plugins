import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { mobileMcpCommand } from '../lib/launch-mobile-mcp.mjs';
import { definitions } from '../lib/definitions.mjs';
import { adbArguments, runAdb } from '../lib/adb.mjs';
import { register, prepareOptions } from '../entry.mjs';
import { findAdb, mobileEnvironment } from '../lib/environment.mjs';
import { preparePhone, installOfficialTools } from '../lib/prepare.mjs';
import { executePhoneScript } from '../lib/phone-run.mjs';
import { nodeExecutable } from '../lib/node-executable.mjs';
import { packageFiles } from '../../../../scripts/package-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));

test('manifest declares the exact registered tools and the complete fixed upstream MCP', async () => {
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  const registered = [];
  register({ registerTool(definition, execute) { registered.push(definition); assert.equal(typeof execute, 'function'); } });
  assert.deepEqual(registered, definitions);
  assert.deepEqual(manifest.mcpServers.mobile, {
    command: 'node',
    args: ['./lib/launch-mobile-mcp.mjs'],
    cwd: './',
    env: { MOBILEMCP_DISABLE_TELEMETRY: '1', npm_config_ignore_scripts: 'true' },
  });
  const files = await packageFiles(root);
  for (const file of ['kimi.plugin.json', 'entry.mjs', 'lib/adb.mjs', 'lib/definitions.mjs', 'lib/launch-mobile-mcp.mjs', 'lib/environment.mjs', 'lib/prepare.mjs', 'lib/prepare-cli.mjs', 'lib/start.cmd', 'lib/phone-run.mjs', 'lib/node-executable.mjs', 'skills/phone-control/SKILL.md', 'skills/phone-control/agents/openai.yaml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => !file.startsWith('test/') && !file.includes('node_modules') && !file.includes('.cache')));
  for (const file of files) assert.doesNotMatch(await readFile(resolve(root, file), 'utf8'), /C:\\Programs|C:\/Programs|C:\\Users|C:\/Users/);
});

test('settings match the strict Host contribution shape, not arbitrary JSON Schema', () => {
  // Host contributions.ts settingsContributionSchema allows only these schema
  // keys. parseManifest was also exercised against the production Host.
  assert.equal(manifest['x-kiki'].settings.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest['x-kiki'].settings.schema).sort(), ['properties', 'type']);
  assert.deepEqual(Object.keys(manifest['x-kiki'].settings.schema.properties), ['adbPath']);
  assert.equal(manifest['x-kiki'].settings.schema.properties.adbPath.type, 'string');
  assert.deepEqual(Object.keys(manifest['x-kiki'].tools.find(tool => tool.name === 'phone_prepare').parameters.properties).sort(), ['download', 'platform']);
  assert.deepEqual(prepareOptions({ download: true, platform: 'android', adbPath: '/untrusted/other.exe' }, { adbPath: '/user/adb' }), { download: true, platform: 'android', adbPath: '/user/adb' });
  assert.equal(prepareOptions({ adbPath: '/untrusted/other.exe' }, {}).adbPath, undefined);
  for (const definition of definitions) assert.equal(definition.parameters.additionalProperties, false);
});

test('connection operations keep addresses and pairing codes in distinct argv', () => {
  assert.deepEqual(adbArguments('android_connection', { action: 'devices' }), ['devices', '-l']);
  assert.deepEqual(adbArguments('android_connection', { action: 'pair', address: '192.168.1.8:37123', code: '012345' }), ['pair', '192.168.1.8:37123', '012345']);
  assert.deepEqual(adbArguments('android_connection', { action: 'connect', address: '192.168.1.8:41755' }), ['connect', '192.168.1.8:41755']);
  assert.deepEqual(adbArguments('android_connection', { action: 'disconnect', address: '192.168.1.8:41755' }), ['disconnect', '192.168.1.8:41755']);
  assert.throws(() => adbArguments('android_connection', { action: 'disconnect' }), /address/);
  assert.throws(() => adbArguments('android_connection', { action: 'pair', address: 'host:1' }), /code/);
  assert.throws(() => adbArguments('android_connection', { action: 'connect', address: '--help' }), /must not start/);
});

test('shell argv quotes literals at the Android shell and su layers', () => {
  assert.deepEqual(adbArguments('android_shell', { serial: '192.168.1.8:41755', argv: ['id'] }), ['-s', '192.168.1.8:41755', 'shell', "'id'"]);
  assert.deepEqual(adbArguments('android_shell', { serial: 'USB1', argv: ['id'], root: true }), ['-s', 'USB1', 'shell', "su -c ''\\''id'\\'''"]);
  const original = ['printf', '%s\\n', "中文 path/it's here", '$(echo MUST_NOT_EXECUTE); x & y', '', 'line1\nline2'];
  for (const root of [false, true]) {
    const command = adbArguments('android_shell', { serial: 'USB1', argv: original, root }).at(-1);
    // Run the device-shell command with a local shell only in this test. Fake su
    // evaluates exactly its -c argument; no privileged process is involved.
    const program = `su() { [ "$1" = '-c' ] || exit 9; sh -c "$2"; }; ${command}`;
    const actual = execFileSync('sh', ['-c', program], { encoding: 'utf8' });
    assert.equal(actual, original.slice(2).map(value => `${value}\n`).join(''));
  }
});

test('ADB path with spaces, signal and original authorization output are preserved', async () => {
  const controller = new AbortController();
  let calls = 0;
  const output = 'List of devices attached\nUSB1 unauthorized usb:1\nUSB2 offline\n';
  const result = await runAdb('android_connection', { action: 'devices' }, {
    settings: { adbPath: 'C:/Android SDK/platform-tools/adb.exe' }, signal: controller.signal,
  }, async (file, argv, options) => {
    calls++;
    assert.equal(file, 'C:/Android SDK/platform-tools/adb.exe');
    assert.deepEqual(argv, ['devices', '-l']);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.shell, undefined);
    return { stdout: output, stderr: 'adb diagnostic\n' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(result.output), { exitCode: 0, stdout: output, stderr: 'adb diagnostic\n' });
});

test('missing executable returns actionable real ENOENT', async () => {
  const result = await runAdb('android_connection', { action: 'devices' }, { settings: { adbPath: resolve(root, 'missing-adb-test-binary') } });
  assert.equal(result.isError, true);
  const error = JSON.parse(result.output);
  assert.equal(error.code, 'ENOENT');
  assert.match(error.message, /platform-tools/);
});

test('nonzero exit preserves stderr/stdout, does not retry or echo pairing code', async () => {
  let calls = 0;
  const result = await runAdb('android_connection', { action: 'pair', address: 'host:1', code: '012345' }, {}, async () => {
    calls++;
    throw Object.assign(new Error('Command failed: adb pair host:1 012345'), { code: 1, stdout: 'pairing failed\n', stderr: 'adb: connection refused\n' });
  });
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  const error = JSON.parse(result.output);
  assert.equal(error.exitCode, 1);
  assert.equal(error.stdout, 'pairing failed\n');
  assert.equal(error.stderr, 'adb: connection refused\n');
  assert.doesNotMatch(result.output, /012345/);
});

test('cancellation and timeout return interrupted state without retry', async () => {
  for (const failure of [Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }), Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' })]) {
    let calls = 0;
    const result = await runAdb('android_shell', { serial: 'USB1', argv: ['id'] }, {}, async () => { calls++; throw failure; });
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.output).message, /interrupted; inspect device state/);
  }
});

test('already cancelled actual child process is cancelled', async () => {
  const signal = AbortSignal.abort();
  const result = await runAdb('android_connection', { action: 'devices' }, { signal, settings: { adbPath: process.execPath } });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.output).message, /interrupted/);
});

const pinnedNpxArgs = ['--yes', '--package=@mobilenext/mobile-mcp@1.0.13', '--package=mobilecli@1.0.21', 'mcp-server-mobile', '--stdio'];

test('launcher uses Windows cmd for the shim and direct npx elsewhere, with fixed argv', () => {
  assert.deepEqual(mobileMcpCommand('win32', { ComSpec: 'C:/Windows/System32/cmd.exe' }), {
    command: 'C:/Windows/System32/cmd.exe', args: ['/d', '/s', '/c', 'npx --yes --package=@mobilenext/mobile-mcp@1.0.13 --package=mobilecli@1.0.21 mcp-server-mobile --stdio'],
  });
  assert.equal(mobileMcpCommand('win32', {}).command, 'cmd.exe');
  for (const platform of ['darwin', 'linux']) assert.deepEqual(mobileMcpCommand(platform, {}), { command: 'npx', args: pinnedNpxArgs });
});

test('actual launcher inherits stdin/stdout/stderr and policies, propagates child exit', async () => {
  const temporary = resolve(root, '../../../.tmp/phone-launch');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'shim space-'));
  const fixture = fileURLToPath(new URL('./fixtures/npx.mjs', import.meta.url));
  try {
    if (process.platform === 'win32') {
      await writeFile(join(directory, 'npx.cmd'), `@echo off\r\n@"${process.execPath}" "${fixture}" %*\r\n`);
    } else {
      await writeFile(join(directory, 'npx'), '#!/usr/bin/env node\n' + await readFile(fixture, 'utf8'), { mode: 0o755 });
    }
    const input = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"text":"中文"}}\n';
    const result = spawnSync(process.execPath, [join(root, 'lib/launch-mobile-mcp.mjs')], {
      cwd: directory, encoding: 'utf8', input, timeout: 10_000,
      env: { ...process.env, ...manifest.mcpServers.mobile.env, KIKI_PHONE_DATA_DIR: join(directory, 'data'), PATH: directory + delimiter + process.env.PATH, KIKI_PHONE_FIXTURE_EXIT_CODE: '23' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 23);
    assert.equal(result.stderr.trim(), 'upstream fixture stderr');
    assert.deepEqual(JSON.parse(result.stdout), {
      args: pinnedNpxArgs, input, telemetry: '1', ignoreScripts: 'true', cache: join(directory, 'data', 'npm-cache'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(name) {
  const parent = resolve(root, '../../../.tmp/phone-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, name));
}

test('one-step preparation reports real transport states and saves one shared ADB', async () => {
  const directory = await scratch('prepare-');
  const adb = join(directory, 'sdk', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  await mkdir(join(directory, 'sdk', 'platform-tools'), { recursive: true });
  await writeFile(adb, 'fixture', { mode: 0o755 });
  const env = { PATH: '', LOCALAPPDATA: directory, KIKI_PHONE_DATA_DIR: directory };
  try {
    for (const [row, expected] of [['USB1 device model:example', 'transport_ready'], ['USB1 unauthorized', 'authorization_required'], ['USB1 offline', 'device_offline'], ['', 'no_device']]) {
      const calls = [];
      const result = await preparePhone({ adbPath: adb, warmup: false }, { dataDir: directory, env, execute: async (file, args, options) => {
        calls.push({ file, args });
        if (file !== adb) return { stdout: '11.16.0\n', stderr: '' };
        if (args[0] === 'version') return { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.1\n', stderr: '' };
        assert.equal(options.env.ANDROID_HOME, join(directory, 'sdk'));
        return { stdout: `List of devices attached\n${row}\n`, stderr: '' };
      } });
      assert.equal(result.status, expected);
      assert.equal(result.mcp.connected, false);
      assert.equal(result.adb.path, adb);
      assert.equal(await findAdb({ dataDir: directory, env }), adb);
      assert.equal(mobileEnvironment(adb, env).ANDROID_HOME, join(directory, 'sdk'));
      assert.deepEqual(calls.filter(call => call.file === adb).map(call => call.args), [['version'], ['devices', '-l']]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing ADB asks for download consent; outdated Node and missing npm report errors', async () => {
  const directory = await scratch('missing-');
  const env = { PATH: '', LOCALAPPDATA: directory, KIKI_PHONE_DATA_DIR: directory };
  try {
    const support = { env, dataDir: directory, execute: async () => ({ stdout: '11.16.0', stderr: '' }) };
    assert.equal((await preparePhone({}, support)).status, 'download_consent_required');
    assert.match((await preparePhone({}, { ...support, nodeVersion: '20.0.0' })).message, /22.12.0/);
    const missing = await preparePhone({}, { ...support, execute: async () => { throw Object.assign(new Error('npm not found'), { code: 'ENOENT' }); } });
    assert.equal(missing.status, 'error');
    assert.equal(missing.code, 'ENOENT');
    let fetched = false;
    await assert.rejects(() => installOfficialTools({ consent: false, dataDir: directory, fetchArchive: async () => { fetched = true; } }), /consent/);
    assert.equal(fetched, false);
    await assert.rejects(() => installOfficialTools({ consent: true, dataDir: directory, fetchArchive: async () => ({ ok: false, status: 503 }) }), /503/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('iOS preparation does not require or invoke Android ADB', async () => {
  const directory = await scratch('ios-');
  try {
    const result = await preparePhone({ platform: 'ios', warmup: false }, { dataDir: directory, execute: async (file, args) => {
      assert.ok(args.join(' ').includes('--version'));
      return { stdout: '11.16.0', stderr: '' };
    } });
    assert.equal(result.status, 'runtime_ready');
    assert.equal(result.adb, undefined);
    assert.equal(result.mcp.connected, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('semantic script delegates to Mobilewright, preserves snapshot values, returns image and remembers device', async () => {
  const directory = await scratch('script-');
  const calls = [];
  const deepInput = { type: 'miuix.androidbasewidget.widget.ClearableEditText', id: 'search', label: 'Search', text: '深层搜索', value: '你好\n第二行' };
  const tree = [{ type: 'Root', children: [{ type: 'Panel', children: [{ type: 'List', children: [deepInput, ...Array.from({ length: 150 }, (_, index) => ({ type: 'Text', id: `item-${index}`, text: `条目${index}`, value: index === 149 ? '长值'.repeat(6000) + '完整末尾' : '' }))] }] }] }];
  let devices = [{ id: 'one', state: 'online' }, { id: 'two', state: 'online' }];
  const driverModule = { MobilecliDriver: class { async listDevices() { return devices; } async dispose() { calls.push('dispose'); } } };
  const sdk = { expect: value => ({ async toBeVisible() { calls.push(['expect', value]); } }), async connectDevice({ deviceId }) {
    calls.push(['connect', deviceId]);
    return { async close() { calls.push('close'); }, async launchApp(id) { calls.push(['launch', id]); }, screen: {
      getByText(text) { return { async tap() { calls.push(['tap', text]); }, async fill(value) { calls.push(['fill', value]); } }; },
      async viewTree() { return tree; }, async screenshot(options) { assert.equal(options.format, 'png'); return Buffer.from('image fixture'); },
    } };
  } };
  try {
    const support = { dataDir: directory, sdk, driverModule };
    const ambiguous = await executePhoneScript({ script: 'throw new Error("must not execute")' }, {}, support);
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.output, /Choose one/);
    const result = await executePhoneScript({ device: 'two', script: "await device.launchApp('com.android.settings'); await screen.getByText('Search').tap(); await screen.getByText('Search').fill('你好\\n第二行'); console.log(await snapshot()); await screenshot(); return 'observed';" }, {}, support);
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls.filter(call => Array.isArray(call) && ['tap', 'fill'].includes(call[0])), [['tap', 'Search'], ['fill', '你好\n第二行']]);
    const printedTree = result.output[1].text;
    for (const value of ['ClearableEditText', "id: 'search'", '深层搜索', '第二行', 'item-149', '条目149', '长值'.repeat(6000) + '完整末尾']) assert.ok(printedTree.includes(value), `Full snapshot should include ${value.slice(0, 32)}`);
    assert.doesNotMatch(printedTree, /\[Object\]|\[Array\]|more items|characters omitted/);
    assert.ok(result.output.some(part => part.type === 'image_url' && part.imageUrl.url.startsWith('data:image/png;base64,')));
    const next = await executePhoneScript({ script: 'console.log(await snapshot());' }, {}, support);
    assert.equal(JSON.parse(next.output[0].text).device, 'two');
    const connectedBeforeOffline = calls.filter(call => Array.isArray(call) && call[0] === 'connect').length;
    devices = [{ id: 'one', state: 'online' }];
    const offline = await executePhoneScript({ script: 'throw new Error("must not execute")' }, {}, support);
    assert.equal(offline.isError, true);
    assert.equal(JSON.parse(offline.output).selected, 'two');
    assert.match(offline.output, /Selected device two is not online/);
    assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'connect').length, connectedBeforeOffline);
    const selection = await executePhoneScript({ device: 'one' }, {}, support);
    assert.equal(JSON.parse(selection.output).selected, 'one');
    const selectedRound = await executePhoneScript({ script: "return 'new explicit target';" }, {}, support);
    assert.equal(JSON.parse(selectedRound.output[0].text).device, 'one');
    devices = [];
    const gone = await executePhoneScript({ script: 'throw new Error("must not execute")' }, {}, support);
    assert.equal(gone.isError, true);
    assert.match(gone.output, /not online/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('prepared runtime launcher uses local fixed entry with pure stdout and shared ADB', async () => {
  const directory = await scratch('prepared-launch-');
  try {
    for (const [name, version] of [['@mobilenext/mobile-mcp', '1.0.13'], ['mobilecli', '1.0.21'], ['mobilewright', '0.0.67']]) {
      const location = join(directory, 'runtime', 'node_modules', name);
      await mkdir(location, { recursive: true });
      await writeFile(join(location, 'package.json'), JSON.stringify({ version, type: 'module' }));
    }
    const entry = join(directory, 'runtime/node_modules/@mobilenext/mobile-mcp/lib');
    await mkdir(entry);
    await writeFile(join(entry, 'index.js'), "let input=''; for await (const chunk of process.stdin) input+=chunk; process.stdout.write(JSON.stringify({input,adb:process.env.ANDROID_HOME,cache:process.env.npm_config_cache,node:process.execPath}));");
    const sdk = join(directory, 'sdk');
    const binary = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    await mkdir(join(sdk, 'platform-tools'), { recursive: true });
    await writeFile(binary, 'fixture', { mode: 0o755 });
    await writeFile(join(directory, 'adb.json'), JSON.stringify({ adbPath: binary }));
    const result = spawnSync(process.execPath, [join(root, 'lib/launch-mobile-mcp.mjs')], { env: { ...process.env, KIKI_PHONE_DATA_DIR: directory }, input: 'protocol-only\n', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { input: 'protocol-only\n', adb: sdk, cache: join(directory, 'npm-cache'), node: process.execPath });
    const simulatedSea = spawnSync(process.execPath, [join(root, 'test/fixtures/fake-sea.mjs'), 'mcp'], {
      env: { ...process.env, KIKI_PHONE_DATA_DIR: directory, KIKI_PHONE_FAKE_EXEC_PATH: join(directory, 'kiki.exe'), PATH: dirname(process.execPath) + delimiter + (process.env.PATH || '') },
      input: 'protocol-only\n', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(simulatedSea.error, undefined);
    assert.equal(simulatedSea.status, 0, simulatedSea.stderr);
    assert.equal(simulatedSea.stderr, '');
    assert.deepEqual(JSON.parse(simulatedSea.stdout), { input: 'protocol-only\n', adb: sdk, cache: join(directory, 'npm-cache'), node: process.execPath });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('phone worker returns missing runtime and cancellation without starting a device', async () => {
  const directory = await scratch('worker-');
  const previous = process.env.KIKI_PHONE_DATA_DIR;
  process.env.KIKI_PHONE_DATA_DIR = directory;
  try {
    const { runPhoneScript } = await import('../lib/phone-run.mjs');
    const missing = await runPhoneScript({ script: 'throw new Error("must not execute")' });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.output), /phone_prepare/);
    const cancelled = await runPhoneScript({ script: 'throw new Error("must not execute")' }, { signal: AbortSignal.abort() });
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.output, /interrupted/);
  } finally {
    if (previous === undefined) delete process.env.KIKI_PHONE_DATA_DIR; else process.env.KIKI_PHONE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual worker bridge returns script text/images and cancels a running isolated script', async () => {
  const directory = await scratch('worker-bridge-');
  const previous = process.env.KIKI_PHONE_DATA_DIR;
  process.env.KIKI_PHONE_DATA_DIR = directory;
  try {
    for (const [name, version] of [['@mobilenext/mobile-mcp', '1.0.13'], ['mobilecli', '1.0.21'], ['mobilewright', '0.0.67'], ['@mobilewright/driver-mobilecli', '0.0.67']]) {
      const location = join(directory, 'runtime/node_modules', name);
      await mkdir(join(location, 'dist'), { recursive: true });
      await writeFile(join(location, 'package.json'), JSON.stringify({ version, type: 'module' }));
    }
    await writeFile(join(directory, 'runtime/node_modules/@mobilewright/driver-mobilecli/dist/index.js'), "export class MobilecliDriver { async listDevices() { return [{id:'fixture-phone',state:'online'}]; } async dispose() {} }");
    await writeFile(join(directory, 'runtime/node_modules/mobilewright/dist/index.js'), "export const expect = value => value; export async function connectDevice() { return { async close() {}, screen: { async viewTree() { return [{type:'CustomInput',id:'search',label:'搜索',value:'你好'}]; }, async screenshot() { return Buffer.from('fixture-image'); } } }; }");
    const { runPhoneScript } = await import('../lib/phone-run.mjs');
    const result = await runPhoneScript({ script: 'console.log(await snapshot()); await screenshot(); return "observed";' });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.output[0].text).device, 'fixture-phone');
    assert.ok(result.output.some(part => part.type === 'text' && part.text.includes('CustomInput') && part.text.includes('你好')));
    assert.deepEqual(result.output.find(part => part.type === 'image_url'), { type: 'image_url', imageUrl: { url: 'data:image/png;base64,' + Buffer.from('fixture-image').toString('base64') } });
    const simulatedSea = spawnSync(process.execPath, [join(root, 'test/fixtures/fake-sea.mjs'), 'worker'], {
      env: { ...process.env, KIKI_PHONE_DATA_DIR: directory, KIKI_PHONE_FAKE_EXEC_PATH: join(directory, 'kiki.exe'), PATH: dirname(process.execPath) + delimiter + (process.env.PATH || '') },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(simulatedSea.error, undefined);
    assert.equal(simulatedSea.status, 0, simulatedSea.stderr);
    const workerResult = JSON.parse(simulatedSea.stdout);
    assert.notEqual(workerResult.isError, true);
    assert.equal(JSON.parse(workerResult.output[0].text).result, process.execPath);
    const controller = new AbortController();
    const running = runPhoneScript({ script: 'await new Promise(resolve => setTimeout(resolve, 60_000));' }, { signal: controller.signal });
    const overlap = await runPhoneScript({ script: 'throw new Error("must not run concurrently")' });
    assert.equal(overlap.isError, true);
    assert.match(overlap.output, /already running/);
    const timer = setTimeout(() => controller.abort(), 300);
    const cancelled = await running;
    clearTimeout(timer);
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.output, /interrupted/);
  } finally {
    if (previous === undefined) delete process.env.KIKI_PHONE_DATA_DIR; else process.env.KIKI_PHONE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('external Node resolver reuses native Node and reports missing packaged-host Node', async () => {
  const directory = await scratch('node-path-');
  try {
    assert.equal(await nodeExecutable({ execPath: process.execPath, env: { PATH: '' } }), process.execPath);
    const resolved = await nodeExecutable({ execPath: join(directory, 'kiki.exe'), env: { PATH: dirname(process.execPath) } });
    assert.equal(resolved, process.execPath);
    await assert.rejects(nodeExecutable({ execPath: join(directory, 'kiki.exe'), env: { PATH: directory } }), /Node.js 22.12.0\+.*PATH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only user settings or direct CLI ADB may be saved after successful version check', async () => {
  const directory = await scratch('adb-origin-');
  const valid = join(directory, 'sdk', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const impostor = join(directory, 'other', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const saved = join(directory, 'adb.json');
  await mkdir(join(directory, 'sdk', 'platform-tools'), { recursive: true });
  await mkdir(join(directory, 'other'), { recursive: true });
  await writeFile(valid, 'fixture');
  await writeFile(impostor, 'fixture');
  await writeFile(saved, JSON.stringify({ adbPath: '/previous/user/adb' }));
  const env = { PATH: '', LOCALAPPDATA: directory, KIKI_PHONE_DATA_DIR: directory };
  const calls = [];
  let invalidExit = false;
  const execute = async (file, argv) => {
    calls.push([file, ...argv]);
    if (file === impostor) {
      if (invalidExit) throw Object.assign(new Error('exited 7'), { code: 7, stdout: 'Android Debug Bridge version 1.0.41', stderr: 'failed' });
      return { stdout: 'Node.js v24.22.1\n', stderr: '' };
    }
    if (file === valid) return argv[0] === 'version'
      ? { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.1\n', stderr: '' }
      : { stdout: 'List of devices attached\n\n', stderr: '' };
    return { stdout: '11.16.0\n', stderr: '' };
  };
  const support = { dataDir: directory, env, execute };
  try {
    const rejected = await preparePhone({ adbPath: impostor, warmup: false }, support);
    assert.equal(rejected.status, 'error');
    assert.match(rejected.message, /did not report an Android Debug Bridge version/);
    assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), { adbPath: '/previous/user/adb' });
    assert.deepEqual(calls.filter(call => call[0] === impostor), [[impostor, 'version']]);
    invalidExit = true;
    assert.equal((await preparePhone({ adbPath: impostor, warmup: false }, support)).status, 'error');
    assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), { adbPath: '/previous/user/adb' });
    const fromSettings = await preparePhone({ ...prepareOptions({ adbPath: impostor }, { adbPath: valid }), warmup: false }, support);
    assert.equal(fromSettings.status, 'no_device');
    assert.equal(fromSettings.adb.path, valid);
    assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), { adbPath: valid });
    const directCli = await preparePhone({ adbPath: valid, warmup: false }, support);
    assert.equal(directCli.status, 'no_device');
    assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), { adbPath: valid });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
