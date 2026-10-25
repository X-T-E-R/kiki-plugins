import { register as registerQQ } from '../entry.mjs';
import { createOfficialAdapter, createOneBotAdapter } from '../lib/adapters.mjs';

async function fetchImpl(input, init = {}) {
  const url = new URL(input);
  const allowed = url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !url.search
    && ((init.method === 'GET' && /^\/(?:gateway|media\/(?:official|onebot)\/(?:first|second)\.png)$/u.test(url.pathname))
      || (init.method === 'POST' && ['/app/getAppAccessToken', '/v2/groups/g1/messages'].includes(url.pathname)));
  if (!allowed) throw new Error(`Unexpected contract fixture HTTP request: ${init.method} ${input}`);
  return fetch(url, init);
}
export function register(api) {
  registerQQ({ registerTool: api.registerTool.bind(api), registerImAdapter(definition) {
    const factory = definition.id === 'qq-official' ? createOfficialAdapter : definition.id === 'qq-onebot' ? createOneBotAdapter : undefined;
    if (!factory) throw new Error(`Unexpected QQ fixture adapter: ${definition.id}`);
    api.registerImAdapter(definition, factory({ fetchImpl, onError(error) { console.error('QQ fixture inbound failed:', error); } }));
  } });
}
