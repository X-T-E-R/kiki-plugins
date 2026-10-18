import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const esbuild = require('esbuild');
const outfile = path.join(root, 'vendor', 'runtime.mjs');
await mkdir(path.dirname(outfile), { recursive: true });
const built = await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'runtime-entry.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'none',
  metafile: true,
  logLevel: 'silent',
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n",
  },
});
const bundled = new Map();
for (const input of Object.keys(built.metafile.inputs)) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) continue;
  const rest = normalized.slice(index + marker.length);
  const name = rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0];
  if (name && name !== 'esbuild') bundled.set(name, path.join(root, 'node_modules', ...name.split('/')));
}
const notices = [
  '# Third-party notices',
  '',
  'kiki-mail bundles these npm packages into vendor/runtime.mjs. Each package keeps the license declared by its published package.json. The license texts below are copied from the installed artifacts. Nodemailer and PostalMime are MIT-0 in their package metadata. ImapFlow is MIT. Transitive packages keep whatever SPDX identifier they publish; they are not relabeled.',
  '',
];
const versions = {};
const licenseDir = path.join(root, 'vendor', 'licenses');
await mkdir(licenseDir, { recursive: true });
for (const [name, directory] of [...bundled.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  versions[manifest.name] = { version: manifest.version, license: manifest.license ?? null };
  const files = (await readdir(directory)).filter((file) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file));
  if (files.length === 0) throw new Error(`No license file found for bundled package ${name}`);
  notices.push(`## ${manifest.name} ${manifest.version}`, '', `npm package.json license: ${manifest.license ?? '(not declared)'}`, '');
  for (const file of files) {
    const text = (await readFile(path.join(directory, file), 'utf8')).replaceAll('\r\n', '\n').trim();
    const safe = `${manifest.name.replace(/[\\/]/g, '__')}--${file}`.replace(/[^A-Za-z0-9._-]+/g, '_');
    await writeFile(path.join(licenseDir, safe), `${text}\n`);
    notices.push(`### ${file}`, '', '```text', text, '```', '');
  }
}
for (const name of ['nodemailer', 'imapflow', 'postal-mime']) {
  if (!versions[name]) throw new Error(`Bundle did not include ${name}`);
}
await writeFile(path.join(root, 'vendor', 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), `${notices.join('\n')}\n`);
process.stdout.write(`Bundled ${Object.entries(versions).map(([name, info]) => `${name}@${info.version}`).join(', ')}\n`);
