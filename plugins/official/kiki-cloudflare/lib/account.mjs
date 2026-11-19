import { boundedBytes } from './binary.mjs';

const HEX32 = /^[a-f\d]{32}$/i;
const SAFE_ID = /^[a-zA-Z\d_-]{8,64}$/;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'SRV', 'NS']);
const PROXIABLE_TYPES = new Set(['A', 'AAAA', 'CNAME']);

function cleanSingleLine(value, label, maxLen = 2048) {
  if (typeof value !== 'string') throw new Error(`Provide a valid ${label}.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`Provide a valid ${label}.`);
  }
  return trimmed;
}

function normalizeDnsRecord(item = {}) {
  const type = String(item.type || '').toUpperCase();
  return {
    id: String(item.id || ''),
    type,
    name: String(item.name || ''),
    content: String(item.content || ''),
    ttl: Number.isFinite(Number(item.ttl)) ? Number(item.ttl) : 1,
    proxied: Boolean(item.proxied),
    proxiable: item.proxiable !== undefined ? Boolean(item.proxiable) : PROXIABLE_TYPES.has(type),
    ...(item.priority !== undefined ? { priority: Number(item.priority) } : {}),
  };
}

export class CloudflareAccount {
  constructor({ apiToken, accountId }, { fetchFn = fetch, baseUrl = 'https://api.cloudflare.com/client/v4' } = {}) {
    this.token = apiToken;
    this.accountId = accountId;
    this.fetch = fetchFn;
    this.baseUrl = baseUrl;
  }

  async request(route, signalOrOptions) {
    if (!this.token) throw new Error('Add a Cloudflare API token for account access. Tunnel tokens cannot manage accounts.');
    const isSignal = signalOrOptions && typeof signalOrOptions === 'object' && 'aborted' in signalOrOptions;
    const opts = isSignal ? { signal: signalOrOptions } : (signalOrOptions || {});
    const method = opts.method || 'GET';
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    const timeout = AbortSignal.timeout(15000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const err = new Error(`Cloudflare API returned HTTP ${response.status}. Check token permissions and account selection.`);
      err.status = response.status;
      throw err;
    }
    const json = JSON.parse((await boundedBytes(response, 8 * 1024 * 1024)).toString());
    if (json.success !== true) {
      const firstMsg = Array.isArray(json.errors) && typeof json.errors[0]?.message === 'string' ? json.errors[0].message.trim() : '';
      throw new Error(firstMsg ? `Cloudflare rejected the request: ${firstMsg}` : 'Cloudflare rejected the request. Check token permissions.');
    }
    return json;
  }

  async list(route, signal) {
    const MAX_PAGES = 100;
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await this.request(`${route}${route.includes('?') ? '&' : '?'}page=${page}&per_page=50`, signal);
      if (!Array.isArray(json.result)) throw new Error('Invalid Cloudflare list response.');
      items.push(...json.result);
      const info = json.result_info;
      if (info?.total_pages !== undefined ? page >= Math.min(info.total_pages, MAX_PAGES) : json.result.length < 50) return items;
    }
    return items;
  }

  async accounts(signal) { return (await this.list('/accounts', signal)).map(({ id, name }) => ({ id, name })); }
  accountRoute() {
    if (!HEX32.test(this.accountId ?? '')) throw new Error('Choose a Cloudflare account first.');
    return `/accounts/${this.accountId}/cfd_tunnel`;
  }
  async tunnels(signal) {
    return (await this.list(`${this.accountRoute()}?is_deleted=false`, signal)).map(({ id, name, status }) => ({ id, name, status }));
  }
  async tunnelToken(id, signal) {
    if (!UUID.test(id ?? '')) throw new Error('Choose a valid tunnel UUID.');
    const json = await this.request(`${this.accountRoute()}/${id}/token`, signal);
    if (typeof json.result !== 'string' || !json.result.trim()) throw new Error('Cloudflare did not return a tunnel token.');
    return json.result;
  }

  zoneRoute(zoneId) {
    if (!HEX32.test(zoneId ?? '')) throw new Error('Choose a valid Cloudflare zone ID.');
    return `/zones/${zoneId}`;
  }

  async zones(signal) {
    const raw = await this.list('/zones', signal);
    return raw.map((z) => ({
      id: String(z.id || ''),
      name: String(z.name || ''),
      status: String(z.status || 'active'),
      plan: typeof z.plan?.name === 'string' ? z.plan.name : '',
    }));
  }

  async dnsRecords(zoneId, signal) {
    const raw = await this.list(`${this.zoneRoute(zoneId)}/dns_records`, signal);
    return raw.map(normalizeDnsRecord);
  }

  async saveDnsRecord(zoneId, input = {}, signal) {
    const base = this.zoneRoute(zoneId);
    const type = String(input.type || '').trim().toUpperCase();
    if (!DNS_TYPES.has(type)) throw new Error('Choose a supported DNS record type (A, AAAA, CNAME, TXT, MX, CAA, SRV, NS).');
    const name = cleanSingleLine(input.name, 'DNS record name', 255);
    const content = cleanSingleLine(input.content, 'DNS record content', 4096);
    const rawTtl = input.ttl === undefined || input.ttl === '' ? 1 : Number(input.ttl);
    if (!Number.isInteger(rawTtl) || (rawTtl !== 1 && (rawTtl < 60 || rawTtl > 86400))) {
      throw new Error('TTL must be 1 (Auto) or between 60 and 86400 seconds.');
    }
    const payload = {
      type,
      name,
      content,
      ttl: rawTtl,
      ...(PROXIABLE_TYPES.has(type) ? { proxied: Boolean(input.proxied) } : {}),
    };
    if (type === 'MX' || input.priority !== undefined) {
      const prio = Number(input.priority ?? 10);
      if (!Number.isInteger(prio) || prio < 0 || prio > 65535) throw new Error('MX priority must be between 0 and 65535.');
      payload.priority = prio;
    }

    const recordId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : '';
    if (recordId) {
      if (!SAFE_ID.test(recordId)) throw new Error('Choose a valid DNS record ID.');
      const json = await this.request(`${base}/dns_records/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: payload, signal });
      return normalizeDnsRecord(json.result);
    }
    const json = await this.request(`${base}/dns_records`, { method: 'POST', body: payload, signal });
    return normalizeDnsRecord(json.result);
  }

  async deleteDnsRecord(zoneId, recordId, signal) {
    const base = this.zoneRoute(zoneId);
    const id = typeof recordId === 'string' ? recordId.trim() : '';
    if (!SAFE_ID.test(id)) throw new Error('Choose a valid DNS record ID.');
    await this.request(`${base}/dns_records/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
    return { id, deleted: true };
  }

  async workerRoutes(zoneId, signal) {
    const base = this.zoneRoute(zoneId);
    try {
      const json = await this.request(`${base}/workers/routes`, signal);
      const list = Array.isArray(json.result) ? json.result : [];
      return {
        supported: true,
        items: list.map((r) => ({
          id: String(r.id || ''),
          pattern: String(r.pattern || ''),
          script: typeof r.script === 'string' ? r.script : '',
        })),
      };
    } catch (error) {
      if (error?.status === 403 || error?.status === 404) {
        return { supported: false, items: [] };
      }
      throw error;
    }
  }
}
