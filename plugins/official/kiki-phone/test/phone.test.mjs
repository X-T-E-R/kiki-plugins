import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { mobileMcpCommand } from '../lib/launch-mobile-mcp.mjs';
import { definitions } from '../lib/definitions.mjs';
import { adbArguments, execAdb, runAdb } from '../lib/adb.mjs';
import { ensureMobilecliRuntimePatched, ensureMobilecliServer } from '../lib/mobilecli-server.mjs';
import { register, prepareOptions } from '../entry.mjs';
import { findAdb, mobileEnvironment } from '../lib/environment.mjs';
import { preparePhone, installOfficialTools } from '../lib/prepare.mjs';
import {
  attachPhoneConvenienceApis,
  buildHumanSwipeKeyframes,
  buildHumanTapKeyframes,
  createPhoneScriptRunner,
  executePhoneScript,
  parseAndroidScreenState,
  resolveDirectionEndpoints,
  sampleHumanDelayMs,
  samplePointInBox,
} from '../lib/phone-run.mjs';
import { nodeExecutable } from '../lib/node-executable.mjs';
import { packageFiles } from '../../../../scripts/package-files.mjs';
import './mobile-facade.test.mjs';
import './preview.test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
const businessPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('business package exports the reusable runtime without Kiki host entrypoints', () => {
  assert.equal(businessPackage.name, '@kiki/phone-business');
  assert.equal(businessPackage.version, manifest.version);
  assert.deepEqual(Object.keys(businessPackage.exports).sort(), ['./adb', './definitions', './environment', './guidance', './mobile-facade', './package.json', './phone-run', './prepare', './preview-service', './runtime', './scrcpy-stream', './skill', './slots']);
  assert.ok(!JSON.stringify(businessPackage).includes('entry.mjs'));
});

