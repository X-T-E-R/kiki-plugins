import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions } from '../lib/definitions.mjs';
import { readTable, audit, compare } from '../lib/tables.mjs';
import { register } from '../entry.mjs';

test('manifest tools match one definition source', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
});
test('quoted CSV, leading zeroes, composite keys and row differences stay exact and read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-tables-'));
  try {
    const left = join(root, 'before.csv'), right = join(root, 'after.csv');
    const before = '\ufeffid,region,amount,note\r\n001,East,100,"hello, world"\r\n002,West,200,"line one\nline two"\r\n';
    await writeFile(left, before); await writeFile(right, 'id,region,amount,note\n001,East,120,"hello, world"\n003,East,50,new\n');
    const result = compare(await readTable(left, ['id', 'region']), await readTable(right, ['id', 'region']));
    assert.equal(result.complete, true);
    assert.deepEqual(result.changed[0].key, ['001', 'East']);
    assert.deepEqual(result.changed[0].changes, [{ column: 'amount', before: '100', after: '120' }]);
    assert.equal(result.removed[0].values.note, 'line one\nline two');
    assert.equal(result.added[0].values.id, '003');
    assert.equal(await readFile(left, 'utf8'), before);
    const handlers = new Map(); register({ registerTool(definition, handler) { handlers.set(definition.name, handler); } });
    const call = await handlers.get('table_compare')({ left, right, keys: ['id', 'region'], limit: 1 }, { signal: new AbortController().signal, progress() {} });
    assert.equal(call.isError, undefined); assert.equal(JSON.parse(call.output).counts.changed, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('ambiguities, malformed headers, invalid encoding and cancellation remain visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-tables-'));
  try {
    const file = join(root, 'table.tsv');
    await writeFile(file, 'id\tvalue\nA\t1\nA\t2\n\t3\n');
    const result = audit(await readTable(file, ['id']));
    assert.equal(result.safe_to_compare, false); assert.deepEqual(result.blank_key_rows, [4]);
    assert.deepEqual(result.duplicate_keys, [{ key: ['A'], rows: [2, 3] }]);
    await assert.rejects(readTable(file, ['unknown']), /Key column is missing/);
    await writeFile(file, 'id,id\n1,2\n'); await assert.rejects(readTable(file, ['id']), /unique/);
    await writeFile(file, Buffer.from([0xff, 0xff])); await assert.rejects(readTable(file, ['id']), /encoded data/);
    const abort = new AbortController(); abort.abort(); await assert.rejects(readTable(file, ['id'], abort.signal));
  } finally { await rm(root, { recursive: true, force: true }); }
});
