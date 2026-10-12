import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const host = process.env.KIKI_HOST_REPO;
if (host === undefined || host.length === 0) throw new Error('KIKI_HOST_REPO is required');
const { satisfies, validRange } = createRequire(`${host}/packages/agent-core-v2/package.json`)('semver');

test('the task board bridge range rejects 0.4.0 and accepts 0.4.1', async () => {
  const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
  const range = manifest['x-kiki'].engines.kiki;
  assert.equal(range, '>=0.4.1');
  assert.notEqual(validRange(range), null);
  assert.equal(satisfies('0.4.0', range), false);
  assert.equal(satisfies('0.4.1', range), true);
  assert.equal(satisfies('0.4.2', range), true);
});
