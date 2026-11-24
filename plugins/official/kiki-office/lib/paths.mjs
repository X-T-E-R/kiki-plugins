import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const OFFICE_EXTENSIONS = ['.docx', '.xlsx', '.pptx'];
export const XLSX_EXTENSIONS = ['.xlsx'];
export const IMPORT_SOURCE_EXTENSIONS = ['.csv', '.tsv'];

export class OfficeError extends Error {
  constructor(code, message, suggestion) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}

const within = (file, root) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export async function admitFile(input, operation, scope, { extensions = OFFICE_EXTENSIONS, maxBytes, label = 'Document' } = {}) {
  if (typeof scope?.workspaceRoot !== 'string' || !path.isAbsolute(scope.workspaceRoot)) {
    throw new OfficeError('WORKSPACE_UNAVAILABLE', 'The plugin host did not provide a workspace root.', 'Open an Office document in a session with a workspace.');
  }
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || /^[A-Za-z]:[^\\/]/.test(input)) {
    throw new OfficeError('PATH_INVALID', `${label} path must be a nonempty, unambiguous path.`, 'Use a workspace-relative path or an explicitly approved absolute path.');
  }
  const workspace = await realpath(scope.workspaceRoot);
  const candidate = path.resolve(workspace, input);
  const ext = path.extname(candidate).toLowerCase();
  if (!extensions.includes(ext)) {
    const allowed = extensions.join(', ');
    throw new OfficeError('FORMAT_UNSUPPORTED', `${label} format "${ext || '(none)'}" is not supported; expected ${allowed}.`, `Choose a file with extension ${allowed}.`);
  }

  const approved = [workspace];
  const lexicalApproved = [path.resolve(scope.workspaceRoot), workspace];
  for (const raw of scope.approvedPaths ?? []) {
    if (typeof raw === 'string' && path.isAbsolute(raw)) {
      const normalized = path.resolve(raw);
      lexicalApproved.push(normalized);
      const real = await realpath(normalized).catch(() => undefined);
      if (real) approved.push(real);
    }
  }
  if (!lexicalApproved.some((root) => within(candidate, root) || root === candidate)) {
    throw new OfficeError('PATH_OUTSIDE_WORKSPACE', `${label} is outside the approved workspace: ${candidate}`, 'Use a workspace path or ask the user to approve this absolute path through Kiki.');
  }

  const existing = await stat(candidate).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (operation === 'create' && existing !== undefined) {
    throw new OfficeError('FILE_EXISTS', `File already exists: ${candidate}`, 'Choose a new filename; use office_set or office_add for an existing file.');
  }
  if (operation !== 'create' && (!existing || !existing.isFile())) {
    throw new OfficeError('FILE_MISSING', `${label} does not exist or is not a regular file: ${candidate}`, 'Create the file first or provide an existing regular file path.');
  }
  if (operation !== 'create' && maxBytes !== undefined && existing.size > maxBytes) {
    throw new OfficeError('PACKAGE_LIMIT', `${label} exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit: ${candidate}`, 'Split or reduce the input file before retrying.');
  }
  const resolved = existing ? await realpath(candidate) : path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
  const resolvedExt = path.extname(resolved).toLowerCase();
  if (!extensions.includes(resolvedExt)) {
    const allowed = extensions.join(', ');
    throw new OfficeError('FORMAT_UNSUPPORTED', `Resolved ${label.toLowerCase()} target has unsupported format "${resolvedExt || '(none)'}"; expected ${allowed}.`, `Choose a file with extension ${allowed}.`);
  }
  if (!approved.some((root) => within(resolved, root) || root === resolved)) {
    throw new OfficeError('PATH_OUTSIDE_WORKSPACE', `${label} is outside the approved workspace: ${candidate}`, 'Use a workspace path or ask the user to approve this absolute path through Kiki.');
  }
  return resolved;
}
