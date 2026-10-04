import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pack } from './pack.mjs';
const repo='X-T-E-R/kiki-plugins';
const tag=process.env.RELEASE_TAG,revision=process.env.GITHUB_SHA;
if(!tag||!revision||! /^[a-f0-9]{40}$/.test(revision))throw new Error('RELEASE_TAG and exact GITHUB_SHA are required');
const gh=(args)=>execFileSync('gh',args,{encoding:'utf8'});
function api(path){const result=spawnSync('gh',['api',path],{encoding:'utf8'});if(result.status===0)return JSON.parse(result.stdout);if(result.stderr.includes('HTTP 404'))return undefined;throw new Error(result.stderr);}
function findRelease(){return api(`repos/${repo}/releases/tags/${tag}`)??api(`repos/${repo}/releases?per_page=100`).find(r=>r.tag_name===tag);}
async function bytes(url){const r=await fetch(url);if(!r.ok)throw new Error(`Anonymous download ${r.status}: ${url}`);return Buffer.from(await r.arrayBuffer());}
const hash=b=>createHash('sha256').update(b).digest('hex');
const latest=api(`repos/${repo}/releases/latest`);
let previous;
if(latest){
 const indexAsset=latest.assets.find(a=>a.name==='marketplace.json');if(!indexAsset)throw new Error('Latest release has no catalog snapshot');
 previous=JSON.parse(await bytes(indexAsset.browser_download_url));
 if(previous.revision!==revision&&spawnSync('git',['merge-base','--is-ancestor',previous.revision,revision]).status!==0)throw new Error('Refusing stale/non-descendant catalog revision');
}
const result=await pack({tag,revision,previous});
let release=findRelease();
if(release&&!release.draft){
 const remote=JSON.parse(await bytes(release.assets.find(a=>a.name==='marketplace.json')?.browser_download_url));
 if(JSON.stringify(remote)!==JSON.stringify(result.index))throw new Error('Published batch differs; use a new tag, never overwrite');
}else{
 if(!release){gh(['release','create',tag,'--repo',repo,'--target',revision,'--draft','--title',tag,'--notes','Versioned Kiki plugin packages and checksum-pinned catalog. Each package keeps its manifest version.']);release=findRelease();}
 if(release.target_commitish!==revision)throw new Error('Draft target revision mismatch');
 const files=['marketplace.json','SHA256SUMS',...result.newPackages.map(p=>p.filename)];
 for(const filename of files){
  const old=release.assets.find(a=>a.name===filename);
  if(old){const dir=resolve('.tmp','draft-check',String(old.id));await mkdir(dir,{recursive:true});gh(['release','download',tag,'--repo',repo,'--pattern',filename,'--dir',dir]);if(hash(await readFile(join(dir,filename)))!==hash(await readFile(join('dist/assets',filename))))throw new Error('Draft asset differs: '+filename);}
  else gh(['release','upload',tag,join('dist/assets',filename),'--repo',repo]);
 }
 const verifiedDir=resolve('.tmp','uploaded-check',String(Date.now()));await mkdir(verifiedDir,{recursive:true});
 gh(['release','download',tag,'--repo',repo,'--dir',verifiedDir]);
 for(const filename of files)if(hash(await readFile(join(verifiedDir,filename)))!==hash(await readFile(join('dist/assets',filename))))throw new Error('Uploaded asset checksum mismatch: '+filename);
 gh(['release','edit',tag,'--repo',repo,'--draft=false','--latest']);
}
for(const p of result.index.plugins.filter(p=>p.source.startsWith(`https://github.com/${repo}/releases/download/`))){
 const b=await bytes(p.source);if(hash(b)!==p.sha256)throw new Error('Anonymous checksum mismatch: '+p.id);console.log('Anonymous checksum verified',p.id,p.version,p.sha256);
}
await mkdir('.tmp/site',{recursive:true});
await cp('dist/official','.tmp/site/official',{recursive:true});
await cp('dist/marketplace.json','.tmp/site/marketplace.json');await cp('dist/index.html','.tmp/site/index.html');
await writeFile('.tmp/release-receipt.json',JSON.stringify({tag,revision,newPackages:result.newPackages,verified:result.index.plugins.filter(p=>p.source.startsWith(`https://github.com/${repo}/releases/download/`)).length},null,2));
