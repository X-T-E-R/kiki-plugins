import { definitions } from './lib/definitions.mjs';
import { readTable, audit, compare } from './lib/tables.mjs';

function pageCollections(value, offset, limit) {
  const counts = {};
  const result = {};
  let more = false;
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && key !== 'headers') {
      counts[key] = item.length;
      result[key] = item.slice(offset, offset + limit);
      more ||= item.length > offset + limit;
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      result[key] = pageCollections(item, offset, limit);
      more ||= result[key].has_more;
    } else result[key] = item;
  }
  return { ...result, counts, offset, limit, has_more: more, next_offset: more ? offset + limit : null };
}
export function register(api) {
  for (const definition of definitions) api.registerTool(definition, async (args, context) => {
    try {
      const offset = args.offset ?? 0, limit = args.limit ?? 200;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Use offset >= 0 and limit between 1 and 1000.');
      context.progress({ kind: 'status', text: 'Reading table keys without changing the files' });
      const left = await readTable(args.file ?? args.left, args.keys, context.signal);
      const value = definition.name === 'table_audit' ? audit(left) : compare(left, await readTable(args.right, args.keys, context.signal));
      return { output: JSON.stringify(pageCollections(value, offset, limit), null, 2) };
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  });
}
