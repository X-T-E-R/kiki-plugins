import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function workspaceRootKey(root) {
  const slashed = root.replaceAll('\\', '/');
  if (WIN_SHAPED.test(slashed)) {
    return stripTrailingSeparators(win32.normalize(slashed).replaceAll('\\', '/')).toLowerCase();
  }
  return stripTrailingSeparators(posix.normalize(root));
}

export function slugifyWorkDirName(name) {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40).replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

export function encodeWorkDirKey(workDir) {
  const normalized = workspaceRootKey(workDir);
  const base = normalized.split('/').pop() ?? normalized;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slugifyWorkDirName(base)}_${hash}`;
}

function stripTrailingSeparators(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}
