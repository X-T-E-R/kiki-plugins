import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { satisfies } from 'semver';
import { packageFiles } from './package-files.mjs';
import { validateRegistration } from './validate-registration.mjs';
const catalog=JSON.parse(await readFile('plugins/marketplace.json','utf8'));
assert.equal(new Set(catalog.plugins.map(p=>p.id)).size,catalog.plugins.length,'Duplicate catalog id');
for(const p of catalog.plugins){assert.ok(p.author&&p.license&&p.version&&p.source);if(!p.source.startsWith('./official/'))assert.ok(p.compatibility?.status);else assert.equal(p.source,`./official/${p.id}`);}
const selected=process.argv[2];
const packages=catalog.plugins.filter(p=>p.source.startsWith('./official/')&&(!selected||selected===p.id));
if(selected && selected!=='catalog' && packages.length===0)throw new Error(`No local package selected: ${selected}`);
if(selected==='catalog')console.log(`Validated catalog: ${catalog.plugins.length} entries`);
else await checkPackages();
async function checkPackages(){
  const lock=JSON.parse(await readFile('sdk.lock.json','utf8'));
  assert.equal(createHash('sha256').update(await readFile(lock.artifact)).digest('hex'),lock.sha256);
  const sdk=JSON.parse(await readFile('node_modules/@kiki/plugin-sdk/package.json','utf8'));assert.equal(sdk.version,lock.version);
  await mkdir('.tmp',{recursive:true});
  const runner=resolve(process.env.KIKI_HOST_RUNNER??'.tmp/hostRunner.mjs');
  if(!process.env.KIKI_HOST_RUNNER){
    const response=await fetch(`https://raw.githubusercontent.com/X-T-E-R/kiki/${lock.ref}/packages/agent-core-v2/src/app/plugin/hostRunner.mjs`);
    if(!response.ok)throw new Error('Pinned Host runner fetch: '+response.status);
    await writeFile(runner,Buffer.from(await response.arrayBuffer()));
  }
  assert.equal(createHash('sha256').update(await readFile(runner)).digest('hex'),lock.hostRunnerSha256,'Host runner differs from sdk.lock.json');
  const run=(file,args=[])=>{const r=spawnSync(process.execPath,[file,...args],{stdio:'inherit',env:{...process.env,KIKI_HOST_RUNNER:runner}});if(r.status!==0)throw new Error(`Check failed: ${file} (${r.status})`);};
  for(const p of packages){
    const root=resolve('plugins',p.source),m=JSON.parse(await readFile(resolve(root,'kimi.plugin.json'),'utf8'));
    assert.equal(m.name,p.id);assert.ok(satisfies(lock.pluginEngineVersion,m['x-kiki']?.engines?.kiki??'*'));
    await packageFiles(root);
    const module=m['x-kiki']?.entry ? await import(pathToFileURL(resolve(root,m['x-kiki'].entry))) : undefined;
    await validateRegistration(m,module?.register);
    console.log('Validated package',p.id,m.version);
  }
  run('plugins/official/media-runtime/distribute.mjs',['--check']);
  for(const id of ['kiki-extract','kiki-office','kiki-media','kiki-bilibili','kiki-voice','kiki-qq'])if(!selected||selected===id)run(`plugins/official/${id}/scripts/sync-manifest.mjs`,['--check']);
  if(!selected||selected==='kiki-bilibili')run('--test',['plugins/official/kiki-bilibili/test/bilibili.test.mjs']);
  if(!selected||selected==='kiki-voice')run('--test',['plugins/official/kiki-voice/test/voice.test.mjs']);
  if(!selected||selected==='kiki-qq'){
    run('--test',['--test-timeout=15000','plugins/official/kiki-qq/test/qq.test.mjs','plugins/official/kiki-qq/test/qq-regressions.test.mjs']);
    run('plugins/official/kiki-qq/scripts/check-host-contract.mjs',[resolve('node_modules/@kiki/plugin-sdk/dist/im.js'),runner]);
  }
  if(!selected||selected==='kiki-extract')run('--test',['plugins/official/kiki-extract/test/documents.test.mjs']);
  if(!selected||selected==='kiki-office')run('--test',['plugins/official/kiki-office/test/office.test.mjs']);
  if(!selected||selected==='kiki-task-board')run('--test',['plugins/official/kiki-task-board/test/board.test.mjs','plugins/official/kiki-task-board/test/engine.test.mjs','plugins/official/kiki-task-board/test/panel-recovery.test.mjs']);
  if(!selected||selected==='kiki-media') { run('plugins/official/kiki-media/scripts/sync-sources.mjs',['--check']); run('scripts/sync-media-catalog.mjs',['--check']); }
  if(!selected||selected.startsWith('kiki-media-'))run('--test',['plugins/official/media-runtime/test/protocol.test.mjs']);
}
