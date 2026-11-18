import { createOfficialAdapter, createOneBotAdapter } from './lib/adapters.mjs';
import { OfficialBinding } from './lib/official-binding.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition, toolDefinitions } from './lib/definitions.mjs';

const binding = new OfficialBinding();
export function activate(context) { binding.activate(context); }
export function deactivate() { binding.deactivate(); }

async function probeQqChannel(args = {}, context = {}) {
  const settings = context?.settings ?? binding.settings ?? {};
  const fetchFn = typeof context?.fetchImpl === 'function' ? context.fetchImpl : globalThis.fetch;
  const target = args?.target === 'onebot' ? 'onebot' : 'official';
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    if (target === 'official') {
      const appId = String(args?.appId || settings.official__appId || '').trim();
      const appSecret = String(settings.official__appSecret || '').trim();
      const tokenBase = String(args?.tokenBaseUrl || settings.official__tokenBaseUrl || 'https://bots.qq.com').trim().replace(/\/+$/, '');
      if (!appId || !appSecret) {
        return { ok: false, target: 'official', code: 'unconfigured' };
      }
      if (!/^https?:\/\//.test(tokenBase)) {
        return { ok: false, target: 'official', code: 'invalid_url' };
      }
      const res = await fetchFn(`${tokenBase}/app/getAppAccessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return {
          ok: false,
          target: 'official',
          code: res.status === 401 || res.status === 403 ? 'auth_failed' : 'http_error',
          status: res.status,
          latencyMs,
        };
      }
      const data = await res.json().catch(() => ({}));
      if (typeof data?.access_token === 'string' && data.access_token.length > 0) {
        return {
          ok: true,
          target: 'official',
          appId,
          expiresIn: Number(data.expires_in) || 0,
          latencyMs,
        };
      }
      return { ok: false, target: 'official', code: 'auth_failed', latencyMs };
    }

    const baseUrl = String(args?.baseUrl || settings.onebot__baseUrl || 'http://127.0.0.1:5700').trim().replace(/\/+$/, '');
    const expectedSelfId = String(args?.selfId ?? settings.onebot__selfId ?? '').trim();
    const accessToken = String(settings.onebot__accessToken || '').trim();
    if (!/^https?:\/\//.test(baseUrl)) {
      return { ok: false, target: 'onebot', code: 'invalid_url' };
    }
    const headers = { 'content-type': 'application/json' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const res = await fetchFn(`${baseUrl}/get_login_info`, {
      method: 'POST',
      headers,
      body: '{}',
      redirect: 'manual',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        target: 'onebot',
        code: res.status === 401 || res.status === 403 ? 'auth_failed' : 'http_error',
        status: res.status,
        latencyMs,
      };
    }
    const payload = await res.json().catch(() => ({}));
    if (payload?.status !== 'ok' || Number(payload?.retcode) !== 0 || payload?.data?.user_id === undefined) {
      return { ok: false, target: 'onebot', code: 'protocol_error', latencyMs };
    }
    const accountId = String(payload.data.user_id);
    if (expectedSelfId && expectedSelfId !== accountId) {
      return { ok: false, target: 'onebot', code: 'self_id_mismatch', accountId, latencyMs };
    }
    return {
      ok: true,
      target: 'onebot',
      accountId,
      nickname: typeof payload.data.nickname === 'string' ? payload.data.nickname : '',
      latencyMs,
    };
  } catch {
    return {
      ok: false,
      target,
      code: controller.signal.aborted ? 'timeout' : 'unreachable',
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function handlePanelRequest(action, args, context) {
  if (action === 'qq_probe') return probeQqChannel(args, context);
  return binding.panel(action, args, context);
}

export function register(api) {
  const onebot = createOneBotAdapter();
  api.registerImAdapter(officialAdapterDefinition, createOfficialAdapter());
  api.registerImAdapter(onebotAdapterDefinition, onebot);
  for (const definition of toolDefinitions) api.registerTool(definition, async (args, context) => {
    try {
      context.progress({ kind: 'status', text: 'Reading OneBot group data' });
      const result = await onebot.readGroups(definition.name === 'qq_list_groups' ? {} : { groupId: args.groupId }, context);
      return { output: JSON.stringify(result) };
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  });
}
