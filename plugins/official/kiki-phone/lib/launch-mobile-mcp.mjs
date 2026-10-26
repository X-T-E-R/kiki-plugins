import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAdb, phoneDataDir } from './environment.mjs';
import { upstreamEnvironment, runtimeInstalled } from './prepare.mjs';
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  launchMobileMcp().catch(error => { console.error(`Cannot start Mobile MCP: ${error.message}`); process.exitCode = 1; });
}
