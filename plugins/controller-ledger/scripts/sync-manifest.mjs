import { writeFile } from 'node:fs/promises';
import { definitions } from '../lib/definitions.mjs';
const manifest = {
  name: 'controller-ledger', version: '0.1.1',
  description: 'Workspace-scoped, incremental controller work ledger with dependencies, decisions and evidence.',
  license: 'MIT',
  interface: { displayName: 'Controller Ledger', shortDescription: '局部更新工作、依赖、决定与证据' },
  systemPrompt: 'For controller work, on first use or after context recovery read controller-ledger ledger_read(view="brief", workspace="."). Keep running work and pending decisions with incremental ledger_write updates when facts change; do not inject the full ledger or equate a background task ending with acceptance. Native Task, Memory and History remain separate authorities linked by references.',
  'x-kiki': { engines: { kiki: '^0.4.0' }, entry: './entry.mjs', permissions: { fs: 'outside' }, tools: definitions },
};
await writeFile(new URL('../kimi.plugin.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
