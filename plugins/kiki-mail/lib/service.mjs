import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appConfigView, coded, credentialForStorage, loadState, mailboxAuth, mergeCredential, normalizeAccount, publicAccount } from './accounts.mjs';
import { idempotencyKey, messageIdentity, normalizeId } from './identity.mjs';
import { listMailboxes, readSource, searchPage, withImap } from './imap.mjs';
import { bridgeFrom, forwardMailDigest, idleBridgeView, inspectIm, summaryText } from './im.mjs';
import { resolveAuth, oauthStatus, startLoopbackAuthorization } from './oauth.mjs';
import { connectionAccount, folderPath, mappedMailboxes } from './custom.mjs';
import { contentBytes, parseMessage } from './parse.mjs';
import { allowedAttachment, safeSegment, storageKey, writeInside } from './paths.mjs';
import { publicPresets } from './providers.mjs';
import { redactJson, redactText, secretValues } from './redact.mjs';
import { sendSmtp } from './smtp.mjs';

const PAGE_DEFAULT = 20;
// While Kiki is open, a dropped inbox watch keeps reconnecting. The delay doubles from
// one second up to one minute, and a mailbox that opens resets it. Authentication, TLS,
// and cancellation stop the loop. Closing aborts the wait immediately.
const WATCH_RETRY_BASE_MS = 1000;
const WATCH_RETRY_MAX_MS = 60_000;

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
    this.inflight = new Map();
    this.oauthFlows = new Map();
    this.authFlights = new Map();
    this.draftCredentials = new Map();
    this.settingsQueue = Promise.resolve();
  }

  async activate(context) {
    if (!context || typeof context.updateSettings !== 'function' || typeof context.dataDir !== 'string') {
      throw coded('lifecycle_required', 'Mail watch needs the Kiki App plugin lifecycle.');
    }
    await this.deactivate();
    this.context = context;
    this.closed = false;
    this.im = bridgeFrom(context);
    context.signal?.addEventListener('abort', () => { void this.deactivate(); }, { once: true });
    await this.startWatchers();
    return this.publicState(loadState(context.settings), { probe: false });
  }

  async deactivate() {
    this.closed = true;
    for (const flow of this.oauthFlows.values()) flow.cancel();
    this.oauthFlows.clear();
    this.draftCredentials.clear();
    await this.stopWatchers();
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
      const result = action === 'state' ? await this.publicState(this.stateOf(context), { list: true })
        : action === 'routes' ? await this.routeState(context)
        : action === 'presets' ? { ok: true, presets: publicPresets() }
        : ['testDraft', 'discardDraft', 'oauthStart', 'oauthStatus', 'oauthComplete', 'oauthCancel', 'default', 'appConfig'].includes(action) ? await this.managementAction(action, args ?? {}, context ?? {})
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
    try {
      const state = this.stateOf(context);
      const found = secretValues(state.credentials);
      for (const app of Object.values(state.oauthDefaults || {})) {
        if (app && typeof app.clientSecret === 'string' && app.clientSecret.length >= 4) found.push(app.clientSecret);
      }
      return found;
    } catch { return []; }
  }

  accountView(account, state) {
    const cred = state.credentials[account.id];
    const use = mailboxAuth(account, cred, state.oauthDefaults);
    let status = oauthStatus(account, cred);
    if (account.auth === 'oauth2' && !account.oauthClientId && !use.inherited) status = 'app_required';
    else if (use.blocked) status = 'reauthorize';
    return {
      ...publicAccount(account, state.credentials),
      isDefault: state.defaultAccountId === account.id,
      lastTest: state.accountStatus[account.id] || null,
      oauthStatus: status,
      oauthInherited: use.inherited,
    };
  }

  async publicState(state, options = {}) {
    const accounts = state.accounts.map((account) => this.accountView(account, state));
    const lastTest = Object.values(state.accountStatus).sort((a, b) => b.at - a.at)[0] || null;
    return {
      ok: true,
      watchEnabled: state.watchEnabled,
      defaultAccountId: state.defaultAccountId,
      summary: { accountCount: accounts.length, defaultAccountId: state.defaultAccountId, watchEnabled: state.watchEnabled, watchedCount: state.watchEnabled ? accounts.filter((account) => account.watch).length : 0, lastTest },
      imBridge: options.probe === false ? idleBridgeView(this.im) : await inspectIm(this.im ?? bridgeFrom(this.context), this.context?.signal, { list: options.list === true }),
      accounts,
      apps: appConfigView(state.oauthDefaults),
    };
  }

  async managementAction(action, args, context) {
    const state = this.stateOf(context);
    if (action === 'appConfig') return this.saveAppConfig(args, context);
    if (action === 'default') {
      const account = requireAccount(state, args.accountId);
      await this.updateSettings(context, { defaultAccountId: account.id });
      return this.publicState(this.stateOf(context));
    }
    const flowId = clean(args.flowId, 80);
    if (action === 'discardDraft') {
      this.oauthFlows.get(flowId)?.cancel();
      this.oauthFlows.delete(flowId);
      for (const id of [args.draftId, args.oauthDraftId]) this.draftCredentials.delete(id);
      return { ok: true };
    }
    if (['oauthStatus', 'oauthComplete', 'oauthCancel'].includes(action)) {
      const flow = this.oauthFlows.get(flowId);
      if (!flow) throw coded('oauth_expired', 'Authorization expired. Start again.');
      if (action === 'oauthCancel') { flow.cancel(); this.oauthFlows.delete(flowId); return { ok: true, phase: 'cancelled' }; }
      return { ok: true, ...(action === 'oauthComplete' ? await flow.complete(args) : await flow.inspect()) };
    }
    const account = normalizeAccount(args.account, { allowSecrets: true });
    const existing = state.accounts.find((item) => item.id === account.id);
    if (existing && args.editingId !== account.id) throw coded('account_exists', 'This account ID is already in use. Choose another ID.');
    let credential = mergeCredential(state.credentials[account.id], args.credential);
    const draft = this.draftCredentials.get(args.draftId);
    if (draft) {
      const original = JSON.parse(draft.account);
      if (draft.expiresAt < Date.now() || ['id', 'user', 'auth', 'oauthClientId', 'oauthTokenUrl'].some((key) => original[key] !== account[key])) throw coded('draft_expired', 'The authorization details changed or expired. Enter credentials or authorize again.');
      this.assertAppStamp(account, draft.stamp, state.oauthDefaults);
      credential = mergeCredential(credential, draft.credential);
    }
    credential = withSubmittedClient(account, credential, args.credential, state.oauthDefaults);
    const use = mailboxAuth(account, credential, state.oauthDefaults);
    if (account.auth === 'oauth2' && !account.oauthClientId && !use.inherited) throw coded('app_required', 'Set up the Gmail or Outlook project before authorizing this mailbox.');
    if (action === 'testDraft') {
      if (use.blocked) throw coded('oauth_reauthorize', 'This mailbox was authorized for a previous OAuth client. Authorize it again.');
      const result = await this.checkConnection(account, credential, context, async (patch) => {
        credential = mergeCredential(credential, { ...patch, ...(use.clientId ? { tokenClientId: use.clientId } : {}) });
      });
      const draftId = randomUUID();
      this.storeDraft(draftId, { accountId: account.id, account: JSON.stringify(account), credential: credentialForStorage(account, credential), stamp: use.stamp, tested: true, expiresAt: Date.now() + 600000 });
      this.draftCredentials.delete(args.draftId);
      this.pruneDrafts();
      return { ...result, draftId };
    }
    if (action === 'oauthStart') {
      this.oauthFlows.get(flowId)?.cancel();
      this.oauthFlows.delete(flowId);
      const draftId = randomUUID();
      const id = randomUUID();
      const stamp = use.stamp;
      const runtime = { ...use.runtime };
      if (use.blocked) {
        delete runtime.refreshToken;
        delete runtime.accessToken;
        delete runtime.accessTokenExpiresAt;
      }
      const flow = await startLoopbackAuthorization(use.account, runtime, async (patch) => {
        this.assertAppStamp(account, stamp, this.stateOf(context).oauthDefaults);
        const base = { ...(credential ?? {}) };
        if (use.blocked) {
          delete base.refreshToken;
          delete base.accessToken;
          delete base.accessTokenExpiresAt;
          delete base.tokenClientId;
        }
        const next = credentialForStorage(account, mergeCredential(base, { ...patch, tokenClientId: use.clientId }));
        this.storeDraft(draftId, { accountId: account.id, account: JSON.stringify(account), credential: next, stamp, expiresAt: Date.now() + 600000 });
        this.pruneDrafts();
      }, { signal: this.context?.signal, fetch: this.deps.oauthFetch });
      const guarded = {
        authorizationUrl: flow.authorizationUrl,
        redirectUri: flow.redirectUri,
        expiresAt: flow.expiresAt,
        cancel: () => flow.cancel(),
        inspect: () => flow.inspect(),
        complete: async (input) => {
          try { this.assertAppStamp(account, stamp, this.stateOf(context).oauthDefaults); }
          catch (error) { flow.cancel(); this.oauthFlows.delete(id); throw error; }
          return flow.complete(input);
        },
      };
      this.oauthFlows.set(id, guarded);
      return { ok: true, flowId: id, draftId, authorizationUrl: flow.authorizationUrl, redirectUri: flow.redirectUri, expiresAt: flow.expiresAt, phase: 'waiting' };
    }
    throw coded('unknown_action', 'Unknown account management action.');
  }

  assertAppStamp(account, stamp, defaults) {
    if (!stamp) return;
    const current = mailboxAuth(account, {}, defaults).stamp;
    if (!current || current.provider !== stamp.provider || current.clientId !== stamp.clientId || current.revision !== stamp.revision) {
      throw coded('app_changed', 'The Mail project changed after this authorization. Generate a new link and test the mailbox again.');
    }
  }

  async saveAppConfig(args, context) {
    const state = this.stateOf(context);
    const provider = clean(args.provider, 32);
    if (!['gmail', 'outlook'].includes(provider)) throw coded('app_invalid', 'Choose Gmail or Outlook.');
    const defaults = { ...state.oauthDefaults };
    const previous = defaults[provider] && typeof defaults[provider] === 'object' ? defaults[provider] : null;
    let clientChanged = false;
    if (args.clear === true) {
      clientChanged = Boolean(previous);
      delete defaults[provider];
    } else {
      const clientId = clean(args.clientId, 256);
      if (!clientId) throw coded('app_invalid', 'Enter the OAuth client ID from your cloud project.');
      let clientSecret = typeof previous?.clientSecret === 'string' ? previous.clientSecret : '';
      if (args.clearSecret === true) clientSecret = '';
      const typed = clean(args.clientSecret, 512);
      if (typed) clientSecret = typed;
      const same = Boolean(previous && previous.clientId === clientId && (previous.clientSecret || '') === clientSecret && typeof previous.revision === 'string' && previous.revision);
      const next = { clientId };
      if (clientSecret) next.clientSecret = clientSecret;
      next.revision = same ? previous.revision : randomUUID();
      clientChanged = !previous || previous.clientId !== clientId;
      defaults[provider] = next;
    }
    const patch = { oauthDefaults: JSON.stringify(defaults) };
    if (clientChanged) {
      const status = { ...state.accountStatus };
      for (const account of state.accounts) {
        if (account.auth === 'oauth2' && !account.oauthClientId && account.preset === provider) delete status[account.id];
      }
      patch.accountStatus = JSON.stringify(status);
    }
    await this.updateSettings(context, patch);
    return { ok: true, apps: appConfigView(this.stateOf(context).oauthDefaults) };
  }

  storeDraft(id, draft) {
    this.draftCredentials.set(id, draft);
    const timer = setTimeout(() => this.draftCredentials.delete(id), Math.max(0, draft.expiresAt - Date.now()));
    timer.unref?.();
  }

  pruneDrafts() {
    for (const [id, draft] of this.draftCredentials) if (draft.expiresAt < Date.now()) this.draftCredentials.delete(id);
    for (const [id, flow] of this.oauthFlows) if (flow.expiresAt < Date.now()) { flow.cancel(); this.oauthFlows.delete(id); }
  }

  async auth(account, credential, context, persist) {
    const state = this.stateOf(context);
    const use = mailboxAuth(account, credential, state.oauthDefaults);
    if (account.auth === 'oauth2' && !account.oauthClientId && !use.inherited) throw coded('app_required', 'Set up the Gmail or Outlook project before using this mailbox.');
    if (use.blocked) throw coded('oauth_reauthorize', 'This mailbox was authorized for a previous OAuth client. Authorize it again.');
    const key = authFlightKey(use.account, use.runtime);
    let flight = this.authFlights.get(key);
    if (!flight) {
      let patch;
      flight = { users: 0, promise: resolveAuth(use.account, use.runtime, (value) => { patch = value; }, { signal: context.signal, fetch: this.deps.oauthFetch }).then((auth) => ({ auth, patch })) };
      this.authFlights.set(key, flight);
    }
    flight.users++;
    try {
      const result = await flight.promise;
      if (result.patch) {
        const patch = { ...result.patch };
        if (use.clientId && (patch.accessToken || patch.refreshToken)) patch.tokenClientId = use.clientId;
        await (persist || ((value) => this.rememberCredential(context, account.id, value)))(patch);
      }
      return result.auth;
    } finally {
      if (--flight.users === 0 && this.authFlights.get(key) === flight) this.authFlights.delete(key);
    }
  }

  routeState() {
    return inspectIm(this.im ?? bridgeFrom(this.context), this.context?.signal, { list: true }).then((view) => ({ ok: true, ...view }));
  }

  async accountAction(args, context, allowSecrets) {
    const action = args.action;
    if (action === 'presets') return { ok: true, presets: publicPresets() };
    if (action === 'list') return this.publicState(this.stateOf(context));
    if (action === 'show') {
      const state = this.stateOf(context);
      const account = requireAccount(state, args.accountId);
      return { ok: true, account: this.accountView(account, state) };
    }
    if (action === 'save') return this.saveAccount(args, context, allowSecrets);
    if (action === 'delete') return this.deleteAccount(args, context);
    if (action === 'test') return this.testAccount(args, context);
    throw coded('unknown_action', 'Unknown account action.');
  }

  async saveAccount(args, context, allowSecrets) {
    const state = this.stateOf(context);
    const body = args.account ?? args;
    const normalized = normalizeAccount(body, { allowSecrets });
    const account = normalized;
    const accounts = state.accounts.filter((item) => item.id !== account.id);
    accounts.push(account);
    const credentials = { ...state.credentials };
    const credential = body.credential ?? args.credential;
    if (!allowSecrets && credential) throw coded('credential_in_tool', 'Passwords and tokens stay in the Mail panel.');
    const draft = allowSecrets ? this.draftCredentials.get(args.draftId) : undefined;
    if (args.draftId && (!draft || draft.account !== JSON.stringify(account) || draft.expiresAt < Date.now())) throw coded('draft_expired', 'Account details changed or the test expired. Test again before saving.');
    if (draft) {
      this.assertAppStamp(account, draft.stamp, state.oauthDefaults);
      credentials[account.id] = mergeCredential(credentials[account.id], draft.credential);
    }
    if (allowSecrets && credential) credentials[account.id] = mergeCredential(credentials[account.id], credential);
    if (credentials[account.id]) {
      credentials[account.id] = withSubmittedClient(account, credentials[account.id], credential, state.oauthDefaults);
      credentials[account.id] = credentialForStorage(account, credentials[account.id]);
    }
    const watchEnabled = typeof args.watchEnabled === 'boolean' ? args.watchEnabled : state.watchEnabled;
    await this.persist(context, accounts, credentials, watchEnabled);
    if (draft?.tested && !credential) await this.updateSettings(context, { accountStatus: JSON.stringify({ ...this.stateOf(context).accountStatus, [account.id]: { ok: true, at: Date.now(), message: 'IMAP and SMTP accepted the credentials.' } }) });
    else {
      const prior = state.accounts.find((item) => item.id === account.id);
      const connection = (item) => item && JSON.stringify(['user', 'from', 'auth', 'imapHost', 'imapPort', 'imapSecure', 'smtpHost', 'smtpPort', 'smtpSecure', 'allowInsecureAuth', 'oauthClientId', 'oauthTokenUrl', 'oauthScope', 'timeoutMs', 'imapId'].map((key) => item[key]));
      if (credential || draft || connection(prior) !== connection(account)) await this.invalidateTest(context, account.id);
    }
    if (args.draftId) this.draftCredentials.delete(args.draftId);
    await this.reconcileWatchers();
    return { ok: true, account: this.accountView(account, this.stateOf(context)) };
  }

  async deleteAccount(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    const accounts = state.accounts.filter((item) => item.id !== account.id);
    const credentials = { ...state.credentials };
    delete credentials[account.id];
    await this.persist(context, accounts, credentials, state.watchEnabled);
    await this.reconcileWatchers();
    return { ok: true, deleted: account.id };
  }

  async invalidateTest(context, accountId) {
    const status = { ...this.stateOf(context).accountStatus };
    delete status[accountId];
    await this.updateSettings(context, { accountStatus: JSON.stringify(status) });
  }

  async testAccount(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    try {
      const result = await this.checkConnection(account, state.credentials[account.id], context);
      await this.updateSettings(context, { accountStatus: JSON.stringify({ ...this.stateOf(context).accountStatus, [account.id]: { ok: true, at: Date.now(), message: result.message } }) });
      return result;
    } catch (error) {
      const message = redactText(error.message, this.secrets(context));
      await this.updateSettings(context, { accountStatus: JSON.stringify({ ...this.stateOf(context).accountStatus, [account.id]: { ok: false, at: Date.now(), code: error.code, message } }) });
      throw error;
    }
  }

  async checkConnection(account, credential, context, persist) {
    const auth = await this.auth(account, credential, context, persist);
    const mailboxes = await withImap(account, auth, { signal: context.signal }, (client) => listMailboxes(client));
    await verifySmtp(connectionAccount(account), auth, context.signal);
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
    const auth = await this.auth(account, state.credentials[account.id], context);
    if (args.action === 'folders') {
      const mailboxes = await withImap(account, auth, { signal: context.signal }, (client) => listMailboxes(client));
      return { ok: true, accountId: account.id, mailboxes: mappedMailboxes(account, mailboxes) };
    }
    if (args.action === 'search') {
      const page = await withImap(account, auth, { signal: context.signal }, (client) => searchPage(client, folderPath(account, args.mailbox || 'INBOX'), {
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
    if (!parsed.textComplete && directory) textPath = await writeInside(directory, ['bodies', account.id, storageKey(identity.mailbox, 'box'), identity.uidValidity, identity.uid, 'body.txt'], Buffer.from(parsed.text));
    if (!parsed.htmlComplete && parsed.html && directory) htmlPath = await writeInside(directory, ['bodies', account.id, storageKey(identity.mailbox, 'box'), identity.uidValidity, identity.uid, 'body.html'], Buffer.from(parsed.html));
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
    const saved = await writeInside(directory, ['attachments', account.id, storageKey(identity.mailbox, 'box'), identity.uidValidity, identity.uid, part.partId, storageKey(part.filename, 'file')], contentBytes(part.content));
    return { ok: true, identity, partId: part.partId, filename: part.filename, mimeType: part.mimeType, size: part.size, sha256: part.sha256, path: saved };
  }

  async sendAction(args, context) {
    const state = this.stateOf(context);
    const account = requireAccount(state, args.accountId);
    const requestId = clean(args.requestId, 80) || randomUUID();
    const flightKey = `${account.id}\0${requestId}`;
    const current = this.inflight.get(flightKey);
    if (current) {
      const draft = args.action === 'reply' ? await this.replyDraft(account, state, args, context) : await this.composeDraft(account, args, context);
      const fingerprint = payloadFingerprint(draft);
      if (current.fingerprint && current.fingerprint !== fingerprint) return payloadConflict(account.id, requestId);
      const winner = await current.promise;
      if (winner.fingerprint !== fingerprint) return payloadConflict(account.id, requestId);
      if (winner.error) throw winner.error;
      return winner.result;
    }
    let resolveFlight;
    const promise = new Promise((resolve) => { resolveFlight = resolve; });
    const flight = { promise, fingerprint: undefined };
    this.inflight.set(flightKey, flight);
    try {
      const result = await this.performSend(state, account, args, context, requestId, (fingerprint) => { flight.fingerprint = fingerprint; });
      resolveFlight({ fingerprint: flight.fingerprint, result });
      return result;
    } catch (error) {
      resolveFlight({ fingerprint: flight.fingerprint, error });
      throw error;
    } finally {
      if (this.inflight.get(flightKey) === flight) this.inflight.delete(flightKey);
    }
  }

  async performSend(state, account, args, context, requestId, onFingerprint) {
    const draft = args.action === 'reply' ? await this.replyDraft(account, state, args, context) : await this.composeDraft(account, args, context);
    const fingerprint = payloadFingerprint(draft);
    onFingerprint(fingerprint);
    const loaded = await this.readSend(account.id, requestId, context);
    if (loaded.source === 'unreadable') {
      const error = coded('receipt_unreadable', 'The stored send receipt is unreadable. The message was not sent again.');
      error.outcome = 'unknown';
      throw error;
    }
    const blocked = resendBlock(loaded.record, fingerprint);
    if (blocked) return { ...blocked, requestId, accountId: account.id };
    const intent = { phase: 'sending', outcome: 'sending', requestId, accountId: account.id, fingerprint, at: Date.now() };
    await this.writeSend(account.id, requestId, intent, context);
    try {
      const auth = await this.auth(account, state.credentials[account.id], context);
      const sent = await sendSmtp(account, auth, draft, { signal: context.signal, createTransport: this.deps.createTransport });
      const record = { phase: 'done', outcome: 'accepted', requestId, accountId: account.id, fingerprint, messageId: sent.messageId, at: Date.now() };
      this.memorySends.set(sendKey(account.id, requestId), record);
      sent.hookWarnings = [];
      for (const hook of account.hooks || []) {
        if (hook.event !== 'afterSend') continue;
        try { await this.recordEvent(account.id, { kind: 'afterSend', label: hook.value, requestId, outcome: 'accepted', at: Date.now() }); }
        catch { sent.hookWarnings.push('The message was accepted, but its afterSend event could not be saved. Do not resend.'); }
      }
      try {
        await this.writeSend(account.id, requestId, record, context);
      } catch (error) {
        if (error.code !== 'send_store_failed') throw error;
        return {
          ok: true,
          requestId,
          accountId: account.id,
          receiptStored: false,
          resent: false,
          automaticRetry: false,
          ...sent,
          note: 'SMTP accepted the message. The local receipt could not be saved, so it was not marked failed and will not be sent again.',
        };
      }
      return { ok: true, requestId, accountId: account.id, receiptStored: true, automaticRetry: false, ...sent, note: 'The SMTP server accepted the message for the listed recipients. That is not a final delivery receipt.' };
    } catch (error) {
      const outcome = error.outcome || 'failed';
      const record = { phase: 'done', outcome, requestId, accountId: account.id, fingerprint, code: error.code, at: Date.now() };
      this.memorySends.set(sendKey(account.id, requestId), record);
      try {
        await this.writeSend(account.id, requestId, record, context);
      } catch (writeError) {
        if (outcome !== 'uncertain' && outcome !== 'accepted') throw writeError;
        error.receiptStored = false;
      }
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
      headers: account.headers,
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
    const auth = await this.auth(account, state.credentials[account.id], context);
    const { raw } = await withImap(account, auth, { signal: context.signal }, (client) => readSource(client, identity.mailbox, identity));
    const parsed = await parseMessage(raw);
    const subject = /^re:/i.test(parsed.subject) ? parsed.subject : `Re: ${parsed.subject}`;
    const references = [parsed.references, parsed.messageId].filter(Boolean).join(' ').trim();
    const to = addressList(args.to).length ? addressList(args.to) : addressList(parsed.replyTo || parsed.from);
    if (!to.length) throw coded('send_invalid', 'The message has nobody to reply to.');
    return {
      from: account.from,
      headers: account.headers,
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
    const state = this.stateOf(context);
    const defaultAccountId = accounts.some((account) => account.id === state.defaultAccountId) ? state.defaultAccountId : accounts[0]?.id || '';
    const accountStatus = Object.fromEntries(Object.entries(state.accountStatus).filter(([id]) => accounts.some((account) => account.id === id)));
    await this.updateSettings(context, { accounts: JSON.stringify(accounts), credentials: JSON.stringify(credentials), watchEnabled, defaultAccountId, accountStatus: JSON.stringify(accountStatus) });
  }

  async updateSettings(context, patch) {
    const update = this.context?.updateSettings;
    if (typeof update !== 'function') throw coded('lifecycle_required', 'Saving mail settings needs the Kiki App plugin lifecycle.');
    const operation = this.settingsQueue.then(async () => {
      const values = typeof patch === 'function' ? patch(this.stateOf(this.context || context)) : patch;
      await update(values);
      if (context.settings) Object.assign(context.settings, values);
      if (this.context?.settings) Object.assign(this.context.settings, values);
    });
    this.settingsQueue = operation.catch(() => {});
    return operation;
  }

  async rememberCredential(context, accountId, patch) {
    await this.updateSettings(context, (state) => {
      if (!state.accounts.some((account) => account.id === accountId)) throw coded('not_found', 'The account was removed during authorization.');
      return { credentials: JSON.stringify({ ...state.credentials, [accountId]: mergeCredential(state.credentials[accountId], patch) }) };
    });
  }

  directory(context) {
    if (typeof context?.dataDir === 'string') return context.dataDir;
    if (typeof this.context?.dataDir === 'string') return this.context.dataDir;
    if (typeof context?.kikiHome === 'string') return path.join(context.kikiHome, 'plugins', 'data', 'kiki-mail');
    return undefined;
  }

  async readSend(accountId, requestId, context) {
    const directory = this.directory(context);
    if (!directory) throw coded('send_store_failed', 'Reading a send receipt needs the plugin data directory.');
    const exact = exactSendPaths(directory, accountId, requestId);
    let sawExact = false;
    for (const file of exact) {
      const hit = await readReceiptBytes(file);
      if (hit.status === 'absent') continue;
      sawExact = true;
      if (hit.status === 'error') throw coded('send_store_failed', 'The send receipt could not be read.');
      const kind = receiptKind(hit.record, accountId, requestId);
      if (kind === 'usable') {
        this.memorySends.set(sendKey(accountId, requestId), hit.record);
        return { source: 'disk', record: hit.record };
      }
    }
    if (sawExact) return { source: 'unreadable', record: null };
    for (const file of legacySendPaths(directory, accountId, requestId)) {
      const hit = await readReceiptBytes(file);
      if (hit.status === 'absent') continue;
      if (hit.status === 'error') throw coded('send_store_failed', 'The send receipt could not be read.');
      const kind = receiptKind(hit.record, accountId, requestId);
      if (kind === 'foreign') continue;
      if (kind !== 'usable') return { source: 'unreadable', record: null };
      this.memorySends.set(sendKey(accountId, requestId), hit.record);
      return { source: 'disk', record: hit.record };
    }
    const memory = this.memorySends.get(sendKey(accountId, requestId));
    return memory ? { source: 'memory', record: memory } : { source: 'missing', record: null };
  }

  async writeSend(accountId, requestId, record, context) {
    if (this.deps.failPersist?.(record)) throw coded('send_store_failed', 'The send receipt could not be written.');
    const directory = this.directory(context);
    if (!directory) throw coded('send_store_failed', 'Saving a send receipt needs the plugin data directory.');
    const file = exactSendPaths(directory, accountId, requestId)[0];
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record));
      await this.installReceipt(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error?.code === 'send_store_failed') throw error;
      const wrapped = coded('send_store_failed', 'The send receipt could not be written.');
      wrapped.causeCode = error?.code;
      throw wrapped;
    }
    this.memorySends.set(sendKey(accountId, requestId), record);
  }

  async installReceipt(temporary, file) {
    const backup = `${file}.bak`;
    const moved = await this.moveReceiptAside(file, backup);
    if (moved && this.deps.failReceiptInstall) {
      const failed = coded('send_store_failed', 'The send receipt could not be replaced.');
      failed.causeCode = 'EPERM';
      throw failed;
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      const failed = coded('send_store_failed', 'The send receipt could not be replaced.');
      failed.causeCode = error?.code;
      throw failed;
    }
    if (moved) await rm(backup, { force: true }).catch(() => {});
  }

  async moveReceiptAside(file, backup) {
    try {
      await rename(file, backup);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    await rm(backup, { force: true });
    try {
      await rename(file, backup);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
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
      resent: ['uncertain_not_resent', 'already_accepted', 'payload_conflict', 'receipt_unreadable', 'send_store_failed'].includes(error.code) ? false : undefined,
    };
  }

  async stopWatchers() {
    const jobs = this.watchers.splice(0);
    for (const watcher of jobs) watcher.controller.abort();
    await Promise.all(jobs.map((watcher) => watcher.job.catch(() => {})));
  }

  async reconcileWatchers() {
    await this.stopWatchers();
    if (this.closed || !this.context) return;
    await this.startWatchers();
  }

  async startWatchers() {
    const state = loadState(this.context.settings);
    if (!state.watchEnabled) return;
    for (const account of state.accounts) {
      if (!account.watch) continue;
      const controller = new AbortController();
      const job = this.watchAccount(account, controller.signal);
      this.watchers.push({ controller, job, accountId: account.id });
    }
  }

  async watchAccount(account, signal) {
    const pace = { delay: WATCH_RETRY_BASE_MS };
    let attempt = 0;
    while (!signal.aborted && !this.closed) {
      try {
        await this.watchOnce(account, signal, pace);
        return;
      } catch (error) {
        if (signal.aborted || this.closed) return;
        attempt += 1;
        await this.recordEvent(account.id, { kind: 'watch-error', code: error.code || 'disconnected', message: error.message, attempt });
        if (['auth_failed', 'tls_required', 'cancelled', 'auth_missing', 'oauth_prerequisite', 'oauth_reauthorize', 'oauth_client_invalid', 'oauth_rejected', 'app_required', 'app_changed'].includes(error.code)) {
          await this.recordEvent(account.id, { kind: 'watch-stopped', code: error.code, attempt });
          return;
        }
        const wait = pace.delay;
        pace.delay = Math.min(pace.delay * 2, WATCH_RETRY_MAX_MS);
        if (await this.wait(signal, wait) || this.closed) return;
      }
    }
  }

  async wait(signal, ms) {
    if (typeof this.deps.wait === 'function') return (await this.deps.wait(ms, signal)) === true;
    return pause(signal, ms);
  }

  async watchOnce(account, signal, pace) {
    const state = loadState(this.context.settings);
    const auth = await this.auth(account, state.credentials[account.id], { ...this.context, signal });
    await withImap(account, auth, { signal }, async (client) => {
      const opened = await client.mailboxOpen('INBOX');
      if (pace) pace.delay = WATCH_RETRY_BASE_MS;
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
          last = await this.consumeNew(client, account, uidValidity, last, signal);
          if (signal.aborted || this.closed) break;
          await client.idle();
        }
      } finally {
        client.off('exists', poke);
      }
    });
  }

  async consumeNew(client, account, uidValidity, last, signal) {
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
      event.im = await forwardMailDigest(this.im ?? bridgeFrom(this.context), {
        enabled: account.imEnabled === true,
        channelId: account.imChannelId,
        routeRevision: account.imRouteRevision,
        accountRef: account.id,
        idempotencyKey: idempotencyKey(identity),
        text: summaryText({ label: account.label, accountId: account.id, mailbox: 'INBOX', from, subject, preview, identity }),
      }, signal);
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

// A refresh or access token typed in this request belongs to the client resolved now.
// Tokens already in storage keep their tokenClientId, including a missing one.
function explicitToken(patch) {
  return Boolean(patch && ['refreshToken', 'accessToken'].some((key) => typeof patch[key] === 'string' && patch[key] !== ''));
}

function withSubmittedClient(account, credential, submitted, defaults) {
  if (!explicitToken(submitted)) return credential;
  const clientId = mailboxAuth(account, {}, defaults).clientId;
  if (!clientId) return credential;
  return { ...(credential ?? {}), tokenClientId: clientId };
}

function authFlightKey(account, runtime) {
  const hash = createHash('sha256')
    .update(String(runtime?.password || ''))
    .update('\0')
    .update(String(runtime?.refreshToken || ''))
    .update('\0')
    .update(String(runtime?.accessToken || ''))
    .update('\0')
    .update(String(runtime?.clientSecret || ''))
    .digest('hex');
  return [account.id, account.user, account.oauthClientId, account.oauthTokenUrl, hash].join('\0');
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

function sendKey(accountId, requestId) {
  return `${accountId}\0${requestId}`;
}

function exactSendPaths(directory, accountId, requestId) {
  const file = path.join(directory, 'sends', accountId, `${storageKey(requestId, 'send')}.json`);
  return [file, `${file}.bak`];
}

function legacySendPaths(directory, accountId, requestId) {
  const slug = safeSegment(requestId, 'send');
  return [
    path.join(directory, 'sends', safeSegment(accountId, 'account'), `${slug}.json`),
    path.join(directory, 'sends', `${slug}.json`),
  ];
}

function payloadConflict(accountId, requestId) {
  return {
    ok: false,
    code: 'payload_conflict',
    outcome: 'uncertain',
    requestId,
    accountId,
    resent: false,
    automaticRetry: false,
    finalDelivery: false,
    message: 'Another send with this request id is already in progress for a different message. This one was not sent.',
  };
}

function payloadFingerprint(draft) {
  const body = JSON.stringify({
    from: draft.from ?? '',
    ...(Object.keys(draft.headers || {}).length ? { headers: draft.headers } : {}),
    to: draft.to ?? [],
    cc: draft.cc ?? [],
    bcc: draft.bcc ?? [],
    subject: draft.subject ?? '',
    text: draft.text ?? '',
    html: draft.html ?? '',
    inReplyTo: draft.inReplyTo ?? '',
    references: draft.references ?? '',
    attachments: (draft.attachments ?? []).map((item) => ({
      filename: item.filename ?? '',
      sha256: createHash('sha256').update(item.content ?? Buffer.alloc(0)).digest('hex'),
    })),
  });
  return createHash('sha256').update(body).digest('hex');
}

function resendBlock(prior, fingerprint) {
  if (!prior) return null;
  const outcome = prior.outcome;
  const submitted = prior.phase === 'sending' || outcome === 'sending' || outcome === 'accepted' || outcome === 'uncertain';
  if (!submitted) return null;
  const accepted = outcome === 'accepted';
  const conflict = accepted && Boolean(prior.fingerprint) && prior.fingerprint !== fingerprint;
  return {
    ok: false,
    code: conflict ? 'payload_conflict' : accepted ? 'already_accepted' : 'uncertain_not_resent',
    outcome: accepted ? 'accepted' : 'uncertain',
    accountId: prior.accountId,
    resent: false,
    automaticRetry: false,
    finalDelivery: false,
    message: accepted
      ? 'This send was already accepted by SMTP. It was not sent again.'
      : 'The earlier send has no proof it was not submitted. It was not sent again.',
  };
}

const RETRYABLE_OUTCOMES = new Set(['failed', 'auth_failed', 'rejected', 'cancelled']);
const BLOCKING_OUTCOMES = new Set(['accepted', 'uncertain', 'sending']);

function receiptKind(record, accountId, requestId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'unreadable';
  if (record.accountId !== accountId || record.requestId !== requestId) return 'foreign';
  if (record.phase === 'sending') return 'usable';
  if (record.phase === 'done' && (BLOCKING_OUTCOMES.has(record.outcome) || RETRYABLE_OUTCOMES.has(record.outcome))) return 'usable';
  return 'unreadable';
}

async function readReceiptBytes(file) {
  try {
    const text = await readFile(file, 'utf8');
    try {
      return { status: 'json', record: JSON.parse(text) };
    } catch {
      return { status: 'json', record: null };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent' };
    return { status: 'error', code: error?.code };
  }
}

function pause(signal, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

export async function readEvents(directory, accountId) {
  try {
    const text = await readFile(path.join(directory, 'events', `${safeSegment(accountId)}.jsonl`), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
