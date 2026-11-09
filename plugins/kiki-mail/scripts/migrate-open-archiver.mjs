import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { archiveBaseUrl, coded, isArchive } from '../lib/accounts.mjs';
import { archiveClient } from '../lib/open-archiver.mjs';
import { migrationStatus } from '../lib/archive-migration.mjs';

const [command, ...flags] = process.argv.slice(2);
const args = {};
for (let i = 0; i < flags.length; i += 2) {
  if (!/^--[a-z-]+$/.test(flags[i]) || !flags[i + 1]) throw new Error('Use --option value pairs.');
  args[flags[i].slice(2)] = flags[i + 1];
}
const home = path.resolve(required('home'));
const session = required('session');
const connection = JSON.parse(execFileSync(required('kiki'), ['serve', '--home', home, '--query', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
if (!connection.running || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.url).hostname)) throw new Error('A running local Kiki owner connection is required.');
const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
const directory = path.join(home, 'plugins', 'data', 'kiki-mail', 'archive-migration');

try {
  const state = await panel('state', {});
  if (command === 'inventory') {
    print({ accounts: state.accounts.map((account) => ({ id: account.id, preset: account.preset, address: mask(account.user), auth: account.auth, passwordStored: account.hasPassword,
      tokenStored: Boolean(account.hasAccessToken || account.hasRefreshToken), smtp: Boolean(account.smtpHost), watch: account.watch, sendOnly: account.sendOnly === true })), defaultSender: state.defaultAccountId, defaultReader: state.defaultReadAccountId });
  } else if (command === 'connect') {
    const account = { id: args['archive-account'] || 'open-archiver', label: 'Open Archiver', preset: 'open-archiver', baseUrl: archiveBaseUrl(required('url')), timeoutMs: 60_000 };
    const credential = { apiKey: await key('read') };
    const existing = state.accounts.find((item) => item.id === account.id);
    const tested = await panel('testDraft', { account, credential, editingId: existing?.id });
    await panel('save', { account, draftId: tested.draftId });
    print({ accountId: account.id, connected: true });
  } else if (command === 'prepare') {
    const archive = state.accounts.find((account) => account.id === required('archive-account') && isArchive(account));
    if (!archive) throw coded('migration_mismatch', 'Connect the archive account first.');
    if (!archive.baseUrl.startsWith('https://')) throw coded('migration_tls_required', 'Use the approved HTTPS service.');
    const ids = required('accounts').split(',');
    const accounts = ids.map((id) => {
      const account = state.accounts.find((item) => item.id === id && !isArchive(item));
      if (!account) throw coded('migration_mismatch', 'A selected direct account is missing.');
      return { id, user: account.user, host: account.imapHost, port: account.imapPort, sendOnly: account.sendOnly === true };
    });
    await privateDirectory(directory);
    const id = randomBytes(16).toString('hex');
    await savePlan(id, { version: 1, archiveAccountId: archive.id, baseUrl: archive.baseUrl, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      originalDefaultReadAccountId: state.defaultReadAccountId || state.defaultAccountId, accounts, sources: {} });
    print({ planId: id, accountCount: accounts.length, recovery: path.join(directory, `${id}.json`) });
  } else {
    const id = required('plan');
    if (!/^[a-f0-9]{32}$/.test(id)) throw coded('migration_permit', 'Invalid plan ID.');
    const plan = JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8'));
    const archive = state.accounts.find((account) => account.id === plan.archiveAccountId && account.baseUrl === plan.baseUrl && isArchive(account));
    if (!archive) throw coded('migration_mismatch', 'The archive account no longer matches the plan.');
    if (command === 'migrate' || command === 'reconnect') {
      const accountId = required('account');
      const before = new Date().toISOString();
      const result = await panel('archiveMigrate', { planId: id, accountId, adminApiKey: await key('admin'), sync: command === 'reconnect' });
      plan.sources[accountId] = { ...plan.sources[accountId], sourceId: result.source.id, outcome: result.outcome,
        ...(command === 'reconnect' ? { reconnectRequestedAt: before } : {}) };
      await savePlan(id, plan);
      print({ accountId, outcome: result.outcome, sourceId: result.source.id });
    } else if (command === 'status' || command === 'cutover') {
      const request = archiveClient(archive, { apiKey: await key('read') });
      const summaries = [];
      for (const account of plan.accounts) {
        const mapped = plan.sources[account.id];
        if (!mapped?.sourceId) { summaries.push({ accountId: account.id, state: 'not_migrated' }); continue; }
        const stats = await request(`ingestion-sources/${encodeURIComponent(mapped.sourceId)}/stats`);
        summaries.push(migrationStatus(account, mapped, stats));
      }
      if (command === 'status') print({ sources: summaries });
      else {
        if (summaries.some((source) => !source.ready)) throw coded('migration_incomplete', 'Every selected source needs archived/indexed mail, verified samples and a completed reconnect before cutover.');
        const current = await panel('state', {});
        assertCurrentAccounts(current, plan);
        const ids = new Set(plan.accounts.map((account) => account.id));
        const accounts = current.accounts.map((account) => storedAccount(ids.has(account.id) ? { ...account, sendOnly: true } : account));
        await api('/api/plugins/kiki-mail/settings', { values: { accounts: JSON.stringify(accounts), defaultReadAccountId: archive.id } });
        const applied = await panel('state', {});
        if (applied.defaultReadAccountId !== archive.id || applied.defaultAccountId !== current.defaultAccountId || applied.accounts.filter((account) => ids.has(account.id) && account.sendOnly).length !== ids.size) {
          throw coded('migration_reconcile', 'The settings save did not produce the expected read and SMTP roles. Inspect Mail before continuing.');
        }
        plan.cutoverAt = new Date().toISOString();
        await savePlan(id, plan);
        print({ defaultReader: applied.defaultReadAccountId, defaultSender: applied.defaultAccountId, sendOnlyCount: ids.size });
      }
    } else if (command === 'verify') {
      const accountId = required('account');
      const mapped = plan.sources[accountId];
      if (!mapped?.sourceId) throw coded('migration_incomplete', 'Migrate or reconcile this source first.');
      const samples = args['archive-id'] ? [{ archiveId: args['archive-id'] }]
        : (await panel('search', { accountId: archive.id, sourceIds: [mapped.sourceId], limit: 10 })).messages.slice(0, 2);
      if (!samples.length) throw coded('migration_incomplete', 'No archived sample is available yet.');
      let attachmentCount = 0;
      for (const sample of samples) attachmentCount += (await panel('archiveVerify', { planId: id, accountId, archiveId: sample.archiveId })).attachmentCount;
      Object.assign(mapped, { verifiedAt: new Date().toISOString(), verifiedSamples: samples.length, verifiedAttachments: attachmentCount });
      await savePlan(id, plan);
      print({ accountId, verifiedSamples: samples.length, verifiedAttachments: attachmentCount });
    } else if (command === 'restore') {
      assertCurrentAccounts(state, plan);
      const accounts = state.accounts.map((account) => {
        const original = plan.accounts.find((item) => item.id === account.id);
        return storedAccount(original ? { ...account, sendOnly: original.sendOnly } : account);
      });
      await api('/api/plugins/kiki-mail/settings', { values: { accounts: JSON.stringify(accounts), defaultReadAccountId: plan.originalDefaultReadAccountId } });
      await panel('state', {});
      print({ restoredDirectReaders: plan.accounts.length, defaultReader: plan.originalDefaultReadAccountId });
    } else throw coded('input_invalid', 'Use inventory, connect, prepare, migrate, status, verify, reconnect, cutover or restore.');
  }
} catch (error) {
  print({ ok: false, code: error.code || 'operation_failed', message: error.code ? error.message : 'The operation failed. Saved credentials and source data were not printed.' });
  process.exitCode = 1;
}

function storedAccount(account) {
  const { capabilities, credentialStored, hasPassword, hasAccessToken, hasRefreshToken, hasClientSecret, hasApiKey, isDefault, isDefaultRead, lastTest, oauthStatus, oauthInherited, ...stored } = account;
  return stored;
}
function assertCurrentAccounts(state, plan) {
  for (const original of plan.accounts) {
    const account = state.accounts.find((item) => item.id === original.id);
    if (!account || account.user !== original.user || account.imapHost !== original.host || account.imapPort !== original.port) throw coded('migration_mismatch', 'A direct account changed since this plan was prepared.');
  }
}
async function panel(action, values) {
  const data = await api('/api/plugins/kiki-mail/panels/mail/bridge', { method: 'plugin.call', session_id: session, action, args: values });
  const result = data.result;
  if (result?.ok !== true) throw coded(result?.code || 'panel_failed', result?.message || 'Mail panel action failed.');
  return result;
}
async function api(route, body) {
  const response = await fetch(`${connection.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(180000) });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw coded('host_failed', 'The trusted Kiki operation failed.');
  return envelope.data;
}
async function key(kind) {
  const file = required(`${kind}-key-file`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const value = stored[kind === 'read' ? 'readonly_user' : 'admin_user']?.api_key;
  if (typeof value !== 'string' || !value) throw coded('auth_missing', 'The approved Open Archiver key file has no requested API key.');
  return value;
}
async function privateDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = /S-1-[0-9-]+/.exec(execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }))?.[0];
    if (!sid) throw coded('private_store_failed', 'Could not identify the current Windows user for the recovery ACL.');
    execFileSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else await chmod(target, 0o700);
}
async function savePlan(id, plan) { await writeFile(path.join(directory, `${id}.json`), JSON.stringify(plan, null, 2), { mode: 0o600 }); }
function required(name) { if (!args[name]) throw coded('input_invalid', `Missing --${name}.`); return args[name]; }
function mask(value = '') { const [local, domain] = value.split('@'); return domain ? `${local[0]}***@${domain}` : ''; }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
