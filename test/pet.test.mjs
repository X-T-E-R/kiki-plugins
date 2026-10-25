import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import yazl from 'yazl';
import {normalizeAtlas} from '../plugins/official/kiki-pet/lib/atlas.mjs';
import {readPetZip} from '../plugins/official/kiki-pet/lib/zip.mjs';
import {PetImporter,validateImage,runtimeExecutable} from '../plugins/official/kiki-pet/lib/importer.mjs';
import {PetService,activityFromSessions} from '../plugins/official/kiki-pet/lib/service.mjs';
import {PetRuntime} from '../plugins/official/kiki-pet/lib/runtime.mjs';
import {publicAddress,safeUrl} from '../plugins/official/kiki-pet/lib/network.mjs';
import {importWebsite,AWESOME_REF} from '../plugins/official/kiki-pet/lib/sources.mjs';
import {tools} from '../plugins/official/kiki-pet/lib/definitions.mjs';
const root=path.resolve('plugins/official/kiki-pet');
const image=await readFile(path.join(root,'lib/assets/momo/spritesheet.webp'));
const manifest=JSON.parse(await readFile(path.join(root,'lib/assets/momo/pet.json'),'utf8'));
async function zip(entries){const z=new yazl.ZipFile();for(const [name,bytes] of entries)z.addBuffer(Buffer.from(bytes),name);z.end();const chunks=[];for await(const c of z.outputStream)chunks.push(c);return Buffer.concat(chunks);}

