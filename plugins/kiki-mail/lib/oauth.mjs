import { coded } from './accounts.mjs';
import { XOAuth2 } from './runtime.mjs';

export async function resolveAuth(account, credential, persist) {
  const stored = credential ?? {};
  if (account.auth === 'password') {
    if (!stored.password) throw coded('auth_missing', 'Save a password or app password in the mail panel. This plugin does not open a provider sign-in page.');
    return { user: account.user, pass: stored.password };
  }
  if (account.auth !== 'oauth2') throw coded('account_invalid', 'Auth must be password or oauth2.');
  const expiresAt = Number(stored.accessTokenExpiresAt) || 0;
  if (stored.accessToken && (!expiresAt || expiresAt > Date.now() + 60_000)) {
    return { user: account.user, accessToken: stored.accessToken, expires: expiresAt || Date.now() + 3_600_000 };
  }
  if (!stored.refreshToken || !account.oauthClientId || !stored.clientSecret || !account.oauthTokenUrl) {
    throw coded('oauth_prerequisite', 'OAuth2 needs an access token, or a refresh token with client id, client secret and token URL. This plugin does not open a consent screen.');
  }
  const oauth = new XOAuth2({
    user: account.user,
    clientId: account.oauthClientId,
    clientSecret: stored.clientSecret,
    refreshToken: stored.refreshToken,
    accessUrl: account.oauthTokenUrl,
    timeout: 3600,
  });
  const accessToken = await new Promise((resolve, reject) => {
    oauth.getToken(false, (error, token) => error ? reject(error) : resolve(token));
  }).catch(() => {
    throw coded('oauth_prerequisite', 'The token endpoint did not return an access token.');
  });
  if (typeof accessToken !== 'string' || accessToken === '') throw coded('oauth_prerequisite', 'The token endpoint did not return an access token.');
  const expires = Date.now() + 3_600_000;
  await persist?.({ accessToken, accessTokenExpiresAt: expires });
  return { user: account.user, accessToken, expires };
}
