import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { coded } from './accounts.mjs';
import { presetById } from './providers.mjs';

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') };
}

// Host-independent half. The verifier and state stay in the backend session, never in a tool result.
export function beginAuthorization(account, redirectUri) {
  const preset = presetById(account.preset);
  if (!account.oauthClientId || !preset.oauthAuthorizationUrl) throw coded('oauth_prerequisite', 'Choose Gmail or Outlook and enter your OAuth client ID.');
  let callback;
  try { callback = new URL(redirectUri); } catch { throw coded('oauth_prerequisite', 'OAuth requires a loopback callback URI.'); }
  if (callback.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(callback.hostname) || callback.username || callback.password || callback.search || callback.hash) throw coded('oauth_prerequisite', 'OAuth callback must be an http loopback URI without query or fragment.');
  const pkce = createPkce();
  const url = new URL(preset.oauthAuthorizationUrl);
  const params = { response_type: 'code', client_id: account.oauthClientId, redirect_uri: callback.href, scope: account.oauthScope || preset.oauthScope || '', state: pkce.state, code_challenge: pkce.challenge, code_challenge_method: 'S256', login_hint: account.user };
  if (account.preset === 'gmail') Object.assign(params, { access_type: 'offline', prompt: 'consent' });
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { ...pkce, accountId: account.id, redirectUri: callback.href, authorizationUrl: url.href, expiresAt: Date.now() + 600000 };
}

export async function exchangeAuthorizationCode(account, credential, session, callback, persist, options = {}) {
  if (!session || session.accountId !== account.id || session.expiresAt < Date.now() || callback.state !== session.state) throw coded('oauth_state_invalid', 'Authorization expired or its state did not match. Start authorization again.');
  if (callback.error) throw coded('oauth_denied', 'Authorization was declined. Start again when you are ready.');
  if (typeof callback.code !== 'string' || !callback.code) throw coded('oauth_code_missing', 'The callback did not contain an authorization code.');
  const result = await requestToken(account, { grant_type: 'authorization_code', code: callback.code, code_verifier: session.verifier, redirect_uri: session.redirectUri }, credential, { ...options, retry: false });
  if (options.signal?.aborted) throw coded('cancelled', 'Authorization cancelled.');
  await persist(tokenPatch(result));
  return { ok: true, accountId: account.id, authorized: true };
}

export function oauthStatus(account, stored = {}) {
  if (account.auth !== 'oauth2') return 'not_applicable';
  if (stored.refreshToken) return 'refresh_ready';
  if (stored.accessToken && (!stored.accessTokenExpiresAt || stored.accessTokenExpiresAt > Date.now())) return 'token_only';
  return stored.accessToken ? 'expired' : 'authorization_required';
}

export async function resolveAuth(account, credential, persist, options = {}) {
  const stored = credential ?? {};
  if (account.auth === 'password') {
    if (!stored.password) throw coded('auth_missing', 'Save a password or app password in the Mail panel.');
    return { user: account.user, pass: stored.password };
  }
  if (account.auth !== 'oauth2') throw coded('account_invalid', 'Auth must be password or oauth2.');
  const expiresAt = Number(stored.accessTokenExpiresAt) || 0;
  if (stored.accessToken && (!expiresAt || expiresAt > Date.now() + 60000)) return { user: account.user, accessToken: stored.accessToken, expires: expiresAt || Date.now() + 3600000 };
  if (!stored.refreshToken || !account.oauthClientId || !account.oauthTokenUrl) throw coded('oauth_prerequisite', 'Save a refresh token and OAuth client ID, or replace the expired access token in the Mail panel.');
  const result = await requestToken(account, { grant_type: 'refresh_token', refresh_token: stored.refreshToken }, stored, options);
  const patch = tokenPatch(result);
  await persist?.(patch);
  return { user: account.user, accessToken: patch.accessToken, expires: patch.accessTokenExpiresAt };
}

