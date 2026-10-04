#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pack } from './pack.mjs';
export async function startPluginMarketplaceServer(options = {}) {
  const pluginsRoot=resolve(options.pluginsRoot??'plugins'), outDir=resolve(options.outDir??'.tmp/dev-cdn');
  let ready=false;
  const server=createServer((req,res)=>{void serve(req,res,outDir,ready);});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(options.port??0,'127.0.0.1',yes);});
  const base=`http://127.0.0.1:${server.address().port}/`;
  try {await pack({pluginsRoot,outDir,siteBase:base,releaseBase:base+'assets/'});ready=true;}catch(e){server.close();throw e;}
  return {server,pluginsRoot,marketplaceUrl:base+'marketplace.json',close:()=>new Promise((yes,no)=>server.close(e=>e?no(e):yes()))};
}
async function serve(req,res,root,ready){
 if(!ready){res.writeHead(503);res.end();return;}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
 try {
  let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'index.html';
  if(name.split('/').some(p=>p.startsWith('.'))){res.writeHead(403);res.end();return;}
  const file=resolve(root,name),rel=relative(root,file);
  if(rel.startsWith('..')||isAbsolute(rel)){res.writeHead(403);res.end();return;}
  const info=await stat(file).catch(()=>undefined);if(!info?.isFile()){res.writeHead(404);res.end();return;}
  const type={'.json':'application/json','.zip':'application/zip','.svg':'image/svg+xml','.html':'text/html; charset=utf-8'}[extname(file)]??'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Content-Length':info.size});
  if(req.method==='HEAD')res.end();else createReadStream(file).on('error',e=>res.destroy(e)).pipe(res);
 }catch{res.writeHead(400);res.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const started=await startPluginMarketplaceServer();console.log(started.marketplaceUrl);}
