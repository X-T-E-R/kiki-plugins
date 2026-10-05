import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import yauzl from 'yauzl';

const site = 'https://x-t-e-r.github.io/kiki-plugins/';
const release = 'https://github.com/X-T-E-R/kiki-plugins/releases/download/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readArchiveIcon(bytes, id, version) {
 const manifest = JSON.parse((await zipFile(bytes, `${id}/kimi.plugin.json`)).toString('utf8'));
 if (manifest.name !== id || manifest.version !== version) throw new Error(`Historical icon identity mismatch: ${id}@${version}`);
 const declared = manifest.icon?.replace(/^\.\//, '');
 if (typeof declared !== 'string' || declared.startsWith('/') || declared.includes('\\') || declared.split('/').includes('..')) throw new Error(`Invalid historical icon path: ${id}`);
 return zipFile(bytes, posix.join(id, declared));
}

export async function retainHistoricalIcons(previous, outDir, loadBytes) {
 const records = new Map();
 const entries = new Map((previous?.plugins ?? []).map(entry => [entry.id, entry]));
 const ids = new Set([...entries.keys(), ...Object.keys(previous?.packageHistory ?? {})]);
 for (const id of ids) {
  for (const record of [entries.get(id), ...(previous?.packageHistory?.[id] ?? [])]) {
   if (record?.icon === undefined || !record.source?.startsWith(release)) continue;
   const extension = record.icon.match(/\.(?:svg|png|webp|jpg|jpeg)$/)?.[0];
   const path = `official/${id}/icon-${record.version}${extension}`;
   if (!/^[a-z0-9-]+$/.test(id) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(record.version) || extension === undefined || record.icon !== site + path || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) throw new Error(`Invalid historical icon contract: ${id}`);
   const known = records.get(path);
   if (known !== undefined && (known.source !== record.source || known.sha256 !== record.sha256)) throw new Error(`Conflicting historical icon: ${path}`);
   records.set(path, { ...record, id });
  }
 }
 const receipts = [];
 const archives = new Map();
 for (const [path, record] of records) {
  let bytes = archives.get(record.source);
  if (bytes === undefined) {
   bytes = await loadBytes(record.source);
   archives.set(record.source, bytes);
  }
  if (hash(bytes) !== record.sha256) throw new Error(`Historical ZIP checksum mismatch: ${record.id}@${record.version}`);
  const icon = await readArchiveIcon(bytes, record.id, record.version);
  const target = join(outDir, path);
  const existing = await readFile(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing !== undefined && !existing.equals(icon)) throw new Error(`Refusing to overwrite immutable icon: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  if (existing === undefined) await writeFile(target, icon, { flag: 'wx' });
  receipts.push({ id: record.id, version: record.version, path, sha256: hash(icon), archiveSha256: record.sha256 });
 }
 return receipts;
}

function zipFile(bytes, path) {
 return new Promise((resolve, reject) => {
  yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
   if (error !== null) { reject(error); return; }
   let found;
   const fail = error => { zip.close(); reject(error); };
   zip.on('error', fail);
   zip.on('entry', entry => {
    if (entry.fileName !== path) { zip.readEntry(); return; }
    if (found !== undefined || entry.uncompressedSize > 1024 * 1024) { fail(new Error(`Invalid historical ZIP asset: ${path}`)); return; }
    zip.openReadStream(entry, (error, stream) => {
     if (error !== null) { fail(error); return; }
     const chunks = [];
     stream.on('error', fail);
     stream.on('data', chunk => chunks.push(chunk));
     stream.on('end', () => { found = Buffer.concat(chunks); zip.readEntry(); });
    });
   });
   zip.on('end', () => found === undefined ? reject(new Error(`Missing historical ZIP asset: ${path}`)) : resolve(found));
   zip.readEntry();
  });
 });
}
