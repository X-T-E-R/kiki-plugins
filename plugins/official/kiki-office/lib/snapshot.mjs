import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeError } from './paths.mjs';

export async function snapshotFromFile(file, { maxBytes, label = 'Document', ext = path.extname(file) } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kiki-office-snap-'));
  const target = path.join(dir, `snapshot${ext || '.bin'}`);
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new OfficeError('FILE_MISSING', `${label} is not a regular file: ${file}`, 'Provide an existing regular file path.');
    }
    if (maxBytes !== undefined && info.size > maxBytes) {
      throw new OfficeError('PACKAGE_LIMIT', `${label} exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit.`, 'Choose a smaller file.');
    }

    const hash = createHash('sha256');
    let total = 0;
    const reader = handle.createReadStream({ autoClose: false });
    const writer = createWriteStream(target, { flags: 'wx', mode: 0o600 });

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reader.destroy();
        writer.destroy();
        reject(err);
      };
      reader.on('error', fail);
      writer.on('error', fail);
      writer.on('finish', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      reader.on('data', (chunk) => {
        total += chunk.length;
        if (maxBytes !== undefined && total > maxBytes) {
          fail(new OfficeError('PACKAGE_LIMIT', `${label} grew beyond the ${Math.round(maxBytes / (1024 * 1024))} MiB limit while reading.`, 'Choose a smaller file.'));
          return;
        }
        hash.update(chunk);
        if (!writer.write(chunk)) {
          reader.pause();
          writer.once('drain', () => reader.resume());
        }
      });
      reader.on('end', () => writer.end());
    });

    return {
      path: target,
      size: total,
      sha256: hash.digest('hex'),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashFile(file) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new OfficeError('CONCURRENT_MODIFICATION', `Destination is no longer a regular file: ${file}`, 'Re-inspect the destination and retry.');
    }
    const hash = createHash('sha256');
    const reader = handle.createReadStream({ autoClose: false });
    for await (const chunk of reader) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function publishSnapshotAtomic(snapshotPath, destination, expectedBeforeSha256) {
  const currentHash = await hashFile(destination);
  if (currentHash !== expectedBeforeSha256) {
    throw new OfficeError(
      'CONCURRENT_MODIFICATION',
      `Destination file changed on disk during operation: ${destination}`,
      'Re-read the updated document and reapply your changes.',
    );
  }
  const staged = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.kiki-${process.pid}-${Date.now()}.tmp`,
  );
  let srcHandle;
  try {
    srcHandle = await open(snapshotPath, 'r');
    const reader = srcHandle.createReadStream({ autoClose: false });
    const writer = createWriteStream(staged, { flags: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => {
      reader.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      reader.pipe(writer);
    });
    await srcHandle.close();
    srcHandle = undefined;

    // Final check immediately before atomic rename
    const verifyHash = await hashFile(destination);
    if (verifyHash !== expectedBeforeSha256) {
      throw new OfficeError(
        'CONCURRENT_MODIFICATION',
        `Destination file changed on disk before commit: ${destination}`,
        'Re-read the updated document and reapply your changes.',
      );
    }
    await rename(staged, destination);
  } catch (err) {
    await srcHandle?.close().catch(() => undefined);
    await unlink(staged).catch(() => undefined);
    throw err;
  }
}
