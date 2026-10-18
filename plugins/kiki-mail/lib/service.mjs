import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { coded, loadState, mergeCredential, normalizeAccount, publicAccount } from './accounts.mjs';
import { idempotencyKey, messageIdentity, normalizeId } from './identity.mjs';
import { listMailboxes, readSource, searchPage, withImap } from './imap.mjs';
import { notifyIm, resolveImSender, summaryText } from './im.mjs';
import { resolveAuth } from './oauth.mjs';
import { contentBytes, parseMessage } from './parse.mjs';
import { allowedAttachment, safeSegment, writeInside } from './paths.mjs';
import { publicPresets } from './providers.mjs';
import { redactJson, redactText, secretValues } from './redact.mjs';
import { sendSmtp } from './smtp.mjs';

const PAGE_DEFAULT = 20;

export function createMailService(deps = {}) {
  return new MailService(deps);
}

class MailService {
  constructor(deps) {
    this.deps = deps;
    this.context = undefined;
    this.closed = true;
    this.watchers = [];
    this.memorySends = new Map();
  }

  async activate(context) {
    if (!context || typeof context.updateSettings !== 'function' || typeof context.dataDir !== 'string') {
      throw coded('lifecycle_required', 'Mail watch needs the Kiki App plugin lifecycle.');
    }
    await this.deactivate();
    this.context = context;
    this.closed = false;
    this.imSender = resolveImSender(context, this.deps.imSend);
    context.signal?.addEventListener('abort', () => { void this.deactivate(); }, { once: true });
    await this.startWatchers();
    return this.publicState(loadState(context.settings));
  }

  async deactivate() {
    this.closed = true;
    const jobs = this.watchers.splice(0);
    for (const watcher of jobs) watcher.controller.abort();
    await Promise.all(jobs.map((watcher) => watcher.job.catch(() => {})));
  }

  async tool(name, args, context) {
    const secrets = this.secrets(context);
    try {
      const result = await this.dispatch(name, args ?? {}, context ?? {}, false);
      return { output: redactJson(result, secrets) };
    } catch (error) {
      return { output: redactJson(this.failureBody(error), secrets), isError: true };
    }
  }

  async panel(action, args, context) {
    const secrets = this.secrets(context);
    try {
      const result = action === 'state' ? this.publicState(this.stateOf(context))
        : action === 'presets' ? { ok: true, presets: publicPresets() }
        : await this.dispatch(this.panelTool(action), { ...(args ?? {}), action: this.panelAction(action) }, context ?? {}, true);
      return JSON.parse(redactJson(result, secrets));
    } catch (error) {
      return JSON.parse(redactJson(this.failureBody(error), secrets));
    }
  }

  panelTool(action) {
    if (['save', 'delete', 'test', 'presets'].includes(action)) return 'MailAccount';
    if (['folders', 'search', 'read', 'attachment'].includes(action)) return 'Mailbox';
    if (['send', 'reply'].includes(action)) return 'MailSend';
    throw coded('unknown_action', 'Unknown mail panel action.');
  }

  panelAction(action) {
    if (action === 'save') return 'save';
    if (action === 'delete') return 'delete';
    if (action === 'test') return 'test';
    return action;
  }

  async dispatch(name, args, context, allowSecrets) {
    if (name === 'MailAccount') return this.accountAction(args, context, allowSecrets);
    if (name === 'Mailbox') return this.boxAction(args, context);
    if (name === 'MailSend') return this.sendAction(args, context);
    throw coded('unknown_action', 'Unknown mail tool.');
  }

  stateOf(context) {
    return loadState(context?.settings ?? this.context?.settings ?? {});
  }

  secrets(context) {
    try { return secretValues(this.stateOf(context).credentials); } catch { return []; }
  }

  publicState(state) {
    return {
      ok: true,
      watchEnabled: state.watchEnabled,
      imBridge: this.bridgeState(),
      accounts: state.accounts.map((account) => publicAccount(account, state.credentials)),
    };
  }

  bridgeState() {
    const available = typeof (this.imSender ?? resolveImSender(this.context, this.deps.imSend)) === 'function';
    return available
      ? { available: true, consumed: false }
      : { available: false, reason: 'host-im-unavailable' };
  }

