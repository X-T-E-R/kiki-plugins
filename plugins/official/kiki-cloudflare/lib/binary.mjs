import { createHash } from 'node:crypto';
import { mkdir, open, readFile, link, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { command } from './process.mjs';

export const VERSION = '2026.10.0';
export const ASSETS = {
  'win32/x64': ['cloudflared-windows-amd64.exe', '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c'],
  'linux/x64': ['cloudflared-linux-amd64', 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'],
  'linux/arm64': ['cloudflared-linux-arm64', 'e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08'],
  'darwin/x64': ['cloudflared-darwin-amd64.tgz', '903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f'],
  'darwin/arm64': ['cloudflared-darwin-arm64.tgz', 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70'],
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function dependency(settings, run = command) {
  const file = settings.cloudflaredPath || 'cloudflared';
  try {
    const text = await run(file, ['--version'], { timeoutMs: 5000, limit: 8192 });
    const match = /cloudflared version (\d{4}\.\d+\.\d+)/.exec(text);
    if (!match) return { state: 'error', path: file };
    const parts = match[1].split('.').map(Number);
    if (parts[0] < 2025 || (parts[0] === 2025 && parts[1] < 4)) return { state: 'error', path: file, version: match[1] };
    return { state: 'ready', path: file, version: match[1] };
  } catch { return { state: 'missing', path: file }; }
}

export async function boundedBytes(response, limit = 80 * 1024 * 1024) {
  if (!response.ok) throw new Error(`cloudflared download failed (HTTP ${response.status}). Retry installation.`);
  let size = 0;
  const parts = [];
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error('cloudflared download exceeds its size limit.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function binaryFromTar(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 100 * 1024 * 1024 });
  let found;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid cloudflared archive.');
    if ((name === 'cloudflared' || name === './cloudflared') && [0, 48].includes(header[156])) {
      if (found) throw new Error('Duplicate cloudflared binary in archive.');
      found = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!found?.length) throw new Error('cloudflared binary is missing from archive.');
  return found;
}

export async function installBinary({ consent, destination }, { fetchFn = fetch, platform = process.platform, arch = process.arch, assets = ASSETS } = {}) {
  if (consent !== true) throw new Error('Choose Install to allow downloading cloudflared.');
  if (!path.isAbsolute(destination)) throw new Error('Installer destination must be absolute.');
  const asset = assets[`${platform}/${arch}`];
  if (!asset) throw new Error('Automatic installation is unavailable on this platform. Choose an existing cloudflared executable.');
  const [name, checksum] = asset;
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${name}`;
  const bytes = await boundedBytes(await fetchFn(url, { signal: AbortSignal.timeout(120000) }));
  if (hash(bytes) !== checksum) throw new Error('cloudflared download checksum mismatch. Nothing was installed; retry installation.');
  const binary = name.endsWith('.tgz') ? binaryFromTar(bytes) : bytes;
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.partial`;
  try {
    const fd = await open(temporary, 'wx', 0o700);
    try { await fd.writeFile(binary); await fd.sync(); } finally { await fd.close(); }
    await chmod(temporary, 0o700);
    try { await link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST' || hash(await readFile(destination)) !== hash(binary)) throw new Error('An existing file occupies the install path. Choose another executable path.');
    }
    return destination;
  } finally { await unlink(temporary).catch(() => {}); }
}
