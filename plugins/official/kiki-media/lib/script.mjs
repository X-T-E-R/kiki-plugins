import { spawn } from 'node:child_process';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function execute(action, input, context) {
  const source = context.settings.scriptSource;
  if (!source) throw new Error('Custom script source is missing');
  const kind = input.request?.kind ?? source.kinds[0];
  const extension = source.format ?? { image: 'png', video: 'mp4', tts: 'mp3' }[kind];
  const output = join(context.stagingDir, `output.${extension}`);
  const inputFile = join(context.stagingDir, `${action}-input.json`);
  const resultFile = join(context.stagingDir, `${action}-result.json`);
  await writeFile(inputFile, JSON.stringify({ action, input, output, resultFile, jobId: context.jobId }));
  const replacements = { action, input: inputFile, output, result: resultFile, prompt: input.request?.prompt ?? '', text: input.request?.text ?? '', job_id: context.jobId };
  const args = (source.args ?? []).map((arg) => arg.replace(/\{(action|input|output|result|prompt|text|job_id)\}/g, (_, key) => replacements[key]));
  const environment = context.settings.environment ? JSON.parse(context.settings.environment) : {};
  await new Promise((resolve, reject) => {
    const child = spawn(source.command, args, { cwd: source.cwd || undefined, env: { ...process.env, ...environment, KIKI_MEDIA_INPUT: inputFile, KIKI_MEDIA_OUTPUT: output, KIKI_MEDIA_RESULT: resultFile, KIKI_MEDIA_ACTION: action }, shell: false, signal: context.signal, windowsHide: true });
    child.stdout?.on('data', (bytes) => context.progress({ kind: 'stdout', text: bytes.toString() }));
    child.stderr?.on('data', (bytes) => context.progress({ kind: 'stderr', text: bytes.toString() }));
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Media script exited ${code}`)));
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
