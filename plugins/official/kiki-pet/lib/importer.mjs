import {readFile,stat,lstat,realpath,mkdir,writeFile,rename,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeAtlas,sanitizeId,shortText} from './atlas.mjs';
import {readPetZip} from './zip.mjs';
import {importWebsite} from './sources.mjs';
import {MAX_IMAGE_BYTES} from './network.mjs';
export function runtimeExecutable(root){return path.join(root,'vendor','runtime',`${process.platform}-${process.arch}`,process.platform==='win32'?'kiki-pet-runtime.exe':'kiki-pet-runtime');}
export async function validateImage(image,executable,{signal}={}){
 if(image.length>MAX_IMAGE_BYTES)throw new Error('Image exceeds 11 MiB');
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,['--validate-image'],{stdio:['pipe','pipe','pipe'],windowsHide:true,signal});let out='',error='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('Image decoder timed out'));},10000);timer.unref();
  child.stdout.on('data',chunk=>{out+=chunk;if(out.length>8192)child.kill();});child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4096);});child.stdin.on('error',()=>{});
  child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(error.trim()||'Image decoder failed'));try{resolve(JSON.parse(out));}catch{reject(new Error('Invalid image decoder response'));}});
  child.stdin.end(image);
 });
}
async function boundedRead(file,maxBytes){const info=await stat(file);if(!info.isFile()||info.size>maxBytes)throw new Error('File is not regular or exceeds its size limit');return readFile(file);}
async function localSource(source){
 const absolute=await realpath(source),info=await stat(absolute);let folder=info.isDirectory()?absolute:path.dirname(absolute);
 if(info.isFile()&&/\.(?:zip|petpack)$/i.test(absolute))return {...await readPetZip(await boundedRead(absolute,MAX_IMAGE_BYTES)),provenance:{sourceName:'Local package',license:'Unknown — original asset terms apply'}};
 let manifest;
 try{const manifestFile=info.isFile()&&path.basename(absolute)==='pet.json'?absolute:path.join(folder,'pet.json');if((await lstat(manifestFile)).isSymbolicLink())throw new Error('Package pet.json must not be a symlink');manifest=JSON.parse((await boundedRead(manifestFile,1024*1024)).toString('utf8'));}catch(error){if(error.code!=='ENOENT'||info.isDirectory()||!/\.(?:webp|png)$/i.test(absolute))throw error;manifest={id:path.basename(folder),displayName:path.basename(folder),spritesheetPath:path.basename(absolute)};}
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw new Error('pet.json must be an object');
 const relative=manifest.spritesheetPath??'spritesheet.webp';
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>p==='..'||p==='.'))throw new Error('spritesheetPath must stay inside the package');
 const imagePath=await realpath(path.join(folder,relative)),rel=path.relative(folder,imagePath);
 if(rel.startsWith('..')||path.isAbsolute(rel)||!['.webp','.png'].includes(path.extname(imagePath).toLowerCase()))throw new Error('spritesheetPath escapes package or is not PNG/WebP');
 const notices=[];
 for(const name of await readdir(folder)){if(/^(LICENSE|NOTICE)/i.test(name)){const item=await lstat(path.join(folder,name));if(item.isFile()&&!item.isSymbolicLink()&&item.size<=65536)notices.push({name,text:(await readFile(path.join(folder,name),'utf8'))});}}
 return {manifest,image:await boundedRead(imagePath,MAX_IMAGE_BYTES),notices,provenance:{sourceName:'Local Codex pet',license:manifest.license??'Unknown — original asset terms apply',author:manifest.author,sourceUrl:manifest.sourceUrl}};
}
export class PetImporter{
 constructor({root,dataDir,decoder,remote=importWebsite}){this.root=root;this.dataDir=dataDir;this.decoder=decoder??((image,options)=>validateImage(image,runtimeExecutable(root),options));this.remote=remote;}
 async import(input,{signal}={}){
  if(typeof input?.source!=='string'||!input.source.trim())throw new Error('Choose a local pet package or public HTTPS link');
  const result=/^https:\/\//i.test(input.source)?await this.remote(input.source,{signal}):await localSource(input.source);
  signal?.throwIfAborted();
  const {manifest,image}=result;
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw new Error('Invalid pet manifest');
  const dimensions=await this.decoder(image,{signal}),normalized=normalizeAtlas(manifest,dimensions);
  const sha256=createHash('sha256').update(image).digest('hex');
  const sourceLicense=result.provenance?.license;
  const license=sourceLicense&&!/^Unknown\b/i.test(sourceLicense)?sourceLicense:manifest.license??input.license??sourceLicense??'Unknown — original asset terms apply';
  const id=sanitizeId(manifest.id)+'-'+sha256.slice(0,8),provenance={...result.provenance,license:shortText(license,1000),author:shortText(result.provenance?.author??manifest.author??input.author,160)||undefined,importedAt:new Date().toISOString(),sha256};
  const pet={id,displayName:shortText(manifest.displayName??manifest.name??manifest.id??'Imported Pet',96),description:shortText(manifest.description,280),...normalized,provenance};
  const directory=path.join(this.dataDir,'pets');await mkdir(directory,{recursive:true});
  const temp=path.join(directory,`.import-${randomUUID()}`),destination=path.join(directory,id);
  await mkdir(temp);try{
   await writeFile(path.join(temp,'image'),image);
   await writeFile(path.join(temp,'record.json'),JSON.stringify(pet));
   await writeFile(path.join(temp,'original-pet.json'),JSON.stringify(manifest,null,2));
   await writeFile(path.join(temp,'source-notices.json'),JSON.stringify(result.notices??[]));
   try{await rename(temp,destination);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;const existing=JSON.parse(await readFile(path.join(destination,'record.json'),'utf8'));if(existing.provenance.sha256!==sha256)throw error;await rm(temp,{recursive:true,force:true});}
  }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
  return {...pet,spriteUrl:`data:image/${image.subarray(0,4).toString()==='RIFF'?'webp':'png'};base64,${image.toString('base64')}`};
 }
 async list(){
  const directory=path.join(this.dataDir,'pets');let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const result=[];
  for(const entry of entries){
   if(!entry.isDirectory()||entry.name.startsWith('.')||sanitizeId(entry.name)!==entry.name)continue;
   try{const dir=path.join(directory,entry.name);const pet=JSON.parse((await boundedRead(path.join(dir,'record.json'),1024*1024)).toString());const image=await boundedRead(path.join(dir,'image'),MAX_IMAGE_BYTES);if(pet.id!==entry.name||createHash('sha256').update(image).digest('hex')!==pet.provenance.sha256)continue;result.push({...pet,spriteUrl:`data:image/${image.subarray(0,4).toString()==='RIFF'?'webp':'png'};base64,${image.toString('base64')}`});}catch{}
  }
  return result;
 }
}
