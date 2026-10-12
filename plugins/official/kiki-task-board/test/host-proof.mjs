import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeWorkDirKey } from '../lib/paths.mjs';

const hostRoot = process.env.KIKI_HOST_REPO;
if (!hostRoot) throw new Error('Set KIKI_HOST_REPO to the Kiki host worktree');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PluginHost } = await import(pathToFileURL(path.join(hostRoot, 'packages/agent-core-v2/src/app/plugin/host.ts')).href);
const { parseManifest } = await import(pathToFileURL(path.join(hostRoot, 'packages/agent-core-v2/src/app/plugin/manifest.ts')).href);

const parsed = await parseManifest(pluginRoot);
const errors = parsed.diagnostics.filter((item) => item.severity === 'error');
assert.deepEqual(errors, [], JSON.stringify(errors));
const tools = parsed.manifest.kiki.tools;
const entry = path.resolve(pluginRoot, parsed.manifest.kiki.entry);

const root = await mkdtemp(path.join(tmpdir(), 'kiki-task-board-host-'));
const home = path.join(root, 'home');
const workspace = path.join(root, 'workspace');
await mkdir(home);
await mkdir(workspace);
const workspaceId = encodeWorkDirKey(workspace);
await writeFile(path.join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { [workspaceId]: { root: workspace, name: 'Proof' } } }));

const host = new PluginHost('kiki-task-board', entry, tools, [], [], undefined, home);
const bare = new PluginHost('kiki-task-board', entry, tools);
const signal = new AbortController().signal;
const proofDir = path.join(pluginRoot, '.tmp', 'proof');
await mkdir(proofDir, { recursive: true });

try {
  const created = await host.execute('BoardWrite', {
    action: 'create', workspaceId, requestKey: 'host-proof', title: 'Host card', description: 'From PluginHost', priority: 'P1',
  }, signal, undefined, {}, { workspaceId });
  assert.notEqual(created.isError, true, created.output);
  const createdValue = JSON.parse(created.output);
  assert.equal(createdValue.ok, true);
  assert.equal(createdValue.value.title, 'Host card');
  const listed = await host.execute('BoardRead', { action: 'list', workspaceId }, signal, undefined, {}, { workspaceId });
  assert.notEqual(listed.isError, true, listed.output);
  const cards = JSON.parse(listed.output).value.cards;
  assert.equal(cards.some((card) => card.id === createdValue.value.id), true);
  const shown = await host.execute('BoardRead', {
    action: 'show', workspaceId, storage: createdValue.value.storage, id: createdValue.value.id,
  }, signal, undefined, {}, { workspaceId });
  assert.equal(JSON.parse(shown.output).value.description, 'From PluginHost');
  await assert.rejects(host.execute('BoardMissing', {}, signal), /did not register BoardMissing/);

  const denied = await bare.execute('BoardWrite', {
    action: 'create', workspaceId, requestKey: 'no-home', title: 'No home',
  }, signal, undefined, {}, { workspaceId });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.output).error.code, 'BOARD_UNAVAILABLE');

  const panelSaved = await host.requestPanel('write', {
    action: 'create', workspaceId, requestKey: 'panel-proof', title: 'Panel card', description: 'From the panel bridge', priority: 'P2',
  }, {});
  assert.equal(panelSaved.ok, true);

  const gui = createRequire(path.join(hostRoot, 'apps/kiki-gui/package.json'));
  const { chromium } = gui('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.exposeFunction('kikiBridge', (action, args) => host.requestPanel(action, args, {}));
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#f3efe6}iframe{width:100%;height:100%;border:0}</style><iframe id="panel" sandbox="allow-scripts"></iframe><script>
      const frame = document.getElementById('panel');
      window.addEventListener('message', async (event) => {
        if (event.source !== frame.contentWindow || event.origin !== 'null') return;
        const data = event.data;
        if (!data || data.channel !== 'kiki.panel.v1' || data.kind !== 'request') return;
        try {
          const result = await window.kikiBridge(data.action, data.args);
          frame.contentWindow.postMessage({ channel: 'kiki.panel.v1', kind: 'response', id: data.id, ok: true, result }, '*');
        } catch (error) {
          frame.contentWindow.postMessage({ channel: 'kiki.panel.v1', kind: 'response', id: data.id, ok: false, error: String(error) }, '*');
        }
      });
      frame.addEventListener('load', () => frame.contentWindow.postMessage({ channel: 'kiki.panel.v1', kind: 'init' }, '*'));
    </script>`, { waitUntil: 'domcontentloaded' });
    const panelHtml = await readFile(path.join(pluginRoot, 'panel.html'), 'utf8');
    await page.locator('#panel').evaluate((frame, html) => { frame.srcdoc = html; }, panelHtml);
    const board = page.frameLocator('#panel');
    await board.locator('#workspace option[value="' + workspaceId + '"]').waitFor({ state: 'attached' });
    await board.locator('article h3', { hasText: 'Panel card' }).waitFor();
    await board.locator('#card-title').fill('Wide card');
    await board.locator('#detail').fill('Saved on a wide panel');
    await board.locator('#save').click();
    try {
      await board.locator('article h3', { hasText: 'Wide card' }).waitFor({ timeout: 8000 });
    } catch (error) {
      const status = await board.locator('#status').textContent();
      const text = await board.locator('body').innerText();
      await page.screenshot({ path: path.join(proofDir, 'panel-save-failed.png'), fullPage: true });
      throw new Error(`Panel save did not show the card. status=${JSON.stringify(status)} body=${JSON.stringify(text)}`, { cause: error });
    }
    await board.locator('#status.ok').waitFor();
    const hostCard = board.locator('article').filter({ hasText: 'Host card' });
    await hostCard.locator('select').selectOption('done');
    await board.locator('h2', { hasText: /完成 · 1|Done · 1/ }).waitFor();
    const moved = JSON.parse((await host.execute('BoardRead', {
      action: 'show', workspaceId, storage: createdValue.value.storage, id: createdValue.value.id,
    }, signal, undefined, {}, { workspaceId })).output);
    assert.equal(moved.value.status, 'done');
    const wide = path.join(proofDir, 'panel-1440.png');
    await page.screenshot({ path: wide, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await board.locator('article h3', { hasText: 'Wide card' }).waitFor();
    const narrow = path.join(proofDir, 'panel-390.png');
    await page.screenshot({ path: narrow, fullPage: true });
    const after = JSON.parse((await host.execute('BoardRead', { action: 'list', workspaceId, limit: 100 }, signal, undefined, {}, { workspaceId })).output);
    assert.equal(after.value.cards.some((card) => card.title === 'Wide card'), true);
    const receipt = { home, workspaceId, card: createdValue.value, screenshots: [wide, narrow], listed: after.value.cards.map((card) => card.title) };
    await writeFile(path.join(proofDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  await host.stopAndWait();
  await bare.stopAndWait();
}
