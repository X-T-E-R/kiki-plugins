import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { exportPages, readLedger, writeLedger } from '../lib/ledger.mjs';

async function writeStdout(page) {
  if (!process.stdout.write(page)) await once(process.stdout, 'drain');
}

export async function streamExport(workspaceRoot, format, signal, sink) {
  for await (const page of exportPages(workspaceRoot, format, signal)) {
    signal?.throwIfAborted();
    await sink(page);
  }
}

export async function writeFully(handle, value, position = 0) {
  const bytes = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    const written = result?.bytesWritten;
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error('Export output made no write progress.');
    offset += written;
  }
  return bytes.length;
}

export async function exportSnapshot(workspaceRoot, format, signal, outputFile) {
  if (outputFile === undefined) throw new TypeError('outputFile is required; use streamExport for stdout');
  const handle = await open(outputFile, 'wx');
  try {
    let position = 0;
    await streamExport(workspaceRoot, format, signal, async (page) => {
      position += await writeFully(handle, page, position);
    });
    await handle.close();
    return undefined;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(outputFile).catch(() => undefined);
    throw error;
  }
}

const sameFile = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const invokedDirectly = process.argv[1] && sameFile(path.resolve(fileURLToPath(import.meta.url)), path.resolve(process.argv[1]));
if (invokedDirectly) {
  const [command, workspace, inputFile, outputFile] = process.argv.slice(2);
  if (!['read', 'write', 'export'].includes(command) || !workspace || ((command === 'read' || command === 'write') && !inputFile) || (command === 'export' && !inputFile)) {
    console.error('Usage: node scripts/ledger.mjs read|write WORKSPACE INPUT.json\n       node scripts/ledger.mjs export WORKSPACE json|markdown [OUTPUT]'); process.exitCode = 2;
  } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort(new Error('Cancelled')));
    const root = path.resolve(workspace);
    try {
      if (command === 'export') {
        const destination = outputFile ? path.resolve(outputFile) : undefined;
        if (destination === undefined) {
          await streamExport(root, inputFile, controller.signal, writeStdout);
        } else {
          await exportSnapshot(root, inputFile, controller.signal, destination);
        }
      } else {
        const input = JSON.parse(await readFile(path.resolve(inputFile), 'utf8'));
        const result = await (command === 'read' ? readLedger : writeLedger)({ ...input, workspace: '.' }, { workspaceRoot: root, approvedPaths: [], signal: controller.signal });
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) { console.error(JSON.stringify({ error: error.code ?? 'ledger_error', message: error.message, details: error.details })); process.exitCode = 1; }
  }
}