  async accountAction(args, context, allowSecrets) {
    const action = args.action;
    if (action === 'presets') return { ok: true, presets: publicPresets() };
    if (action === 'list') return this.publicState(this.stateOf(context));
    if (action === 'show') {
      const state = this.stateOf(context);
      const account = requireAccount(state, args.accountId);
      return { ok: true, account: publicAccount(account, state.credentials) };
    }
    if (action === 'save') return this.saveAccount(args, context, allowSecrets);
    if (action === 'delete') return this.deleteAccount(args, context);
    if (action === 'test') return this.testAccount(args, context);
    throw coded('unknown_action', 'Unknown account action.');
  }

  async saveAccount(args, context, allowSecrets) {
    const state = this.stateOf(context);
    const body = args.account ?? args;
    const account = normalizeAccount(body, { allowSecrets });
    const accounts = state.accounts.filter((item) => item.id !== account.id);
    accounts.push(account);
    const credentials = { ...state.credentials };
    const credential = body.credential ?? args.credential;
    if (allowSecrets && credential) credentials[account.id] = mergeCredential(credentials[account.id], credential);
    const watchEnabled = typeof args.watchEnabled === 'boolean' ? args.watchEnabled : state.watchEnabled;
    await this.persist(context, accounts, credentials, watchEnabled);
    return { ok: true, account: publicAccount(account, credentials) };
  }

  async deleteAccount(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    const accounts = state.accounts.filter((item) => item.id !== account.id);
    const credentials = { ...state.credentials };
    delete credentials[account.id];
    await this.persist(context, accounts, credentials, state.watchEnabled);
    return { ok: true, deleted: account.id };
  }

  async testAccount(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    const auth = await resolveAuth(account, state.credentials[account.id], (patch) => this.rememberCredential(context, account.id, patch));
    const mailboxes = await withImap(account, auth, { signal: context.signal }, (client) => listMailboxes(client));
    await verifySmtp(account, auth, context.signal);
    return {
      ok: true,
      accountId: account.id,
      authenticated: true,
      auth: account.auth,
      mailboxCount: mailboxes.length,
      oauthConsent: false,
      finalDelivery: false,
      message: account.auth === 'oauth2'
        ? 'IMAP and SMTP accepted the stored token. This is not a provider consent screen.'
        : 'IMAP and SMTP accepted the saved password.',
    };
  }

  async boxAction(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    const auth = await resolveAuth(account, state.credentials[account.id], (patch) => this.rememberCredential(context, account.id, patch));
    if (args.action === 'folders') {
      const mailboxes = await withImap(account, auth, { signal: context.signal }, (client) => listMailboxes(client));
      return { ok: true, accountId: account.id, mailboxes };
    }
    if (args.action === 'search') {
      const page = await withImap(account, auth, { signal: context.signal }, (client) => searchPage(client, args.mailbox || 'INBOX', {
        text: clean(args.query, 500),
        from: clean(args.from, 320),
        unseen: args.unseen === true,
        since: clean(args.since, 32),
      }, { limit: pageLimit(args.limit), cursor: clean(args.cursor, 80) }));
      return { ok: true, accountId: account.id, ...page, messages: page.messages.map((item) => ({ ...item, accountId: account.id })) };
    }
    if (args.action === 'read') return this.readMessage(account, auth, args, context);
    if (args.action === 'attachment') return this.saveAttachment(account, auth, args, context);
    throw coded('unknown_action', 'Unknown mailbox action.');
  }

  async readMessage(account, auth, args, context) {
    const identity = this.identityFrom(account.id, args);
    const { raw } = await withImap(account, auth, { signal: context.signal }, (client) => readSource(client, identity.mailbox, identity));
    const parsed = await parseMessage(raw);
    const directory = this.directory(context);
    let textPath;
    let htmlPath;
    if (!parsed.textComplete && directory) textPath = await writeInside(directory, ['bodies', account.id, identity.uidValidity, identity.uid, 'body.txt'], Buffer.from(parsed.text));
    if (!parsed.htmlComplete && parsed.html && directory) htmlPath = await writeInside(directory, ['bodies', account.id, identity.uidValidity, identity.uid, 'body.html'], Buffer.from(parsed.html));
    return {
      ok: true,
      identity,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      date: parsed.date,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      text: parsed.textInline,
      html: parsed.htmlInline,
      textComplete: parsed.textComplete,
      htmlComplete: parsed.htmlComplete,
      textPath,
      htmlPath,
      attachments: parsed.attachments.map(({ content: _content, ...item }) => item),
    };
  }

