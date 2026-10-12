import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { satisfies, validRange } from 'semver';

test('the task board bridge range rejects 0.4.0 and accepts 0.4.1', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const range = manifest['x-kiki'].engines.kiki;
  assert.equal(range, '>=0.4.1');
  assert.notEqual(validRange(range), null);
  assert.equal(satisfies('0.4.0', range), false);
  assert.equal(satisfies('0.4.1', range), true);
  assert.equal(satisfies('0.4.2', range), true);
});
