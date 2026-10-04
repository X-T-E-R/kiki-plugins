import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { satisfies } from 'semver';
import { mediaProviderDefinitionSchema } from '@kiki/plugin-sdk/media';
import { packageFiles } from './package-files.mjs';
const lock=JSON.parse(await readFile('sdk.lock.json','utf8'));
assert.equal(createHash('sha256').update(await readFile(lock.artifact)).digest('hex'),lock.sha256);
const sdk=JSON.parse(await readFile('node_modules/@kiki/plugin-sdk/package.json','utf8'));assert.equal(sdk.version,lock.version);
await mkdir('.tmp',{recursive:true});
const runner=resolve(process.env.KIKI_HOST_RUNNER??'.tmp/hostRunner.mjs');
if(!process.env.KIKI_HOST_RUNNER){
 const response=await fetch(`https://raw.githubusercontent.com/X-T-E-R/kiki/${lock.ref}/packages/agent-core-v2/src/app/plugin/hostRunner.mjs`);
 if(!response.ok)throw new Error('Pinned Host runner fetch: '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),lock.hostRunnerSha256);await writeFile(runner,bytes);
}
const catalog=JSON.parse(await readFile('plugins/marketplace.json','utf8'));
const selected=process.argv[2];
const run=(file,args=[])=>{const r=spawnSync(process.execPath,[file,...args],{stdio:'inherit',env:{...process.env,KIKI_HOST_RUNNER:runner}});if(r.status!==0)throw new Error(`Check failed: ${file} (${r.status})`);};
const packages=catalog.plugins.filter(p=>p.source.startsWith('./official/')&&(!selected||selected===p.id));
for(const p of packages){
 const root=resolve('plugins',p.source),m=JSON.parse(await readFile(resolve(root,'kimi.plugin.json'),'utf8'));
 assert.equal(m.name,p.id);assert.ok(satisfies(lock.pluginEngineVersion,m['x-kiki']?.engines?.kiki??'*'));
 await packageFiles(root);
 if(m['x-kiki']?.entry){const module=await import(pathToFileURL(resolve(root,m['x-kiki'].entry)));assert.equal(typeof module.register,'function');module.register({registerTool(d,f){assert.equal(typeof f,'function');assert.ok(m['x-kiki'].tools.some(t=>t.name===d.name));},registerMediaProvider(d){mediaProviderDefinitionSchema.parse(d);assert.ok(m['x-kiki'].mediaProviders.some(p=>p.id===d.id));}});}
 console.log('Validated package',p.id,m.version);
}
run('plugins/official/media-runtime/distribute.mjs',['--check']);
for(const id of ['kiki-extract','kiki-office','kiki-media'])if(!selected||selected===id)run(`plugins/official/${id}/scripts/sync-manifest.mjs`,['--check']);
if(!selected||selected==='kiki-extract')run('--test',['plugins/official/kiki-extract/test/documents.test.mjs']);
if(!selected||selected==='kiki-office')run('--test',['plugins/official/kiki-office/test/office.test.mjs']);
if(!selected||selected.startsWith('kiki-media-')||selected==='kiki-media')run('--test',['plugins/official/media-runtime/test/protocol.test.mjs']);
for(const p of catalog.plugins){assert.ok(p.author&&p.license&&p.version&&p.source);if(!p.source.startsWith('./official/'))assert.ok(p.compatibility?.status);}
