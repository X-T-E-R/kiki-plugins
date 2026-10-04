import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const directories = new Set(['lib', 'skills', 'vendor']);
const topFile = /^(kimi\.plugin\.json|entry\.mjs|adapters\.mjs|runtime\.mjs|panel\.html|icon\.(svg|png|webp|jpg|jpeg)|README(?:\.[a-zA-Z-]+)?\.md|LICENSE(?:\.[a-zA-Z0-9.-]+)?|NOTICE|THIRD_PARTY_NOTICES\.md)$/;
export async function packageFiles(root) {
  const out = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) throw new Error(`Package symlink is forbidden: ${prefix}${entry.name}`);
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (prefix === '' && !directories.has(entry.name)) continue;
        await walk(join(directory, entry.name), `${name}/`);
      } else if (entry.isFile() && (prefix !== '' || topFile.test(entry.name))) out.push(name);
    }
  }
  await walk(root);
  if (!out.includes('kimi.plugin.json') || !out.some(f => f.startsWith('LICENSE'))) throw new Error(`Package needs manifest and license: ${root}`);
  return out;
}
export async function inputDigest(root) {
  const hash = createHash('sha256');
  for (const file of await packageFiles(root)) hash.update(file).update('\0').update(await readFile(join(root, file))).update('\0');
  return hash.digest('hex');
}
