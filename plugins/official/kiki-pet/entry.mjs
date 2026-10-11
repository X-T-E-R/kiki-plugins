import path from 'node:path';
import {PetService} from './lib/service.mjs';
import {tools} from './lib/definitions.mjs';
const service=new PetService();
export function register(api){
 for(const definition of tools)api.registerTool(definition,async(args,context)=>{
  try{
   context.signal.throwIfAborted();
   const action=definition.name==='pet_control'?args.operation:'import';
   if(definition.name==='pet_import_url'&&!/^https:\/\//i.test(args.source))throw new Error('Use a public HTTPS URL');
   if(definition.name==='pet_import_local'&&/^https?:/i.test(args.source))throw new Error('Use pet_import_url for web resources');
   const input=definition.name==='pet_import_local'?{...args,source:path.resolve(context.workspaceRoot??process.cwd(),args.source)}:args;
   const result=await service.panel(action,input,context.signal);
   if(action==='import')return {output:`Imported ${result.pet.displayName}. License: ${result.pet.provenance.license}. Source: ${result.pet.provenance.sourceUrl??result.pet.provenance.sourceName}.`};
   const state=result;return {output:JSON.stringify(action==='focus'?state:{runtime:state.runtime,pet:{id:state.activePet.id,name:state.activePet.displayName,license:state.activePet.provenance.license},settings:state.settings,activity:state.activity,action:state.action,bubble:state.bubble})};
  }catch(error){return {isError:true,output:error.message};}
 });
}
export function activate(context){return service.activate(context);}
export function deactivate(){return service.deactivate();}
export function handlePanelRequest(action,args){return service.panel(action,args);}
