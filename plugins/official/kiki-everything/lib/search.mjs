import { EverythingError, baseArgs, checkEs, notASwitch, resolveEsPath, runner, splitQueryTerms } from './es.mjs';
import { admitRoot, enrichCandidate } from './paths.mjs';

export const sorts = ['name', 'name-descending', 'path', 'path-descending', 'extension', 'size', 'size-descending', 'date-modified', 'date-modified-descending'];
const functions = new Set(['name', 'path', 'ext', 'extension', 'size', 'dm', 'datemodified', 'file', 'folder', 'case', 'nocase', 'wholeword', 'nowholeword', 'wildcards', 'nowildcards', 'regex', 'noregex', 'exact', 'startwith', 'endwith']);
export function validateArgs(args, settings = {}) {
  if (!args || typeof args !== 'object') throw new EverythingError('INVALID_ARGUMENT', 'Provide root and an optional indexed query.');
  const result = { query: '', type: 'both', limit: 100, offset: 0, sort: 'date-modified-descending', ...args };
  if (typeof result.query !== 'string' || result.query.length > 4096 || result.query.includes('\0')) throw new EverythingError('INVALID_QUERY', 'query must be a string of at most 4096 characters without NUL.');
  if (!['both', 'file', 'directory'].includes(result.type) || !sorts.includes(result.sort) || !Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 1000 || !Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > 2147480000) throw new EverythingError('INVALID_ARGUMENT', 'Use type=both/file/directory, a supported sort, limit=1..1000 and a nonnegative integer offset.');
  for (const flag of ['match_case', 'match_path', 'match_whole_word']) if (result[flag] !== undefined && typeof result[flag] !== 'boolean') throw new EverythingError('INVALID_ARGUMENT', `${flag} must be boolean.`);
  if (settings.instance && (typeof settings.instance !== 'string' || /["\r\n\0]/.test(settings.instance) || settings.instance.length > 128)) throw new EverythingError('INVALID_INSTANCE', 'instance must be the exact Everything instance name without quotes, NUL or newlines. Empty means the default instance; it never switches indexes automatically.');
  if (settings.timeoutMs !== undefined && (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 100 || settings.timeoutMs > 120000)) throw new EverythingError('INVALID_TIMEOUT', 'timeoutMs must be an integer from 100 to 120000.');
  // This is an index tool: never let a function trigger content/property disk reads.
  for (const match of result.query.matchAll(/([a-z][a-z0-9-]*):/gi)) {
    const name = match[1].toLowerCase();
    if (name.length === 1 && /[\\/]/.test(result.query[match.index + match[0].length] ?? '')) continue;
    if (!functions.has(name)) throw new EverythingError('INDEX_QUERY_ONLY', `Unsupported indexed function ${name}:. Use name/path/ext/size/dm filters; use Grep for contents.`);
  }
  return result;
}
export function searchArgs(args, root, settings) {
  const output = ['-txt', '-no-header', '-full-path-and-name', '-no-name', '-no-path-column', '-no-extension', '-no-size', '-no-date-created', '-no-date-modified', '-no-date-accessed', '-no-attributes', '-no-filelist-filename', '-no-run-count', '-no-date-run', '-no-date-recently-changed', '-no-highlight', '-no-double-quote', '-no-pause', '-no-folder-append-path-separator'];
  const flags = ['-no-case', '-no-whole-word', '-no-match-path'];
  if (args.match_case) flags.push('-case');
  if (args.match_path) flags.push('-p');
  if (args.match_whole_word) flags.push('-w');
  return [...baseArgs(settings), ...output, '-n', String(args.limit + 1), '-o', String(args.offset), '-sort', args.sort, '-path', `"${root}"`, ...(args.type === 'directory' ? ['/ad'] : args.type === 'file' ? ['/a-d'] : []), ...flags, ...splitQueryTerms(args.query).map(notASwitch)];
}
export function createSearch({ executor = runner, findEs = resolveEsPath, probe = checkEs, admit = admitRoot, enrich = enrichCandidate } = {}) {
  return async (input, context = {}) => {
    try {
      const settings = context.settings ?? {};
      const args = validateArgs(input, settings);
      const root = await admit(args.root, context);
      if (process.platform !== 'win32') throw new EverythingError('WINDOWS_REQUIRED', 'Everything ES indexed search runs on the local Windows host. Keep Glob/Grep for remote or non-Windows workspaces.');
      const executable = await findEs(settings);
      context.progress?.({ kind: 'status', text: 'Querying the local Everything index' });
      const versions = await probe(executable, settings, context, executor);
      const { stdout } = await executor.run(executable, searchArgs(args, root, settings), { signal: context.signal, timeoutMs: settings.timeoutMs ?? 30000 });
      const paths = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.length > 0);
      if (paths.some(line => !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(line))) throw new EverythingError('ES_OUTPUT_FORMAT', 'ES returned unexpected non-path output. Check esPath is official voidtools ES and reset custom display settings.');
      const hasMore = paths.length > args.limit;
      const page = paths.slice(0, args.limit), results = [];
      for (const file of page) {
        if (context.signal?.aborted) throw new EverythingError('CANCELLED', 'Search cancelled while filtering results.');
        const item = await enrich(file, root);
        if (item && (args.type === 'both' || item.type === args.type || item.type === 'unknown')) results.push(item);
      }
      return { output: JSON.stringify({ source: 'Everything index', root, query: args.query, sort: args.sort, versions, results, returned: results.length, pagination: { stage: 'index-before-path-and-sensitive-filtering', offset: args.offset, limit: args.limit, scanned: page.length, filtered: page.length - results.length, has_more: hasMore, next_offset: hasMore ? args.offset + page.length : null, total: null }, note: 'Only Kiki-admitted, canonical paths under root are returned. Sensitive and VCS paths are excluded. Index coverage/freshness depends on Everything; pages are live queries, not a snapshot. An empty filtered page can still have next_offset.' }, null, 2) };
    } catch (error) {
      return { isError: true, output: JSON.stringify({ code: error.code ?? 'EVERYTHING_ERROR', message: error.message }) };
    }
  };
}
export const search = createSearch();
