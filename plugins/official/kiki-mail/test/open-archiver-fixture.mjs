import http from 'node:http';

export const FIXTURE_API_KEY = 'fixture-open-archiver-api-key';

export async function startOpenArchiverFixture(spec = {}) {
  const defaults = defaultData();
  const sources = spec.sources ?? defaults.sources;
  const hits = spec.hits ?? defaults.hits;
  const details = toMap(spec.details ?? defaults.details);
  const storage = toMap(spec.storage ?? defaults.storage);
  const apiKey = spec.apiKey ?? FIXTURE_API_KEY;
  const delayMs = spec.delays ?? {};
  const state = { requests: [], unexpected: [], fetchTargets: [], egressViolations: [] };

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      state.unexpected.push(`fixture handler failed: ${error?.stack || error}`);
      if (!response.headersSent) json(response, 500, { error: 'fixture handler failed' });
      else response.destroy();
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const record = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      apiKey: request.headers['x-api-key'] ?? '',
      authorization: request.headers.authorization ?? '',
      status: undefined,
    };
    state.requests.push(record);

    let route;
    if (url.pathname === '/api/v1/ingestion-sources') route = 'sources';
    else if (url.pathname === '/api/v1/search') route = 'search';
    else if (url.pathname === '/api/v1/storage/download') route = 'download';
    else if (/^\/api\/v1\/archived-emails\/([^/]+)$/.test(url.pathname)) route = 'detail';
    else {
      unexpected(state, response, record, `unexpected route ${request.method} ${url.pathname}`);
      return;
    }

    if (request.method !== 'GET') {
      unexpected(state, response, record, `unexpected method ${request.method} for ${url.pathname}`);
      return;
    }
    const allowedQueries = route === 'search'
      ? ['keywords', 'sources', 'mailboxes', 'from', 'dateFrom', 'sort', 'limit', 'page']
      : route === 'download' ? ['path'] : [];
    if (!checkQuery(url, allowedQueries, state, response, record)) return;

    if (record.apiKey !== apiKey || record.authorization !== '') {
      json(response, 401, { error: 'fixture authentication failed' }, record);
      return;
    }

    const delay = Number(delayMs[`${request.method} ${url.pathname}`] ?? delayMs[route] ?? 0);
    if (delay > 0 && !(await waitForDelay(response, delay))) return;

    if (route === 'sources') {
      json(response, 200, sources, record);
      return;
    }
    if (route === 'search') {
      const result = search(url.searchParams);
      if (result.error) {
        json(response, 400, { error: result.error }, record);
        return;
      }
      json(response, 200, result.body, record);
      return;
    }
    if (route === 'detail') {
      let id;
      try { id = decodeURIComponent(/^\/api\/v1\/archived-emails\/([^/]+)$/.exec(url.pathname)[1]); }
      catch { json(response, 400, { error: 'invalid archive id' }, record); return; }
      const detail = details.get(id);
      if (!detail) {
        json(response, 404, { error: 'archived message not found' }, record);
        return;
      }
      json(response, 200, detail, record);
      return;
    }
    const requestedPath = url.searchParams.get('path');
    if (requestedPath == null || !trustedStoragePaths(details).has(requestedPath)) {
      json(response, 404, { error: 'storage object not found' }, record);
      return;
    }
    const bytes = storage.get(requestedPath);
    if (bytes == null) {
      json(response, 404, { error: 'storage object not found' }, record);
      return;
    }
    record.status = 200;
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(bytes) });
    response.end(bytes);
  }

  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    baseUrl: origin,
    state,
    assertClean() {
      if (state.unexpected.length) throw new Error(`Unexpected Open Archiver fixture traffic:\n${state.unexpected.join('\n')}`);
      if (state.egressViolations.length) throw new Error(`Blocked non-fixture fetch target:\n${state.egressViolations.join('\n')}`);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };

  function search(query) {
    const sourceFilter = query.get('sources') ?? '';
    const mailboxFilter = query.get('mailboxes') ?? '';
    if (sourceFilter === '*' || mailboxFilter === '*@*') return { error: 'wildcard browsing is not supported' };
    if ((query.get('sort') ?? '') !== 'date_desc') return { error: 'unsupported sort order' };
    const sourceIds = splitFilter(sourceFilter);
    const mailboxes = splitFilter(mailboxFilter);
    if (sourceIds.some((id) => !sources.some((source) => source.id === id))) return { error: 'unknown source id' };
    const keywords = (query.get('keywords') ?? '').toLowerCase();
    const from = (query.get('from') ?? '').toLowerCase();
    const since = query.get('dateFrom') ?? '';
    if (!sourceIds.length && !mailboxes.length && !keywords && !from && !since) return { error: 'empty source browse requires explicit source ids' };
    const limit = Number(query.get('limit'));
    const page = Number(query.get('page'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(page) || page < 1) return { error: 'invalid pagination' };

    let matching = hits.filter((hit) => {
      if (sourceIds.length && !sourceIds.includes(hit.ingestionSourceId)) return false;
      if (mailboxes.length && !mailboxes.some((mailbox) => mailbox.toLowerCase() === String(hit.userEmail ?? '').toLowerCase())) return false;
      if (keywords && !`${hit.subject ?? ''} ${hit.from ?? ''} ${hit.to ?? ''}`.toLowerCase().includes(keywords)) return false;
      if (from && !JSON.stringify(hit.from ?? '').toLowerCase().includes(from)) return false;
      if (since && Number(hit.timestamp) < Date.parse(`${since}T00:00:00.000Z`)) return false;
      return true;
    });
    matching = [...matching].sort((left, right) => Number(right.timestamp) - Number(left.timestamp));
    const total = matching.length;
    const totalPages = Math.ceil(total / limit);
    return { body: { hits: matching.slice((page - 1) * limit, page * limit), total, page, limit, totalPages } };
  }
}

