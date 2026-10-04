import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare as compareVersion } from 'semver';
import { buildPluginMarketplaceCdn } from './build-plugin-marketplace-cdn.mjs';
import { inputDigest } from './package-files.mjs';

export async function pack({ pluginsRoot = resolve('plugins'), outDir = resolve('dist'), tag = 'local', previous, revision = 'local', siteBase = 'https://x-t-e-r.github.io/kiki-plugins/', releaseBase = `https://github.com/X-T-E-R/kiki-plugins/releases/download/${tag}/` } = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(tag)) throw new Error('Invalid release tag');
  const catalog = JSON.parse(await readFile(join(pluginsRoot,'marketplace.json'),'utf8'));
  const prior = new Map((previous?.plugins ?? []).map(p=>[p.id,p]));
  const reuse = new Map(), inputs = new Map();
  const ids = new Set();
  for (const p of catalog.plugins) {
    if (ids.has(p.id)) throw new Error('Duplicate catalog id: '+p.id); ids.add(p.id);
    if (!p.author || !p.license || !p.version || !p.source) throw new Error('Incomplete catalog entry: '+p.id);
    if (!p.source.startsWith('./official/')) {
      if (!p.compatibility?.status || !/^https:\/\//.test(p.source)) throw new Error('External catalog contract missing: '+p.id);
      const pinnedGitHub=/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:commit|tree)\/[a-f0-9]{40}$/.test(p.source);
      if(!pinnedGitHub&&!/^[a-f0-9]{64}$/.test(p.sha256??''))throw new Error('External source needs a fixed commit or ZIP checksum: '+p.id);
      continue;
    }
    if (p.source !== `./official/${p.id}`) throw new Error('Local identity/path mismatch: '+p.id);
    const root = resolve(pluginsRoot,p.source), manifest=JSON.parse(await readFile(join(root,'kimi.plugin.json'),'utf8'));
    if (manifest.name !== p.id || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Invalid package identity/version: '+p.id);
    const digest=await inputDigest(root); inputs.set(p.id,digest);
    const history=previous?.packageHistory?.[p.id]??[];
    const old=history.find(x=>x.version===manifest.version)??prior.get(p.id);
    if (old?.version === manifest.version) {
      if (old.inputSha256 !== digest) throw new Error(`Immutable ${p.id}@${manifest.version} changed; bump its version`);
      if (!/^[a-f0-9]{64}$/.test(old.sha256 ?? '') || !old.source.startsWith('https://github.com/X-T-E-R/kiki-plugins/releases/download/')) throw new Error('Invalid previous release contract: '+p.id);
      reuse.set(p.id,old);
    } else if (old?.version && compareVersion(manifest.version,old.version) <= 0) throw new Error('Version must increase: '+p.id);
  }
  await buildPluginMarketplaceCdn({pluginsRoot,outDir,publicBaseUrl:siteBase,reuse});
  const index = JSON.parse(await readFile(join(outDir,'marketplace.json'),'utf8'));
  await mkdir(join(outDir,'assets'),{recursive:true});
  const newPackages=[];
  for (const p of index.plugins) {
    if (!inputs.has(p.id)) continue;
    p.inputSha256=inputs.get(p.id);
    if (!reuse.has(p.id)) {
      const filename=`${p.id}-${p.version}.zip`;
      await copyFile(join(outDir,'official',p.id,filename),join(outDir,'assets',filename));
      await rm(join(outDir,'official',p.id,filename));
      p.source=releaseBase+filename;
      newPackages.push({id:p.id,version:p.version,filename,sha256:p.sha256,inputSha256:p.inputSha256});
    }
  }
  index.revision=revision;
  index.releaseTag=tag;
  index.packageHistory=structuredClone(previous?.packageHistory??{});
  for(const p of index.plugins.filter(p=>inputs.has(p.id))){
    const versions=index.packageHistory[p.id]??=[];
    if(!versions.some(v=>v.version===p.version))versions.push({version:p.version,source:p.source,sha256:p.sha256,inputSha256:p.inputSha256,engines:p.engines,icon:p.icon});
  }
  await writeFile(join(outDir,'marketplace.json'),JSON.stringify(index,null,2)+'\n');
  await writeFile(join(outDir,'assets','marketplace.json'),JSON.stringify(index,null,2)+'\n');
  const checksums=newPackages.map(p=>`${p.sha256}  ${p.filename}`).join('\n')+'\n';
  await writeFile(join(outDir,'assets','SHA256SUMS'),checksums);
  await writeFile(join(outDir,'release.json'),JSON.stringify({revision,tag,newPackages,reused:[...reuse.keys()]},null,2)+'\n');
  await writeFile(join(outDir,'index.html'),render(index));
  await writeFile(join(outDir,'.kimi-plugin-marketplace-build.json'), '{"generatedBy":"kiki-plugins"}\n');
  console.log(`Packed ${newPackages.length}; reused ${reuse.size}; catalog ${index.plugins.length}`);
  return {index,newPackages};
}
function escape(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(index){return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiki Plugins</title><style>body{font:18px Georgia,serif;max-width:960px;margin:48px auto;padding:0 24px;color:#25231e;background:#faf8f2}h1{font-size:48px}article{border-top:1px solid #ddd5c7;padding:24px 0}img{width:48px;height:48px;float:right}small{color:#665d50}a{color:#225c54}p{line-height:1.5}</style><h1>Kiki Plugins</h1><p>Install from Kiki's plugin market. Preview permissions and dependencies before enabling.</p><p><a href="marketplace.json">Catalog JSON</a> · <a href="https://github.com/X-T-E-R/kiki-plugins">Source & contribution guide</a></p>${index.plugins.map(p=>`<article>${p.icon?`<img alt="" src="${escape(p.icon)}">`:''}<h2>${escape(p.displayName)}</h2><small>${escape(p.author)} · ${escape(p.version)} · ${escape(p.license)} · ${escape(p.engines?.kiki ?? p.compatibility?.status ?? 'engine not declared')}</small><p>${escape(p.description)}</p>${p.compatibility?`<p>${escape(p.compatibility.notes)}</p>`:''}<a href="${escape(p.homepage??p.source)}">Author / source</a> · <a href="${escape(p.source)}">Package source</a>${p.sha256?`<p><small>SHA-256: ${escape(p.sha256)}</small></p>`:''}</article>`).join('')}</html>\n`;}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const previous=process.env.PREVIOUS_INDEX ? JSON.parse(await readFile(process.env.PREVIOUS_INDEX,'utf8')) : undefined;
 await pack({tag:process.env.RELEASE_TAG??'local',revision:process.env.GITHUB_SHA??'local',previous});
}
