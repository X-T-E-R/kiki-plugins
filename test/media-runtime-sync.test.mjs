import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mediaCapabilitiesSchema } from '@kiki/plugin-sdk/media';
import { MEDIA_VENDORS, buildMediaPlugins } from '../scripts/build-media.mjs';
import { packageFiles } from '../scripts/package-files.mjs';
import { validateRegistration } from '../scripts/validate-registration.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officialRoot = path.join(repoRoot, 'plugins', 'official');
const allMediaPlugins = ['kiki-media', ...MEDIA_VENDORS.map((vendor) => `kiki-media-${vendor}`)];

test('single-source media-runtime has zero copied runtime.mjs or adapters.mjs files across all media plugins', async () => {
  const canonical = await readFile(path.join(officialRoot, 'media-runtime', 'runtime.mjs'), 'utf8');
  assert.ok(canonical.length > 1000, 'canonical media-runtime/runtime.mjs must be non-empty');
  assert.ok(existsSync(path.join(officialRoot, 'media-runtime', 'entry.mjs')));

  assert.equal(existsSync(path.join(officialRoot, 'kiki-media', 'entry.mjs')), false);
  assert.equal(existsSync(path.join(officialRoot, 'kiki-media', 'lib', 'runtime.mjs')), false);
  assert.equal(existsSync(path.join(officialRoot, 'kiki-media', 'lib', 'sources')), false);
  assert.ok(existsSync(path.join(officialRoot, 'kiki-media', 'src', 'index.mjs')));
  assert.ok(existsSync(path.join(officialRoot, 'kiki-media', 'dist', 'index.mjs')));

  for (const vendor of MEDIA_VENDORS) {
    const pluginDir = path.join(officialRoot, `kiki-media-${vendor}`);
    assert.equal(existsSync(path.join(pluginDir, 'runtime.mjs')), false, `${vendor}: legacy runtime.mjs must be deleted`);
    assert.equal(existsSync(path.join(pluginDir, 'entry.mjs')), false, `${vendor}: legacy entry.mjs must be deleted`);
    assert.equal(existsSync(path.join(pluginDir, 'adapters.mjs')), false, `${vendor}: legacy adapters.mjs must be moved to src/`);
    assert.ok(existsSync(path.join(pluginDir, 'src', 'adapters.mjs')), `${vendor}: src/adapters.mjs missing`);
    assert.ok(existsSync(path.join(pluginDir, 'src', 'index.mjs')), `${vendor}: src/index.mjs missing`);
    assert.ok(existsSync(path.join(pluginDir, 'dist', 'index.mjs')), `${vendor}: dist/index.mjs missing`);

    const adapterSrc = await readFile(path.join(pluginDir, 'src', 'adapters.mjs'), 'utf8');
    assert.match(adapterSrc, /['"]\.\.\/\.\.\/media-runtime\/runtime\.mjs['"]/);
  }
});

test('build-media --check and sync-media --check pass and reject hand-edited dist/index.mjs or re-added runtime.mjs', async () => {
  const buildCheck = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-media.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(buildCheck.status, 0, buildCheck.stderr || buildCheck.stdout);

  const syncCheck = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'sync-media.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(syncCheck.status, 0, syncCheck.stderr || syncCheck.stdout);

  // Verify drift & legacy-copy detection on an isolated scratch plugins tree
  const scratchBase = await mkdtemp(path.join(os.tmpdir(), 'kiki-media-check-guard-'));
  try {
    const tempPlugins = path.join(scratchBase, 'plugins');
    const tempOfficial = path.join(tempPlugins, 'official');
    await mkdir(path.join(tempOfficial, 'media-runtime'), { recursive: true });
    for (const file of ['runtime.mjs', 'entry.mjs', 'LICENSE', 'NOTICE']) {
      await copyFile(path.join(officialRoot, 'media-runtime', file), path.join(tempOfficial, 'media-runtime', file));
    }
    for (const pluginId of allMediaPlugins) {
      const srcRoot = path.join(officialRoot, pluginId);
      const dstRoot = path.join(tempOfficial, pluginId);
      await mkdir(path.join(dstRoot, 'src'), { recursive: true });
      await mkdir(path.join(dstRoot, 'dist'), { recursive: true });
      await copyFile(path.join(srcRoot, 'kimi.plugin.json'), path.join(dstRoot, 'kimi.plugin.json'));
      await copyFile(path.join(srcRoot, 'dist', 'index.mjs'), path.join(dstRoot, 'dist', 'index.mjs'));
      await copyFile(path.join(srcRoot, 'src', 'index.mjs'), path.join(dstRoot, 'src', 'index.mjs'));
      if (pluginId === 'kiki-media') {
        await copyFile(path.join(srcRoot, 'src', 'provider-concurrency.mjs'), path.join(dstRoot, 'src', 'provider-concurrency.mjs'));
        await copyFile(path.join(srcRoot, 'src', 'script.mjs'), path.join(dstRoot, 'src', 'script.mjs'));
      } else {
        await copyFile(path.join(srcRoot, 'src', 'adapters.mjs'), path.join(dstRoot, 'src', 'adapters.mjs'));
        await copyFile(path.join(srcRoot, 'LICENSE'), path.join(dstRoot, 'LICENSE'));
        await copyFile(path.join(srcRoot, 'NOTICE'), path.join(dstRoot, 'NOTICE'));
      }
    }

    await buildMediaPlugins({ pluginsRoot: tempPlugins, check: true });

    // 1. Hand-editing dist/index.mjs must fail --check
    const openaiDist = path.join(tempOfficial, 'kiki-media-openai', 'dist', 'index.mjs');
    const originalDist = await readFile(openaiDist, 'utf8');
    await writeFile(openaiDist, `${originalDist}\n// manual edit\n`, 'utf8');
    await assert.rejects(
      buildMediaPlugins({ pluginsRoot: tempPlugins, check: true }),
      /Generated media artifact drift/,
    );
    await writeFile(openaiDist, originalDist, 'utf8');

    // 2. Re-adding a copied runtime.mjs must fail --check
    const rogueRuntime = path.join(tempOfficial, 'kiki-media-openai', 'runtime.mjs');
    await writeFile(rogueRuntime, '// rogue copy\n', 'utf8');
    await assert.rejects(
      buildMediaPlugins({ pluginsRoot: tempPlugins, check: true }),
      /Forbidden legacy copied media files/,
    );
  } finally {
    await rm(scratchBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('standalone isolation proof: every packaged media plugin loads and registers outside the repo with zero relative media-runtime access', async () => {
  const isolationRoot = await mkdtemp(path.join(os.tmpdir(), 'isolated-plugin-check-'));
  try {
    // Confirm the isolated directory is genuinely outside systems/kiki-plugins
    const relToRepo = path.relative(repoRoot, isolationRoot);
    assert.ok(relToRepo.startsWith('..') || path.isAbsolute(relToRepo), `Isolation dir must be outside repo: ${isolationRoot}`);

    for (const pluginId of allMediaPlugins) {
      const sourceDir = path.join(officialRoot, pluginId);
      const packaged = await packageFiles(sourceDir);
      assert.ok(packaged.includes('kimi.plugin.json'), `${pluginId}: missing kimi.plugin.json in packageFiles`);
      assert.ok(packaged.includes('dist/index.mjs'), `${pluginId}: missing dist/index.mjs in packageFiles`);
      assert.ok(!packaged.some((f) => f.startsWith('src/')), `${pluginId}: src/ must not be packaged in ZIP`);
      assert.ok(!packaged.some((f) => f === 'runtime.mjs' || f.endsWith('/runtime.mjs')), `${pluginId}: runtime.mjs must not be packaged`);

      const isolatedDir = path.join(isolationRoot, pluginId);
      for (const relFile of packaged) {
        const dst = path.join(isolatedDir, relFile);
        await mkdir(path.dirname(dst), { recursive: true });
        await copyFile(path.join(sourceDir, relFile), dst);
      }

      const manifest = JSON.parse(await readFile(path.join(isolatedDir, 'kimi.plugin.json'), 'utf8'));
      assert.equal(manifest['x-kiki'].entry, './dist/index.mjs');

      const entryUrl = pathToFileURL(path.resolve(isolatedDir, manifest['x-kiki'].entry)).href;
      const mod = await import(entryUrl);
      assert.equal(typeof mod.register, 'function', `${pluginId}: register() export missing`);

      // Full contract validation against pinned SDK schemas
      await validateRegistration(manifest, mod.register);

      // Verify every registered media provider responds to describe() with valid SDK capability schema
      const registeredProviders = [];
      const registeredTools = [];
      await mod.register({
        registerMediaProvider(definition, adapter) {
          registeredProviders.push({ definition, adapter });
        },
        registerTool(definition, execute) {
          registeredTools.push({ definition, execute });
        },
      });
      assert.equal(registeredProviders.length, manifest['x-kiki'].mediaProviders.length, `${pluginId}: provider count mismatch`);
      for (const { definition, adapter } of registeredProviders) {
        if (definition.id === 'custom-script') continue;
        const caps = await adapter.describe({}, { settings: {}, signal: new AbortController().signal });
        mediaCapabilitiesSchema.parse(caps);
      }

      if (pluginId === 'kiki-media') {
        assert.equal(registeredTools.length, 2);
        assert.equal(typeof mod.handlePanelRequest, 'function');
        const catalog = await mod.handlePanelRequest('catalog');
        assert.equal(catalog.sources.length, MEDIA_VENDORS.length);
        assert.equal(catalog.providers.length, manifest['x-kiki'].mediaProviders.length);
      }
    }
  } finally {
    await rm(isolationRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
