import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officialRoot = path.join(repoRoot, 'plugins', 'official');
const vendors = ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui'];

const normalize = (text) => text.replaceAll('\r\n', '\n');
const stripGeneratedBanner = (text) => normalize(text).replace(/^\/\/ GENERATED [^\n]*\n/, '');

test('all 12 media runtime copies stay byte-exact with media-runtime/runtime.mjs canonical source', async () => {
  const canonical = normalize(await readFile(path.join(officialRoot, 'media-runtime', 'runtime.mjs'), 'utf8'));
  assert.ok(canonical.length > 1000, 'canonical media runtime must be non-empty');

  const unifiedRaw = normalize(await readFile(path.join(officialRoot, 'kiki-media', 'lib', 'runtime.mjs'), 'utf8'));
  assert.match(unifiedRaw, /^\/\/ GENERATED from \.\.\/\.\.\/media-runtime\/runtime\.mjs\./);
  assert.equal(stripGeneratedBanner(unifiedRaw), canonical, 'kiki-media/lib/runtime.mjs drifted from canonical source');

  for (const vendor of vendors) {
    const copyRaw = normalize(await readFile(path.join(officialRoot, `kiki-media-${vendor}`, 'runtime.mjs'), 'utf8'));
    assert.match(copyRaw, /^\/\/ GENERATED from \.\.\/media-runtime\/runtime\.mjs\./);
    assert.equal(stripGeneratedBanner(copyRaw), canonical, `kiki-media-${vendor}/runtime.mjs drifted from canonical source`);

    const donorAdapter = normalize(await readFile(path.join(officialRoot, `kiki-media-${vendor}`, 'adapters.mjs'), 'utf8'));
    const unifiedAdapter = normalize(await readFile(path.join(officialRoot, 'kiki-media', 'lib', 'sources', `${vendor}.mjs`), 'utf8'));
    assert.match(unifiedAdapter, new RegExp(`^// GENERATED from \\.\\./\\.\\./kiki-media-${vendor}/adapters\\.mjs\\.`));
    assert.equal(
      stripGeneratedBanner(unifiedAdapter),
      donorAdapter.replace("'./runtime.mjs'", "'../runtime.mjs'"),
      `kiki-media/lib/sources/${vendor}.mjs drifted from donor adapter`,
    );
  }
});

test('unified scripts/sync-media.mjs --check passes end-to-end', () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'sync-media.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
