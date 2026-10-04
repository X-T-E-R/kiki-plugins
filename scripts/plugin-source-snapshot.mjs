#!/usr/bin/env node
/**
 * Print the first-party plugin source snapshot: exactly which package trees a
 * separate publish repository must copy, what each one is called, and a
 * content fingerprint that changes only when the bytes of that package change.
 *
 * The point is a handoff that can be verified on both sides. A path list alone
 * goes stale silently; a per-package digest does not, so the copy repository
 * can prove it holds the same bytes rather than merely the same names.
 *
 *   node scripts/plugin-source-snapshot.mjs            # summary + digests
 *   node scripts/plugin-source-snapshot.mjs --paths    # copy list only
 *   node scripts/plugin-source-snapshot.mjs --json     # machine-readable
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_ROOT = join(REPO_ROOT, 'plugins');
const OFFICIAL = join(PLUGINS_ROOT, 'official');
const SHARED_RUNTIME = join(OFFICIAL, 'media-runtime');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp']);

/** Files that never belong in a published package. */
const SKIP_FILES = new Set(['.DS_Store']);

async function walk(root, prefix = '') {
  const out = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path, `${prefix}${entry.name}/`));
    else out.push(`${prefix}${entry.name}`);
  }
  return out;
}

/** Digest of one package's file contents, independent of mtime and ordering. */
async function digestOf(root) {
  const hash = createHash('sha256');
  for (const relativePath of await walk(root)) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(join(root, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collect() {
  const catalog = JSON.parse(await readFile(join(PLUGINS_ROOT, 'marketplace.json'), 'utf8'));
  const listed = new Map(catalog.plugins.filter((e) => e.tier === 'official').map((e) => [e.id, e]));
  const packages = [];
  for (const dir of (await readdir(OFFICIAL, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory() || SKIP_DIRS.has(dir.name)) continue;
    const root = join(OFFICIAL, dir.name);
    const manifestPath = join(root, 'kimi.plugin.json');
    const manifest = await readFile(manifestPath, 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => undefined);
    // media-runtime is shared source, not an installable package: it ships
    // inside the ten provider packages rather than as one of its own.
    if (manifest === undefined) continue;
    const entry = listed.get(manifest.name);
    packages.push({
      id: manifest.name,
      directory: dir.name,
      version: manifest.version,
      displayName: entry?.displayName ?? manifest.interface?.displayName ?? manifest.name,
      engines: manifest['x-kiki']?.engines?.kiki ?? manifest.kiki?.engines?.kiki,
      license: manifest.license,
      hasIcon: await stat(join(root, 'icon.svg')).then((s) => s.isFile()).catch(() => false),
      sharedRuntime: false,
      source: `plugins/official/${dir.name}`,
      sha256: await digestOf(root),
    });
  }
  const runtime = await stat(join(SHARED_RUNTIME, 'distribute.mjs')).then((s) => s.isFile()).catch(() => false)
    ? [{
      id: '(shared) media-runtime',
      directory: 'media-runtime',
      version: undefined,
      displayName: 'Shared media distribution runtime',
      engines: undefined,
      license: undefined,
      hasIcon: false,
      sharedRuntime: true,
      source: 'plugins/official/media-runtime',
      sha256: await digestOf(SHARED_RUNTIME),
    }]
    : [];
  return { packages, runtime, catalog };
}

const { packages, runtime } = await collect();
const all = [...packages, ...runtime];
const argv = process.argv.slice(2);

if (argv.includes('--paths')) {
  for (const item of all) process.stdout.write(`${item.source}\n`);
} else if (argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ packages: all }, null, 2)}\n`);
} else {
  process.stdout.write(`First-party plugin source snapshot: ${packages.length} packages + ${runtime.length} shared\n\n`);
  for (const item of all) {
    const tags = [item.version, item.engines, item.license, item.hasIcon ? 'icon' : undefined]
      .filter(Boolean).join('  ');
    process.stdout.write(`${item.id.padEnd(20)} ${item.source.padEnd(38)} ${tags}\n  sha256 ${item.sha256}\n`);
  }
}
