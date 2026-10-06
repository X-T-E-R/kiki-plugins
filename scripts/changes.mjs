import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export function changedPackages(paths, ids) {
  const selected=new Set(); let metadataOnly=true;
  for(const p of paths){
    if(p==='plugins/marketplace.json'||p.startsWith('catalog/')||p.endsWith('.md')&&!p.startsWith('plugins/official/'))continue;
    metadataOnly=false;
    if(p.startsWith('plugins/official/media-runtime/')){for(const id of ids.filter(id=>id==='kiki-media'||id.startsWith('kiki-media-')))selected.add(id);continue;}
    if(/^plugins\/official\/kiki-media-[^/]+\//.test(p)&&ids.includes('kiki-media'))selected.add('kiki-media');
    const id=p.match(/^plugins\/official\/([^/]+)\//)?.[1];
    if(ids.includes(id)){selected.add(id);continue;}
    if(/^(scripts\/|test\/|vendor\/|sdk\.lock|package|\.github\/)/.test(p))for(const id of ids)selected.add(id);
  }
  return {packages:[...selected].sort(),metadataOnly};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const catalog=JSON.parse(await readFile('plugins/marketplace.json','utf8'));
 const ids=catalog.plugins.filter(p=>p.source.startsWith('./official/')).map(p=>p.id);
 const base=process.env.BASE_SHA;
 let paths;
 try {if(!base||/^0+$/.test(base))throw new Error('initial');paths=execFileSync('git',['diff','--name-only',base,'HEAD']).toString().trim().split('\n');}catch{paths=['package.json'];}
 const result=changedPackages(paths,ids);
 console.log(JSON.stringify({...result,matrix:result.packages.length?result.packages:['catalog']}));
}