  async saveAttachment(account, auth, args, context) {
    const identity = this.identityFrom(account.id, args);
    const directory = this.directory(context);
    if (!directory) throw coded('lifecycle_required', 'Saving an attachment needs the plugin data directory.');
    const { raw } = await withImap(account, auth, { signal: context.signal }, (client) => readSource(client, identity.mailbox, identity));
    const parsed = await parseMessage(raw);
    const part = parsed.attachments.find((item) => item.partId === String(args.partId));
    if (!part) throw coded('not_found', 'That attachment is not on this message.');
    const saved = await writeInside(directory, ['attachments', account.id, identity.uidValidity, identity.uid, part.filename], contentBytes(part.content));
    return { ok: true, identity, partId: part.partId, filename: part.filename, mimeType: part.mimeType, size: part.size, sha256: part.sha256, path: saved };
  }

  async sendAction(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    const requestId = clean(args.requestId, 80) || randomUUID();
    const prior = await this.readSend(requestId, context);
    if (prior && ['uncertain', 'accepted', 'sending'].includes(prior.outcome ?? prior.phase) && args.confirmResend !== true) {
      const outcome = prior.outcome === 'accepted' || prior.phase === 'done' && prior.outcome === 'accepted' ? 'accepted' : 'uncertain';
      return {
        ok: false,
        code: outcome === 'accepted' ? 'already_accepted' : 'uncertain_not_resent',
        outcome,
        requestId,
        resent: false,
        automaticRetry: false,
        finalDelivery: false,
        message: outcome === 'accepted'
          ? 'This send was already accepted by SMTP. It was not sent again.'
          : 'The earlier send has no acceptance receipt. It was not sent again.',
      };
    }
    await this.writeSend(requestId, { phase: 'sending', requestId, accountId: account.id, at: Date.now() }, context);
    try {
      const draft = args.action === 'reply' ? await this.replyDraft(account, state, args, context) : await this.composeDraft(account, args, context);
      const auth = await resolveAuth(account, state.credentials[account.id], (patch) => this.rememberCredential(context, account.id, patch));
      const sent = await sendSmtp(account, auth, draft, { signal: context.signal, createTransport: this.deps.createTransport });
      const record = { phase: 'done', outcome: 'accepted', requestId, accountId: account.id, messageId: sent.messageId, at: Date.now() };
      await this.writeSend(requestId, record, context);
      return { ok: true, requestId, automaticRetry: false, ...sent, note: 'The SMTP server accepted the message for the listed recipients. That is not a final delivery receipt.' };
    } catch (error) {
      const outcome = error.outcome || 'failed';
      await this.writeSend(requestId, { phase: 'done', outcome, requestId, accountId: account.id, code: error.code, at: Date.now() }, context);
      error.requestId = requestId;
      throw error;
    }
  }

  async composeDraft(account, args, context) {
    const to = addressList(args.to);
    if (!to.length) throw coded('send_invalid', 'A recipient is required.');
    if (!clean(args.subject, 998) && !clean(args.text, 2_000_000) && !clean(args.html, 2_000_000)) throw coded('send_invalid', 'Write a subject or a body before sending.');
    return {
      from: account.from,
      to,
      cc: addressList(args.cc),
      bcc: addressList(args.bcc),
      subject: clean(args.subject, 998),
      text: clean(args.text, 2_000_000),
      html: clean(args.html, 2_000_000),
      attachments: await this.attachmentContents(args.attachmentPaths, context),
    };
  }

  async replyDraft(account, state, args, context) {
    const identity = this.identityFrom(account.id, args.identity ?? args);
    const auth = await resolveAuth(account, state.credentials[account.id], (patch) => this.rememberCredential(context, account.id, patch));
    const { raw } = await withImap(account, auth, { signal: context.signal }, (client) => readSource(client, identity.mailbox, identity));
    const parsed = await parseMessage(raw);
    const subject = /^re:/i.test(parsed.subject) ? parsed.subject : `Re: ${parsed.subject}`;
    const references = [parsed.references, parsed.messageId].filter(Boolean).join(' ').trim();
    const to = addressList(args.to).length ? addressList(args.to) : addressList(parsed.replyTo || parsed.from);
    if (!to.length) throw coded('send_invalid', 'The message has nobody to reply to.');
    return {
      from: account.from,
      to,
      cc: addressList(args.cc),
      bcc: addressList(args.bcc),
      subject: clean(args.subject, 998) || subject,
      text: clean(args.text, 2_000_000),
      html: clean(args.html, 2_000_000),
      inReplyTo: parsed.messageId || undefined,
      references: references || undefined,
      attachments: await this.attachmentContents(args.attachmentPaths, context),
    };
  }

