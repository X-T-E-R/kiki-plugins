import { spawn } from 'node:child_process';
import { writeFile, readFile, stat } from 'node:fs/promises';
import path, { join } from 'node:path';

const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000;

function terminateProcessTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
  } else {
    try { child.kill('SIGTERM'); } catch {}
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    force.unref?.();
  }
}

function parseEnvironment(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') throw new Error('Invalid script environment: expected JSON object string');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Environment JSON must be an object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid script environment JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function execute(action, input, context) {
  const source = context.settings.scriptSource;
  if (!source) throw new Error('Custom script source is missing');
  context.signal?.throwIfAborted();
  const kind = input.request?.kind ?? source.kinds[0];
  const extension = source.format ?? { image: 'png', video: 'mp4', tts: 'mp3' }[kind];
  const output = join(context.stagingDir, `output.${extension}`);
  const inputFile = join(context.stagingDir, `${action}-input.json`);
  const resultFile = join(context.stagingDir, `${action}-result.json`);
  await writeFile(inputFile, JSON.stringify({ action, input, output, resultFile, jobId: context.jobId }));
  const replacements = { action, input: inputFile, output, result: resultFile, prompt: input.request?.prompt ?? '', text: input.request?.text ?? '', job_id: context.jobId };
  const args = (source.args ?? []).map((arg) => arg.replace(/\{(action|input|output|result|prompt|text|job_id)\}/g, (_, key) => replacements[key]));
  const environment = parseEnvironment(context.settings.environment);
  const timeoutMs = Number.isInteger(source.timeoutMs) && source.timeoutMs >= 1000 ? source.timeoutMs : DEFAULT_SCRIPT_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    if (context.signal?.aborted) {
      reject(new Error('Media script cancelled before start'));
      return;
    }
    const child = spawn(source.command, args, {
      cwd: source.cwd || undefined,
      env: { ...process.env, ...environment, KIKI_MEDIA_INPUT: inputFile, KIKI_MEDIA_OUTPUT: output, KIKI_MEDIA_RESULT: resultFile, KIKI_MEDIA_ACTION: action },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stopReason = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => {
      stopReason = 'aborted';
      terminateProcessTree(child);
      finish(new Error('Media script cancelled'));
    };
    const timer = setTimeout(() => {
      stopReason = 'timeout';
      terminateProcessTree(child);
      finish(new Error(`Media script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (bytes) => context.progress({ kind: 'stdout', text: bytes.toString() }));
    child.stderr?.on('data', (bytes) => context.progress({ kind: 'stderr', text: bytes.toString() }));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (stopReason) return;
      finish(code === 0 ? undefined : new Error(`Media script exited ${code}`));
    });
  });
  if (source.protocol === 'json') return JSON.parse(await readFile(resultFile, 'utf8'));
  if (action !== 'submit') throw new Error('File-output scripts do not implement this action');
  const size = (await stat(output)).size;
  if (!size) throw new Error('Media script produced an empty output');
  return { state: 'complete', artifacts: [{ path: output, name: `output.${extension}`, mime: source.mime ?? { image: 'image/png', video: 'video/mp4', tts: 'audio/mpeg' }[kind], kind: kind === 'tts' ? 'audio' : kind, role: 'original', complete: true }] };
}
export const scriptAdapter = {
  describe: async (_query, context) => ({ models: context.settings.scriptSource.kinds.map((kind) => ({ id: context.settings.scriptSource.id, kind })), constraints: ['Trusted local command; configure its own dependencies, credentials and file-output or JSON bridge.'] }),
  submit: (input, context) => execute('submit', input, context),
  poll: (input, context) => execute('poll', input, context),
  cancel: async (input, context) => context.settings.scriptSource.protocol === 'json' ? execute('cancel', input, context) : { remote: 'unsupported', billing: 'unknown' },
  voices: (input, context) => execute('voices', input, context),
};
