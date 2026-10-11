import {readFile,readdir,stat,mkdir,writeFile,copyFile,rm,cp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const result=spawnSync('cargo',['metadata','--offline','--locked','--format-version=1','--filter-platform',process.platform==='win32'?'x86_64-pc-windows-msvc':`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux-gnu'}`,'--manifest-path',path.join(root,'runtime/src-tauri/Cargo.toml')],{encoding:'utf8',maxBuffer:16*1024*1024});
if(result.status!==0)throw new Error(result.stderr);
const metadata=JSON.parse(result.stdout),ids=new Set(metadata.resolve.nodes.map(node=>node.id)),out=path.join(root,'vendor/runtime-licenses');await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});const packages=[];
for(const pkg of metadata.packages.filter(pkg=>ids.has(pkg.id)&&pkg.source)){
 const directory=path.dirname(pkg.manifest_path),names=(await readdir(directory)).filter(name=>/^(?:LICEN[CS]E|COPYING|NOTICE)(?:$|[-_.])/i.test(name));if(pkg.license_file)names.push(path.relative(directory,pkg.license_file));const files=[];
 for(const name of new Set(names)){const input=path.resolve(directory,name),relative=path.relative(directory,input);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('License file escapes crate');if(!(await stat(input)).isFile())continue;const file=`${pkg.name}-${pkg.version}/${relative.replaceAll('\\','/')}`;await mkdir(path.dirname(path.join(out,file)),{recursive:true});await copyFile(input,path.join(out,file));files.push(file);}
 if(!files.length){
  const override=pkg.name.startsWith('webview2-com')?'webview2-com':pkg.name;
  const input=pkg.name==='selectors'?path.join(path.dirname(metadata.packages.find(item=>item.name==='cssparser').manifest_path),'LICENSE'):path.join(root,'scripts/runtime-license-overrides',override,pkg.name==='defmt-parser'?'LICENSE-MIT':'LICENSE');
  const file=`${pkg.name}-${pkg.version}/LICENSE`;await mkdir(path.dirname(path.join(out,file)),{recursive:true});await copyFile(input,path.join(out,file));files.push(file);
 }
 let correspondingSource;
 if(pkg.license==='MPL-2.0'){
  correspondingSource=`vendor/native-dependency-source/${pkg.name}-${pkg.version}`;
  await cp(directory,path.join(root,correspondingSource),{recursive:true,filter:input=>!path.basename(input).startsWith('.')});
  await copyFile(path.join(out,files[0]),path.join(root,correspondingSource,'LICENSE'));
 }
 packages.push({name:pkg.name,version:pkg.version,license:pkg.license,repository:pkg.repository,source:pkg.source,files,correspondingSource});
}
await writeFile(path.join(out,'index.json'),JSON.stringify({scope:'Cargo resolved graph filtered for build platform; includes build dependencies, not a claim that every crate is linked into the binary',packages},null,2)+'\n');
console.log(JSON.stringify({nativeDependencyPackages:packages.length,licenseFiles:packages.reduce((count,pkg)=>count+pkg.files.length,0),withoutLicenseFiles:packages.filter(pkg=>!pkg.files.length).map(pkg=>({name:pkg.name,version:pkg.version,license:pkg.license}))}));
