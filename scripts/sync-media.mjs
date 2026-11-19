import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkMode = process.argv.includes('--check');
const args = checkMode ? ['--check'] : [];

const steps = [
  'plugins/official/kiki-media/scripts/sync-sources.mjs',
  'scripts/sync-media-catalog.mjs',
  'scripts/build-media.mjs',
];

for (const step of steps) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, step), ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Media sync step failed (${result.status}): ${step}`);
  }
}
