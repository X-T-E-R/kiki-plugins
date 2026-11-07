import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
export const DEFAULT_COMPAT_STAGE_DIR = path.join(repoRoot, '.tmp', 'magpie-harness-quota-compat');
const STAGE_MARKER_FILE = '.kiki-live-compat-stage.json';

function normalizePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function statOrNull(targetPath) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function isDedicatedCompatStageDir(targetDir) {
  const markerRaw = await readFile(path.join(targetDir, STAGE_MARKER_FILE), 'utf8').catch(() => null);
  if (!markerRaw) return false;
  try {
    const parsed = JSON.parse(markerRaw);
    return parsed?.pluginId === 'magpie-harness-quota' && parsed?.kind === 'kiki-0.4.3-live-compat';
  } catch {
    return false;
  }
}

/**
 * Stages a zero-duplicate, single-source compatible plugin directory for Kiki 0.4.3 hosts
 * whose `parsePluginExtension` has not yet merged `x-kiki.harnessQuotaSources`
 * or `x-kiki.harnessAccountSources`.
 *
 * Recycle contract:
 * - A missing directory, or an empty directory, is created and filled.
 * - A non-empty directory is replaced only when it already carries this plugin's stage marker
 *   (`.kiki-live-compat-stage.json` with `pluginId=magpie-harness-quota` and
 *   `kind=kiki-0.4.3-live-compat`). That covers a repeat run of the default
 *   `.tmp/magpie-harness-quota-compat` path and any custom directory this script staged before.
 * - Any other existing non-empty directory, including the default path without that marker,
 *   is left untouched and staging fails closed.
 */
export async function stageLiveCompatPlugin({ outputDir, compatStageDir } = {}) {
  const isExplicitCustomOut = outputDir !== undefined && outputDir !== null && String(outputDir).trim() !== '';
  const dedicatedDir = compatStageDir ? path.resolve(String(compatStageDir)) : DEFAULT_COMPAT_STAGE_DIR;
  const targetDir = isExplicitCustomOut ? path.resolve(String(outputDir)) : dedicatedDir;

  const forbiddenRoots = new Set([
    normalizePathKey(repoRoot),
    normalizePathKey(pluginRoot),
    normalizePathKey(path.parse(targetDir).root),
  ]);
  if (forbiddenRoots.has(normalizePathKey(targetDir))) {
    throw new Error(`Refusing to stage into protected directory: ${targetDir}`);
  }

  const existingStat = await statOrNull(targetDir);
  if (existingStat) {
    if (!existingStat.isDirectory()) {
      throw new Error(`Refusing to overwrite non-directory output path: ${targetDir}`);
    }
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      const recyclable = await isDedicatedCompatStageDir(targetDir);
      if (!recyclable) {
        throw new Error(
          `Refusing to overwrite existing non-empty directory: ${targetDir}. A directory is replaced only when it already carries ${STAGE_MARKER_FILE} for magpie-harness-quota. Omit outputDir to use ${DEFAULT_COMPAT_STAGE_DIR} after that marker exists, or pass a new empty directory.`,
        );
      }
      await rm(targetDir, { recursive: true, force: true });
    }
  }

  await mkdir(targetDir, { recursive: true });

  const manifestRaw = JSON.parse(await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
  const {
    harnessQuotaSources: _omittedQuotaSources,
    harnessAccountSources: _omittedAccountSources,
    ...compatXKiki
  } = manifestRaw['x-kiki'] ?? {};
  const compatManifest = {
    ...manifestRaw,
    'x-kiki': compatXKiki,
  };

  await writeFile(path.join(targetDir, 'kimi.plugin.json'), `${JSON.stringify(compatManifest, null, 2)}\n`, 'utf8');
  await cp(path.join(pluginRoot, 'entry.mjs'), path.join(targetDir, 'entry.mjs'));
  await cp(path.join(pluginRoot, 'lib'), path.join(targetDir, 'lib'), { recursive: true });
  await cp(path.join(pluginRoot, 'LICENSE'), path.join(targetDir, 'LICENSE'));
  await cp(path.join(pluginRoot, 'README.md'), path.join(targetDir, 'README.md'));
  await writeFile(
    path.join(targetDir, STAGE_MARKER_FILE),
    `${JSON.stringify({ kind: 'kiki-0.4.3-live-compat', pluginId: compatManifest.name, version: compatManifest.version }, null, 2)}\n`,
    'utf8',
  );

  return {
    outputDir: targetDir,
    pluginId: compatManifest.name,
    version: compatManifest.version,
  };
}

const isDirectCli = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectCli) {
  const customOut = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const staged = await stageLiveCompatPlugin({ outputDir: customOut });
  process.stdout.write(`${JSON.stringify(staged)}\n`);
}
