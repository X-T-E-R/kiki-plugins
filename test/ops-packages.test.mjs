import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yauzl from 'yauzl';
import { packLocalPlugin } from '../scripts/pack.mjs';

const ids = ['controller-ledger', 'argon-error-recovery', 'argon-tool-result-appendix'];

test('ops packages stay outside the public catalog and ship their declared hook runtime', async () => {
  const catalog = JSON.parse(await readFile('plugins/marketplace.json', 'utf8'));
  const outDir = await mkdtemp(resolve('.tmp/ops-packages-'));
  try {
    for (const id of ids) {
      assert.equal(catalog.plugins.some(plugin => plugin.id === id), false);
      const manifest = JSON.parse(await readFile(`plugins/${id}/kimi.plugin.json`, 'utf8'));
      const file = await packLocalPlugin({ id, outDir });
      assert.equal(file, join(outDir, `${id}-${manifest.version}.zip`));
      const entries = await new Promise((resolveEntries, reject) => {
        yauzl.open(file, { lazyEntries: true }, (error, zip) => {
          if (error) { reject(error); return; }
          const names = [];
          zip.on('error', reject);
          zip.on('end', () => resolveEntries(names));
          zip.on('entry', entry => { names.push(entry.fileName); zip.readEntry(); });
          zip.readEntry();
        });
      });
      assert.ok(entries.includes(`${id}/LICENSE`));
      assert.ok(!entries.some(name => name.includes('/test/') || name.includes('/node_modules/')));
      for (const hook of manifest.hooks ?? []) {
        assert.match(hook.command, /^node \.\//);
        assert.ok(entries.includes(`${id}/${hook.command.slice('node ./'.length)}`));
      }
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('public appendix defaults require explicit model opt-in', async () => {
  const manifest = JSON.parse(await readFile('plugins/argon-tool-result-appendix/kimi.plugin.json', 'utf8'));
  assert.deepEqual(manifest['x-kiki'].requestProjection.defaultModels, []);
  assert.equal(manifest['x-kiki'].settings.schema.properties.targetModels.default, '');
});
