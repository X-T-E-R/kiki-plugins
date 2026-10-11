import {createHash} from 'node:crypto';
import {download,jsonDownload,safeUrl} from './network.mjs';
import {readPetZip} from './zip.mjs';
export const AWESOME_REF='c2d8bbd417474171ce7861172f87a9b779ccc3ab';
const raw=`https://raw.githubusercontent.com/legeling/awesome-codex-pet/${AWESOME_REF}/`;
export const sources=[
 {id:'openpets',label:'OpenPets',url:'https://openpets.dev',description:'1,304 pets · 1,265 GitHub stars (2026-10-06)',licenseNote:'Community assets: retain original terms; absent terms remain unknown. Not bundled or republished.'},
 {id:'awesome',label:'Awesome Codex Pet',url:'https://codexpet.top',description:'303 pets · 1,063 GitHub stars (2026-10-06)',licenseNote:'Per-pet terms; default CC BY-NC 4.0. Source-author restrictions may differ.'},
 {id:'petdex',label:'Petdex',url:'https://petdex.crafter.run',description:'Existing public Petdex detail links',licenseNote:'Original asset terms apply.'},
 {id:'codex-pets',label:'Codex Pets',url:'https://codex-pets.net',description:'Existing share and detail links',licenseNote:'Original asset terms apply.'},
 {id:'generic',label:'SpriteYard / Codex Pet Shop',url:'https://spriteyard.com',description:'Existing public pages exposing spritesheet.webp',licenseNote:'Terms remain unknown when not supplied.'},
 {id:'petpacks',label:'Chen Petpacks',url:'https://jieyangxchen.github.io/codex-pet-desktop',description:'7 checksumed packages · extra compatibility',licenseNote:'CC-BY-4.0; retain Chen attribution.'},
];
function integrity(bytes,sha,size){if(size!==undefined&&bytes.length!==size)throw new Error('Source byte count mismatch');if(sha&&createHash('sha256').update(bytes).digest('hex')!==sha)throw new Error('Source SHA-256 mismatch');}
function slug(value){if(!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value??''))throw new Error('Invalid pet identifier in URL');return value;}
const pageMeta=(html,key)=>html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']*)["']`,'i'))?.[1];
const unescape=value=>value.replaceAll('&amp;','&').replaceAll('&#x2F;','/').replaceAll('&quot;','"').replaceAll('\\/','/');
export async function importWebsite(input,{signal,fetchBytes=download,fetchJson=jsonDownload}={}){
 const url=safeUrl(input),host=url.hostname.replace(/^www\./,'');
 const get=url=>fetchBytes(url,{signal}),json=url=>fetchJson(url,{signal});
 const provenance={sourceUrl:url.href,sourceName:host,license:'Unknown — check the source author’s terms'};
 if(host==='codexpet.top'||host==='raw.githubusercontent.com'&&url.pathname.includes('/legeling/awesome-codex-pet/')||host==='github.com'&&url.pathname.startsWith('/legeling/awesome-codex-pet/')){
  const id=slug(url.pathname.split('/').filter(Boolean).filter(p=>!['pet.json','spritesheet.webp','submission.json'].includes(p)).at(-1));
  const manifestIndex=await json(raw+'install-manifest.json');const entry=manifestIndex.pets?.[id];if(!entry)throw new Error('Open an Awesome Codex Pet /pets/<slug> detail link');
  const base=raw+`pets/${id}/`;const [metadata,petBytes,image]=await Promise.all([json(base+'submission.json'),get(base+'pet.json'),get(base+'spritesheet.webp')]);
  integrity(petBytes,entry.petJsonSha256,entry.petJsonBytes);integrity(image,entry.spritesheetSha256,entry.spritesheetBytes);
  return {manifest:JSON.parse(petBytes.toString('utf8')),image,provenance:{...provenance,sourceName:'Awesome Codex Pet',sourceRevision:AWESOME_REF,license:metadata.license??'CC BY-NC 4.0',author:metadata.author,originalSourceUrl:metadata.source_url??metadata.sourceUrl}};
 }
 if(host==='openpets.dev'){
  const hint=slug(url.pathname.split('/').filter(Boolean).at(-1));
  const index=await json('https://openpets.dev/pets/catalog.v3.json');if(index.version!==3||!Array.isArray(index.pages)||index.pages.length>40)throw new Error('Unsupported OpenPets catalog');
  for(const pageUrl of index.pages){
   if(!/^https:\/\/openpets\.dev\/pets\/catalog\.v3\/page-\d+\.json$/.test(pageUrl))throw new Error('Unsafe OpenPets catalog page');
   const page=await json(pageUrl);const pet=page.pets?.find(p=>p.id===hint||new URL(p.spritesheet).pathname.split('/').at(-2)===hint);
   if(!pet)continue;
   if(!/^https:\/\/zip\.openpets\.dev\/pets\/[a-z0-9_-]+\/[a-z0-9_-]+\.zip$/.test(pet.zip))throw new Error('Unsafe OpenPets ZIP URL');
   const packageBytes=await get(pet.zip);const result=await readPetZip(packageBytes);
   return {...result,provenance:{...provenance,sourceName:'OpenPets',sourceRevision:index.generatedAt,downloadUrl:pet.zip,packageSha256:createHash('sha256').update(packageBytes).digest('hex'),license:result.manifest.license??provenance.license,author:result.manifest.author}};
  }
  throw new Error('Pet is not in the current OpenPets public catalog');
 }
 if(host==='jieyangxchen.github.io'&&url.pathname.startsWith('/codex-pet-desktop')){
  const catalog=await json('https://jieyangxchen.github.io/codex-pet-desktop/petpacks/petpacks.json');
  const filename=url.pathname.split('/').at(-1),id=url.searchParams.get('pet');
  const pet=catalog.find(p=>p.fileName===filename||p.id===id||p.id===filename);if(!pet)throw new Error('Paste a Chen .petpack download link or add ?pet=<id>');
  if(!/^[a-z0-9][a-z0-9.-]*\.petpack$/.test(pet.fileName))throw new Error('Unsafe Petpack filename');
  const bytes=await get(new URL(pet.fileName,'https://jieyangxchen.github.io/codex-pet-desktop/petpacks/').href);integrity(bytes,pet.sha256,pet.sizeBytes);
  return {...await readPetZip(bytes),provenance:{...provenance,sourceName:'Chen Petpacks',license:pet.license,author:pet.author,sourceRevision:pet.version,packageSha256:pet.sha256}};
 }
 if(host==='petdex.crafter.run'){
  const id=slug(url.pathname.split('/').at(-1));const catalog=await json('https://petdex.crafter.run/api/manifest');const pet=catalog.pets?.find(p=>p.slug===id);
  if(!pet)throw new Error('Petdex pet was not found');
  return {manifest:{id,displayName:pet.displayName,description:pet.description,spriteVersionNumber:pet.spriteVersionNumber},image:await get(pet.spritesheetUrl),provenance:{...provenance,license:pet.license??provenance.license,author:pet.author}};
 }
 if(host==='codex-pets.net'){
  const id=slug((url.hash.match(/\/pets\/([^/?#]+)/)?.[1])??url.pathname.split('/').at(-1));const detail=await json(`https://ihzwckyzfcuktrljwpha.supabase.co/functions/v1/petshare/api/pets/${id}`);const pet=detail.pet;if(!pet)throw new Error('Codex Pets share was not found');
  return {manifest:{...pet,id,spritesheetPath:'spritesheet.webp'},image:await get(pet.spritesheetUrl),provenance:{...provenance,license:pet.license??provenance.license,author:pet.author}};
 }
 if(/\.(?:zip|petpack)$/i.test(url.pathname))return {...await readPetZip(await get(url.href)),provenance};
 if(/\.(?:webp|png)$/i.test(url.pathname))return {manifest:{id:url.pathname.split('/').at(-2)??'pet',displayName:'Imported Pet'},image:await get(url.href),provenance};
 if(/pet\.json$/i.test(url.pathname)){const manifest=await json(url.href);if(!['spritesheet.webp','spritesheet.png'].includes(manifest.spritesheetPath??'spritesheet.webp'))throw new Error('Unsupported remote spritesheetPath');return {manifest,image:await get(new URL(manifest.spritesheetPath??'spritesheet.webp',url).href),provenance};}
 const html=(await fetchBytes(url.href,{signal,maxBytes:2*1024*1024})).toString('utf8');
 const candidates=[...html.matchAll(/(?:https?:[^\s"'<>]+?\.webp(?:\?[^\s"'<>]*)?|[^\s"'<>]+spritesheet\.webp(?:\?[^\s"'<>]*)?)/g)].map(m=>unescape(m[0]));
 const imageUrl=candidates.find(c=>c.includes('spritesheet.webp'))??candidates[0];if(!imageUrl)throw new Error('This public page does not expose a downloadable spritesheet.webp; use its download link');
 return {manifest:{id:url.pathname.split('/').filter(Boolean).at(-1)??'pet',displayName:pageMeta(html,'og:title')??html.match(/<title>([^<]+)<\/title>/i)?.[1]??'Imported Pet',description:pageMeta(html,'description')??pageMeta(html,'og:description')},image:await get(new URL(imageUrl,url).href),provenance};
}
