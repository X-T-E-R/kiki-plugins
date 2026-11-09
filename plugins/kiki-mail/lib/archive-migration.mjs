import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { archiveBaseUrl, coded, isArchive } from './accounts.mjs';
import { archiveClient, archiveMessage, archiveSources, sourceMetadata } from './open-archiver.mjs';
import { listMailboxes, withImap } from './imap.mjs';
import { parseMessage } from './parse.mjs';
import { storageKey } from './paths.mjs';

// Only an operator holding a locally provisioned permit can transfer a password.
// The panel bridge receives a permit ID, never a credential file path or destination URL.
export async function migrateArchiveSource(state, directory, args, options) {
  const plan = await loadPermit(directory, args.planId);
  const target = state.accounts.find((account) => account.id === plan.archiveAccountId && isArchive(account));
  const direct = state.accounts.find((account) => account.id === args.accountId && !isArchive(account));
  const binding = plan.accounts.find((account) => account.id === args.accountId);
  if (!target || !direct || !binding || target.baseUrl !== plan.baseUrl || direct.user !== binding.user || direct.imapHost !== binding.host || direct.imapPort !== binding.port) {
    throw coded('migration_mismatch', 'The saved accounts no longer match the local migration permit.');
  }
  if (direct.auth === 'oauth2') throw coded('migration_reauthorize', 'Authorize this mailbox in Open Archiver. Its OAuth client needs its own consent; Mail does not transfer tokens.');
  if (!direct.imapSecure || direct.allowInsecureAuth) throw coded('migration_tls_required', 'Password migration requires verified implicit IMAP TLS.');
  const password = state.credentials[direct.id]?.password;
  if (!password) throw coded('auth_missing', 'This account has no saved IMAP password.');
  if (typeof args.adminApiKey !== 'string' || !args.adminApiKey) throw coded('auth_missing', 'The migration operator must supply an Open Archiver management key.');
  if (args.adminApiKey === state.credentials[target.id]?.apiKey) throw coded('migration_key_scope', 'Use a separate management key for source creation.');

  const request = archiveClient({ ...target, timeoutMs: 90_000 }, { apiKey: args.adminApiKey }, options);
  const name = `Kiki Mail: ${direct.user}`;
  const identity = direct.user.toLowerCase();
  const mappedId = plan.sources?.[direct.id]?.sourceId;
  const existing = await findMigrationSource(request, name, identity, mappedId);
  if (existing) {
    if (args.sync === true) {
      await request(`ingestion-sources/${encodeURIComponent(existing.id)}/sync`, { body: {} });
      return { ok: true, outcome: 'sync_requested', source: existing };
    }
    return { ok: true, outcome: 'existing', source: existing };
  }
  if (args.sync === true) throw coded('migration_mismatch', 'Create or reconcile this source before requesting a reconnect.');

  const attempts = path.join(directory, 'archive-migration', 'attempts');
  await mkdir(attempts, { recursive: true });
  const record = path.join(attempts, `${storageKey(`${target.baseUrl}\n${direct.imapHost}:${direct.imapPort}\n${identity}`, 'source')}.json`);
  try {
    await writeFile(record, JSON.stringify({ startedAt: new Date().toISOString(), accountId: direct.id }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw coded('migration_reconcile', 'A previous create attempt has no matching source yet. Check Open Archiver before retrying.');
    throw coded('migration_permit', 'Could not record the migration attempt locally.');
  }
  let created;
  try {
    created = await request('ingestion-sources', { body: {
      name, provider: 'generic_imap', preserveOriginalFile: true,
      providerConfig: { type: 'generic_imap', host: direct.imapHost, port: direct.imapPort, secure: true, allowInsecureCert: false, username: direct.user, password },
    } });
  } catch (error) {
    if (error.code !== 'archive_create_rolled_back') throw error;
    try {
      const reconciled = await findMigrationSource(request, name, identity, mappedId);
      if (reconciled) return { ok: true, outcome: 'existing', source: reconciled };
      await rm(record);
    } catch {
      throw coded('migration_reconcile', 'Could not reconcile the failed create. Check the source in Open Archiver before retrying.');
    }
    throw coded('migration_source_rejected', 'Open Archiver rejected the IMAP connection and no source was created. Check the mailbox authorization or server connection, then rerun migrate.');
  }
  const source = sourceMetadata(created);
  await writeFile(record, JSON.stringify({ accountId: direct.id, sourceId: source.id, recordedAt: new Date().toISOString() }), { mode: 0o600 });
  return { ok: true, outcome: 'created', source };
}

async function findMigrationSource(request, name, identity, mappedId) {
  const matches = [];
  for (const source of await archiveSources(request)) {
    if (!['generic_imap', 'oauth_mailbox'].includes(source.provider)) {
      if (source.name === name) throw coded('migration_conflict', 'An Open Archiver source already uses this name with a different provider.');
      continue;
    }
    const stats = await request(`ingestion-sources/${encodeURIComponent(source.id)}/stats`);
    const owners = (stats.mailboxes || []).map((mailbox) => mailbox.userEmail?.toLowerCase()).filter(Boolean);
    const sameMailbox = owners.includes(identity);
    const mapped = mappedId === source.id;
    if ((source.name === name || mapped) && !sameMailbox && (owners.length || !mapped)) {
      throw coded('migration_reconcile', 'The Open Archiver source name or previous mapping does not yet match this mailbox. Check the source before continuing.');
    }
    if (sameMailbox || mapped) matches.push(source);
  }
  if (matches.length > 1) throw coded('migration_conflict', 'More than one Open Archiver source matches this mailbox. Resolve the overlap before migration.');
  return matches[0];
}

export async function verifyArchiveSample(state, directory, args, options, authorize) {
  const plan = await loadPermit(directory, args.planId);
  const target = state.accounts.find((account) => account.id === plan.archiveAccountId && isArchive(account) && account.baseUrl === plan.baseUrl);
  const direct = state.accounts.find((account) => account.id === args.accountId && !isArchive(account));
  const binding = plan.accounts.find((account) => account.id === args.accountId);
  if (!target || !direct || !binding || direct.user !== binding.user || direct.imapHost !== binding.host || direct.imapPort !== binding.port || direct.sendOnly) throw coded('migration_mismatch', 'The sample requires the original direct reader and approved archive.');
  const request = archiveClient(target, state.credentials[target.id], options);
  const { parsed, sourceId, mailboxOwner } = await archiveMessage(target, request, { archiveId: args.archiveId });
  if (sourceId !== plan.sources?.[direct.id]?.sourceId || mailboxOwner?.toLowerCase() !== direct.user.toLowerCase() || !parsed.messageId) {
    throw coded('migration_mismatch', 'The sample does not match the mapped source, mailbox owner and Message-ID requirements.');
  }
  for (const part of parsed.attachments) if (part.storagePath) part.content = await request('storage/download', { query: { path: part.storagePath }, binary: true });
  const auth = await authorize(direct);
  let found = false;
  const attachmentCount = await withImap(direct, auth, options, async (client) => {
    for (const folder of await listMailboxes(client)) {
      await client.mailboxOpen(folder.path, { readOnly: true });
      const uids = await client.search({ header: { 'Message-ID': parsed.messageId } }, { uid: true });
      if (!Array.isArray(uids) || !uids.length) continue;
      for await (const item of client.fetch(uids.join(','), { source: true }, { uid: true })) {
        const original = await parseMessage(item.source);
        if (original.messageId !== parsed.messageId) continue;
        found = true;
        const bodyMatches = original.text === parsed.text && original.html === parsed.html && original.date === parsed.date;
        if (bodyMatches && attachmentsMatch(original.attachments, parsed.attachments)) return original.attachments.length;
      }
    }
  });
  if (attachmentCount === undefined) throw coded('migration_mismatch', found ? 'The archived sample differs in date, body, HTML or attachments (names, types, counts or bytes).' : 'The archived sample Message-ID was not found in the direct mailbox.');
  return { ok: true, verified: true, accountId: direct.id, sourceId, attachmentCount };
}

function attachmentsMatch(original, archived) {
  const stored = archived.filter((part) => part.storagePath);
  const mime = archived.filter((part) => !part.storagePath);
  // Default OA mode stores every attachment, retaining inline MIME copies too.
  return stored.length ? sameParts(original, stored) && sameParts(original, mime, false) : sameParts(original, mime);
}

function sameParts(original, archived, complete = true) {
  if (complete && original.length !== archived.length) return false;
  const remaining = [...original];
  for (const part of archived) {
    const index = remaining.findIndex((other) => part.filename === other.filename && part.mimeType === other.mimeType && part.content.equals(other.content));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export function migrationStatus(account, mapped, stats) {
  const started = Date.parse(stats.lastSyncStartedAt);
  const reconnected = Boolean(mapped.reconnectRequestedAt && started >= Date.parse(mapped.reconnectRequestedAt) && Date.parse(stats.lastSyncFinishedAt) >= started && stats.status === 'active');
  const verified = Boolean(mapped.verifiedAt && mapped.verifiedSamples > 0);
  const ownerMatches = stats.mailboxes?.some((mailbox) => mailbox.userEmail?.toLowerCase() === account.user.toLowerCase());
  const ready = reconnected && verified && ownerMatches === true && stats.totalEmails > 0 && stats.indexedCount >= stats.totalEmails;
  return { accountId: account.id, sourceId: mapped.sourceId, state: stats.status, archived: stats.totalEmails, indexed: stats.indexedCount,
    reconnected, verifiedSamples: mapped.verifiedSamples || 0, verifiedAttachments: mapped.verifiedAttachments || 0, ready };
}

async function loadPermit(directory, id) {
  if (!directory || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw coded('migration_permit', 'A local Mail migration permit is required.');
  let plan;
  try { plan = JSON.parse(await readFile(path.join(directory, 'archive-migration', `${id}.json`), 'utf8')); }
  catch { throw coded('migration_permit', 'The local Mail migration permit is missing or unreadable.'); }
  if (plan.version !== 1 || !Array.isArray(plan.accounts) || Date.parse(plan.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(plan.expiresAt))) {
    throw coded('migration_permit', 'The local Mail migration permit is invalid or expired.');
  }
  if (archiveBaseUrl(plan.baseUrl) !== plan.baseUrl || !plan.baseUrl.startsWith('https://')) throw coded('migration_tls_required', 'The migration destination must be the approved HTTPS service.');
  return plan;
}
