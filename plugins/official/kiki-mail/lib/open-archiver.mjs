import { archiveBaseUrl, coded } from './accounts.mjs';
import { parseMessage } from './parse.mjs';

export function archiveIdentity(accountId, archiveId) {
  if (typeof archiveId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(archiveId)) throw coded('identity_invalid', 'Use the archiveId returned by Open Archiver search.');
  return { provider: 'open-archiver', accountId, archiveId };
}

export function archiveClient(account, credential = {}, { signal, fetch: send = globalThis.fetch } = {}) {
  const base = archiveBaseUrl(account.baseUrl);
  return async (route, { query, body, binary = false } = {}) => {
    if (!credential.apiKey) throw coded('auth_missing', 'Save an Open Archiver API key in the Mail panel.');
    const headers = { 'X-API-KEY': credential.apiKey };
    const url = new URL(`${base}/api/v1/${route}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== '' && value != null) url.searchParams.set(key, String(value));
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = AbortSignal.timeout(account.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await send(url, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal: combined, redirect: 'error' });
      if (!response.ok) {
        if (response.status === 400 && route === 'ingestion-sources' && body?.provider === 'generic_imap' && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
          const failure = await response.json().catch((error) => { if (combined.aborted) throw error; });
          if (isImapCreateRollback(failure)) throw coded('archive_create_rolled_back', 'Open Archiver rejected the IMAP connection and rolled back source creation.');
        } else await response.body?.cancel();
        const code = response.status === 401 ? 'auth_failed' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : 'archive_http';
        throw coded(code, `Open Archiver returned HTTP ${response.status}${response.status === 401 ? ': check the API key' : response.status === 403 ? ': this key lacks permission' : ''}.`);
      }
      if (binary) return Buffer.from(await response.arrayBuffer());
      try { return await response.json(); }
      catch (error) { if (combined.aborted) throw error; throw coded('archive_protocol', 'Open Archiver returned an invalid JSON response.'); }
    } catch (error) {
      if (signal?.aborted) throw coded('cancelled', 'The Open Archiver request was cancelled.');
      if (timeout.aborted) throw coded('timeout', 'The Open Archiver request timed out.');
      if (error.code && ['auth_missing', 'auth_failed', 'forbidden', 'not_found', 'archive_http', 'archive_protocol', 'archive_create_rolled_back'].includes(error.code)) throw error;
      throw coded('disconnected', 'Open Archiver could not be reached. Check the service URL and TLS connection.');
    }
  };
}

function isImapCreateRollback(failure) {
  // OA v0.6.2 rethrows testConnection's error only after deleting the new source.
  const message = failure?.message;
  return typeof message === 'string' && Object.keys(failure).length === 1 && (
    message === 'Ingestion authentication failed.'
    || /^IMAP Connection Error: ./.test(message)
    || message.startsWith('The mail server accepted the sign-in and then refused to open the mailbox.')
  );
}

export async function archiveSearch(account, request, args = {}) {
  if (args.unseen === true || args.mailbox) throw coded('unsupported', 'Open Archiver has mailbox-owner filters, not source folders or unread flags. Use sourceIds or mailboxes.');
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw coded('page_invalid', 'Page size must be from 1 to 100.');
  const query = {
    keywords: inputText(args.query, 500), sources: listFilter(args.sourceIds), mailboxes: listFilter(args.mailboxes),
    from: inputText(args.from, 320), dateFrom: inputText(args.since, 10), sort: 'date_desc', limit,
  };
  if (query.dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom)) throw coded('input_invalid', 'Since date must use YYYY-MM-DD.');
  let sources;
  if (!query.keywords && !query.sources && !query.mailboxes && !query.from && !query.dateFrom) {
    sources = await archiveSources(request);
    if (!sources.length) return { ok: true, accountId: account.id, provider: 'open-archiver', page: 1, total: 0, totalPages: 0, nextCursor: null, messages: [] };
    query.sources = sources.map((source) => source.id).sort().join(',');
  }
  const scope = JSON.stringify([account.id, account.baseUrl, query]);
  let page = 1;
  if (args.cursor) {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); } catch { /* validated below */ }
    if (decoded?.v !== 1 || decoded.scope !== scope || !Number.isSafeInteger(decoded.page) || decoded.page < 1) throw coded('cursor_invalid', 'This cursor belongs to another account or search. Start from the first page.');
    page = decoded.page;
  }
  const data = await request('search', { query: { ...query, page } });
  if (!Array.isArray(data.hits) || !Number.isInteger(data.totalPages) || data.page !== page || data.limit !== limit) throw coded('archive_protocol', 'Open Archiver returned invalid search pagination.');
  return {
    ok: true, accountId: account.id, provider: 'open-archiver', page, total: data.total, totalPages: data.totalPages,
    nextCursor: page < data.totalPages ? Buffer.from(JSON.stringify({ v: 1, scope, page: page + 1 })).toString('base64url') : null,
    messages: data.hits.map((hit) => ({
      ...archiveIdentity(account.id, hit.id), sourceId: hit.ingestionSourceId, sourceName: sources?.find((source) => source.id === hit.ingestionSourceId)?.name, mailboxOwner: hit.userEmail,
      subject: hit.subject || '', from: addresses(hit.from), to: addresses(hit.to),
      date: hit.timestamp == null ? '' : new Date(hit.timestamp).toISOString(),
      messageId: hit.messageId, size: hit.sizeBytes, hasAttachments: hit.hasAttachments,
    })),
  };
}

export async function archiveMessage(account, request, args) {
  if (args.uid || args.uidValidity) throw coded('identity_invalid', 'Open Archiver uses archiveId, not IMAP UID or UIDVALIDITY.');
  const identity = archiveIdentity(account.id, args.archiveId);
  const data = await request(`archived-emails/${encodeURIComponent(identity.archiveId)}`);
  if (data.id !== identity.archiveId) throw coded('archive_protocol', 'Open Archiver returned a different message identity.');
  let raw;
  if (data.raw?.type === 'Buffer' && Array.isArray(data.raw.data)) raw = Buffer.from(data.raw.data);
  else if (typeof data.storagePath === 'string' && data.storagePath) raw = await request('storage/download', { query: { path: data.storagePath }, binary: true });
  else throw coded('archive_protocol', 'The archived message has no original EML.');
  const parsed = await parseMessage(raw);
  parsed.attachments = parsed.attachments.map((part) => ({ ...part, attachmentId: `eml:${part.partId}` }));
  for (const part of data.attachments || []) {
    if (typeof part.id !== 'string' || typeof part.storagePath !== 'string') throw coded('archive_protocol', 'Open Archiver returned an invalid stored attachment.');
    parsed.attachments.push({ attachmentId: `stored:${part.id}`, filename: part.filename, mimeType: part.mimeType, size: part.sizeBytes, storagePath: part.storagePath });
  }
  return { identity, parsed, sourceId: data.ingestionSourceId, mailboxOwner: data.userEmail, raw };
}

export async function archiveSources(request) {
  const result = await request('ingestion-sources');
  if (!Array.isArray(result)) throw coded('archive_protocol', 'Open Archiver returned an invalid source list.');
  return result.map(sourceMetadata);
}

export function sourceMetadata(source) {
  if (typeof source?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(source.id)) throw coded('archive_protocol', 'Open Archiver returned an invalid source ID.');
  return Object.fromEntries(['id', 'name', 'provider', 'status', 'lastSyncStartedAt', 'lastSyncFinishedAt', 'createdAt'].filter((key) => typeof source[key] === 'string' || source[key] === null).map((key) => [key, source[key]]));
}

function listFilter(value) {
  if (value == null) return '';
  if (!Array.isArray(value) || value.length > 100) throw coded('input_invalid', 'Filters must be a list of at most 100 values.');
  return value.map((item) => { const text = inputText(item, 320); if (!text || text.includes(',')) throw coded('input_invalid', 'Filter values must be nonempty and contain no commas.'); return text; }).join(',');
}
function inputText(value, max) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)) throw coded('input_invalid', 'Invalid search field.');
  return value.trim();
}
function addresses(value) {
  if (typeof value === 'string') return value;
  if (!value) return '';
  return (Array.isArray(value) ? value : [value]).map((item) => typeof item === 'string' ? item : item?.name ? `${item.name} <${item.address}>` : item?.address || '').filter(Boolean).join(', ');
}
