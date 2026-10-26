import { createInterface } from 'node:readline/promises';
import { preparePhone } from './prepare.mjs';

const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
if (value('--data-dir')) process.env.KIKI_PHONE_DATA_DIR = value('--data-dir');
const server = args.includes('--server');
const options = { download: args.includes('--download'), adbPath: value('--adb'), warmup: !args.includes('--no-warmup'), platform: value('--platform') || 'android' };
let result = await preparePhone(options);
if (result.status === 'download_consent_required' && process.stdin.isTTY && !args.includes('--json')) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(`Download official Google platform-tools from ${result.download.url}\nLicense: ${result.download.license}\nPrivate data: ${result.dataDir}`);
    const answer = await prompt.question('Accept these terms and download? [y/N] ');
    if (/^y(?:es)?$/i.test(answer.trim())) result = await preparePhone({ ...options, download: true });
  } finally { prompt.close(); }
}
const output = args.includes('--json') ? JSON.stringify(result, null, 2)
  : [`Kiki Phone: ${result.status}`, result.message, `Private data: ${result.dataDir}`, result.adb && `ADB: ${result.adb.path}`, result.stdout, result.stderr, result.mcp.message].filter(Boolean).join('\n');
(server ? console.error : console.log)(output);
if (['error', 'download_consent_required'].includes(result.status)) process.exitCode = 1;
else if (server) {
  const { launchMobileMcp } = await import('./launch-mobile-mcp.mjs');
  await launchMobileMcp();
}
