import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { satisfies } from 'semver';
import { packageFiles } from '../../../scripts/package-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
const sdkLock = JSON.parse(await readFile(path.join(repo, 'sdk.lock.json'), 'utf8'));
assert.equal(manifest.name, 'kiki-mail');
assert.equal(manifest.version, '0.2.1');
assert.equal(satisfies(sdkLock.pluginEngineVersion, manifest['x-kiki'].engines.kiki), true);
const files = await packageFiles(root);
for (const required of [
  'kimi.plugin.json', 'entry.mjs', 'panel.html', 'README.md', 'LICENSE', 'NOTICE',
  'THIRD_PARTY_NOTICES.md', 'icon.svg', 'lib/service.mjs', 'vendor/runtime.mjs',
  'vendor/versions.json', 'skills/kiki-mail/SKILL.md', 'skills/kiki-mail/agents/openai.yaml',
]) assert.ok(files.includes(required), `missing ${required}`);
assert.equal(files.some((file) => file.includes('node_modules') || file.startsWith('test/') || file === 'package.json'), false);
const catalog = JSON.parse(await readFile(path.join(repo, 'plugins', 'marketplace.json'), 'utf8'));
assert.equal(catalog.plugins.some((plugin) => plugin.id === 'kiki-mail' || String(plugin.source).includes('kiki-mail')), false);
const versions = JSON.parse(await readFile(path.join(root, 'vendor', 'versions.json'), 'utf8'));
const npmLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const name of ['nodemailer', 'imapflow', 'postal-mime']) {
  const locked = npmLock.packages[`node_modules/${name}`];
  assert.equal(versions[name].version, locked.version);
  assert.equal(versions[name].license, locked.license);
}
assert.equal(versions.nodemailer.license, 'MIT-0');
assert.equal(versions.imapflow.license, 'MIT');
assert.equal(versions['postal-mime'].license, 'MIT-0');
const registered = [];
const plugin = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
await plugin.register({
  registerTool(definition, handler) {
    assert.equal(typeof handler, 'function');
    registered.push(definition);
  },
});
assert.equal(JSON.stringify(registered), JSON.stringify(manifest['x-kiki'].tools));
const tests = spawnSync(process.execPath, ['--test', 'test/accounts.test.mjs', 'test/im-bridge.test.mjs', 'test/im-digest.test.mjs', 'test/repairs.test.mjs', 'test/durability.test.mjs', 'test/protocol.test.mjs', 'test/panel.test.mjs', 'test/panel-races.test.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
if (tests.status !== 0) process.exit(tests.status ?? 1);
process.stdout.write('kiki-mail check ok\n');
