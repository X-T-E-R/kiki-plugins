import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function acquireLease(address = process.platform === 'win32' ? '\\\\.\\pipe\\kiki-everything-es-query-v1' : path.join(os.tmpdir(), 'kiki-everything-es-query-v1.sock')) {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', error => {
      error.code = error.code === 'EADDRINUSE' || error.code === 'EACCES' ? 'ES_BUSY' : 'ES_LOCK';
      error.message = error.code === 'ES_BUSY' ? 'Everything has a query from another plugin session. Wait and retry with a narrower query.' : `Cannot acquire the Everything query lease: ${error.message}`;
      reject(error);
    });
    server.listen(address, () => resolve({ release: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())) }));
  });
}
export function clientIdentity(instance = '') {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Filter "name=\'Everything.exe\'" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 4000);
    child.stdout.on('data', data => chunks.push(data));
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const clients = (Array.isArray(raw) ? raw : [raw]).filter(item => {
          if (!item?.CommandLine || /(?:^|\s)-(?:service|svc)(?:\s|$)/i.test(item.CommandLine)) return false;
          const named = /-instance\s+(?:"([^"]+)"|(\S+))/i.exec(item.CommandLine);
          return (named?.[1] ?? named?.[2] ?? '').toLowerCase() === instance.toLowerCase();
        });
        resolve(clients.map(item => `${item.ProcessId}:${item.CreationDate}`).sort().join('|') || null);
      } catch { resolve(null); }
    });
  });
}