// The short alias is convenient for browser harnesses that share the repository fixtures.
export const startFixture = startOpenArchiverFixture;

export function guardedLoopbackFetch(fixture) {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    try {
      // Keep the guard before global fetch: a regression cannot reach the network.
      if (url.origin !== fixture.origin) throw new Error(`unexpected HTTP origin ${url.origin}`);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error(`non-loopback HTTP target ${url.href}`);
    } catch (error) {
      fixture.state.egressViolations.push(url.href);
      throw error;
    }
    fixture.state.fetchTargets.push(url.origin);
    return globalThis.fetch(input, init);
  };
}

function defaultData() {
  const attachmentBytes = Buffer.from('Complete MIME attachment bytes from fixture.');
  const storedBytes = Buffer.from('Complete stored attachment bytes from fixture.');
  const storedPath = 'fixture-storage/attachments/record-001';
  const originalPath = 'fixture-storage/messages/archive-002.eml';
  const longBody = `OA-LONG-BEGIN\n${'Neutral fixture body content. '.repeat(900)}\nOA-LONG-END`;
  const sources = [
    { id: 'source-alpha', name: 'Fixture archive alpha', provider: 'generic_imap', status: 'active', lastSyncStartedAt: '2026-11-08T11:59:00.000Z', lastSyncFinishedAt: '2026-11-08T12:00:00.000Z', lastSyncStatusMessage: 'fixture-poison-value', createdAt: '2026-11-01T00:00:00.000Z', credentials: { apiKey: 'fixture-poison-value', password: 'fixture-poison-value' }, syncState: { accessToken: 'fixture-poison-value', cursor: 'fixture-poison-value' } },
    { id: 'source-beta', name: 'Fixture archive beta', provider: 'eml_import', status: 'imported', lastSyncStartedAt: '2026-11-07T11:59:00.000Z', lastSyncFinishedAt: '2026-11-07T12:00:00.000Z', lastSyncStatusMessage: 'fixture-poison-value', createdAt: '2026-11-02T00:00:00.000Z', credentials: 'fixture-poison-value', syncState: 'fixture-poison-value' },
  ];
  const hits = [
    { id: 'archive-001', ingestionSourceId: 'source-alpha', userEmail: 'owner-alpha@example.test', timestamp: Date.UTC(2026, 10, 9, 12, 0, 0), subject: 'Fixture long message', from: [{ name: 'Mina Fixture', address: 'mina@example.test' }], to: 'owner-alpha@example.test', messageId: '<archive-001@example.test>', sizeBytes: 24_000, hasAttachments: true },
    { id: 'archive-002', ingestionSourceId: 'source-beta', userEmail: 'owner-beta@example.test', timestamp: Date.UTC(2026, 10, 8, 12, 0, 0), subject: 'Stored original message', from: 'noah@example.test', to: 'owner-beta@example.test', messageId: '<archive-002@example.test>', sizeBytes: 220, hasAttachments: false },
    { id: 'archive-003', ingestionSourceId: 'source-alpha', userEmail: 'owner-alpha@example.test', timestamp: Date.UTC(2026, 10, 7, 12, 0, 0), subject: 'Another fixture note', from: 'mina@example.test', to: 'owner-alpha@example.test', messageId: '<archive-003@example.test>', sizeBytes: 180, hasAttachments: false },
  ];
  const details = new Map([
    ['archive-001', {
      id: 'archive-001', ingestionSourceId: 'source-alpha', userEmail: 'owner-alpha@example.test', raw: mimeMessage({ subject: 'Fixture long message', text: longBody, attachment: { filename: 'mime-note.txt', mimeType: 'text/plain', content: attachmentBytes } }),
      attachments: [{ id: 'stored-part-001', filename: '..\\..\\outside-fixture.bin', mimeType: 'application/octet-stream', sizeBytes: storedBytes.length, storagePath: storedPath }],
    }],
    ['archive-002', {
      id: 'archive-002', ingestionSourceId: 'source-beta', userEmail: 'owner-beta@example.test', storagePath: originalPath, attachments: [],
    }],
    ['archive-003', {
      id: 'archive-003', ingestionSourceId: 'source-alpha', userEmail: 'owner-alpha@example.test', raw: mimeMessage({ subject: 'Another fixture note', text: 'Small neutral body.' }), attachments: [],
    }],
    ['mismatch-id', {
      id: 'different-archive-id', ingestionSourceId: 'source-alpha', userEmail: 'owner-alpha@example.test', raw: mimeMessage({ subject: 'Mismatched detail', text: 'Neutral fixture body.' }), attachments: [],
    }],
  ]);
  const storage = new Map([
    [storedPath, storedBytes],
    [originalPath, mimeMessage({ subject: 'Stored original message', text: 'Message fetched through the detail storagePath.' })],
  ]);
  return { sources, hits, details, storage };
}

