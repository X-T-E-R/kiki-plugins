import { coded } from './accounts.mjs';
import { normalizeId } from './identity.mjs';
import { ImapFlow } from './runtime.mjs';
import { connectionAccount } from './custom.mjs';

export async function withImap(account, auth, options, fn) {
  account = connectionAccount(account);
  const client = (options.createClient ?? defaultClient)(account, auth);
  let settled = false;
  const fail = () => {
    if (!settled) void client.close();
  };
  options.signal?.addEventListener('abort', fail, { once: true });
  try {
    if (options.signal?.aborted) throw coded('cancelled', 'The mail connection was cancelled.');
    await client.connect();
    if (!account.allowInsecureAuth && client.secureConnection !== true) {
      throw coded('tls_required', 'The IMAP server did not negotiate TLS. The password was not left on a clear connection.');
    }
    return await fn(client);
  } catch (error) {
    if (options.signal?.aborted) throw coded('cancelled', 'The mail connection was cancelled.');
    if (error?.code === 'tls_required' || error?.code === 'cancelled') throw error;
    if (error?.tlsFailed) throw coded('tls_required', 'The IMAP server did not offer STARTTLS. Login was not attempted.');
    if (error?.authenticationFailed) throw coded('auth_failed', 'IMAP authentication failed.');
    const closed = /closed|socket|ECONN|timeout|ETIMEOUT|NoConnection/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
    if (closed) throw coded('disconnected', 'The IMAP server closed the connection.');
    throw error;
  } finally {
    settled = true;
    options.signal?.removeEventListener('abort', fail);
    await client.logout().catch(() => client.close());
  }
}

function defaultClient(account, auth) {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    doSTARTTLS: account.imapSecure || account.allowInsecureAuth ? false : true,
    auth: auth.accessToken ? { user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: account.timeoutMs,
    greetingTimeout: account.timeoutMs,
    socketTimeout: Math.max(account.timeoutMs, 30_000),
    tls: account.imapSecure ? { servername: account.imapHost } : undefined,
    clientInfo: { name: 'kiki-mail', version: '0.2.0', vendor: 'Kiki', ...account.imapId },
  });
}

export async function listMailboxes(client) {
  const boxes = await client.list();
  return boxes
    .filter((box) => !box.flags?.has?.('\\Noselect'))
    .map((box) => ({
      path: box.path,
      name: box.name || box.path,
      delimiter: box.delimiter || '/',
      specialUse: box.specialUse || undefined,
    }));
}

export async function searchPage(client, mailbox, query, page) {
  const box = await client.mailboxOpen(mailbox);
  const uidValidity = normalizeId(box.uidValidity);
  const criteria = compileCriteria(query);
  const found = await client.search(criteria, { uid: true });
  const uids = (Array.isArray(found) ? found : []).map((uid) => normalizeId(uid));
  uids.sort((left, right) => compareUid(right, left));
  const cursor = page.cursor ? normalizeId(page.cursor) : '';
  const filtered = cursor ? uids.filter((uid) => compareUid(uid, cursor) < 0) : uids;
  const limit = page.limit;
  const slice = filtered.slice(0, limit);
  const messages = [];
  if (slice.length) {
    const range = slice.slice().sort((left, right) => compareUid(left, right)).join(',');
    for await (const item of client.fetch(range, { uid: true, flags: true, envelope: true, size: true, internalDate: true }, { uid: true })) {
      messages.push(summarize(mailbox, uidValidity, item));
    }
    const order = new Map(slice.map((uid, index) => [uid, index]));
    messages.sort((left, right) => order.get(left.uid) - order.get(right.uid));
  }
  return {
    mailbox,
    uidValidity,
    messages,
    nextCursor: filtered.length > limit ? slice.at(-1) : null,
  };
}

export async function readSource(client, mailbox, identity) {
  const box = await client.mailboxOpen(mailbox);
  const uidValidity = normalizeId(box.uidValidity);
  if (identity.uidValidity !== uidValidity) {
    throw coded('uidvalidity_mismatch', 'This folder\'s UIDVALIDITY changed. The old message id no longer refers to the same message.');
  }
  let raw;
  for await (const item of client.fetch(identity.uid, { uid: true, source: true, flags: true }, { uid: true })) {
    if (normalizeId(item.uid) === identity.uid) raw = Buffer.from(item.source);
  }
  if (!raw) throw coded('not_found', 'That message is not in this account and folder.');
  return { uidValidity, raw };
}

export function compileCriteria(query = {}) {
  const criteria = {};
  if (query.unseen === true) criteria.seen = false;
  if (query.from) criteria.from = query.from;
  if (query.since) criteria.since = query.since instanceof Date ? query.since : new Date(`${query.since}T00:00:00Z`);
  if (query.text) criteria.body = query.text;
  return criteria;
}

function summarize(mailbox, uidValidity, item) {
  const envelope = item.envelope ?? {};
  return {
    mailbox,
    uidValidity,
    uid: normalizeId(item.uid),
    subject: envelope.subject || '',
    from: joinAddresses(envelope.from),
    to: joinAddresses(envelope.to),
    date: envelope.date ? new Date(envelope.date).toISOString() : undefined,
    messageId: envelope.messageId || undefined,
    flags: [...(item.flags ?? [])],
    size: item.size,
  };
}

function joinAddresses(value) {
  if (!Array.isArray(value)) return '';
  return value.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).filter(Boolean).join(', ');
}

function compareUid(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
