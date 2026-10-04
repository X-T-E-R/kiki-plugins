import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pack } from '../scripts/pack.mjs';
import { changedPackages } from '../scripts/changes.mjs';
import { startPluginMarketplaceServer } from '../scripts/dev-plugin-marketplace-server.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
await mkdir('.tmp',{recursive:true});
test('deterministic ZIPs, complete digest/icon contract, metadata reuse and immutable versions',async()=>{
 const dir=await mkdtemp(resolve('.tmp/pack-test-'));
 try{
  await cp('plugins',join(dir,'plugins'),{recursive:true});
  const opts={pluginsRoot:join(dir,'plugins'),outDir:join(dir,'first'),tag:'batch-1',revision:'a'.repeat(40)};
  const first=await pack(opts);assert.equal(first.newPackages.length,15);assert.equal(first.index.plugins.length,20);
  const second=await pack({...opts,outDir:join(dir,'second')});
  for(const p of first.newPackages){assert.equal(p.sha256,second.newPackages.find(x=>x.id===p.id).sha256);assert.equal(sha(await readFile(join(opts.outDir,'assets',p.filename))),p.sha256);const entry=first.index.plugins.find(x=>x.id===p.id);const manifest=JSON.parse(await readFile(join(opts.pluginsRoot,'official',p.id,'kimi.plugin.json')));assert.equal(entry.engines?.kiki,manifest['x-kiki']?.engines?.kiki);assert.match(entry.icon,/icon-0\.1\.0\.svg$/);}
  const catalogPath=join(opts.pluginsRoot,'marketplace.json'),catalog=JSON.parse(await readFile(catalogPath));catalog.plugins[0].description='Changed description only';await writeFile(catalogPath,JSON.stringify(catalog));
  const reused=await pack({...opts,outDir:join(dir,'reuse'),tag:'batch-2',previous:first.index});assert.equal(reused.newPackages.length,0);for(const p of first.index.plugins)assert.equal(reused.index.plugins.find(x=>x.id===p.id).source,p.source);
  const panel=join(opts.pluginsRoot,'official/kiki-writing/panel.html');await writeFile(panel,(await readFile(panel,'utf8'))+'\n');
  await assert.rejects(pack({...opts,outDir:join(dir,'reject'),previous:first.index}),/Immutable kiki-writing@0.1.0 changed/);
  const manifestPath=join(opts.pluginsRoot,'official/kiki-writing/kimi.plugin.json'),m=JSON.parse(await readFile(manifestPath));m.version='0.1.1';await writeFile(manifestPath,JSON.stringify(m));
  const update=await pack({...opts,outDir:join(dir,'updated'),tag:'batch-3',previous:first.index});assert.deepEqual(update.newPackages.map(p=>p.id),['kiki-writing']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('change mapping includes ten shared-runtime consumers and metadata builds no ZIP',()=>{
 const ids=['kiki-writing','kiki-extract','kiki-media',...['openai','google','ark','xai','minimax','stepfun','novita','agnes','newapi','comfyui'].map(x=>'kiki-media-'+x),'kiki-office','kiki-notion'];
 assert.equal(changedPackages(['plugins/official/media-runtime/runtime.mjs'],ids).packages.length,10);
 assert.deepEqual(changedPackages(['plugins/marketplace.json'],ids),{packages:[],metadataOnly:true});
 assert.deepEqual(changedPackages(['plugins/official/kiki-media-openai/adapters.mjs'],ids).packages,['kiki-media-openai']);
 assert.equal(changedPackages(['sdk.lock.json'],ids).packages.length,15);
});
test('dev catalog digest matches exactly served immutable bytes and hides dotfiles',async()=>{
 const dir=await mkdtemp(resolve('.tmp/dev-test-'));
 const s=await startPluginMarketplaceServer({outDir:dir});
 try{const index=await(await fetch(s.marketplaceUrl)).json();for(const p of index.plugins.filter(p=>p.id.startsWith('kiki-'))){const response=await fetch(p.source);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),p.sha256);}assert.equal((await fetch(new URL('.kimi-plugin-marketplace-build.json',s.marketplaceUrl))).status,403);}finally{await s.close();await rm(dir,{recursive:true,force:true});}
});
