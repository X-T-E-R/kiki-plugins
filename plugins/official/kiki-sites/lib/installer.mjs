import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { run, SitesError } from './runtime.mjs';
export const cliPackages = {
  vercel: { package: 'vercel', version: '62.2.0', entry: 'dist/index.js' },
  netlify: { package: 'netlify-cli', version: '27.10.0', entry: 'bin/run.js' },
  'cloudflare-pages': { package: 'wrangler', version: '4.147.0', entry: 'bin/wrangler.js' },
  'cloudflare-workers': { package: 'wrangler', version: '4.147.0', entry: 'bin/wrangler.js' },
};
export async function installCli(service, directory, signal, runner = run) {
  const spec = cliPackages[service]; if (!spec) throw new SitesError('external_cli', 'This CLI is installed using its official distribution.', 'Install the documented official executable, then select its path in Sites.');
  const root = path.join(directory, 'cli', `${spec.package}-${spec.version}`);
  const entry = path.join(root, 'node_modules', spec.package, spec.entry);
  if (!await access(entry).then(() => true, () => false)) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await runner('npm', ['install', '--prefix', root, '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', `${spec.package}@${spec.version}`], { signal, timeout: 10 * 60 * 1000 });
    await access(entry).catch(() => { throw new SitesError('install_incomplete', 'The official CLI package did not provide its expected entry.', 'Retry Download CLI or choose an existing official installation.'); });
  }
  return { cliPath: entry, package: spec.package, version: spec.version };
}
