#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import yazl from 'yazl';

import { readPluginManifestVersion } from './plugin-manifest-version.mjs';
import { packageFiles } from './package-files.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_PLUGINS_ROOT = resolve(REPO_ROOT, 'plugins');
const DEFAULT_OUT_DIR = resolve(DEFAULT_PLUGINS_ROOT, 'cdn');
const SENTINEL = '.kimi-plugin-marketplace-build.json';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set(['.DS_Store']);
const EXTRA_CDN_PLUGIN_SOURCES = [];
const ICON_TYPES = new Set(['.svg', '.png', '.webp', '.jpg', '.jpeg']);
/** Placeholder rewritten to the published base URL so the index has real, fetchable asset URLs. */
const PUBLIC_BASE_FLAG = '--public-base-url';
const DEFAULT_PUBLIC_BASE = './';

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const pluginsRoot = resolve(options.pluginsRoot ?? DEFAULT_PLUGINS_ROOT);
    const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
    const publicBaseUrl = options.publicBaseUrl ?? DEFAULT_PUBLIC_BASE;
    await buildPluginMarketplaceCdn({ pluginsRoot, outDir, publicBaseUrl });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Build the publishable marketplace.
 *
 * Every official package becomes a versioned, immutable archive at
 * `official/<id>/<id>-<version>.zip` beside its sha256 and its icon as a
 * versioned static asset, and the index entry carries all three. That is what
 * makes a remote install real rather than listed: the installer refuses a ZIP
 * without a matching digest, and a card before install has nothing to show
 * unless the icon is a URL the client can actually fetch.
 */
