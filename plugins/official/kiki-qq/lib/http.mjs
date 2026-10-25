function httpUrl(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Only credential-free HTTP(S) URLs are allowed'), { code: 'INVALID_URL' });
  return url;
}
export class HttpProtocolError extends Error {
  constructor(message, { code = 'HTTP_ERROR', status = 0, bizCode, retryAfterMs, retryAfter } = {}) {
    super(retryAfter === undefined || retryAfter === null ? message : `Retry-After=${JSON.stringify(retryAfter)}; ${message}`);
    this.name = 'HttpProtocolError'; Object.assign(this, { code, status, bizCode, retryAfterMs });
  }
}
function retryDelay(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const numeric = /^\d+(?:\.\d+)?$/.test(text);
  const milliseconds = numeric ? Number(text) * 1000 : /[A-Za-z]{3}.*\d{2}:\d{2}:\d{2}/u.test(text) ? Date.parse(text) - Date.now() : NaN;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.ceil(milliseconds)) : undefined;
}
export function createHttpClient({ fetchImpl = globalThis.fetch, baseUrl, defaultHeaders = {}, timeoutMs = 30000, allowOrigins } = {}) {
  const base = httpUrl(baseUrl);
  const origins = allowOrigins ? new Set(allowOrigins.map((value) => new URL(value).origin)) : new Set([base.origin]);
  async function request(path, options = {}) {
    const target = httpUrl(new URL(path, base));
    if (!origins.has(target.origin)) throw new HttpProtocolError('Unexpected network origin', { code: 'NETWORK_DENIED' });
    if (options.signal?.aborted) throw new HttpProtocolError('Cancelled before HTTP request', { code: 'NOT_SENT' });
    const timeout = AbortSignal.timeout(options.timeoutMs ?? timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers = new Headers(defaultHeaders);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      const response = await fetchImpl(target.href, { method: options.method ?? 'GET', headers, signal, redirect: 'manual', body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      if ([301, 302, 303, 307, 308].includes(response.status)) throw new HttpProtocolError('Authenticated redirects are not followed', { code: 'REDIRECT', status: response.status });
      const retryAfter = response.status === 429 ? response.headers.get('retry-after') : undefined;
      const retryAfterMs = retryDelay(retryAfter);
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : undefined; } catch { throw new HttpProtocolError('Malformed platform JSON receipt', { code: 'INVALID_RESPONSE', status: response.status, retryAfterMs, retryAfter }); }
      const bizCode = Number(data?.code ?? data?.err_code);
      if (!response.ok) throw new HttpProtocolError(String(data?.message ?? data?.msg ?? data?.wording ?? `HTTP ${response.status}`), { code: `HTTP_${response.status}`, status: response.status, bizCode, retryAfterMs, retryAfter });
      if (Number.isFinite(bizCode) && bizCode !== 0) throw new HttpProtocolError(String(data.message ?? data.msg ?? `Platform code ${bizCode}`), { code: 'PLATFORM_REJECTED', status: response.status, bizCode });
      return { status: response.status, headers: response.headers, data, text };
    } catch (error) {
      if (error instanceof HttpProtocolError) throw error;
      throw new HttpProtocolError(signal.aborted ? 'HTTP wait aborted or timed out' : 'HTTP response lost', { code: signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' });
    }
  }
  return { request };
}