  async attachmentContents(value, context) {
    const paths = Array.isArray(value) ? value : [];
    if (paths.length > 20) throw coded('send_invalid', 'Too many attachments in one send.');
    const files = [];
    for (const file of paths) {
      const target = allowedAttachment(file, { ...context, dataDir: this.directory(context) });
      files.push({ filename: path.basename(target), content: await readFile(target) });
    }
    return files;
  }

  identityFrom(accountId, args) {
    const claimed = args.identity?.accountId ?? args.accountId ?? accountId;
    if (claimed !== accountId) throw coded('account_mismatch', 'That message identity belongs to a different account.');
    const identity = messageIdentity(accountId, args.identity?.mailbox ?? args.mailbox, args.identity?.uidValidity ?? args.uidValidity, args.identity?.uid ?? args.uid);
    if (!identity.mailbox || !/^[1-9][0-9]{0,20}$/.test(identity.uidValidity) || !/^[1-9][0-9]{0,20}$/.test(identity.uid)) {
      throw coded('identity_invalid', 'A message identity needs the account, folder, UIDVALIDITY and UID.');
    }
    return identity;
  }

  async persist(context, accounts, credentials, watchEnabled) {
    const settings = {
      ...(context.settings ?? this.context?.settings ?? {}),
      accounts: JSON.stringify(accounts),
      credentials: JSON.stringify(credentials),
      watchEnabled,
    };
    const update = this.context?.updateSettings;
    if (typeof update !== 'function') throw coded('lifecycle_required', 'Saving mail settings needs the Kiki App plugin lifecycle.');
    await update({ accounts: settings.accounts, credentials: settings.credentials, watchEnabled });
    if (context.settings) Object.assign(context.settings, settings);
    if (this.context?.settings) Object.assign(this.context.settings, settings);
  }

  async rememberCredential(context, accountId, patch) {
    const state = this.stateOf(context);
    const credentials = { ...state.credentials, [accountId]: mergeCredential(state.credentials[accountId], patch) };
    await this.persist(context, state.accounts, credentials, state.watchEnabled);
  }

  directory(context) {
    if (typeof context?.dataDir === 'string') return context.dataDir;
    if (typeof this.context?.dataDir === 'string') return this.context.dataDir;
    if (typeof context?.kikiHome === 'string') return path.join(context.kikiHome, 'plugins', 'data', 'kiki-mail');
    return undefined;
  }

  async readSend(requestId, context) {
    const memory = this.memorySends.get(requestId);
    const directory = this.directory(context);
    if (!directory) return memory;
    try {
      return JSON.parse(await readFile(path.join(directory, 'sends', `${safeSegment(requestId)}.json`), 'utf8'));
    } catch {
      return memory;
    }
  }

