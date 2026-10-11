import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PetImporter} from './importer.mjs';
import {PetRuntime} from './runtime.mjs';
import {normalizeAtlas,shortText} from './atlas.mjs';
import {sources} from './sources.mjs';
export const defaults={scale:1,paused:false,reducedMotion:false,autonomousWalking:false,hoverPause:true,idleSelfPlay:true,eventReactions:true,eventBubbles:true,bubbleTtlMs:4000};
export function petSettings(input){
 const result={};for(const [key,value] of Object.entries(input??{})){
  if(!(key in defaults))continue;
  if(typeof defaults[key]==='boolean'){if(typeof value!=='boolean')throw new Error(`Invalid ${key}`);}
  else if(typeof value!=='number'||!Number.isFinite(value)||value<(key==='scale'?.5:1000)||value>(key==='scale'?2.5:10000))throw new Error(`Invalid ${key}`);
  result[key]=value;
 }return result;
}
export function activityFromSessions(sessions){
 const waiting=sessions.find(s=>s.pendingInteraction!=='none'&&s.pendingInteraction!==undefined);
 const busy=sessions.find(s=>s.busy);const latest=[...sessions].sort((a,b)=>(b.at??0)-(a.at??0))[0];const selected=waiting??busy??latest;
 if(!selected)return {phase:'idle',at:Date.now()};
 const phase=waiting?'waiting':busy?'working':selected.lastTurnReason==='failed'?'failed':selected.lastTurnReason==='completed'?'completed':'idle';
 return {phase,sessionId:selected.sessionId,reason:waiting?selected.pendingInteraction:selected.lastTurnReason==='cancelled'?'cancelled':undefined,at:selected.at??Date.now()};
}
export class PetService{
 constructor({root=fileURLToPath(new URL('..',import.meta.url)),importerFactory=options=>new PetImporter(options),runtimeFactory=options=>new PetRuntime(options)}={}){
  Object.assign(this,{root,importerFactory,runtimeFactory});this.settings={...defaults};this.pets=[];this.activity={phase:'idle',at:Date.now()};this.action=null;this.bubble=null;this.focusRequest=null;this.queue=Promise.resolve();
 }
 async activate(context){
  await this.deactivate();this.context=context;this.settings={...defaults,...petSettings(context.settings)};
  await mkdir(context.dataDir,{recursive:true});
  try{const saved=JSON.parse(await readFile(path.join(context.dataDir,'state.json'),'utf8'));this.settings={...this.settings,...petSettings(saved.settings)};this.activeId=saved.activeId;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const base=path.join(this.root,'lib/assets/momo');const manifest=JSON.parse(await readFile(path.join(base,'pet.json'),'utf8'));const image=await readFile(path.join(base,'spritesheet.webp'));
  this.defaultPet={...manifest,...normalizeAtlas(manifest,{width:1536,height:1872}),spriteUrl:'data:image/webp;base64,'+image.toString('base64'),provenance:{sourceName:'Original Kiki artwork',license:'CC0-1.0',author:'Kiki contributors',importedAt:'2026-10-06',sha256:createHash('sha256').update(image).digest('hex')}};
  this.importer=this.importerFactory({root:this.root,dataDir:context.dataDir});this.pets=[this.defaultPet,...await this.importer.list()];
  if(!this.pets.some(p=>p.id===this.activeId))this.activeId='momo';
  this.runtime=this.runtimeFactory({root:this.root,dataDir:context.dataDir,onDispatch:(action,args)=>this.panel(action,args),onChange:()=>this.push()});
  this.abort=()=>{void this.deactivate();};context.signal.addEventListener('abort',this.abort,{once:true});
  if(typeof context.onActivity==='function')this.activityDispose=context.onActivity(sessions=>{this.activity=activityFromSessions(sessions);this.push();});
  if(context.settings.autoStart!==false)await this.runtime.start(this.snapshot(true));
  return this.snapshot();
 }
 snapshot(withAsset=false){
  if(!this.context)throw new Error('Enable the desktop pet plugin first');
  const descriptor=({spriteUrl,...pet})=>pet;
  const active=this.pets.find(p=>p.id===this.activeId)??this.defaultPet;
  return {version:1,runtime:this.runtime?.snapshot()??{status:'stopped'},settings:this.settings,pets:this.pets.map(descriptor),activePet:withAsset?active:descriptor(active),activity:this.activity,action:this.action,bubble:this.bubble,focusRequest:this.focusRequest,sources};
 }
 push(){if(this.context&&this.runtime)this.runtime.update(this.snapshot(true));}
 async persist(){const file=path.join(this.context.dataDir,'state.json');await writeFile(file+'.tmp',JSON.stringify({settings:this.settings,activeId:this.activeId}));await rename(file+'.tmp',file);}
 panel(action,args={},signal){
  // Read-only polling must stay responsive while an import is downloading/decoding.
  if(action==='state'||action==='asset')return this.dispatch(action,args);
  const work=this.queue.then(()=>{signal?.throwIfAborted();return this.dispatch(action,args,signal);});this.queue=work.catch(()=>{});return work;
 }
 async dispatch(action,args,signal){
  if(action==='state')return this.snapshot();
  if(action==='asset'){const pet=this.pets.find(p=>p.id===args?.id&&p.provenance.sha256===args?.sha256);if(!pet)throw new Error('Pet asset changed; refresh the pet list');return {id:pet.id,sha256:pet.provenance.sha256,spriteUrl:pet.spriteUrl};}
  if(action==='start'){await this.runtime.start(this.snapshot(true));return this.snapshot();}
  if(action==='stop'){await this.runtime.stop();return this.snapshot();}
  if(action==='import'){
   const importSignal=signal?AbortSignal.any([signal,this.context.signal]):this.context.signal;
   const pet=await this.importer.import(args,{signal:importSignal});
   this.pets=[this.defaultPet,...await this.importer.list()];this.activeId=pet.id;await this.persist();this.push();const {spriteUrl,...descriptor}=pet;return {pet:descriptor,state:this.snapshot()};
  }
  if(action==='select'){if(!this.pets.some(p=>p.id===args?.id))throw new Error('Choose an installed pet');this.activeId=args.id;await this.persist();this.push();return this.snapshot();}
  if(action==='settings'){this.settings={...this.settings,...petSettings(args)};await this.persist();this.push();return this.snapshot();}
  if(action==='action'){
   const pet=this.snapshot().activePet;if(!Object.hasOwn(pet.animations,args?.animationId))throw new Error('This pet does not have that animation');const duration=args.durationMs??2500;if(!Number.isFinite(duration)||duration<500||duration>10000)throw new Error('Action duration must be 500–10000 ms');this.action={animationId:args.animationId,until:Date.now()+duration};this.push();return this.snapshot();
  }
  if(action==='say'){
   if(typeof args?.text!=='string'||args.text.length>160||!args.text.trim())throw new Error('Bubble needs 1–160 characters');const ttl=args.ttlMs??this.settings.bubbleTtlMs;if(!Number.isFinite(ttl)||ttl<1000||ttl>10000)throw new Error('Bubble duration must be 1000–10000 ms');this.bubble={text:shortText(args.text),until:Date.now()+ttl};this.push();return this.snapshot();
  }
  if(action==='focus'){
   const sessionId=this.activity.sessionId;if(sessionId){this.focusRequest={sessionId,at:Date.now()};await this.context.focusSession?.(sessionId);this.push();}return {sessionId};
  }
  throw new Error('Unsupported pet operation');
 }
 async deactivate(){
  const context=this.context;if(!context)return;
  context.signal.removeEventListener('abort',this.abort);this.activityDispose?.();this.activityDispose=undefined;
  await this.queue;await this.runtime?.stop();this.context=null;
 }
}
