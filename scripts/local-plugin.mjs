import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function resolveLocalPlugin(id, pluginsRoot = resolve('plugins')) {
  assert.match(id, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid local plugin id');
  const matches = [];
  for (const source of [`./official/${id}`, `./${id}`]) {
    const root = resolve(pluginsRoot, source);
    let raw;
    try { raw = await readFile(resolve(root, 'kimi.plugin.json'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const manifest = JSON.parse(raw);
    assert.equal(manifest.name, id, `Local package identity mismatch: ${id}`);
    matches.push({ id, source, root, manifest });
  }
  assert.ok(matches.length > 0, `No local package selected: ${id}`);
  assert.equal(matches.length, 1, `Ambiguous local package: ${id}`);
  return matches[0];
}
