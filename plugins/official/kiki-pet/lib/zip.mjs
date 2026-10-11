import yauzl from '../vendor/yauzl/index.js';
import crc32 from '../vendor/buffer-crc32/index.js';
export async function readPetZip(bytes){
 if(bytes.length>12*1024*1024)throw new Error('Package exceeds 12 MiB');
 const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,result)=>error?reject(error):resolve(result)));
 const files=new Map();let total=0,count=0;
 return new Promise((resolve,reject)=>{
  const fail=error=>{zip.close();reject(error);};zip.on('error',fail);
  zip.on('entry',entry=>{
   const name=entry.fileName;
   if(++count>128||name.includes('\\')||name.split('/').some(p=>p==='..'||p==='.')||name.startsWith('/')||/^[a-z]:/i.test(name)||entry.isEncrypted()||((entry.externalFileAttributes>>>16)&0xf000)===0xa000)return fail(new Error('Unsafe ZIP entry'));
   total+=entry.uncompressedSize;
   if(total>24*1024*1024||entry.uncompressedSize>12*1024*1024)return fail(new Error('ZIP expanded size exceeds limit'));
   if(name.endsWith('/')){zip.readEntry();return;}
   if(files.has(name))return fail(new Error('Duplicate ZIP entry'));
   const keep=/(?:^|\/)(?:pet\.json|petpack\.json|spritesheet\.(?:webp|png)|LICENSE[^/]*|NOTICE[^/]*|README[^/]*)$/i.test(name);
   if(!keep){files.set(name,null);zip.readEntry();return;}
   zip.openReadStream(entry,(error,stream)=>{
    if(error)return fail(error);
    const chunks=[];let size=0;
    stream.on('data',chunk=>{size+=chunk.length;if(size>12*1024*1024)stream.destroy(new Error('ZIP entry exceeds limit'));else chunks.push(chunk);});
    stream.on('error',fail);stream.on('end',()=>{const data=Buffer.concat(chunks);if(crc32.unsigned(data)!==entry.crc32)return fail(new Error('Corrupt ZIP entry CRC'));files.set(name,data);zip.readEntry();});
   });
  });
  zip.on('end',()=>{
   const manifests=[...files.keys()].filter(name=>/(?:^|\/)pet\.json$/.test(name));
   if(manifests.length!==1)return reject(new Error('Package must contain exactly one pet.json'));
   const name=manifests[0],base=name.slice(0,-'pet.json'.length);
   if(base.split('/').filter(Boolean).length>1)return reject(new Error('Package supports root or one top-level directory'));
   let manifest;try{manifest=JSON.parse(files.get(name).toString('utf8'));}catch{return reject(new Error('Invalid pet.json'));}
   const spriteName=manifest.spritesheetPath??'spritesheet.webp';
   if(!['spritesheet.webp','spritesheet.png'].includes(spriteName))return reject(new Error('Unsafe or unsupported spritesheetPath in ZIP'));
   const image=files.get(base+spriteName);if(!image)return reject(new Error('Package spritesheet is missing'));
   const notices=[...files.entries()].filter(([n,data])=>data&&/(?:^|\/)(?:LICENSE|NOTICE)/i.test(n)).map(([n,data])=>({name:n.split('/').at(-1),text:data.toString('utf8').slice(0,65536)}));
   resolve({manifest,image,notices});
  });
  zip.readEntry();
 });
}
