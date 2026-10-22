import { presetById } from './providers.mjs';
import { customFields } from './custom.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw coded('settings_invalid', 'Mail account settings are not valid JSON.');
  }
}

export function loadState(settings = {}) {
  const accounts = parseJson(typeof settings.accounts === 'string' ? settings.accounts : '', []);
  const credentials = parseJson(typeof settings.credentials === 'string' ? settings.credentials : '', {});
  if (!Array.isArray(accounts)) throw coded('settings_invalid', 'Accounts must be a JSON array.');
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw coded('settings_invalid', 'Credentials must be a JSON object.');
  return {
    watchEnabled: settings.watchEnabled === true,
    defaultAccountId: accounts.some((account) => account.id === settings.defaultAccountId) ? settings.defaultAccountId : accounts[0]?.id || '',
    accountStatus: parseJson(settings.accountStatus, {}),
    accounts: accounts.map((account) => normalizeAccount(account)),
    credentials,
  };
}

export function publicAccount(account, credentials) {
  const secret = credentials?.[account.id] ?? {};
  return {
    ...account,
    credentialStored: Boolean(secret.password || secret.accessToken || secret.refreshToken),
    hasPassword: Boolean(secret.password),
    hasAccessToken: Boolean(secret.accessToken),
    hasRefreshToken: Boolean(secret.refreshToken),
    hasClientSecret: Boolean(secret.clientSecret),
  };
}

export function normalizeAccount(input, { allowSecrets = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw coded('account_invalid', 'Account must be an object.');
  if (allowSecrets !== true) {
    for (const key of ['password', 'clientSecret', 'refreshToken', 'accessToken', 'accessTokenExpiresAt']) {
      if (input[key] != null && input[key] !== '') throw coded('credential_in_tool', 'Passwords and tokens stay in the mail panel. They are not accepted as tool arguments.');
    }
  }
  const preset = presetById(typeof input.preset === 'string' ? input.preset : 'custom');
  const account = {
    id: requiredText(input.id, 'id', 64),
    label: optionalText(input.label, 'label', 120) || requiredText(input.id, 'id', 64),
    note: optionalText(input.note, 'note', 200),
    ...customFields(input),
    user: requiredText(input.user, 'user', 320),
    from: optionalText(input.from, 'from', 320) || requiredText(input.user, 'user', 320),
    auth: input.auth === 'oauth2' || input.auth === 'password' ? input.auth : preset.auth,
    imapHost: optionalText(input.imapHost, 'imapHost', 253) || preset.imapHost || '',
    imapPort: portValue(input.imapPort ?? preset.imapPort, 'imapPort'),
    imapSecure: booleanValue(input.imapSecure, preset.imapSecure !== false),
    smtpHost: optionalText(input.smtpHost, 'smtpHost', 253) || preset.smtpHost || '',
    smtpPort: portValue(input.smtpPort ?? preset.smtpPort, 'smtpPort'),
    smtpSecure: booleanValue(input.smtpSecure, preset.smtpSecure === true),
    allowInsecureAuth: input.allowInsecureAuth === true || preset.allowInsecureAuth === true,
    watch: input.watch === true,
    imEnabled: input.imEnabled === true,
    imChannelId: optionalText(input.imChannelId, 'imChannelId', 120),
    imRouteRevision: optionalText(input.imRouteRevision, 'imRouteRevision', 64),
    imPreview: input.imPreview === true,
    oauthClientId: optionalText(input.oauthClientId, 'oauthClientId', 256),
    oauthTokenUrl: optionalText(input.oauthTokenUrl, 'oauthTokenUrl', 500) || ((input.auth || preset.auth) === 'oauth2' ? preset.oauthTokenUrl || '' : ''),
    oauthScope: optionalText(input.oauthScope, 'oauthScope', 500) || ((input.auth || preset.auth) === 'oauth2' ? preset.oauthScope || '' : ''),
    preset: preset.id,
    timeoutMs: timeoutValue(input.timeoutMs),
  };
  if (!ID_RE.test(account.id)) throw coded('account_invalid', 'Account id must start with a letter or digit and use only letters, digits, _ or -.');
  if (account.imChannelId && !/^[A-Za-z0-9_.:-]{1,120}$/.test(account.imChannelId)) throw coded('account_invalid', 'IM channel id must be a listed route id.');
  if (account.imRouteRevision && !/^[a-f0-9]{64}$/.test(account.imRouteRevision)) throw coded('account_invalid', 'IM route revision must be the 64-character value from the route list.');
  for (const host of [account.imapHost, account.smtpHost]) {
    if (!HOST_RE.test(host) && host !== '::1') throw coded('account_invalid', `Host is not a DNS name or IP address: ${host || '(empty)'}`);
  }
  if (account.allowInsecureAuth && (!LOOPBACK.has(account.imapHost) || !LOOPBACK.has(account.smtpHost))) {
    throw coded('tls_required', 'Cleartext passwords are only accepted for loopback IMAP and SMTP. Use TLS for any other host.');
  }
  if (account.oauthTokenUrl) {
    let url;
    try { url = new URL(account.oauthTokenUrl); } catch { throw coded('account_invalid', 'OAuth token URL is invalid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw coded('account_invalid', 'OAuth token URL must be http(s) without embedded credentials.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw coded('account_invalid', 'An OAuth token URL on the public internet must be https.');
  }
  return account;
}

export function mergeCredential(current, patch) {
  const next = { ...(current ?? {}) };
  for (const key of ['password', 'clientSecret', 'refreshToken', 'accessToken']) {
    if (patch?.[key] === null) delete next[key];
    else if (typeof patch?.[key] === 'string' && patch[key] !== '') next[key] = patch[key];
  }
  if (typeof patch?.accessToken === 'string' && patch.accessToken && patch.accessTokenExpiresAt === undefined) delete next.accessTokenExpiresAt;
  if (patch?.accessTokenExpiresAt === null) delete next.accessTokenExpiresAt;
  else if (Number.isFinite(patch?.accessTokenExpiresAt)) next.accessTokenExpiresAt = patch.accessTokenExpiresAt;
  return next;
}

export function isLoopbackAccount(account) {
  return LOOPBACK.has(account.imapHost) && LOOPBACK.has(account.smtpHost);
}

function requiredText(value, name, max) {
  const text = optionalText(value, name, max);
  if (!text) throw coded('account_invalid', `${name} is required.`);
  return text;
}

function optionalText(value, name, max) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw coded('account_invalid', `${name} must be a string.`);
  const text = value.trim();
  if (text.length > max || /[\r\n\0]/.test(text)) throw coded('account_invalid', `${name} is empty, too long, or contains a line break.`);
  return text;
}

function portValue(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw coded('account_invalid', `${name} must be a TCP port.`);
  return port;
}

function booleanValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw coded('account_invalid', 'Expected a boolean.');
  return value;
}

function timeoutValue(value) {
  if (value == null || value === '') return 20_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 200 || timeout > 120_000) throw coded('account_invalid', 'timeoutMs must be between 200 and 120000.');
  return timeout;
}