function mimeMessage({ subject, text, attachment }) {
  const headers = [
    'From: Fixture Sender <sender@example.test>',
    'To: Fixture Recipient <recipient@example.test>',
    `Subject: ${subject}`,
    'Date: Mon, 09 Nov 2026 12:00:00 +0000',
    `Message-ID: <${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-fixture@example.test>`,
    'MIME-Version: 1.0',
  ];
  if (!attachment) return Buffer.from([...headers, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n'));
  const boundary = 'open-archiver-fixture-boundary';
  return Buffer.from([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    attachment.content.toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n'));
}

function trustedStoragePaths(details) {
  const paths = new Set();
  for (const detail of details.values()) {
    if (typeof detail?.storagePath === 'string') paths.add(detail.storagePath);
    for (const attachment of detail?.attachments ?? []) if (typeof attachment?.storagePath === 'string') paths.add(attachment.storagePath);
  }
  return paths;
}

function toMap(value) {
  if (value instanceof Map) return value;
  return new Map(Object.entries(value));
}

function splitFilter(value) {
  return value ? value.split(',') : [];
}

function checkQuery(url, allowed, state, response, record) {
  const names = [...url.searchParams.keys()];
  if (names.length !== new Set(names).size || names.some((name) => !allowed.includes(name))) {
    unexpected(state, response, record, `unexpected query on ${record.path}: ${url.search}`);
    return false;
  }
  return true;
}

function unexpected(state, response, record, message) {
  state.unexpected.push(message);
  json(response, 500, { error: 'unexpected fixture traffic' }, record);
}

function json(response, status, body, record) {
  const bytes = Buffer.from(JSON.stringify(body));
  if (record) record.status = status;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
  response.end(bytes);
}

function waitForDelay(response, delay) {
  return new Promise((resolve) => {
    const finish = (ready) => {
      clearTimeout(timer);
      response.removeListener('close', closed);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(!response.destroyed), delay);
    const closed = () => finish(false);
    response.once('close', closed);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}