test('Codex v1/v2 and explicit custom geometry reject malformed frames',()=>{
 assert.equal(normalizeAtlas({}, {width:1536,height:1872}).atlas.rows,9);
 const v2=normalizeAtlas({spriteVersionNumber:2},{width:1536,height:2288});assert.equal(v2.atlas.rows,11);assert.equal(v2.atlas.gaze.frames.length,16);assert.equal(v2.animations.sleeping,undefined);
 const custom=normalizeAtlas({atlas:{columns:3,rows:2},animations:{idle:{row:0,frameCount:3,frameDurationMs:100}}},{width:96,height:64});assert.equal(custom.atlas.cellWidth,32);
 assert.throws(()=>normalizeAtlas({atlas:{columns:3,rows:2},animations:{idle:{row:2,frameCount:3}}},{width:96,height:64}),/row/);
 assert.throws(()=>normalizeAtlas({}, {width:2000,height:2000}),/Codex/);
 assert.throws(()=>normalizeAtlas({atlas:{columns:4,rows:1},animations:{idle:{row:0,frameCount:5}}},{width:128,height:32}),/frame count/);
});
test('ZIP is data-only, CRC checked and safe layouts enforced',async()=>{
 const payload=await zip([['pet.json',JSON.stringify(manifest)],['spritesheet.webp',image],['run.mjs','process.exit()']]);const parsed=await readPetZip(payload);assert.equal(parsed.manifest.id,'momo');assert.equal(parsed.image.length,image.length);
 await assert.rejects(readPetZip(Buffer.from('not a zip')));
 const mixed=await zip([['nested/other/pet.json',JSON.stringify(manifest)],['nested/other/spritesheet.webp',image]]);await assert.rejects(readPetZip(mixed),/top-level/);
 const traversal=await zip([['pet.json',JSON.stringify({...manifest,spritesheetPath:'../x.webp'})],['spritesheet.webp',image]]);await assert.rejects(readPetZip(traversal),/Unsafe/);
 const corrupt=Buffer.from(payload);corrupt[50]^=255;await assert.rejects(readPetZip(corrupt));
});
test('public HTTPS boundaries reject private IPv4/IPv6, credentials and non-HTTPS',()=>{
 for(const value of ['http://example.com/a','https://127.0.0.1/a','https://[::1]/a','https://user:secret@example.com/a','https://example.com:8443/a'])assert.throws(()=>safeUrl(value));
 for(const value of ['10.0.0.1','172.16.1.1','192.168.1.2','100.64.1.2','169.254.1.2','::ffff:127.0.0.1'])assert.equal(publicAddress(value),false);
 assert.equal(publicAddress('8.8.8.8'),true);
});
test('bundled native decoder follows the Windows x64-only distribution contract',async()=>{
 const executable=runtimeExecutable(root);
 await assert.rejects(validateImage(Buffer.alloc(11*1024*1024+1),executable),/11 MiB/);
 assert.ok(Buffer.alloc(11*1024*1024).toString('base64').length+65536<16*1024*1024-1024);
 if(process.platform==='win32'&&process.arch==='x64'){
  assert.deepEqual(await validateImage(image,executable),{width:1536,height:1872});
  await assert.rejects(validateImage(Buffer.from('RIFF0000WEBPVP8 '+String.fromCharCode(0).repeat(8)),executable),/Invalid image/);
  await assert.rejects(validateImage(image.subarray(0,500),executable));
 }else{
  // Linux/macOS binaries are not shipped (plugin README, Compatibility).
  await assert.rejects(validateImage(image,executable),{code:'ENOENT',path:executable});
 }
});
test('local import retains rights and rejects escaping spritesheets with a fixture decoder',async()=>{
 const decoder=async bytes=>{assert.deepEqual(bytes,image);return {width:1536,height:1872};};
 const temp=await mkdtemp(path.join(tmpdir(),'kiki-pet-test-'));try{
  const importer=new PetImporter({root,dataDir:temp,decoder});const pet=await importer.import({source:path.join(root,'lib/assets/momo')});assert.equal(pet.provenance.license,'CC0-1.0');assert.equal(pet.atlas.rows,9);assert.equal((await importer.list()).length,1);
  const bad=path.join(temp,'bad');await mkdir(bad);await writeFile(path.join(bad,'pet.json'),JSON.stringify({...manifest,spritesheetPath:'../image.webp'}));await assert.rejects(importer.import({source:bad}),/stay inside/);
  assert.equal((await importer.list()).length,1);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('new hot sources consume catalog URLs and preserve per-asset/unknown terms without running CLI',async()=>{
 const packageBytes=await zip([['pet.json',JSON.stringify(manifest)],['spritesheet.webp',image]]);
 const called=[];const fetchJson=async url=>{called.push(url);if(url==='https://openpets.dev/pets/catalog.v3.json')return {version:3,generatedAt:'2026-10-06',pages:['https://openpets.dev/pets/catalog.v3/page-000.json']};if(url.includes('page-000'))return {pets:[{id:'momo',spritesheet:'https://openpets.dev/pets/momo-openpets/spritesheet.webp',zip:'https://zip.openpets.dev/pets/momo-openpets/momo.zip'}]};throw new Error('Unexpected fixture URL: '+url);};
 const result=await importWebsite('https://openpets.dev/pets/momo-openpets',{fetchJson,fetchBytes:async url=>{assert.equal(url,'https://zip.openpets.dev/pets/momo-openpets/momo.zip');return packageBytes;}});assert.equal(result.provenance.sourceName,'OpenPets');assert.equal(result.provenance.license,'CC0-1.0');assert.equal(called.length,2);
 const raw=`https://raw.githubusercontent.com/legeling/awesome-codex-pet/${AWESOME_REF}/`,petBytes=Buffer.from(JSON.stringify(manifest));
 const remote=await importWebsite('https://codexpet.top/pets/momo--author',{fetchJson:async url=>url===raw+'install-manifest.json'?{pets:{'momo--author':{petJsonSha256:createHash('sha256').update(petBytes).digest('hex'),spritesheetSha256:createHash('sha256').update(image).digest('hex')}}}:url===raw+'pets/momo--author/submission.json'?{license:'Personal use only',author:'Example'}:Promise.reject(new Error('Unexpected URL')),fetchBytes:async url=>url.endsWith('pet.json')?petBytes:url.endsWith('spritesheet.webp')?image:Promise.reject(new Error('Unexpected URL'))});assert.equal(remote.provenance.license,'Personal use only');
});
test('service state polling never retransmits atlas, cached asset reads and privacy-filtered activity work',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'kiki-pet-service-'));let listener,focused;
 const runtime={snapshot:()=>({status:'stopped'}),start:async()=>{},stop:async()=>{},update:()=>{}};
 const service=new PetService({root,runtimeFactory:()=>runtime});const lifetime=new AbortController();try{
  await service.activate({dataDir:temp,settings:{autoStart:false},signal:lifetime.signal,onActivity:fn=>{listener=fn;return()=>{};},focusSession:async id=>{focused=id;}});
  const state=await service.panel('state');assert.equal(state.activePet.spriteUrl,undefined);assert.ok(JSON.stringify(state).length<5000);
  const asset=await service.panel('asset',{id:state.activePet.id,sha256:state.activePet.provenance.sha256});assert.ok(asset.spriteUrl.startsWith('data:image/webp;base64,'));
  listener([{sessionId:'example-session',busy:true,pendingInteraction:'approval',at:1,prompt:'must not cross'}]);assert.deepEqual((await service.panel('state')).activity,{phase:'waiting',sessionId:'example-session',reason:'approval',at:1});
  await service.panel('focus');assert.equal(focused,'example-session');await service.panel('settings',{paused:true,scale:1.5});assert.equal((await service.panel('state')).settings.paused,true);
  await assert.rejects(service.panel('say',{text:'x'.repeat(161)}),/160/);
  const originalImporter=service.importer,operation=new AbortController();
  service.importer={import:async(_args,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
  const importing=service.panel('import',{source:'fixture'},operation.signal);await new Promise(r=>setImmediate(r));
  assert.equal((await service.panel('state')).activePet.id,'momo');
  operation.abort(new Error('User cancelled import'));await assert.rejects(importing,/User cancelled/);service.importer=originalImporter;
 }finally{await service.deactivate();await rm(temp,{recursive:true,force:true});}
 assert.equal(activityFromSessions([{sessionId:'s',busy:false,pendingInteraction:'none',lastTurnReason:'failed'}]).phase,'failed');
});
test('owned runtime supervisor detects exit/hang without unbounded restart and supports explicit recovery',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'kiki-pet-runtime-'));const fixture=path.join(temp,'runtime.mjs');
 await writeFile(fixture,"console.log(JSON.stringify({type:'ready',protocol:1}));let n=0;const t=setInterval(()=>{if(n++<2)console.log(JSON.stringify({type:'heartbeat'}));},100);process.stdin.on('data',b=>{if(b.toString().includes('shutdown'))process.exit(0);});");
 const waiters=new Set();
 const runtime=new PetRuntime({root,dataDir:temp,executable:process.execPath,args:[fixture],heartbeatMs:300,onChange:()=>{for(const check of waiters)check();}});
 function waitForStatus(expected){
  return new Promise((resolve,reject)=>{
   const finish=(error)=>{clearTimeout(timer);waiters.delete(check);if(error)reject(error);else resolve();};
   const check=()=>{const state=runtime.snapshot();if(state.status===expected)finish();else if(state.status==='failed')finish(new Error(`Pet failed before ${expected}: ${state.error}`));};
   const timer=setTimeout(()=>finish(new Error(`Timed out waiting for Pet ${expected}; observed ${runtime.snapshot().status}`)),5000);
   waiters.add(check);check();
  });
 }
 try{
  const state={activePet:{id:'momo',provenance:{sha256:'x'},spriteUrl:'data:image/webp;base64,eA=='}};await runtime.start(state);await waitForStatus('running');
  await waitForStatus('failed');assert.equal(runtime.snapshot().status,'failed');assert.equal(runtime.child,null);const generation=runtime.generation;await new Promise(r=>setTimeout(r,300));assert.equal(runtime.generation,generation);
  await runtime.start(state);await waitForStatus('running');assert.equal(runtime.snapshot().status,'running');await runtime.stop();assert.equal(runtime.snapshot().status,'stopped');
 }finally{await runtime.stop();await rm(temp,{recursive:true,force:true});}
});
test('manifest tool declarations equal registered definitions',async()=>{const m=JSON.parse(await readFile(path.join(root,'kimi.plugin.json'),'utf8'));assert.deepEqual(m['x-kiki'].tools,tools);});

