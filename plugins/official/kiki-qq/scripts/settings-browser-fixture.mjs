import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { OfficialBinding } from '../lib/official-binding.mjs';

const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
const lifetime = new AbortController();
let callbacks, writes = 0, failSave = false;
const manualPatches = [];
const settings = { official__appId: '82041957', official__appSecret: 'fixture-old-secret', onebot__wsUrl: 'ws://127.0.0.1:6700', onebot__accessToken: 'fixture-onebot-token' };
const binding = new OfficialBinding({ connect(cb) { callbacks = cb; queueMicrotask(() => cb.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=browser-fixture-only&source=kiki-qq&_wv=2')); return () => {}; } });
const activate = () => binding.activate({ settings: { ...settings }, signal: lifetime.signal, updateSettings: async patch => { if (failSave) { failSave = false; throw new Error('fixture save failure'); } ++writes; Object.assign(settings, patch); activate(); } });
activate();
const settingsWire = () => ({ schema: manifest['x-kiki'].settings.schema, values: Object.fromEntries(Object.entries(settings).filter(([key]) => !manifest['x-kiki'].settings.schema.properties[key]?.secret)), secretsConfigured: Object.keys(settings).filter(key => manifest['x-kiki'].settings.schema.properties[key]?.secret) });
const parent = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ settings: isolated bridge fixture</title><style>body{margin:0;background:#fbfaf6;font:12px/1.5 sans-serif}header{padding:8px 16px;border-bottom:1px solid #e4ddd0;color:#665e54}iframe{border:0;width:100%;height:900px;display:block}footer{padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap}button{padding:6px 10px}</style><header>Isolated parent bridge stub · no official QR task</header><iframe id="frame" sandbox="allow-scripts"></iframe><footer><button id="confirm">Confirm phone (fixture)</button><button id="expire">Expire (fixture)</button><button id="failure">Fail SDK (fixture)</button><button id="fail-save">Fail next save</button><button id="english">English</button><button id="dark">Dark</button></footer><script>const channel='kiki.panel.v1',frame=document.getElementById('frame');window.fixture={dirty:false,calls:[]};let locale='zh',theme='light';function post(data){frame.contentWindow.postMessage({channel,...data},'*')}function present(){post({kind:'presentation',presentation:{locale,theme}})}frame.addEventListener('load',()=>post({kind:'init',presentation:{locale,theme}}));frame.srcdoc=${JSON.stringify(html).replaceAll('<', '\\u003c')};window.addEventListener('message',async e=>{if(e.source!==frame.contentWindow||e.data?.channel!==channel||e.data.kind!=='request')return;const data=e.data;window.fixture.calls.push({method:data.method,action:data.action});try{let result;if(data.method==='plugin.dirty'){window.fixture.dirty=data.dirty;result={}}else if(data.method==='plugin.openExternal'){window.fixture.openedUrl=data.url;result={}}else{const response=await fetch('/bridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});result=await response.json()}post({kind:'response',id:data.id,ok:true,result})}catch{post({kind:'response',id:data.id,ok:false,error:'fixture failure'})}});for(const id of ['confirm','expire','failure','fail-save'])document.getElementById(id).onclick=()=>fetch('/'+id,{method:'POST'});document.getElementById('english').onclick=()=>{locale='en';present()};document.getElementById('dark').onclick=()=>{theme=theme==='dark'?'light':'dark';present()};</script></html>`;
const server = createServer(async (req, res) => {
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(parent); return; }
    if (req.method === 'GET' && req.url === '/summary') { json({ writes, appId: settings.official__appId, onebotSelfId: settings.onebot__selfId, onebotUnchanged: settings.onebot__accessToken === 'fixture-onebot-token', officialCandidateMatches: settings.official__appId === '92847106' && settings.official__appSecret === 'fixture-only-new-secret', officialManualMatches: settings.official__appId === '60412976' && settings.official__appSecret === 'fixture-manual-draft-secret', manualPatches }); return; }
    if (req.method === 'POST' && req.url === '/bridge') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('fixture payload too large'); }
      const data = JSON.parse(body);
      if (data.method === 'plugin.settings.get') { json(settingsWire()); return; }
      if (data.method === 'plugin.settings.patch') { manualPatches.push(Object.fromEntries(Object.entries(data.values).map(([key, value]) => [key, manifest['x-kiki'].settings.schema.properties[key]?.secret ? '<redacted>' : value]))); Object.assign(settings, data.values); activate(); json(settingsWire()); return; }
      if (data.method === 'plugin.call') { json(await binding.panel(data.action, data.args, { settings: { ...settings } })); return; }
      throw new Error('unexpected fixture bridge method');
    }
    if (req.method === 'POST') {
      if (req.url === '/confirm') callbacks?.onSuccess([{ appId: '92847106', appSecret: 'fixture-only-new-secret' }]);
      else if (req.url === '/expire') callbacks?.onQrExpired();
      else if (req.url === '/failure') callbacks?.onFailure(new Error('fixture failure'));
      else if (req.url === '/fail-save') failSave = true;
      else throw new Error('unexpected fixture action');
      json({ ok: true }); return;
    }
    res.writeHead(404); res.end('Fixture denies unexpected requests');
  } catch { res.writeHead(400); res.end('Fixture request failed'); }
});
server.listen(0, '127.0.0.1', () => console.log(`QQ_BROWSER_FIXTURE=http://127.0.0.1:${server.address().port}/`));
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { lifetime.abort(); server.close(); });
