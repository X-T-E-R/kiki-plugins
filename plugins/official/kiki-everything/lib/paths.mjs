import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EverythingError } from './es.mjs';

const vcs = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']);
const exemptions = new Set(['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
const variants = new Set(['.bak', '.backup', '.copy', '.disabled', '.key', '.old', '.orig', '.pem', '.save', '.tmp']);
// Kiki path-access.ts sensitive-file rules and Glob/Grep VCS exclusions.
export function excluded(file) {
  const parts = file.replaceAll('\\', '/').toLowerCase().replace(/::\$data$/, '').split('/');
  if (parts.some(part => vcs.has(part))) return true;
  return parts.some(name => {
    if (exemptions.has(name)) return false;
    if (name === '.env' || name.startsWith('.env.')) return true;
    return ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'].some(prefix => {
      const suffix = name.slice(prefix.length);
      return name === prefix || (name.startsWith(prefix) && (/^[-_]/.test(suffix) || variants.has(suffix)));
    });
  });
}
export function within(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function admitRoot(raw, context) {
  if (!context.workspaceRoot || !path.isAbsolute(context.workspaceRoot)) throw new EverythingError('WORKSPACE_UNAVAILABLE', 'A local Kiki workspace is required for path admission.');
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || /["\r\n]/.test(raw) || raw.length > 4096 || /^[A-Za-z]:[^\\/]/.test(raw)) throw new EverythingError('ROOT_INVALID', 'root must be an unambiguous local directory, without quotes or newlines. Use C:/ to search a whole drive.');
  const resolved = path.resolve(context.workspaceRoot, raw);
  const roots = [context.workspaceRoot, ...(context.approvedPaths ?? [])];
  if (!roots.some(root => path.isAbsolute(root) && within(resolved, root))) throw new EverythingError('PATH_OUTSIDE_WORKSPACE', 'Search root is outside Kiki-admitted paths. Pass it as root so Kiki can approve that directory or volume.');
  if (excluded(resolved)) throw new EverythingError('ROOT_FILTERED', 'Sensitive and VCS directories are excluded from indexed search.');
  const canonical = await realpath(resolved).catch(error => { throw new EverythingError('ROOT_UNAVAILABLE', `Search root is unavailable (${error.code}). Choose an existing online directory or volume.`); });
  const canonicalRoots = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
  if (!canonicalRoots.some(root => root && within(canonical, root))) throw new EverythingError('PATH_OUTSIDE_WORKSPACE', 'Search root resolves outside Kiki-admitted paths. Approve its real target through Kiki.');
  if (excluded(canonical)) throw new EverythingError('ROOT_FILTERED', 'Sensitive and VCS directories are excluded from indexed search.');
  if (!(await stat(canonical)).isDirectory()) throw new EverythingError('ROOT_INVALID', 'root must be a directory, not a file.');
  return canonical;
}
export async function enrichCandidate(file, root, fs = { realpath, stat }) {
  if (!path.isAbsolute(file) || file.includes('\0') || !within(file, root) || excluded(file)) return null;
  let canonical;
  try { canonical = await fs.realpath(file); }
  catch { return null; }
  if (!within(canonical, root) || excluded(canonical)) return null;
  try {
    const info = await fs.stat(canonical);
    return { path: canonical, name: path.basename(canonical), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size_bytes: info.isFile() ? info.size : null, modified_at: info.mtime.toISOString() };
  } catch (error) {
    return { path: canonical, name: path.basename(canonical), type: 'unknown', size_bytes: null, modified_at: null, metadata_error: error.code ?? 'UNAVAILABLE' };
  }
}
