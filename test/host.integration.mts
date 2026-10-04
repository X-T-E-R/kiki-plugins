import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startPluginMarketplaceServer } from '../scripts/dev-plugin-marketplace-server.mjs';
const hostRoot=process.env.KIKI_HOST_REPO;
if(!hostRoot)throw new Error('Set KIKI_HOST_REPO to the Kiki Host test checkout');
const {PluginManager}=await import(pathToFileURL(resolve(hostRoot,'packages/agent-core-v2/src/app/plugin/manager.ts')).href);
const {PluginHost}=await import(pathToFileURL(resolve(hostRoot,'packages/agent-core-v2/src/app/plugin/host.ts')).href);
await mkdir('.tmp/host-proof',{recursive:true});
const root=await mkdtemp(resolve('.tmp/host-proof/run-')),home=join(root,'home'),workspace=join(root,'workspace');
await mkdir(home);await mkdir(workspace);await writeFile(join(workspace,'proof.txt'),'# ZIP-installed Extract\nProof value 42.\n');
const temporary=join(root,'temporary');await mkdir(temporary);process.env.KIKI_HOME=home;process.env.TMP=temporary;process.env.TEMP=temporary;process.env.TMPDIR=temporary;
const local=process.env.KIKI_CATALOG_URL?undefined:await startPluginMarketplaceServer({outDir:join(root,'cdn')});
const source=process.env.KIKI_CATALOG_URL??local!.marketplaceUrl;
const manager=new PluginManager({kimiHomeDir:home});await manager.load();
const index=await(await fetch(source)).json();
const receipts=[];
const hosts=[];
try{
 const ids=process.argv.includes('--all')?index.plugins.filter((p:any)=>p.id.startsWith('kiki-')).map((p:any)=>p.id):['kiki-writing','kiki-extract','kiki-media','kiki-media-openai'];
 for(const id of ids){
  const p=index.plugins.find((p:any)=>p.id===id);assert.ok(p);const response=await fetch(p.source);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),p.sha256);
  await assert.rejects(manager.preview(p.source),/SHA-256|sha256|checksum/i);
  await assert.rejects(manager.preview(p.source,'0'.repeat(64)),/SHA-256|sha256|checksum/i);
  const plan=await manager.preview(p.source,p.sha256);assert.equal(plan.id,id);
  const installed=await manager.install(p.source,{sha256:p.sha256,fingerprint:plan.fingerprint,consent:true});await manager.setEnabled(installed.id,true);
  const info=manager.get(id);assert.equal(info.state,'ok');assert.deepEqual(info.diagnostics,[]);assert.ok(info.root.startsWith(home));
  assert.equal(await stat(join(info.root,'node_modules')).catch(()=>undefined),undefined);assert.equal(await stat(join(info.root,'test')).catch(()=>undefined),undefined);
  if(id==='kiki-writing'){assert.equal(info.manifest.kiki.panels.length,1);assert.match(await readFile(resolve(info.root,info.manifest.kiki.panels[0].path),'utf8'),/manuscript|textarea/i);assert.ok((await manager.enabledCommands()).some((c:any)=>c.name==='continue-draft'));}
  else if(id==='kiki-notion'){assert.equal(info.manifest.skills.length,1);assert.ok(Object.keys(info.manifest.mcpServers).length>0);}
  else{
   const h=new PluginHost(id,info.manifest.kiki.entry,info.manifest.kiki.tools??[],[],info.manifest.kiki.mediaProviders??[]);hosts.push(h);const signal=new AbortController().signal;
   if(id==='kiki-extract'){const result=await h.execute('documents_extract',{file:'proof.txt',outputDir:'out'},signal,undefined,{}, {workspaceRoot:workspace});assert.notEqual(result.isError,true);const data=JSON.parse(result.output);assert.equal(data.status,'succeeded');assert.match(await readFile(data.markdownPath,'utf8'),/Proof value 42/);}
   if(id==='kiki-media'){const result=await h.execute('media',{action:'capabilities'},signal,undefined,{}, {workspaceRoot:workspace,media:{media:async()=>({models:[],constraints:['isolated fixture']}),generate:async()=>{throw new Error('Paid generation forbidden');}}});assert.notEqual(result.isError,true);assert.match(result.output,/isolated fixture/);}
   if(id==='kiki-office'){const result=await h.execute('office_create',{file:'not-created.docx'},signal);assert.equal(JSON.parse(result.output).code,'WORKSPACE_UNAVAILABLE');}
   if(id.startsWith('kiki-media-')&&id!=='kiki-media-openai'){const provider=info.manifest.kiki.mediaProviders[0].id;const result=await h.requestMediaProvider(provider,'describe',{},signal,{}, {jobId:'isolated',stagingDir:join(root,'staging')});assert.ok(Array.isArray(result.models));}
   if(id==='kiki-media-openai'){const result=await h.requestMediaProvider('image','describe',{},signal,{}, {jobId:'isolated',stagingDir:join(root,'staging')});assert.ok(Array.isArray(result.models));const missing=await h.requestMediaProvider('image','submit',{request:{kind:'image',prompt:'must not send'}},signal,{}, {jobId:'isolated',stagingDir:join(root,'staging')});assert.equal(missing.state,'failed');assert.equal(missing.error.code,'needs_configuration');assert.equal(missing.error.submission,'not_sent');}
  }
  receipts.push({id,version:p.version,sha256:p.sha256,source:p.source,preview:true,installed:true,state:info.state,loaded:true,missingDigestRejected:true,badDigestRejected:true});
 }
 await writeFile(join(root,'receipt.json'),JSON.stringify({catalog:source,receipts},null,2));console.log(JSON.stringify({catalog:source,receipts},null,2));
}finally{for(const h of hosts)await h.stopAndWait();await local?.close();}
