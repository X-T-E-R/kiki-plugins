import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const recovery = 'Node.js 22.12.0+ with npm is required. Install Node.js and put its executable on PATH, then retry.';

export async function nodeExecutable({ execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
  if (/^node(?:\.exe)?$/i.test(path.basename(execPath))) return execPath;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      const { stdout } = await exec(candidate, ['--version'], { windowsHide: true, timeout: 5000 });
      const match = /^v(\d+)\.(\d+)\./.exec(stdout.trim());
      if (match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 12))) return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(recovery);
}
