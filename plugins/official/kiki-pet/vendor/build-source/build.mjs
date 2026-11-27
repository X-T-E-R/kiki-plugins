import {readFile,writeFile,mkdir,cp,copyFile,stat,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tools} from '../lib/definitions.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const copyOnly=process.argv.includes('--copy-only');
const platform=`${process.platform}-${process.arch}`;
function remapRustFlags(){
  const home=os.homedir();
  const cargoHome=process.env.CARGO_HOME||path.join(home,'.cargo');
  const repoRoot=path.resolve(root,'../../..');
  const pairs=[
    [cargoHome,'/cargo'],
    [home,'/home/builder'],
    [repoRoot,'/src'],
  ];
  const flags=['-C','strip=debuginfo'];
  const seen=new Set();
  for(const [from,to] of pairs){
    for(const variant of [from,from.replace(/\\/g,'/'),from.replace(/\//g,'\\')]){
      if(!variant||seen.has(variant))continue;
      seen.add(variant);
      flags.push(`--remap-path-prefix=${variant}=${to}`);
    }
  }
  const existing=process.env.CARGO_ENCODED_RUSTFLAGS?process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean):[];
  return [...existing,...flags].join('\x1f');
}
if(!copyOnly){const result=spawnSync('cargo',['build','--release','--manifest-path',path.join(root,'runtime/src-tauri/Cargo.toml')],{stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:path.resolve(root,'../../../.tmp/desktop-pet-plugin/cargo-target'),CARGO_ENCODED_RUSTFLAGS:remapRustFlags()}});if(result.status!==0)process.exit(result.status??1);}
const target=path.resolve(root,'../../../.tmp/desktop-pet-plugin/cargo-target/release',process.platform==='win32'?'kiki-pet-runtime.exe':'kiki-pet-runtime');
const destination=path.join(root,'vendor/runtime',platform);await mkdir(destination,{recursive:true});await copyFile(target,path.join(destination,path.basename(target)));
// Sync panel assets when a separate top-level panel/ directory exists.
if(existsSync(path.join(root,'panel'))){await rm(path.join(root,'lib/panel'),{recursive:true,force:true});await cp(path.join(root,'panel'),path.join(root,'lib/panel'),{recursive:true});}
const source=path.join(root,'vendor/runtime-source');await mkdir(source,{recursive:true});
for(const file of ['Cargo.toml','Cargo.lock','build.rs','tauri.conf.json'])await copyFile(path.join(root,'runtime/src-tauri',file),path.join(source,file));
for(const folder of ['src','capabilities','icons'])await cp(path.join(root,'runtime/src-tauri',folder),path.join(source,folder),{recursive:true});
await cp(path.join(root,'runtime/ui'),path.join(source,'ui'),{recursive:true});
const conf=JSON.parse(await readFile(path.join(source,'tauri.conf.json'),'utf8'));conf.build.frontendDist='./ui';await writeFile(path.join(source,'tauri.conf.json'),JSON.stringify(conf,null,2)+'\n');
await copyFile(path.join(root,'LICENSE'),path.join(source,'LICENSE'));
await copyFile(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(source,'THIRD_PARTY_NOTICES.md'));
await mkdir(path.join(root,'vendor/build-source'),{recursive:true});
for(const file of ['build.mjs','make-default.py','collect-runtime-licenses.mjs'])await copyFile(path.join(root,'scripts',file),path.join(root,'vendor/build-source',file));
await cp(path.join(root,'scripts/runtime-license-overrides'),path.join(root,'vendor/build-source/runtime-license-overrides'),{recursive:true});
await import('./collect-runtime-licenses.mjs');
const manifest=JSON.parse(await readFile(path.join(root,'kimi.plugin.json'),'utf8'));manifest['x-kiki'].tools=tools;await writeFile(path.join(root,'kimi.plugin.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({platform,executableBytes:(await stat(path.join(destination,path.basename(target)))).size}));
