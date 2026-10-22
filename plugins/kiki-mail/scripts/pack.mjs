import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageBytes, packageFiles } from '../../../scripts/package-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const require = createRequire(path.join(repo, 'package.json'));
const yazl = require('yazl');
const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
const outDir = path.join(repo, '.tmp', 'kiki-mail');
await mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, `${manifest.name}-${manifest.version}.zip`);
const zip = new yazl.ZipFile();
const output = createWriteStream(zipPath);
const done = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  zip.outputStream.on('error', reject);
});
zip.outputStream.pipe(output);
const files = await packageFiles(root);
for (const file of files) {
  zip.addBuffer(await packageBytes(root, file), `${manifest.name}/${file}`, {
    mtime: new Date(1980, 0, 1, 0, 0, 0),
    forceDosTimestamp: true,
    mode: 0o100644,
  });
}
zip.end();
await done;
const entries = await new Promise((resolve, reject) => {
  require('yauzl').open(zipPath, { lazyEntries: true }, (error, archive) => {
    if (error) return reject(error);
    const names = [];
    archive.on('error', reject);
    archive.on('entry', (entry) => { names.push(entry.fileName); archive.readEntry(); });
    archive.on('end', () => resolve(names));
    archive.readEntry();
  });
});
for (const required of ['kiki-mail/kimi.plugin.json', 'kiki-mail/entry.mjs', 'kiki-mail/panel.html', 'kiki-mail/vendor/runtime.mjs', 'kiki-mail/LICENSE', 'kiki-mail/skills/kiki-mail/SKILL.md']) {
  if (!entries.includes(required)) throw new Error(`Package is missing ${required}`);
}
if (entries.some((entry) => entry.includes('node_modules') || entry.endsWith('package.json'))) throw new Error('Package contains files that are not part of the install set');
process.stdout.write(`${zipPath}\n${entries.length} entries\n`);