test('local tool resolves workspace-relative ZIP and retains manifest license with a fixture decoder',async t=>{
 const spawn=childProcess.spawn;let decoderCalls=0;
 // Exercise real entry/service/importer paths; only the native decoder is a protocol fixture.
 t.mock.method(childProcess,'spawn',(executable,args,options)=>{
  assert.equal(executable,runtimeExecutable(root));assert.deepEqual(args,['--validate-image']);decoderCalls++;
  return spawn(process.execPath,['--input-type=commonjs','-e',"const assert=require('node:assert/strict'),fs=require('node:fs');const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{assert.deepEqual(Buffer.concat(chunks),fs.readFileSync(process.argv[1]));console.log(JSON.stringify({width:1536,height:1872}));});",path.join(root,'lib/assets/momo/spritesheet.webp')],options);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const temp=await mkdtemp(path.join(tmpdir(),'kiki-pet-tool-')),lifetime=new AbortController(),toolAbort=new AbortController();const entry=await import('../plugins/official/kiki-pet/entry.mjs');const registered=new Map();entry.register({registerTool(definition,execute){registered.set(definition.name,execute);}});
 try{
  await writeFile(path.join(temp,'petpack.zip'),await zip([['pet.json',JSON.stringify(manifest)],['spritesheet.webp',image]]));
  await entry.activate({dataDir:path.join(temp,'data'),settings:{autoStart:false},signal:lifetime.signal});
  const execute=registered.get('pet_import_local'),context={workspaceRoot:temp,approvedPaths:[temp],signal:toolAbort.signal};
  const result=await execute({source:'petpack.zip'},context);assert.equal(result.isError,undefined,result.output);assert.match(result.output,/License: CC0-1.0/);assert.equal(decoderCalls,1);
  const state=await entry.handlePanelRequest('state');assert.match(state.activePet.provenance.sha256,/^[a-f0-9]{64}$/);
  const missing=await execute({source:'missing.zip'},context);assert.equal(missing.isError,true);assert.match(missing.output,/ENOENT/);assert.equal(decoderCalls,1);assert.equal((await entry.handlePanelRequest('state')).activePet.id,state.activePet.id);
 }
 finally{await entry.deactivate();await rm(temp,{recursive:true,force:true});}
});