export async function buildPluginMarketplaceCdn({ pluginsRoot, outDir, publicBaseUrl = DEFAULT_PUBLIC_BASE, reuse = new Map() }) {
  assertSafeOutputDir(pluginsRoot, outDir);

  const marketplacePath = resolveInsideRoot(pluginsRoot, 'marketplace.json');
  const raw = await readFile(marketplacePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error('plugins/marketplace.json must contain a "plugins" array.');
  }
  if (parsed.plugins.some((entry) =>
    isRecord(entry) && typeof entry.source === 'string' &&
    /^\.\/official\/kiki-media(?:-(?:openai|google|ark|xai|minimax|stepfun|novita|agnes|newapi|comfyui))?$/.test(entry.source))) {
    await promisify(execFile)(process.execPath, [
      resolveInsideRoot(pluginsRoot, 'official/media-runtime/distribute.mjs'),
      '--check',
    ]);
  }
  await prepareOutputDir(outDir);

  const archives = [];
  const plugins = [];
  for (const entry of parsed.plugins) {
    if (!isRecord(entry) || typeof entry.source !== 'string') {
      plugins.push(entry);
      continue;
    }
    const previous = reuse.get(entry.id);
    const result = previous === undefined
      ? await materializeEntrySource(entry.source, pluginsRoot, outDir, publicBaseUrl)
      : { ...previous, icon: await publishIcon(resolveInsideRoot(pluginsRoot, entry.source), entry.id, previous.version, outDir, publicBaseUrl) };
    let stamped = { ...entry, source: result.source };
    if (isLocalRelativeSource(entry.source)) {
      // Stamp the version from the plugin's real manifest so "latest" stays truthful.
      const version = await readPluginManifestVersion(resolveInsideRoot(pluginsRoot, entry.source));
      if (version !== undefined) stamped = { ...stamped, version };
    }
    if (result.sha256 !== undefined) stamped = { ...stamped, sha256: result.sha256 };
    if (result.icon !== undefined) stamped = { ...stamped, icon: result.icon };
    if (result.engines !== undefined) stamped = { ...stamped, engines: result.engines };
    plugins.push(stamped);
    if (result.archive !== undefined) archives.push(result.archive);
    if (result.icon !== undefined) archives.push(result.icon);
  }

  // WebBridge is injected by v2 clients rather than listed in the remote
  // catalog, but its managed plugin still needs a CDN artifact.
  for (const source of EXTRA_CDN_PLUGIN_SOURCES) {
    const archive = stripRelativePrefix(withZipExtension(source));
    if (archives.includes(archive)) continue;
    const result = await materializeEntrySource(source, pluginsRoot, outDir, publicBaseUrl);
    if (result.archive !== undefined) archives.push(result.archive);
  }

  const outputMarketplace = {
    ...parsed,
    plugins,
  };
  await writeFile(
    resolveInsideRoot(outDir, 'marketplace.json'),
    JSON.stringify(outputMarketplace, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    resolveInsideRoot(outDir, SENTINEL),
    JSON.stringify(
      {
        generatedBy: 'build-plugin-marketplace-cdn',
        generatedAt: new Date().toISOString(),
        pluginsRoot,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  process.stdout.write(`Plugin marketplace CDN artifacts written to ${outDir}\n`);
  process.stdout.write(`  marketplace.json\n`);
  for (const archive of archives) {
    process.stdout.write(`  ${archive}\n`);
  }
}

async function materializeEntrySource(source, pluginsRoot, outDir, publicBaseUrl) {
  if (!isLocalRelativeSource(source)) return { source };

  const sourcePath = resolveInsideRoot(pluginsRoot, source);
  const info = await stat(sourcePath).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`Marketplace source does not exist: ${source}`);
  }

  if (info.isDirectory()) {
    const version = await readPluginManifestVersion(sourcePath);
    const id = basename(sourcePath);
    // A versioned file name means an old index keeps resolving the exact
    // archive it was published against, even after a newer version ships.
    const zipRel = version === undefined
      ? stripRelativePrefix(withZipExtension(source))
      : `official/${id}/${id}-${version}.zip`;
    const target = resolveInsideRoot(outDir, zipRel);
    await zipDirectory(sourcePath, target);
    const sha256 = await sha256Of(target);
    const icon = await publishIcon(sourcePath, id, version, outDir, publicBaseUrl);
    const engines = await readPluginEngines(sourcePath);
    return {
      source: publicUrl(publicBaseUrl, zipRel),
      archive: zipRel,
      sha256,
      ...(icon === undefined ? {} : { icon }),
      ...(engines === undefined ? {} : { engines }),
    };
  }

  if (info.isFile() && extname(sourcePath) === '.zip') {
    const zipRel = stripRelativePrefix(source);
    const target = resolveInsideRoot(outDir, zipRel);
    await mkdir(dirname(target), { recursive: true });
    await cp(sourcePath, target);
    return { source: publicUrl(publicBaseUrl, zipRel), archive: zipRel, sha256: await sha256Of(target) };
  }

  throw new Error(`Marketplace source must be a directory or .zip file: ${source}`);
}

/**
 * Copies the package icon out as a standalone, versioned asset. An icon
 * inside the archive is unreachable before install, so a card would have
 * nothing to draw; published this way the catalog can point at it directly.
 */
async function publishIcon(sourceRoot, id, version, outDir, publicBaseUrl) {
  const manifest = await readJson(resolve(sourceRoot, 'kimi.plugin.json'));
  const declared = manifest?.icon;
  if (typeof declared !== 'string') return undefined;
  const name = declared.replace(/^\.\//, '');
  if (!ICON_TYPES.has(extname(name).toLowerCase())) return undefined;
  const iconPath = resolve(sourceRoot, name);
  if (!(await stat(iconPath).then((info) => info.isFile()).catch(() => false))) return undefined;
  const iconRel = `official/${id}/icon-${version ?? 'latest'}${extname(name).toLowerCase()}`;
  const target = resolveInsideRoot(outDir, iconRel);
  await mkdir(dirname(target), { recursive: true });
  await cp(iconPath, target);
  return publicUrl(publicBaseUrl, iconRel);
}

/** The engine range the package declares, so the catalog filters on the real contract. */
async function readPluginEngines(sourceRoot) {
  const manifest = await readJson(resolve(sourceRoot, 'kimi.plugin.json'));
  const kiki = manifest?.['x-kiki']?.engines?.kiki ?? manifest?.kiki?.engines?.kiki;
  return typeof kiki === 'string' ? { kiki } : undefined;
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** A relative base keeps a locally served index self-contained. */
function publicUrl(publicBaseUrl, relativePath) {
  return `${publicBaseUrl.replace(/\/*$/, '/')}${relativePath}`;
}

async function zipDirectory(sourceRoot, outputFile) {
  await mkdir(dirname(outputFile), { recursive: true });
  const zipfile = new yazl.ZipFile();
  const output = createWriteStream(outputFile);
  const done = new Promise((resolveDone, rejectDone) => {
    output.on('close', resolveDone);
    output.on('error', rejectDone);
    zipfile.outputStream.on('error', rejectDone);
  });
  zipfile.outputStream.pipe(output);
  await addDirectoryToZip(zipfile, sourceRoot, basename(sourceRoot));
  zipfile.end();
  await done;
}

async function addDirectoryToZip(zipfile, root, zipRoot) {
  for (const file of await packageFiles(root)) {
    zipfile.addFile(resolve(root, file), `${zipRoot}/${file}`, { mtime: new Date('1980-01-01T00:00:00Z'), mode: 0o100644 });
  }
}

async function prepareOutputDir(outDir) {
  const existing = await stat(outDir).catch(() => undefined);
  if (existing === undefined) {
    await mkdir(outDir, { recursive: true });
    return;
  }
  if (!existing.isDirectory()) {
    throw new Error(`Output path exists and is not a directory: ${outDir}`);
  }
  const entries = await readdir(outDir);
  if (entries.length > 0 && !entries.includes(SENTINEL)) {
    throw new Error(
      `Refusing to overwrite non-generated output directory: ${outDir}\n` +
        `Choose an empty --out-dir or remove it manually.`,
    );
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

function assertSafeOutputDir(pluginsRoot, outDir) {
  if (outDir === pluginsRoot) {
    throw new Error('Output directory must not be the plugins root.');
  }
  if (isWithin(pluginsRoot, outDir)) {
    throw new Error('Output directory must not contain the plugins root.');
  }
}

function resolveInsideRoot(root, input) {
  const resolved = resolve(root, input);
  if (!isWithin(resolved, root)) {
    throw new Error(`Path escapes root: ${input}`);
  }
  return resolved;
}

function isWithin(candidate, root) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isLocalRelativeSource(source) {
  const trimmed = source.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('file://') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('~/') &&
    trimmed !== '~'
  );
}

function withZipExtension(source) {
  const trimmed = source.trim().replace(/\/+$/, '');
  return extname(trimmed) === '.zip' ? trimmed : `${trimmed}.zip`;
}

function stripRelativePrefix(source) {
  return source.trim().replace(/^\.\//, '');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--plugins-root') {
      out.pluginsRoot = requiredValue(args, ++i, arg);
      continue;
    }
    if (arg === '--out-dir') {
      out.outDir = requiredValue(args, ++i, arg);
      continue;
    }
    if (arg === PUBLIC_BASE_FLAG) {
      out.publicBaseUrl = requiredValue(args, ++i, arg);
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Usage: pnpm run build:plugin-marketplace [-- --out-dir <dir>]\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Build CDN-ready plugin marketplace artifacts.\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --plugins-root <dir>     Source plugins root. Default: ${DEFAULT_PLUGINS_ROOT}\n`);
  process.stdout.write(`  --out-dir <dir>          Output directory. Default: ${DEFAULT_OUT_DIR}\n`);
  process.stdout.write(`  --public-base-url <url>  Base URL the index's archive and icon URLs are written\n`);
  process.stdout.write(`                          against. Default: ${DEFAULT_PUBLIC_BASE} (relative, for a\n`);
  process.stdout.write(`                          locally served index)\n`);
}
