import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT_DIR = path.join(REPO_ROOT, 'shared', 'panel-kit');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

const THEME_START = '/* @kiki-panel-kit:theme:start */';
const THEME_END = '/* @kiki-panel-kit:theme:end */';
const RUNTIME_START = '/* @kiki-panel-kit:runtime:start */';
const RUNTIME_END = '/* @kiki-panel-kit:runtime:end */';

const normalize = (text) => text.replaceAll('\r\n', '\n');

function stripEsmSyntax(source) {
  return normalize(source)
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '')
    .trim();
}

export async function buildPanelKitAssets() {
  const [themeCssRaw, storageRaw, themeJsRaw, rpcRaw] = await Promise.all([
    readFile(path.join(KIT_DIR, 'theme.css'), 'utf8'),
    readFile(path.join(KIT_DIR, 'storage.mjs'), 'utf8'),
    readFile(path.join(KIT_DIR, 'theme.mjs'), 'utf8'),
    readFile(path.join(KIT_DIR, 'rpc.mjs'), 'utf8'),
  ]);

  const themeCss = [
    THEME_START,
    '/* GENERATED from shared/panel-kit/theme.css — run `npm run sync:panels`; do not edit this block. */',
    normalize(themeCssRaw).trim(),
    THEME_END,
  ].join('\n');

  const runtimeBody = [
    '// GENERATED from shared/panel-kit/{storage,theme,rpc}.mjs — run `npm run sync:panels`; do not edit this block.',
    'const KikiPanelKit = (() => {',
    indentBlock(stripEsmSyntax(storageRaw), '  '),
    '',
    indentBlock(stripEsmSyntax(themeJsRaw), '  '),
    '',
    indentBlock(stripEsmSyntax(rpcRaw), '  '),
    '',
    '  return {',
    '    createSafeStorage,',
    '    safeStorage,',
    '    copyTextSafe,',
    '    randomId,',
    '    applyThemeName,',
    '    initThemeFromUrl,',
    '    applyPresentation,',
    '    PANEL_CHANNEL,',
    '    DEFAULT_RPC_TIMEOUT_MS,',
    '    createPanelClient,',
    '    openManagedStream,',
    '  };',
    '})();',
  ].join('\n');

  if (/<\/script>/i.test(runtimeBody)) {
    throw new Error('Compiled panel-kit runtime contains forbidden </script> sequence');
  }
  if (/\p{Extended_Pictographic}/u.test(runtimeBody) || /\p{Extended_Pictographic}/u.test(themeCss)) {
    throw new Error('Compiled panel-kit assets must contain zero Emoji');
  }
  // Verify compiled inline script is valid classic JS (compatible with vm.runInContext tests and sandboxed iframes).
  new vm.Script(runtimeBody, { filename: 'shared/panel-kit/runtime.inline.js' });

  const runtimeJs = [RUNTIME_START, runtimeBody, RUNTIME_END].join('\n');
  return { themeCss, runtimeJs };
}

function indentBlock(text, prefix) {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

function replaceBlock(html, startMarker, endMarker, replacement, filePath) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 && endIdx === -1) return { html, matched: false };
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Malformed panel-kit markers in ${filePath}`);
  }
  const lineStart = html.lastIndexOf('\n', startIdx) + 1;
  const linePrefix = html.slice(lineStart, startIdx);
  const indent = /^[ \t]*$/.test(linePrefix) ? linePrefix : '';
  const indented = indent ? indentBlock(replacement, indent) : replacement;
  const next = html.slice(0, lineStart) + indented + html.slice(endIdx + endMarker.length);
  return { html: next, matched: true };
}

async function discoverPanelHtmlFiles() {
  const results = [];
  const roots = [PLUGINS_DIR];
  const officialDir = path.join(PLUGINS_DIR, 'official');
  if (existsSync(officialDir)) roots.push(officialDir);

  for (const dir of roots) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'official' || entry.name === 'cdn') continue;
      const pluginRoot = path.join(dir, entry.name);
      for (const file of ['panel.html', 'settings.html']) {
        const candidate = path.join(pluginRoot, file);
        if (existsSync(candidate)) results.push(candidate);
      }
    }
  }
  return results;
}

export async function syncPanelKit({ check = false } = {}) {
  const { themeCss, runtimeJs } = await buildPanelKitAssets();
  const files = await discoverPanelHtmlFiles();
  const synced = [];
  const drifted = [];

  for (const filePath of files) {
    const originalRaw = await readFile(filePath, 'utf8');
    const original = normalize(originalRaw);
    const themeRes = replaceBlock(original, THEME_START, THEME_END, themeCss, filePath);
    const runtimeRes = replaceBlock(themeRes.html, RUNTIME_START, RUNTIME_END, runtimeJs, filePath);
    if (!themeRes.matched && !runtimeRes.matched) continue;

    synced.push(path.relative(REPO_ROOT, filePath).replaceAll('\\', '/'));
    if (runtimeRes.html !== original) {
      if (check) {
        drifted.push(path.relative(REPO_ROOT, filePath).replaceAll('\\', '/'));
      } else {
        await writeFile(filePath, runtimeRes.html, 'utf8');
      }
    }
  }

  if (check && drifted.length > 0) {
    throw new Error(`Panel kit drift detected in:\n  - ${drifted.join('\n  - ')}\nRun \`npm run sync:panels\` to resynchronize.`);
  }
  return { synced, drifted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const { synced } = await syncPanelKit({ check });
  console.log(`${check ? 'Checked' : 'Synced'} panel-kit in ${synced.length} panel(s)`);
}
