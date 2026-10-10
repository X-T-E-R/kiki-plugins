import { boundedBytes } from './binary.mjs';

export class CloudflareAccount {
  constructor({ apiToken, accountId }, { fetchFn = fetch, baseUrl = 'https://api.cloudflare.com/client/v4' } = {}) {
    this.token = apiToken;
    this.accountId = accountId;
    this.fetch = fetchFn;
    this.baseUrl = baseUrl;
  }

  async request(route, signal) {
    if (!this.token) throw new Error('Add a Cloudflare API token for account access. Tunnel tokens cannot manage accounts.');
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Cloudflare API returned HTTP ${response.status}. Check token permissions and account selection.`);
    const json = JSON.parse((await boundedBytes(response, 8 * 1024 * 1024)).toString());
    if (json.success !== true) throw new Error('Cloudflare rejected the request. Check token permissions.');
    return json;
  }

  async list(route, signal) {
    const items = [];
    for (let page = 1;; page++) {
      const json = await this.request(`${route}${route.includes('?') ? '&' : '?'}page=${page}&per_page=50`, signal);
      if (!Array.isArray(json.result)) throw new Error('Invalid Cloudflare list response.');
      items.push(...json.result);
      const info = json.result_info;
      if (info?.total_pages !== undefined ? page >= info.total_pages : json.result.length < 50) return items;
    }
  }

  async accounts(signal) { return (await this.list('/accounts', signal)).map(({ id, name }) => ({ id, name })); }
  accountRoute() {
    if (!/^[a-f\d]{32}$/i.test(this.accountId ?? '')) throw new Error('Choose a Cloudflare account first.');
    return `/accounts/${this.accountId}/cfd_tunnel`;
  }
  async tunnels(signal) {
    return (await this.list(`${this.accountRoute()}?is_deleted=false`, signal)).map(({ id, name, status }) => ({ id, name, status }));
  }
  async tunnelToken(id, signal) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new Error('Choose a valid tunnel UUID.');
    const json = await this.request(`${this.accountRoute()}/${id}/token`, signal);
    if (typeof json.result !== 'string' || !json.result.trim()) throw new Error('Cloudflare did not return a tunnel token.');
    return json.result;
  }
}
