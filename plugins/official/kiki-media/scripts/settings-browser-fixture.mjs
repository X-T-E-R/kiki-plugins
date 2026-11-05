import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handlePanelRequest } from '../entry.mjs';

const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));
const properties = manifest['x-kiki'].settings.schema.properties;
const settings = {
  defaultImageProvider: 'openai-image',
  openai__enabled: true,
  openai__baseUrl: 'https://own-openai.example.test/v1',
  openai__imageModel: 'gpt-image-1.5',
  openai__apiKey: 'fixture-openai-key',
  google__enabled: true,
  google__baseUrl: 'https://own-google.example.test/v1beta',
  google__apiKey: 'fixture-google-key',
};
const patches = [];
let failSave = false;
let failConnections = false;
const settingsWire = () => ({
  schema: manifest['x-kiki'].settings,
  values: Object.fromEntries(Object.entries(settings).filter(([key]) => !properties[key]?.secret)),
  secretsConfigured: Object.keys(settings).filter((key) => properties[key]?.secret),
});
const parent = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media settings: isolated bridge fixture</title><style>body{margin:0;background:#fbfaf6;color:#1b1a17;font:12px/1.5 ui-sans-serif,system-ui,'Segoe UI','PingFang SC',sans-serif}header{padding:8px 16px;border-bottom:1px solid #e4ddd0;color:#665e54}iframe{border:0;width:100%;height:1050px;display:block}footer{padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid #e4ddd0}button{padding:6px 10px;font:inherit}</style><header>Media settings · isolated Host bridge · synthetic values only</header><iframe id="frame" sandbox="allow-scripts"></iframe><footer><button id="language">English</button><button id="dark">Dark</button><button id="fail-save">Fail next save</button><button id="fail-connections">Fail next connection load</button><button id="reopen">Reopen</button></footer><script>const channel='kiki.panel.v1',frame=document.getElementById('frame');window.fixture={dirty:false,calls:[]};let locale='zh',theme='light';function post(data){frame.contentWindow.postMessage({channel,...data},'*')}function present(){post({kind:'presentation',presentation:{locale,theme}})}frame.addEventListener('load',()=>post({kind:'init',presentation:{locale,theme}}));frame.srcdoc=${JSON.stringify(html).replaceAll('<', '\\u003c')};window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.channel!==channel||event.data.kind!=='request')return;const data=event.data;window.fixture.calls.push({method:data.method,action:data.action});if(data.method==='plugin.dirty'){window.fixture.dirty=data.dirty;post({kind:'response',id:data.id,ok:true,result:{}});return}try{const response=await fetch('/bridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const reply=await response.json();post({kind:'response',id:data.id,...reply})}catch{post({kind:'response',id:data.id,ok:false,error:'Fixture bridge failure'})}});document.getElementById('language').onclick=()=>{locale=locale==='zh'?'en':'zh';document.getElementById('language').textContent=locale==='zh'?'English':'中文';present()};document.getElementById('dark').onclick=()=>{theme=theme==='dark'?'light':'dark';present()};document.getElementById('fail-save').onclick=()=>fetch('/fail-save',{method:'POST'});document.getElementById('fail-connections').onclick=()=>fetch('/fail-connections',{method:'POST'}).then(()=>location.reload());document.getElementById('reopen').onclick=()=>location.reload();</script></html>`;
const server = createServer(async (req, res) => {
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  try {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(parent); return; }
    if (req.method === 'GET' && req.url === '/summary') {
      json({ patches, values: settingsWire().values, secretsConfigured: settingsWire().secretsConfigured });
      return;
    }
    if (req.method === 'POST' && req.url === '/fail-save') { failSave = true; json({ ok: true }); return; }
    if (req.method === 'POST' && req.url === '/fail-connections') { failConnections = true; json({ ok: true }); return; }
    if (req.method === 'POST' && req.url === '/bridge') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('fixture payload too large'); }
      const data = JSON.parse(body);
      if (data.method === 'plugin.call' && data.action === 'catalog') { json({ ok: true, result: await handlePanelRequest('catalog', {}, { settings }) }); return; }
      if (data.method === 'plugin.settings.get') { json({ ok: true, result: settingsWire() }); return; }
      if (data.method === 'plugin.models.list') {
        if (failConnections) { failConnections = false; json({ ok: false, error: 'Synthetic connection catalog failure' }); return; }
        json({ ok: true, result: { models: [], connections: [
          { id: 'openai-team', type: 'openai', status: 'ready', service: 'chat', authentication: 'oauth' },
          { id: 'local-gateway', type: 'openai-compatible', status: 'ready', service: 'chat', authentication: 'api-key' },
        ] } });
        return;
      }
      if (data.method === 'plugin.settings.patch') {
        if (failSave) { failSave = false; json({ ok: false, error: 'Synthetic save rejection. Correct the value and retry.' }); return; }
        patches.push(Object.fromEntries(Object.entries(data.values).map(([key, value]) => [key, properties[key]?.secret ? '<redacted>' : value])));
        for (const [key, value] of Object.entries(data.values)) {
          if (value === null) delete settings[key]; else settings[key] = value;
        }
        json({ ok: true, result: settingsWire() });
        return;
      }
      throw new Error('unexpected fixture bridge method');
    }
    res.writeHead(404); res.end('Fixture denies unexpected requests');
  } catch (error) { json({ ok: false, error: error.message }, 400); }
});
server.listen(0, '127.0.0.1', () => console.log(`MEDIA_BROWSER_FIXTURE=http://127.0.0.1:${server.address().port}/`));
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => server.close());
