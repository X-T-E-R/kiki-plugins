import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readDataUrl(filePath) {
  const bytes = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
