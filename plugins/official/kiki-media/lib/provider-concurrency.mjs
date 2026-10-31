export function createProviderLimiter() {
  const providers = new Map();
  function drain(key, state) {
    while (state.active < state.limit && state.queue.length > 0) {
      const next = state.queue.shift();
      next.signal?.removeEventListener('abort', next.abort);
      state.active++;
      next.resolve(() => {
        state.active--;
        drain(key, state);
      });
    }
    if (state.active === 0 && state.queue.length === 0) providers.delete(key);
  }
  async function run(key, value, signal, execute) {
    const limit = value ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Maximum concurrent provider requests must be a positive integer.');
    signal?.throwIfAborted();
    const state = providers.get(key) ?? { active: 0, limit, queue: [] };
    state.limit = limit;
    providers.set(key, state);
    const release = await new Promise((resolve, reject) => {
      const waiting = { signal, resolve, abort: () => {
        const index = state.queue.indexOf(waiting);
        if (index < 0) return;
        state.queue.splice(index, 1);
        signal.removeEventListener('abort', waiting.abort);
        reject(signal.reason);
        drain(key, state);
      } };
      state.queue.push(waiting);
      signal?.addEventListener('abort', waiting.abort, { once: true });
      drain(key, state);
    });
    try {
      signal?.throwIfAborted();
      return await execute();
    } finally { release(); }
  }
  return function wrap(adapter, providerId) {
    return Object.fromEntries(Object.entries(adapter).map(([action, execute]) => [action, (input, context) => {
      if (!['submit', 'poll'].includes(action)) return execute(input, context);
      const script = context.settings.scriptSource;
      const environment = script && context.settings.environment ? JSON.parse(context.settings.environment) : {};
      const configured = context.settings.maxConcurrentRequests ?? (environment.KIKI_MEDIA_MAX_CONCURRENT_REQUESTS === undefined ? undefined : Number(environment.KIKI_MEDIA_MAX_CONCURRENT_REQUESTS));
      return run(script ? `script-${script.id}` : providerId, configured, context.signal, () => execute(input, context));
    }]));
  };
}
