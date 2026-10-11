import https from 'node:https';
import dns from 'node:dns/promises';
import {isIP} from 'node:net';
// 11 MiB encodes below the existing 16 MiB RPC boundary with JSON/metadata headroom.
export const MAX_IMAGE_BYTES=11*1024*1024;
export function publicAddress(address){
 if(isIP(address)===4){const p=address.split('.').map(Number),[a,b]=p;return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&[18,19].includes(b))||(a===192&&b===0)||(a===198&&b===51)||(a===203&&b===0));}
 if(isIP(address)===6){const prefix=parseInt(address.split(':')[0],16);return prefix>=0x2000&&prefix<=0x3fff&&!address.toLowerCase().startsWith('2001:db8:');}
 return false;
}
export function safeUrl(value){
 const url=new URL(value);
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||(isIP(host)&&!publicAddress(host)))throw new Error('Import requires a public HTTPS URL without credentials');
 return url;
}
export async function download(value,{maxBytes=MAX_IMAGE_BYTES,signal,redirects=0}={}){
 const url=safeUrl(value);signal?.throwIfAborted();
 if(redirects>4)throw new Error('Too many redirects');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await dns.lookup(host,{all:true});
 signal?.throwIfAborted();
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Import hostname resolves to a private or reserved address');
 const pinned=addresses.find(a=>a.family===4)??addresses[0];
 return new Promise((resolve,reject)=>{
  const request=https.get(url,{headers:{'User-Agent':'Kiki-Pet/0.1','Accept-Encoding':'identity'},signal,lookup(_host,options,callback){callback(null,options.all?[pinned]:pinned.address,options.all?undefined:pinned.family);}},response=>{
   if([301,302,303,307,308].includes(response.statusCode)){const location=response.headers.location;response.resume();if(!location)return reject(new Error('Redirect has no destination'));download(new URL(location,url).href,{maxBytes,signal,redirects:redirects+1}).then(resolve,reject);return;}
   if(response.statusCode!==200){response.resume();reject(new Error(`Download failed: HTTP ${response.statusCode}`));return;}
   if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();reject(new Error('Unexpected compressed HTTP response'));return;}
   if(Number(response.headers['content-length'])>maxBytes){response.destroy();reject(new Error('Download exceeds size limit'));return;}
   let count=0;const chunks=[];
   response.on('data',chunk=>{count+=chunk.length;if(count>maxBytes){response.destroy(new Error('Download exceeds size limit'));return;}chunks.push(chunk);});
   response.on('error',reject);response.on('end',()=>resolve(Buffer.concat(chunks)));
  });
  request.setTimeout(15000,()=>request.destroy(new Error('Download timed out')));request.on('error',reject);
 });
}
export async function jsonDownload(url,options={}){return JSON.parse((await download(url,{...options,maxBytes:2*1024*1024})).toString('utf8'));}
