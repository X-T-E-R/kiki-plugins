import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { inc } from 'semver';
import { retainHistoricalIcons, readArchiveIcon } from '../scripts/historical-icons.mjs';
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
  const first=await pack(opts);assert.equal(first.newPackages.length,6);assert.equal(first.index.plugins.length,11);assert.deepEqual(first.index.plugins.filter(p=>p.id.startsWith('kiki-media')).map(p=>p.id),['kiki-media']);
  const second=await pack({...opts,outDir:join(dir,'second')});
  for(const p of first.newPackages){assert.equal(p.sha256,second.newPackages.find(x=>x.id===p.id).sha256);assert.equal(sha(await readFile(join(opts.outDir,'assets',p.filename))),p.sha256);const entry=first.index.plugins.find(x=>x.id===p.id);const manifest=JSON.parse(await readFile(join(opts.pluginsRoot,'official',p.id,'kimi.plugin.json')));assert.equal(entry.engines?.kiki,manifest['x-kiki']?.engines?.kiki);assert.ok(entry.icon.endsWith(`/icon-${manifest.version}.svg`));}
  const lineEndingFile=join(opts.pluginsRoot,'official/kiki-writing/panel.html');
  await writeFile(lineEndingFile,(await readFile(lineEndingFile,'utf8')).replaceAll('\r\n','\n').replaceAll('\n','\r\n'));
  const oldTz=process.env.TZ;process.env.TZ='Pacific/Honolulu';
  let alternate;try{alternate=await pack({...opts,outDir:join(dir,'alternate-platform')});}finally{if(oldTz===undefined)delete process.env.TZ;else process.env.TZ=oldTz;}
  for(const p of first.newPackages)assert.equal(alternate.newPackages.find(x=>x.id===p.id).sha256,p.sha256);
  const catalogPath=join(opts.pluginsRoot,'marketplace.json'),catalog=JSON.parse(await readFile(catalogPath));catalog.plugins[0].description='Changed description only';catalog.plugins[0].localizations={zh:{description:'本地办公文档'},'example-locale':{keywords:['fixture']}};await writeFile(catalogPath,JSON.stringify(catalog));
  const reused=await pack({...opts,outDir:join(dir,'reuse'),tag:'batch-2',previous:first.index});assert.equal(reused.newPackages.length,0);for(const p of first.index.plugins)assert.equal(reused.index.plugins.find(x=>x.id===p.id).source,p.source);
  assert.deepEqual(reused.index.plugins[0].localizations,catalog.plugins[0].localizations);
  const panel=join(opts.pluginsRoot,'official/kiki-writing/panel.html');await writeFile(panel,(await readFile(panel,'utf8'))+'\n');
  const writingVersion=first.index.plugins.find(p=>p.id==='kiki-writing').version;
  const immutableError=error=>error.message===`Immutable kiki-writing@${writingVersion} changed; bump its version`;
  await assert.rejects(pack({...opts,outDir:join(dir,'reject'),previous:first.index}),immutableError);
  await assert.rejects(pack({...opts,outDir:join(dir,'reject-retired-version'),previous:{...first.index,plugins:first.index.plugins.filter(p=>p.id!=='kiki-writing')}}),immutableError);
  const manifestPath=join(opts.pluginsRoot,'official/kiki-writing/kimi.plugin.json'),m=JSON.parse(await readFile(manifestPath));m.version=inc(writingVersion,'patch');await writeFile(manifestPath,JSON.stringify(m));
  const update=await pack({...opts,outDir:join(dir,'updated'),tag:'batch-3',previous:first.index});assert.deepEqual(update.newPackages.map(p=>p.id),['kiki-writing']);
  m.icon='../private.svg';await writeFile(manifestPath,JSON.stringify(m));
  await assert.rejects(pack({...opts,outDir:join(dir,'reject-icon-escape')}),/Path escapes root/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('change mapping includes unified media for every donor and metadata builds no ZIP',()=>{
 const ids=['kiki-writing','kiki-extract','kiki-media','kiki-office','kiki-notion'];
 assert.deepEqual(changedPackages(['plugins/official/media-runtime/runtime.mjs'],ids).packages,['kiki-media']);
 assert.deepEqual(changedPackages(['plugins/marketplace.json'],ids),{packages:[],metadataOnly:true});
 for(const vendor of ['openai','google','ark','xai','minimax','stepfun','novita','agnes','newapi','comfyui']) assert.deepEqual(changedPackages([`plugins/official/kiki-media-${vendor}/adapters.mjs`],ids).packages,['kiki-media']);
 assert.equal(changedPackages(['sdk.lock.json'],ids).packages.length,5);
});
test('dev catalog digest matches exactly served immutable bytes and hides dotfiles',async()=>{
 const dir=await mkdtemp(resolve('.tmp/dev-test-'));
 const s=await startPluginMarketplaceServer({outDir:dir});
 try{const index=await(await fetch(s.marketplaceUrl)).json();for(const p of index.plugins.filter(p=>p.id.startsWith('kiki-'))){const response=await fetch(p.source);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),p.sha256);}assert.equal((await fetch(new URL('.kimi-plugin-marketplace-build.json',s.marketplaceUrl))).status,403);}finally{await s.close();await rm(dir,{recursive:true,force:true});}
});

