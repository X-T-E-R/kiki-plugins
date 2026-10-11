const file = { type: 'string', minLength: 1, description: 'Workspace-relative CSV/TSV file or an approved absolute path.' };
const keys = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 8, description: 'Exact header names used together as a stable row key; values remain strings.' };
const offset = { type: 'integer', minimum: 0, description: 'Offset into each result collection; repeat to read later results.' };
const limit = { type: 'integer', minimum: 1, maximum: 1000, description: 'Result rows per collection, default 200.' };
export const definitions = [
  { schemaVersion: 1, name: 'table_audit', description: 'Read a CSV/TSV table without changing it. Report row count, headers, blank keys and duplicate keys before a report or reconciliation.', parameters: { type: 'object', properties: { file, keys, offset, limit }, required: ['file', 'keys'], additionalProperties: false }, accesses: [{ kind: 'file', operation: 'read', path: '$.file' }] },
  { schemaVersion: 1, name: 'table_compare', description: 'Compare two local CSV/TSV tables by exact composite keys. Report added, removed and changed rows, keeping leading zeroes, currency strings and duplicate-key ambiguities. Read-only; no network.', parameters: { type: 'object', properties: { left: file, right: file, keys, offset, limit }, required: ['left', 'right', 'keys'], additionalProperties: false }, accesses: [{ kind: 'file', operation: 'read', path: '$.left' }, { kind: 'file', operation: 'read', path: '$.right' }] },
];