function tokenPatch(result) {
  if (typeof result.access_token !== 'string' || !result.access_token) throw coded('oauth_response_invalid', 'The token endpoint did not return an access token. Retry authorization.');
  if (result.token_type && String(result.token_type).toLowerCase() !== 'bearer') throw coded('oauth_response_invalid', 'The token endpoint returned an unsupported token type.');
  const seconds = Number(result.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) throw coded('oauth_response_invalid', 'The token endpoint did not return a valid token expiry.');
  const patch = { accessToken: result.access_token, accessTokenExpiresAt: Date.now() + seconds * 1000 };
  if (typeof result.refresh_token === 'string' && result.refresh_token) patch.refreshToken = result.refresh_token;
  return patch;
}
async function requestToken(account, values, credential, options) {
  const body = new URLSearchParams({ ...values, client_id: account.oauthClientId });
  if (credential?.clientSecret) body.set('client_secret', credential.clientSecret);
  if (account.oauthScope) body.set('scope', account.oauthScope);
  const fetcher = options.fetch ?? fetch;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let response;
    try {
      response = await fetcher(account.oauthTokenUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(account.timeoutMs || 20000)]) : AbortSignal.timeout(account.timeoutMs || 20000) });
    } catch {
      if (options.signal?.aborted) throw coded('cancelled', 'OAuth request cancelled.');
      if (options.retry === false || attempt >= 2) throw coded('oauth_unavailable', 'The token endpoint could not be reached. Check your connection and test again.');
    }
    if (response && response.status !== 429 && response.status < 500) {
      let result;
      try { result = await response.json(); } catch { throw coded('oauth_response_invalid', 'The token endpoint returned invalid JSON. Check the token URL.'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw coded('oauth_response_invalid', 'The token endpoint returned an invalid response. Check the token URL.');
      if (!response.ok || result.error) {
        if (result.error === 'invalid_grant') throw coded('oauth_reauthorize', 'Authorization expired or was revoked. Authorize this account again.');
        if (result.error === 'invalid_client') throw coded('oauth_client_invalid', 'The OAuth client was rejected. Check its client ID and client secret.');
        throw coded('oauth_rejected', 'The token endpoint rejected this request. Check the client registration and scopes.');
      }
      return result;
    }
    await response?.body?.cancel?.();
    if (options.retry === false || attempt >= 2) throw coded('oauth_unavailable', 'The token service is temporarily unavailable. Test again shortly.');
    await (options.delay ?? delay)(250 * 2 ** attempt, undefined, { signal: options.signal });
  }
}

export async function startLoopbackAuthorization(account, credential, persist, options = {}) {
  let session;
  let timer;
  let status = { phase: 'waiting', message: 'Waiting for authorization. Open the link in your own browser.' };
  let processing = Promise.resolve();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const close = () => { clearTimeout(timer); server.close(); server.closeIdleConnections(); };
  const cancel = () => { controller.abort(); status = { phase: 'cancelled', message: 'Authorization cancelled. Start again to retry.' }; close(); };
  const complete = async (callback) => {
    if (status.phase !== 'waiting' || session.expiresAt < Date.now()) throw coded('oauth_expired', 'Authorization expired or already used. Start again.');
    if (callback.state !== session.state) throw coded('oauth_state_invalid', 'Authorization state did not match. Copy the complete callback URL.');
    status = { phase: 'exchanging', message: 'Saving authorization…' };
    close();
    processing = exchangeAuthorizationCode(account, credential, session, callback, persist, { ...options, signal })
      .then(() => { status = { phase: 'authorized', message: 'Authorization received. Test and save the account.' }; })
      .catch((error) => { status = { phase: controller.signal.aborted ? 'cancelled' : 'failed', code: error.code || 'oauth_failed', message: error.message }; })
      .finally(() => options.signal?.removeEventListener('abort', cancel));
    await processing;
    return { ...status };
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== session.state || status.phase !== 'waiting') {
      response.writeHead(400); response.end('Invalid authorization callback.'); return;
    }
    response.end('Authorization received. Return to Kiki Mail to check the result.');
    void complete(Object.fromEntries(url.searchParams));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    session = beginAuthorization(account, `http://127.0.0.1:${server.address().port}/oauth/callback`);
    session.expiresAt = Date.now() + (options.timeoutMs ?? 120000);
  } catch (error) { close(); throw error; }
  timer = setTimeout(() => { status = { phase: 'expired', message: 'Waiting for authorization timed out. Generate a new link to retry.' }; close(); options.signal?.removeEventListener('abort', cancel); }, options.timeoutMs ?? 120000);
  timer.unref?.();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  return {
    authorizationUrl: session.authorizationUrl, redirectUri: session.redirectUri, expiresAt: session.expiresAt, cancel,
    async complete(input) {
      let callback;
      if (typeof input.callbackUrl === 'string' && input.callbackUrl.trim()) {
        let url;
        try { url = new URL(input.callbackUrl.trim()); } catch { throw coded('oauth_callback_invalid', 'Paste the complete callback URL, or a code and its state.'); }
        if (!['http:', 'https:'].includes(url.protocol) || `${url.origin}${url.pathname}` !== session.redirectUri) throw coded('oauth_callback_invalid', 'The callback URL does not match this authorization attempt.');
        callback = Object.fromEntries(url.searchParams);
      } else callback = { code: input.code, state: input.state };
      return complete(callback);
    },
    async inspect() { await processing; return { ...status }; },
  };
}