test('versioned icons survive a new site build and retired entries without overwrites',async()=>{
 const dir=await mkdtemp(resolve('.tmp/history-test-'));
 try{
  const pluginsRoot=join(dir,'plugins'),root=join(pluginsRoot,'official/kiki-writing');
  await cp('plugins/official/kiki-writing',root,{recursive:true});
  const entry=JSON.parse(await readFile('plugins/marketplace.json')).plugins.find(p=>p.id==='kiki-writing');
  await writeFile(join(pluginsRoot,'marketplace.json'),JSON.stringify({version:'1',plugins:[entry]}));
  const first=await pack({pluginsRoot,outDir:join(dir,'first'),tag:'history-1'});
  const old=first.index.plugins[0],archive=await readFile(join(dir,'first/assets',first.newPackages[0].filename));
  const oldIcon=await readFile(join(root,'icon.svg'));
  await writeFile(join(root,'icon.svg'),oldIcon.toString().replaceAll('\r\n','\n').replaceAll('\n','\r\n'));
  const same=await pack({pluginsRoot,outDir:join(dir,'line-endings'),tag:'history-line-endings',previous:first.index});
  assert.equal(same.newPackages.length,0);
  assert.deepEqual(await readFile(join(dir,'line-endings',`official/kiki-writing/icon-${old.version}.svg`)),oldIcon);
  await retainHistoricalIcons(first.index,join(dir,'line-endings'),async()=>archive);
  const manifestPath=join(root,'kimi.plugin.json'),manifest=JSON.parse(await readFile(manifestPath));
  manifest.version=inc(manifest.version,'patch');await writeFile(manifestPath,JSON.stringify(manifest));
  await writeFile(join(root,'icon.svg'),oldIcon.toString().replace('stroke-width="1.35"','stroke-width="1.4"'));
  const site=join(dir,'site');
  const next=await pack({pluginsRoot,outDir:site,tag:'history-2',previous:first.index});
  assert.equal(next.newPackages.length,1);
  const path=`official/kiki-writing/icon-${old.version}.svg`;
  await assert.rejects(readFile(join(site,path)),{code:'ENOENT'});
  const urls=[];
  const receipts=await retainHistoricalIcons(first.index,site,async url=>{urls.push(url);assert.equal(url,old.source);return archive;});
  assert.equal(receipts.length,1);assert.deepEqual(urls,[old.source]);
  assert.deepEqual(await readFile(join(site,path)),oldIcon);
  assert.deepEqual(await readFile(join(site,`official/kiki-writing/icon-${manifest.version}.svg`)),await readFile(join(root,'icon.svg')));
  assert.equal((await retainHistoricalIcons(first.index,site,async()=>archive)).length,1);
  assert.equal((await retainHistoricalIcons({...first.index,plugins:[]},join(dir,'retired'),async()=>archive)).length,1);
  await assert.rejects(retainHistoricalIcons({plugins:[{...old,sha256:'0'.repeat(64)}]},join(dir,'bad-digest'),async()=>archive),/Historical ZIP checksum mismatch/);
  await assert.rejects(readArchiveIcon(archive,'kiki-writing',manifest.version),/identity mismatch/);
  await assert.rejects(retainHistoricalIcons({plugins:[{...old,icon:'https://example.test/icon.svg'}]},join(dir,'bad-path'),async()=>archive),/Invalid historical icon contract/);
  await writeFile(join(site,path),'different immutable bytes');
  await assert.rejects(retainHistoricalIcons(first.index,site,async()=>archive),/Refusing to overwrite immutable icon/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