test('manifest retains exact native tools and selects only the compact MCP facade', async () => {
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  const registered = [];
  register({ registerTool(definition, execute) { registered.push(definition); assert.equal(typeof execute, 'function'); } });
  assert.deepEqual(registered, definitions);
  assert.deepEqual(manifest.mcpServers.mobile, {
    command: 'node',
    args: ['./lib/launch-mobile-mcp.mjs', '--compact'],
    cwd: './',
    env: { MOBILEMCP_DISABLE_TELEMETRY: '1', npm_config_ignore_scripts: 'true' },
  });
  const files = await packageFiles(root);
  for (const file of ['kimi.plugin.json', 'entry.mjs', 'panel.html', 'icon.svg', 'lib/adb.mjs', 'lib/definitions.mjs', 'lib/human-input.mjs', 'lib/launch-mobile-mcp.mjs', 'lib/mobile-facade.mjs', 'lib/environment.mjs', 'lib/prepare.mjs', 'lib/prepare-cli.mjs', 'lib/preview-service.mjs', 'lib/scrcpy-stream.mjs', 'lib/slots.mjs', 'lib/start.cmd', 'lib/phone-run.mjs', 'lib/node-executable.mjs', 'skills/phone-control/SKILL.md', 'skills/phone-control/references/anti-risk-control.md', 'skills/phone-control/agents/openai.yaml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => !file.startsWith('test/') && !file.includes('node_modules') && !file.includes('.cache')));
  for (const file of files) {
    const content = await readFile(resolve(root, file), 'utf8');
    assert.doesNotMatch(content, /C:\\Programs|C:\/Programs|C:\\Users|C:\/Users/);
    assert.doesNotMatch(content, /100%\s*\u514d\u75ab|\u96f6\u98ce\u63a7|zero\s+risk[- ]control|100%\s*immune/i);
  }
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
    const result = spawnSync(process.execPath, [join(root, 'lib/launch-mobile-mcp.mjs'), '--raw'], {
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
    const result = spawnSync(process.execPath, [join(root, 'lib/launch-mobile-mcp.mjs'), '--raw'], { env: { ...process.env, KIKI_PHONE_DATA_DIR: directory }, input: 'protocol-only\n', encoding: 'utf8', timeout: 5000 });
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

test('runner instances own worker serialization, data directory and disposal', async () => {
  const calls = [];
  const callbacks = [];
  const executeFile = (node, argv, options, callback) => {
    calls.push({ node, argv, options });
    callbacks.push(callback);
    return { stdin: { on() {}, end() {} } };
  };
  const runner = createPhoneScriptRunner({ executeFile, resolveNode: async () => 'node-fixture', dataDir: 'phone-data' });
  const first = runner.run({ script: 'first' });
  const overlap = await runner.run({ script: 'second' });
  assert.equal(overlap.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.KIKI_PHONE_DATA_DIR, 'phone-data');
  callbacks[0](null, JSON.stringify({ output: 'done' }), '');
  assert.deepEqual(await first, { output: 'done' });
  const running = runner.run({ script: 'third' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const closing = runner.close();
  assert.equal(calls[1].options.signal.aborted, true);
  callbacks[1](Object.assign(new Error('aborted'), { name: 'AbortError' }), '', '');
  assert.equal((await running).isError, true);
  await closing;
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

test('compact MCP SDK is installed privately at a fixed version without changing the legacy phone_run prerequisite', async () => {
  const directory = await scratch('facade-prepare-');
  const { pinnedPackages, runtimeInstalled, facadeRuntimeInstalled } = await import('../lib/prepare.mjs');
  try {
    for (const [name, version] of [['@mobilenext/mobile-mcp', '1.0.13'], ['mobilecli', '1.0.21'], ['mobilewright', '0.0.67']]) {
      const location = join(directory, 'runtime/node_modules', name);
      await mkdir(location, { recursive: true });
      await writeFile(join(location, 'package.json'), JSON.stringify({ version }));
    }
    assert.equal(await runtimeInstalled(directory), true);
    assert.equal(await facadeRuntimeInstalled(directory), false);
    const calls = [];
    const result = await preparePhone({ platform: 'ios' }, { dataDir: directory, execute: async (file, argv, options) => {
      calls.push(argv);
      if (argv.includes('install') || argv.some(value => value.includes('npm install'))) {
        assert.equal(options.cwd, join(directory, 'runtime'));
        assert.equal(options.env.npm_config_ignore_scripts, 'true');
        for (const pinned of pinnedPackages) assert.ok(argv.join(' ').includes(pinned));
        assert.ok(argv.join(' ').includes('--save-exact'));
        assert.ok(argv.join(' ').includes('--ignore-scripts'));
        assert.ok(!argv.includes('--global'));
        const location = join(directory, 'runtime/node_modules/@modelcontextprotocol/sdk');
        await mkdir(location, { recursive: true });
        await writeFile(join(location, 'package.json'), JSON.stringify({ version: '1.27.1' }));
      }
      return { stdout: '11.16.0', stderr: '' };
    } });
    assert.equal(result.runtimeInstalled, true);
    assert.equal(await facadeRuntimeInstalled(directory), true);
    assert.equal(calls.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Android power and lockscreen helpers wake, swipe-unlock unsecured keyguard, respect PIN lock, sleep, and expose screen.typeText', async () => {
  const directory = await scratch('power-helpers-');
  const adbCalls = [];
  const typed = [];
  const pressedKeys = [];
  const swipes = [];
  let awake = false;
  let showing = true;
  let secure = false;
  let dismissClearsShowing = false;

  const executeAdb = async (_adb, argv) => {
    adbCalls.push(argv);
    const shellCmd = argv.slice(3).join(' ');
    if (shellCmd === 'dumpsys power') {
      return { stdout: `  mWakefulness=${awake ? 'Awake' : 'Asleep'}\n`, stderr: '' };
    }
    if (shellCmd === 'dumpsys window policy') {
      return {
        stdout: `    KeyguardServiceDelegate\n      showing=${showing}\n      occluded=false\n      secure=${secure}\n`,
        stderr: '',
      };
    }
    if (shellCmd === 'wm size') {
      return { stdout: 'Physical size: 1440x3200\nOverride size: 1080x2400\n', stderr: '' };
    }
    if (shellCmd === 'input keyevent 224') {
      awake = true;
      return { stdout: '', stderr: '' };
    }
    if (shellCmd === 'input keyevent 223') {
      awake = false;
      showing = true;
      return { stdout: '', stderr: '' };
    }
    if (shellCmd === 'wm dismiss-keyguard') {
      if (dismissClearsShowing && !secure) showing = false;
      return { stdout: '', stderr: '' };
    }
    if (shellCmd.startsWith('input swipe ')) {
      if (!secure) showing = false;
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const driverModule = {
    MobilecliDriver: class {
      async listDevices() { return [{ id: 'android-1', state: 'online' }]; }
      async dispose() {}
    },
  };
  const sdk = {
    expect: v => v,
    async connectDevice() {
      return {
        driver: {
          async typeText(text) { typed.push(text); },
          async pressKeys(keys) { pressedKeys.push(keys); },
          async call(method, params) { if (method === 'device.io.swipe') swipes.push(params); },
        },
        async close() {},
        screen: {
          async viewTree() { return []; },
          async swipe(direction, opts) { swipes.push({ direction, opts }); },
          async screenshot() { return Buffer.from('png'); },
        },
      };
    },
  };

  try {
    const parsed = parseAndroidScreenState({
      power: '  mWakefulness=Awake\n',
      policy: '  KeyguardServiceDelegate\n    showing=true\n    occluded=false\n    secure=false\n',
      wmSize: 'Physical size: 1440x3200\nOverride size: 1080x2400\n',
    });
    assert.deepEqual(parsed, {
      awake: true,
      wakefulness: 'Awake',
      locked: true,
      showing: true,
      occluded: false,
      secure: false,
      width: 1080,
      height: 2400,
    });

    const support = { dataDir: directory, sdk, driverModule, executeAdb, delay: async () => {} };
    const wakeRun = await executePhoneScript({
      script: "const before = await device.screenState(); const after = await device.wake(); await screen.typeText('报到', { submit: true }); await screen.swipe(600, 1900, 600, 1100, 300); const silentShot = await screenshot({ attach: false, path: '/tmp/out.png' }); const slept = await device.sleep(); return { before, after, slept, silentShot };",
    }, {}, support);
    assert.notEqual(wakeRun.isError, true);
    assert.equal(wakeRun.output.some(part => part.type === 'image_url'), false);
    const payload = JSON.parse(wakeRun.output[0].text).result;
    assert.equal(payload.before.awake, false);
    assert.equal(payload.before.locked, true);
    assert.equal(payload.after.awake, true);
    assert.equal(payload.after.locked, false);
    assert.equal(payload.slept.awake, false);
    assert.equal(payload.silentShot.path, '/tmp/out.png');
    assert.deepEqual(typed, ['报到']);
    assert.deepEqual(pressedKeys, [['ENTER']]);
    assert.deepEqual(swipes, [{ x1: 600, y1: 1900, x2: 600, y2: 1100, duration: 300 }]);
    assert.ok(adbCalls.some(argv => argv.slice(3).join(' ') === 'input swipe 540 1968 540 600 200'));

    // Secure PIN lockscreen should not swipe blindly and device.unlock() should report actionable error
    awake = false;
    showing = true;
    secure = true;
    adbCalls.length = 0;
    const secureWake = await executePhoneScript({
      script: 'return await device.wake();',
    }, {}, support);
    assert.notEqual(secureWake.isError, true);
    const secureState = JSON.parse(secureWake.output[0].text).result;
    assert.equal(secureState.awake, true);
    assert.equal(secureState.locked, true);
    assert.equal(secureState.secure, true);
    assert.equal(secureState.reason, 'secure_keyguard');
    assert.ok(!adbCalls.some(argv => argv.slice(3).join(' ').startsWith('input swipe ')));

    const secureUnlock = await executePhoneScript({
      script: 'return await device.unlock();',
    }, {}, support);
    assert.equal(secureUnlock.isError, true);
    assert.match(secureUnlock.output[0].text, /PIN\/password\/pattern/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createDeterministicRng(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

test('human-input pure primitives enforce safe-core Gaussian bounds, 55-125ms tap dwell, and non-collinear Bezier swipes', () => {
  const rng = createDeterministicRng(42);
  const box = { x: 100, y: 200, width: 200, height: 100 };
  const xs = new Set();
  const ys = new Set();
  for (let i = 0; i < 400; i++) {
    const pt = samplePointInBox(box, { rng });
    assert.ok(pt.x >= 156 && pt.x <= 244, `x=${pt.x} outside central 44% core [156,244]`);
    assert.ok(pt.y >= 228 && pt.y <= 272, `y=${pt.y} outside central 44% core [228,272]`);
    xs.add(pt.x);
    ys.add(pt.y);
  }
  assert.ok(xs.size > 5 && ys.size > 5, 'samplePointInBox must produce non-zero spatial entropy');
  // Extreme tail draws still clamp strictly inside safe core
  const tailValues = [1e-9, 0.999999999, 1e-9, 0.00001];
  let idx = 0;
  const extremePt = samplePointInBox(box, { rng: () => tailValues[idx++ % tailValues.length] });
  assert.ok(extremePt.x >= 156 && extremePt.x <= 244);
  assert.ok(extremePt.y >= 228 && extremePt.y <= 272);
  assert.deepEqual(samplePointInBox({ x: 50, y: 80, width: 2, height: 2 }, { rng }), { x: 51, y: 81 });

  for (let i = 0; i < 200; i++) {
    const tap = buildHumanTapKeyframes({ x: 540, y: 1200 }, { rng });
    assert.ok(tap.holdMs >= 55 && tap.holdMs <= 125, `holdMs=${tap.holdMs} outside [55,125]`);
    assert.equal(tap.points.length, 2);
    assert.equal(tap.points[0].time, 0);
    assert.equal(tap.points[1].time, tap.holdMs);
    assert.ok(Math.abs(tap.points[1].x - tap.points[0].x) <= 1);
    assert.ok(Math.abs(tap.points[1].y - tap.points[0].y) <= 1);
  }

  const swipe = buildHumanSwipeKeyframes(560, 1820, 540, 780, { rng });
  assert.ok(swipe.durationMs >= 180 && swipe.durationMs <= 720);
  assert.ok(swipe.points.length >= 7 && swipe.points.length <= 13);
  for (let i = 1; i < swipe.points.length; i++) {
    assert.ok(swipe.points[i].time > swipe.points[i - 1].time, 'Swipe timestamps must strictly increase');
  }
  assert.equal(swipe.points.at(-1).time, swipe.durationMs);
  // Verify non-collinearity against chord (sx, sy) -> (ex, ey) and non-uniform inter-frame dt
  const chordDx = swipe.x2 - swipe.x1;
  const chordDy = swipe.y2 - swipe.y1;
  const chordLen = Math.hypot(chordDx, chordDy);
  const maxPerpDist = Math.max(
    ...swipe.points.slice(1, -1).map(p => Math.abs((p.x - swipe.x1) * chordDy - (p.y - swipe.y1) * chordDx) / chordLen),
  );
  assert.ok(maxPerpDist > 15, `Expected curved Bezier arch > 15px perpendicular deviation, got ${maxPerpDist}`);
  const dts = swipe.points.slice(1).map((p, i) => p.time - swipe.points[i].time);
  assert.ok(new Set(dts).size > 1, `Expected non-uniform inter-frame dt jitter, got ${JSON.stringify(dts)}`);

  // Wide full-row container caps horizontal spread via maxOffsetPx so right-edge steppers/icons stay untouched
  for (let i = 0; i < 100; i++) {
    const widePt = samplePointInBox({ x: 0, y: 800, width: 1080, height: 140 }, { maxOffsetPx: 52, rng });
    assert.ok(widePt.x >= 488 && widePt.x <= 592, `wide row x=${widePt.x} exceeded +-52px center cap`);
  }

  for (const dir of ['up', 'down', 'left', 'right']) {
    const ep = resolveDirectionEndpoints(dir, { width: 1080, height: 2400, rng });
    assert.ok(Number.isFinite(ep.x1) && Number.isFinite(ep.y1) && Number.isFinite(ep.x2) && Number.isFinite(ep.y2));
  }
  assert.throws(() => resolveDirectionEndpoints('diagonal', { rng }), /Unsupported swipe direction/);

  const delays = Array.from({ length: 300 }, () => sampleHumanDelayMs(400, 1400, rng));
  assert.ok(delays.every(ms => ms >= 400 && ms <= 1400));
  const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
  assert.ok(avgDelay < 900, `Right-skewed human delay mean (${avgDelay}) should sit below midpoint 900`);
});

test('humanTap, humanSwipe, humanDelay and ensureCleanIme wire gesture replay, fallbacks and IME recovery', async () => {
  const rng = createDeterministicRng(7);
  const gestures = [];
  const delays = [];
  const adbCommands = [];
  let currentIme = 'com.android.adbkeyboard/.AdbIME';
  let imeList = 'com.android.adbkeyboard/.AdbIME\ncom.iflytek.inputmethod.miui/.FlyIME\n';
  let viewTreeCalls = 0;

  const executeAdb = async (_adb, argv) => {
    const cmd = argv.slice(3).join(' ');
    adbCommands.push(cmd);
    if (cmd === 'settings get secure default_input_method') return { stdout: `${currentIme}\n`, stderr: '' };
    if (cmd === 'ime list -s') return { stdout: imeList, stderr: '' };
    if (cmd.startsWith('ime set ')) {
      currentIme = cmd.slice('ime set '.length).trim();
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const device = {
    async screenSize() { return { width: 1080, height: 2400, scale: 3 }; },
  };
  const screen = {
    async viewTree() { viewTreeCalls++; return []; },
    async gesture(seq) { gestures.push(seq); },
  };
  attachPhoneConvenienceApis(device, screen, {
    platform: 'android',
    serial: 'test-serial',
    adbBinary: 'adb',
    executeAdb,
    delay: async (ms) => { delays.push(ms); },
    rng,
  });

  // 1. Tier S box tap & directional swipe via screen.gesture without calling viewTree()
  const tapBoxRes = await screen.humanTap({ x: 200, y: 300, width: 400, height: 120 });
  assert.ok(tapBoxRes.x >= 312 && tapBoxRes.x <= 488);
  assert.ok(tapBoxRes.y >= 334 && tapBoxRes.y <= 386);
  assert.ok(tapBoxRes.holdMs >= 55 && tapBoxRes.holdMs <= 125);
  assert.equal(viewTreeCalls, 0);
  assert.equal(gestures.length, 1);
  assert.equal(gestures[0].pointers[0].length, 2);

  // 2. Locator tap resolves boundingBox once
  let bboxCalls = 0;
  const fakeLocator = {
    async boundingBox(opts) {
      bboxCalls++;
      assert.equal(opts?.timeout, 2500);
      return { x: 700, y: 2100, width: 300, height: 100 };
    },
  };
  const tapLocRes = await screen.humanTap(fakeLocator, { timeout: 2500 });
  assert.equal(bboxCalls, 1);
  assert.ok(tapLocRes.x >= 784 && tapLocRes.x <= 916);

  // 3. Coordinate tap + humanSwipe + humanDelay
  const tapCoordRes = await screen.humanTap(500, 900, { jitterPx: 4 });
  assert.ok(Math.abs(tapCoordRes.x - 500) <= 4 && Math.abs(tapCoordRes.y - 900) <= 4);
  const swipeRes = await screen.humanSwipe('up', { durationMs: 360 });
  assert.equal(swipeRes.durationMs, 360);
  assert.ok(swipeRes.steps >= 6 && swipeRes.steps <= 12);
  assert.equal(gestures.at(-1).pointers[0].length, swipeRes.steps + 1);
  const waited = await device.humanDelay(300, 500);
  assert.ok(waited >= 300 && waited <= 500);
  assert.deepEqual(delays, [waited]);

  // 4. ensureCleanIme recovers from AdbIME and is idempotent afterward
  const cleaned = await device.ensureCleanIme();
  assert.deepEqual(cleaned, {
    changed: true,
    previous: 'com.android.adbkeyboard/.AdbIME',
    restored: 'com.iflytek.inputmethod.miui/.FlyIME',
  });
  assert.ok(adbCommands.includes('ime set com.iflytek.inputmethod.miui/.FlyIME'));
  assert.ok(adbCommands.includes('ime disable com.android.adbkeyboard/.AdbIME'));
  const secondClean = await device.ensureCleanIme();
  assert.deepEqual(secondClean, { changed: false, current: 'com.iflytek.inputmethod.miui/.FlyIME' });

  // 5. Fallback paths when screen.gesture is unavailable (Android ADB / driver.call swipe & iOS tap)
  const driverSwipes = [];
  const androidNoGestureDevice = {};
  const androidNoGestureScreen = {
    async swipe() {},
  };
  adbCommands.length = 0;
  attachPhoneConvenienceApis(androidNoGestureDevice, androidNoGestureScreen, {
    platform: 'android',
    serial: 'fallback-serial',
    adbBinary: 'adb',
    executeAdb,
    delay: async () => {},
    rng,
  });
  const fbTap = await androidNoGestureScreen.humanTap({ x: 100, y: 100, width: 100, height: 100 }, { holdMs: 80 });
  assert.equal(fbTap.holdMs, 80);
  const fbSwipe = await androidNoGestureScreen.humanSwipe(500, 1700, 500, 800, 400);
  assert.equal(fbSwipe.durationMs, 400);
  assert.equal(adbCommands.length, 2);
  assert.match(adbCommands[0], /^input swipe \d+ \d+ \d+ \d+ 80$/);
  assert.match(adbCommands[1], /^input swipe \d+ \d+ \d+ \d+ 400$/);

  const driverFallbackDevice = {
    driver: { async call(method, params) { if (method === 'device.io.swipe') driverSwipes.push(params); } },
  };
  const driverFallbackScreen = { async swipe() {} };
  attachPhoneConvenienceApis(driverFallbackDevice, driverFallbackScreen, {
    platform: 'android',
    serial: 'driver-fallback',
    executeAdb,
    delay: async () => {},
    rng,
  });
  await driverFallbackScreen.humanSwipe(520, 1750, 520, 820, 380);
  assert.equal(driverSwipes.length, 1);
  assert.equal(driverSwipes[0].duration, 380);

  const iosTaps = [];
  const iosDevice = {};
  const iosScreen = { async tap(x, y) { iosTaps.push({ x, y }); } };
  attachPhoneConvenienceApis(iosDevice, iosScreen, { platform: 'ios', delay: async () => {}, rng });
  await iosScreen.humanTap(180, 320, { jitterPx: 0 });
  assert.deepEqual(iosTaps, [{ x: 180, y: 320 }]);
  assert.deepEqual(await iosDevice.ensureCleanIme(), { changed: false });
});

test('screen.tap, screen.swipe and locator.tap default to humanized gesture trajectories and honor { raw: true } and KIKI_PHONE_RAW_INPUT=1', async () => {
  const rng = createDeterministicRng(2026);
  const rawTaps = [];
  const rawSwipes = [];
  const driverSwipes = [];
  const gestures = [];

  class FakeLocator {
    constructor(driver, bounds) {
      this.driver = driver;
      this.bounds = bounds;
    }
    child(bounds) {
      return new FakeLocator(this.driver, bounds);
    }
    async _step(_title, fn) {
      return fn();
    }
    async resolveActionable() {
      return { bounds: this.bounds, isVisible: true, isEnabled: true };
    }
    async tap() {
      const cx = Math.round(this.bounds.x + this.bounds.width / 2);
      const cy = Math.round(this.bounds.y + this.bounds.height / 2);
      await this.driver.tap(cx, cy);
    }
  }

  const sharedDriver = {
    async tap(x, y) { rawTaps.push({ x, y }); },
    async call(method, params) { if (method === 'device.io.swipe') driverSwipes.push(params); },
  };
  const device = {
    driver: sharedDriver,
    async screenSize() { return { width: 1080, height: 2400, scale: 3 }; },
  };
  const rootLocator = new FakeLocator(sharedDriver, { x: 0, y: 0, width: 1080, height: 2400 });
  const screen = {
    driver: sharedDriver,
    root: rootLocator,
    getByText() {
      return rootLocator.child({ x: 0, y: 900, width: 1080, height: 140 });
    },
    async tap(x, y) { rawTaps.push({ x, y }); },
    async swipe(direction, opts) { rawSwipes.push({ direction, opts }); },
    async gesture(seq) { gestures.push(seq); },
  };

  const env = {};
  attachPhoneConvenienceApis(device, screen, {
    platform: 'android',
    serial: 'auto-human-serial',
    rng,
    env,
  });

  // 1. Default screen.tap(x, y) routes to 2-frame humanized gesture with +-4px jitter
  const tapRes = await screen.tap(540, 1200);
  assert.equal(rawTaps.length, 0);
  assert.equal(gestures.length, 1);
  assert.equal(gestures[0].pointers[0].length, 2);
  assert.ok(Math.abs(tapRes.x - 540) <= 4 && Math.abs(tapRes.y - 1200) <= 4);
  assert.ok(tapRes.holdMs >= 55 && tapRes.holdMs <= 125);

  // 2. Default screen.swipe('up') and tuple screen.swipe(x1,y1,x2,y2,dur) route to curved Bezier gestures
  await screen.swipe('up');
  assert.equal(rawSwipes.length, 0);
  assert.equal(gestures.length, 2);
  assert.ok(gestures[1].pointers[0].length >= 7);

  await screen.swipe(540, 1850, 540, 750, 340);
  assert.equal(driverSwipes.length, 0);
  assert.equal(gestures.length, 3);
  assert.equal(gestures[2].pointers[0].at(-1).time, 340);

  // 3. Default locator.tap() resolves bounds and taps within wide-row safe core via gesture
  await screen.getByText('显示').tap();
  assert.equal(rawTaps.length, 0);
  assert.equal(gestures.length, 4);
  const locTapPt = gestures[3].pointers[0][0];
  assert.ok(locTapPt.x >= 488 && locTapPt.x <= 592, `locator tap x=${locTapPt.x} outside +-52px safe center cap`);
  assert.ok(locTapPt.y >= 939 && locTapPt.y <= 1001);

  // 4. { raw: true } per-call escape hatch bypasses humanization cleanly
  await screen.tap(540, 1200, { raw: true });
  assert.deepEqual(rawTaps, [{ x: 540, y: 1200 }]);
  await screen.swipe('up', { distance: 500, raw: true });
  assert.deepEqual(rawSwipes, [{ direction: 'up', opts: { distance: 500 } }]);
  await screen.swipe(600, 1900, 600, 1100, 300, { raw: true });
  assert.deepEqual(driverSwipes, [{ x1: 600, y1: 1900, x2: 600, y2: 1100, duration: 300 }]);
  await screen.getByText('显示').tap({ raw: true });
  assert.deepEqual(rawTaps.at(-1), { x: 540, y: 970 });
  assert.equal(gestures.length, 4);

  // 5. KIKI_PHONE_RAW_INPUT=1 environment toggle forces raw behavior globally
  env.KIKI_PHONE_RAW_INPUT = '1';
  await screen.tap(320, 640);
  await screen.swipe('down');
  await screen.getByText('显示').tap();
  assert.equal(gestures.length, 4);
  assert.deepEqual(rawTaps.slice(-2), [{ x: 320, y: 640 }, { x: 540, y: 970 }]);
  assert.equal(rawSwipes.at(-1).direction, 'down');
});

test('P0-5: execAdb resolves in <200ms even when a child spawns a long-lived grandchild inheriting stdout/stderr', async () => {
  // Spawn a child node process that spawns a detached background grandchild inheriting stdio pipes,
  // prints the grandchild PID on stdout, and immediately exits.
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: ['ignore', 1, 2], detached: true, windowsHide: true });",
    "gc.unref();",
    "process.stdout.write('PID:' + gc.pid + '\\n');",
    "process.stderr.write('warn-line\\n');",
  ].join(' ');

  const t0 = performance.now();
  const { stdout, stderr } = await execAdb(process.execPath, ['-e', childScript], {
    timeout: 5_000,
    drainGraceMs: 40,
    skipStartServer: true,
  });
  const elapsedMs = performance.now() - t0;

  const pidMatch = stdout.match(/PID:(\d+)/);
  assert.ok(pidMatch, `expected grandchild PID in stdout, got: ${JSON.stringify(stdout)}`);
  const grandchildPid = Number(pidMatch[1]);
  try {
    assert.ok(elapsedMs < 200, `execAdb hung on inherited grandchild pipe: took ${elapsedMs.toFixed(1)}ms`);
    assert.match(stderr, /warn-line/);
  } finally {
    try { process.kill(grandchildPid); } catch {}
  }
});

test('P0-4: ensureMobilecliServer spawns with windowsHide:true + error handler and ensureMobilecliRuntimePatched patches server.js & driver.js', async () => {
  const { EventEmitter } = await import('node:events');
  const spawned = [];
  let probeCount = 0;

  const started = await ensureMobilecliServer({
    binaryPath: '/mock/mobilecli.exe',
    port: 12991,
    pollIntervalMs: 10,
    checkReachable: async () => {
      probeCount += 1;
      return probeCount >= 3;
    },
    spawnProcess: (file, args, opts) => {
      spawned.push({ file, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 0;
      proc.exitCode = null;
      proc.killed = false;
      proc.unref = () => {};
      proc.kill = () => {
        proc.killed = true;
        proc.exitCode = 0;
        proc.emit('exit', 0);
      };
      return proc;
    },
  });

  try {
    assert.equal(started.started, true);
    assert.equal(started.url, 'ws://localhost:12991/ws');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].opts.windowsHide, true);
    assert.deepEqual(spawned[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(started.serverProcess.process.listenerCount('error') >= 1);
  } finally {
    await started.serverProcess.kill();
  }

  // Spawn error must reject cleanly rather than throwing uncaughtException
  await assert.rejects(
    () => ensureMobilecliServer({
      binaryPath: '/nonexistent/mobilecli.exe',
      port: 12992,
      pollIntervalMs: 10,
      checkReachable: async () => false,
      spawnProcess: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => {};
        queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return proc;
      },
    }),
    /Failed to spawn mobilecli server/,
  );

  // Runtime patcher idempotently injects windowsHide: true into upstream server.js & driver.js
  const dir = await scratch('patch-mobilecli-');
  try {
    const dist = join(dir, 'runtime/node_modules/@mobilewright/driver-mobilecli/dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'server.js'), [
      "const proc = spawn(binary, serverArgs, {",
      "    stdio: 'pipe',",
      "    detached: false,",
      "});",
    ].join('\n'));
    await writeFile(join(dist, 'driver.js'), [
      "const statusOutput = execFileSync(binary, ['agent', 'status'], { encoding: 'utf8' });",
      "const output = execFileSync(binary, ['devices'], { encoding: 'utf8' });",
    ].join('\n'));

    const first = await ensureMobilecliRuntimePatched(dir);
    assert.deepEqual(first, { serverPatched: true, driverPatched: true });
    const patchedServer = await readFile(join(dist, 'server.js'), 'utf8');
    const patchedDriver = await readFile(join(dist, 'driver.js'), 'utf8');
    assert.match(patchedServer, /windowsHide:\s*true/);
    assert.match(patchedServer, /proc\.on\('error'/);
    assert.match(patchedDriver, /windowsHide:\s*true/);

    const second = await ensureMobilecliRuntimePatched(dir);
    assert.deepEqual(second, { serverPatched: false, driverPatched: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
