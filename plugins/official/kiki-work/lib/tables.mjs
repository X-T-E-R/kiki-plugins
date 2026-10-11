import { open } from 'node:fs/promises';
import Papa from '../vendor/papaparse.cjs';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 100_000;
export async function readTable(file, keys, signal) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8 || keys.some(key => typeof key !== 'string' || !key)) throw new Error('Select one to eight exact key column names.');
  signal?.throwIfAborted();
  const handle = await open(file, 'r');
  let text;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Choose a regular CSV/TSV file within 16 MiB, or split it before comparing.');
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('The table grew beyond 16 MiB; split it before comparing.');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  const result = Papa.parse(text, { skipEmptyLines: 'greedy', preview: MAX_ROWS + 2 });
  const malformed = result.errors.filter(error => error.code !== 'UndetectableDelimiter');
  if (malformed.length) throw new Error(`Cannot read CSV: ${malformed[0].message}`);
  if (result.meta.truncated || result.data.length > MAX_ROWS + 1) throw new Error('Choose a table with at most 100,000 rows, or split it first.');
  const [headers, ...rows] = result.data;
  if (!headers || new Set(headers).size !== headers.length || headers.some(header => !header)) throw new Error('The first row needs unique, non-empty column headers.');
  const indices = keys.map(key => { const index = headers.indexOf(key); if (index < 0) throw new Error(`Key column is missing: ${key}`); return index; });
  const keyed = new Map();
  const blankKeys = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % 1024 === 0) { await new Promise(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
    const row = rows[i];
    if (row.length !== headers.length) throw new Error(`Row ${i + 2} has ${row.length} fields, expected ${headers.length}.`);
    const values = indices.map(index => row[index]);
    if (values.some(value => value.trim() === '')) blankKeys.push(i + 2);
    const key = JSON.stringify(values);
    const entry = { row: i + 2, values: Object.fromEntries(headers.map((header, index) => [header, row[index]])) };
    if (keyed.has(key)) keyed.get(key).push(entry); else keyed.set(key, [entry]);
  }
  return { headers, count: rows.length, keyed, blankKeys, duplicates: [...keyed].filter(([, entries]) => entries.length > 1).map(([key, entries]) => ({ key: JSON.parse(key), rows: entries.map(entry => entry.row) })) };
}

export function audit(table) {
  return { rows: table.count, headers: table.headers, blank_key_rows: table.blankKeys, duplicate_keys: table.duplicates, safe_to_compare: table.blankKeys.length === 0 && table.duplicates.length === 0 };
}
export function compare(left, right) {
  const added = [], removed = [], changed = [];
  for (const [key, entries] of left.keyed) {
    const after = right.keyed.get(key);
    if (entries.length !== 1 || after?.length > 1) continue;
    if (!after) { removed.push(entries[0]); continue; }
    const before = entries[0];
    const changes = [...new Set([...left.headers, ...right.headers])].filter(column => before.values[column] !== after[0].values[column]).map(column => ({ column, before: before.values[column] ?? null, after: after[0].values[column] ?? null }));
    if (changes.length) changed.push({ key: JSON.parse(key), before_row: before.row, after_row: after[0].row, changes });
  }
  for (const [key, entries] of right.keyed) if (!left.keyed.has(key) && entries.length === 1) added.push(entries[0]);
  return { left: audit(left), right: audit(right), added, removed, changed, complete: left.blankKeys.length === 0 && right.blankKeys.length === 0 && left.duplicates.length === 0 && right.duplicates.length === 0 };
}
