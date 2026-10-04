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
 if(!release)release=JSON.parse(gh(['api','--method','POST',`repos/${repo}/releases`,'-f',`tag_name=${tag}`,'-f',`target_commitish=${revision}`,'-F','draft=true','-f',`name=${tag}`,'-f','body=Versioned Kiki plugin packages and checksum-pinned catalog. Each package keeps its manifest version.']));
 if(release.target_commitish!==revision)throw new Error('Draft target revision mismatch');
 const token=process.env.GH_TOKEN??process.env.GITHUB_TOKEN;if(!token)throw new Error('Workflow GitHub token is required for draft assets');
 const auth=async(url,init={})=>{if(!['api.github.com','uploads.github.com'].includes(new URL(url).hostname))throw new Error('Unexpected authenticated API host');const r=await fetch(url,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers}});if(!r.ok)throw new Error(`Release API ${r.status}`);return r;};
 const files=['marketplace.json','SHA256SUMS',...result.newPackages.map(p=>p.filename)];
 for(const filename of files){
  const local=await readFile(join('dist/assets',filename));let asset=release.assets.find(a=>a.name===filename);
  if(!asset){const upload=release.upload_url.replace(/\{.*$/, '')+'?name='+encodeURIComponent(filename);asset=await(await auth(upload,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:local})).json();release.assets.push(asset);}
  const remote=Buffer.from(await(await auth(asset.url,{headers:{Accept:'application/octet-stream'}})).arrayBuffer());
  if(hash(remote)!==hash(local))throw new Error('Uploaded asset checksum mismatch: '+filename);
 }
 gh(['api','--method','PATCH',`repos/${repo}/releases/${release.id}`,'-F','draft=false','-f','make_latest=true']);
}
for(const p of result.index.plugins.filter(p=>p.source.startsWith(`https://github.com/${repo}/releases/download/`))){
 const b=await bytes(p.source);if(hash(b)!==p.sha256)throw new Error('Anonymous checksum mismatch: '+p.id);console.log('Anonymous checksum verified',p.id,p.version,p.sha256);
}
await mkdir('.tmp/site',{recursive:true});
await cp('dist/official','.tmp/site/official',{recursive:true});
await cp('dist/marketplace.json','.tmp/site/marketplace.json');await cp('dist/index.html','.tmp/site/index.html');
await writeFile('.tmp/release-receipt.json',JSON.stringify({tag,revision,newPackages:result.newPackages,verified:result.index.plugins.filter(p=>p.source.startsWith(`https://github.com/${repo}/releases/download/`)).length},null,2));