  async writeSend(requestId, record, context) {
    this.memorySends.set(requestId, record);
    const directory = this.directory(context);
    if (!directory) return;
    const file = path.join(directory, 'sends', `${safeSegment(requestId)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record));
  }

  failureBody(error) {
    return {
      ok: false,
      code: error.code || 'mail_failed',
      outcome: error.outcome,
      requestId: error.requestId,
      message: error instanceof Error ? error.message : 'Mail request failed.',
      automaticRetry: false,
      finalDelivery: false,
      resent: error.code === 'uncertain_not_resent' || error.code === 'already_accepted' ? false : undefined,
    };
  }

  async startWatchers() {
    const state = loadState(this.context.settings);
    if (!state.watchEnabled) return;
    for (const account of state.accounts) {
      if (!account.watch) continue;
      const controller = new AbortController();
      const job = this.watchAccount(account, controller.signal);
      this.watchers.push({ controller, job });
    }
  }

  async watchAccount(account, signal) {
    try {
      const state = loadState(this.context.settings);
      const auth = await resolveAuth(account, state.credentials[account.id], (patch) => this.rememberCredential(this.context, account.id, patch));
      await withImap(account, auth, { signal }, async (client) => {
        const opened = await client.mailboxOpen('INBOX');
        const uidValidity = normalizeId(opened.uidValidity);
        let last = await this.lastSeen(account.id, uidValidity);
        if (last == null) {
          const uidNext = BigInt(normalizeId(opened.uidNext || 1));
          last = uidNext > 0n ? uidNext - 1n : 0n;
          await this.markSeen(account.id, uidValidity, last);
        }
        const poke = () => { void client.noop().catch(() => {}); };
        client.on('exists', poke);
        try {
          while (!signal.aborted && !this.closed) {
            last = await this.consumeNew(client, account, uidValidity, last);
            if (signal.aborted || this.closed) break;
            await client.idle();
          }
        } finally {
          client.off('exists', poke);
        }
      });
    } catch (error) {
      if (signal.aborted || this.closed) return;
      await this.recordEvent(account.id, { kind: 'watch-error', code: error.code || 'disconnected', message: error.message });
    }
  }

  async consumeNew(client, account, uidValidity, last) {
    const found = await client.search({ uid: `${last + 1n}:*` }, { uid: true });
    const uids = (Array.isArray(found) ? found : []).map((uid) => BigInt(normalizeId(uid))).filter((uid) => uid > last).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let cursor = last;
    for (const uid of uids) {
      cursor = uid;
      const identity = messageIdentity(account.id, 'INBOX', uidValidity, uid);
      let subject = '';
      let from = '';
      let preview = '';
      for await (const item of client.fetch(uid.toString(), { uid: true, envelope: true, source: account.imPreview === true }, { uid: true })) {
        subject = item.envelope?.subject || '';
        from = (item.envelope?.from ?? []).map((entry) => entry.address).filter(Boolean).join(', ');
        if (item.source && account.imPreview) {
          const parsed = await parseMessage(Buffer.from(item.source));
          preview = parsed.text.slice(0, 240);
        }
      }
      const event = { kind: 'arrived', identity, subject, from, at: Date.now() };
      const sender = this.imSender ?? resolveImSender(this.context, this.deps.imSend);
      if (account.imEnabled) {
        event.im = await notifyIm(sender, {
          enabled: true,
          sessionId: account.imSessionId,
          idempotencyKey: idempotencyKey(identity),
          text: summaryText({ label: account.label, accountId: account.id, mailbox: 'INBOX', from, subject, preview, identity }),
        });
      } else {
        event.im = { delivered: false, skipped: true, reason: 'disabled' };
      }
      await this.recordEvent(account.id, event);
      await this.markSeen(account.id, uidValidity, cursor);
    }
    return cursor;
  }

  async lastSeen(accountId, uidValidity) {
    const directory = this.context?.dataDir;
    if (!directory) return null;
    try {
      const stored = JSON.parse(await readFile(path.join(directory, 'watch', `${safeSegment(accountId)}.json`), 'utf8'));
      if (stored.uidValidity !== uidValidity) return null;
      return BigInt(stored.lastUid);
    } catch {
      return null;
    }
  }

  async markSeen(accountId, uidValidity, lastUid) {
    const directory = this.context?.dataDir;
    if (!directory) return;
    const file = path.join(directory, 'watch', `${safeSegment(accountId)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ uidValidity, lastUid: lastUid.toString() }));
  }

  async recordEvent(accountId, event) {
    const directory = this.context?.dataDir;
    if (!directory) return;
    const file = path.join(directory, 'events', `${safeSegment(accountId)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(event)}\n`, { flag: 'a' });
  }
}

function requireAccount(state, accountId) {
  const id = clean(accountId, 64);
  const account = state.accounts.find((item) => item.id === id);
  if (!account) throw coded('not_found', 'That mail account is not configured.');
  return account;
}

function pageLimit(value) {
  const limit = value == null ? PAGE_DEFAULT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw coded('page_invalid', 'Page size must be from 1 to 100.');
  return limit;
}

function clean(value, max) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw coded('input_invalid', 'Expected text.');
  const text = value.trim();
  if (text.length > max || /[\u0000]/.test(text)) throw coded('input_invalid', 'A field is too long.');
  return text;
}

function addressList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => addressList(item));
  return String(value ?? '').split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}

async function verifySmtp(account, auth, signal) {
  const { createTransport } = await import('./runtime.mjs');
  const transport = createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    ignoreTLS: !account.smtpSecure && account.allowInsecureAuth,
    requireTLS: !account.smtpSecure && !account.allowInsecureAuth,
    name: 'kiki-mail',
    connectionTimeout: account.timeoutMs,
    greetingTimeout: account.timeoutMs,
    socketTimeout: account.timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken, expires: auth.expires } : { user: auth.user, pass: auth.pass },
  });
  const abort = () => transport.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await transport.verify();
  } catch (error) {
    if (signal?.aborted) throw coded('cancelled', 'The SMTP check was cancelled.');
    if (error?.code === 'EAUTH') throw coded('auth_failed', 'SMTP authentication failed.');
    throw coded('disconnected', 'SMTP did not accept the connection.');
  } finally {
    signal?.removeEventListener('abort', abort);
    transport.close();
  }
}

export async function readEvents(directory, accountId) {
  try {
    const text = await readFile(path.join(directory, 'events', `${safeSegment(accountId)}.jsonl`), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
