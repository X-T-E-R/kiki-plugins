import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAdb, phoneDataDir } from './environment.mjs';
import { upstreamEnvironment, runtimeInstalled, facadeRuntimeInstalled, preparePhone } from './prepare.mjs';
import { createPhoneFacade, loadPhoneMcpSdk, servePhoneFacade } from './mobile-facade.mjs';
import { nodeExecutable } from './node-executable.mjs';

const npxArgs = ['--yes', '--package=@mobilenext/mobile-mcp@1.0.13', '--package=mobilecli@1.0.21', 'mcp-server-mobile', '--stdio'];

export function mobileMcpCommand(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npx ${npxArgs.join(' ')}`] }
    : { command: 'npx', args: [...npxArgs] };
}

export async function launchMobileMcp() {
  const dataDir = phoneDataDir();
  const adb = await findAdb({ dataDir });
  const { command, args } = await runtimeInstalled(dataDir)
    ? { command: await nodeExecutable(), args: [resolve(dataDir, 'runtime/node_modules/@mobilenext/mobile-mcp/lib/index.js'), '--stdio'] }
    : mobileMcpCommand();
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env: upstreamEnvironment(adb, process.env, dataDir) });
  child.once('error', error => {
    console.error(`Cannot start Mobile MCP: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  return child;
}

export async function createCompactPhoneFacade({ dataDir = phoneDataDir(), prepare = true } = {}) {
  if (!(await facadeRuntimeInstalled(dataDir))) {
    if (!prepare) throw new Error('Run phone_prepare first to install the fixed Mobile MCP runtime.');
    const prepared = await preparePhone({ platform: 'ios' }, { dataDir });
    if (prepared.status === 'error' || !(await facadeRuntimeInstalled(dataDir))) throw new Error(prepared.message || 'Run phone_prepare to prepare the MCP runtime.');
  }
  const adb = await findAdb({ dataDir });
  const sdk = await loadPhoneMcpSdk(dataDir);
  return createPhoneFacade({
    validator: new sdk.AjvJsonSchemaValidator(),
    connect: async () => {
      const client = new sdk.Client({ name: 'kiki-phone', version: '0.1.1' });
      const transport = new sdk.StdioClientTransport({
        command: await nodeExecutable(), args: [resolve(dataDir, 'runtime/node_modules/@mobilenext/mobile-mcp/lib/index.js'), '--stdio'],
        env: upstreamEnvironment(adb, process.env, dataDir),
      });
      try { await client.connect(transport); return { client, transport }; }
      catch (error) { await client.close(); throw error; }
    },
  });
}

export async function launchCompactMobileMcp() {
  const dataDir = phoneDataDir();
  // Like the previous npx launcher, first connection prepares private packages.
  // The iOS preparation path installs runtime only: no ADB download or device I/O.
  if (!(await facadeRuntimeInstalled(dataDir))) {
    const prepared = await preparePhone({ platform: 'ios' });
    if (prepared.status === 'error' || !(await facadeRuntimeInstalled(dataDir))) throw new Error(prepared.message || 'Run phone_prepare to prepare the MCP runtime.');
  }
  const adb = await findAdb({ dataDir });
  const sdk = await loadPhoneMcpSdk(dataDir);
  const running = await servePhoneFacade({ sdk, upstream: {
    command: await nodeExecutable(), args: [resolve(dataDir, 'runtime/node_modules/@mobilenext/mobile-mcp/lib/index.js'), '--stdio'],
    env: upstreamEnvironment(adb, process.env, dataDir),
  } });
  const shutdown = () => { void running.close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.stdin.once('end', shutdown);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
  return running;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const launch = process.argv.includes('--raw') ? launchMobileMcp : launchCompactMobileMcp;
  launch().catch(error => { console.error(`Cannot start Mobile MCP: ${error.message}`); process.exitCode = 1; });
}
