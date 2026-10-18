import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { coded } from './accounts.mjs';

export function assertInside(root, target) {
  const base = path.resolve(root);
  const file = path.resolve(target);
  const relative = path.relative(base, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw coded('path_rejected', 'That path is outside the mail data directory.');
  return file;
}

export function safeSegment(value, fallback = 'item') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return cleaned || fallback;
}

export async function writeInside(root, parts, bytes) {
  const directory = parts.slice(0, -1).reduce((current, part) => path.join(current, safeSegment(part)), path.resolve(root));
  const target = assertInside(root, path.join(directory, safeSegment(parts.at(-1), 'file')));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

export function allowedAttachment(file, context) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw coded('path_rejected', 'Attachment paths must be absolute.');
  const target = path.resolve(file);
  const roots = [context?.workspaceRoot, context?.dataDir, ...(context?.approvedPaths ?? [])].filter((item) => typeof item === 'string' && item);
  if (!roots.some((root) => {
    const relative = path.relative(path.resolve(root), target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) throw coded('path_rejected', 'Attachments must stay inside the workspace, an approved path, or this plugin\'s data directory.');
  return target;
}
