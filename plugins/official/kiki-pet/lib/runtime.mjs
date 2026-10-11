import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {runtimeExecutable} from './importer.mjs';
export class PetRuntime{
 constructor({root,dataDir,onDispatch,onChange,executable=runtimeExecutable(root),args=[],heartbeatMs=6000,spawnFn=spawn}){Object.assign(this,{root,dataDir,onDispatch,onChange,executable,args,heartbeatMs,spawnFn});this.status={status:'stopped'};this.child=null;this.generation=0;}
 snapshot(){return this.status;}
 update(state){
  this.state=state;const child=this.child;if(!child?.stdin.writable)return;
  const {spriteUrl,...pet}=state.activePet;const key=pet.id+':'+pet.provenance.sha256;
  if(child.stdin.writableNeedDrain){if(!this.awaitingDrain){this.awaitingDrain=true;child.stdin.once('drain',()=>{this.awaitingDrain=false;if(child===this.child)this.update(this.state);});}return;}
  const activePet=key===this.sentAssetKey?pet:{...pet,spriteUrl};
  child.stdin.write(JSON.stringify({type:'state',state:{...state,activePet,pets:[pet]}})+'\n');this.sentAssetKey=key;
 }
 async start(state){
  if(this.child&&['running','starting'].includes(this.status.status)){this.update(state);return this.status;}
  await this.stop();this.state=state;this.sentAssetKey=null;this.awaitingDrain=false;const generation=++this.generation;
  this.status={status:'starting'};this.onChange?.();
  let child;try{child=this.spawnFn(this.executable,this.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,KIKI_PET_DATA_DIR:this.dataDir}});}catch(error){this.fail(error.message,generation);throw error;}
  this.child=child;this.lastHeartbeat=Date.now();let stderr='';
  child.stdin.on('error',()=>{});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4096);});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
   if(line.length>8192||generation!==this.generation)return;
   let msg;try{msg=JSON.parse(line);}catch{return;}
   if(msg.type==='ready'&&msg.protocol===1){this.status={status:'starting',pid:child.pid};this.update(this.state);}
   if(msg.type==='heartbeat'){this.lastHeartbeat=Date.now();if(this.status.status==='starting'){this.status={status:'running',pid:child.pid};this.onChange?.();this.update(this.state);}}
   if(msg.type==='dispatch')void Promise.resolve(this.onDispatch?.(msg.action,msg.args)).catch(()=>{});
  });
  child.once('error',error=>this.fail(error.message,generation));
  child.once('exit',(code,signal)=>{
   lines.close();if(generation!==this.generation)return;
   this.child=null;clearInterval(this.watchdog);
   this.status={status:'failed',error:`Pet exited (${signal??code}). ${stderr.slice(-512)}`.trim()};this.onChange?.();
  });
  this.watchdog=setInterval(()=>{if(Date.now()-this.lastHeartbeat>this.heartbeatMs)this.fail('Pet stopped responding. Choose Recover to start it again.',generation);},500);this.watchdog.unref();
  return this.status;
 }
 fail(error,generation){if(generation!==this.generation)return;const child=this.child;this.child=null;++this.generation;clearInterval(this.watchdog);this.status={status:'failed',error};if(child)this.stopping=this.terminate(child);this.onChange?.();}
 async terminate(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const finished=new Promise(resolve=>child.once('close',resolve));
  if(child.stdin.writable)child.stdin.end(JSON.stringify({type:'shutdown'})+'\n');
  const timer=setTimeout(()=>child.kill('SIGKILL'),1500);timer.unref();await finished;clearTimeout(timer);
 }
 async stop(){
  const child=this.child;this.child=null;++this.generation;clearInterval(this.watchdog);
  if(child)this.stopping=this.terminate(child);
  await this.stopping;this.stopping=undefined;
  this.status={status:'stopped'};this.onChange?.();return this.status;
 }
}
