import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';

// Address policy adapted from @nb-im/core 0.3.0 http-transport.js.
const forbidden4 = new BlockList(), forbidden6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) forbidden4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) forbidden6.addSubnet(address, prefix, 'ipv6');
export function publicAddress(ip) {
  if (isIP(ip) === 4) return !forbidden4.check(ip, 'ipv4');
  const first = Number.parseInt(ip.split(':', 1)[0], 16);
  return isIP(ip) === 6 && first >= 0x2000 && first < 0x4000 && !forbidden6.check(ip, 'ipv6');
}
export async function downloadPublicMedia(input, { signal, maxBytes = 8 * 1024 * 1024, lookupImpl = lookup, requestImpl, timeoutMs = 30000 } = {}) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Attachment URL must be credential-free HTTP(S)'), { code: 'MEDIA_URL_INVALID' });
  const timeout = AbortSignal.timeout(timeoutMs);
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
  lifetime.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(lifetime.reason);
    lifetime.addEventListener('abort', abort, { once: true });
  });
  let addresses;
  try {
    addresses = await Promise.race([isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookupImpl(host, { all: true }), cancelled]);
  } finally { lifetime.removeEventListener('abort', abort); }
  lifetime.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw Object.assign(new Error('Attachment address is not public'), { code: 'MEDIA_URL_INVALID' });
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const req = (requestImpl ?? (url.protocol === 'https:' ? https : http))({
      hostname: host, servername: host, port: url.port || undefined, path: url.pathname + url.search, method: 'GET', signal: lifetime, agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, (res) => {
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Attachment response ended before completion')));
      if (res.statusCode !== 200) { res.destroy(); reject(Object.assign(new Error('Attachment HTTP request rejected; redirects are not followed'), { code: 'MEDIA_HTTP_ERROR' })); return; }
      if (Number(res.headers['content-length']) > maxBytes) {
        res.destroy(); reject(Object.assign(new Error('Attachment too large'), { code: 'MEDIA_TOO_LARGE' })); return;
      }
      const parts = [];
      let total = 0;
      res.on('data', (part) => {
        total += part.length;
        if (total > maxBytes) req.destroy(Object.assign(new Error('Attachment too large'), { code: 'MEDIA_TOO_LARGE' }));
        else parts.push(part);
      });
      res.on('end', () => resolve({ bytes: Buffer.concat(parts), mediaType: res.headers['content-type']?.split(';', 1)[0] }));
    });
    req.on('error', reject);
    req.end();
  });
}
