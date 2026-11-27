/**
 * Standardized kiki.panel.v1 postMessage RPC client and MessageChannel stream helper.
 * Enforces default request timeout protection so pending requests never leak or wedge UI state.
 */

import { applyPresentation } from './theme.mjs';

export const PANEL_CHANNEL = 'kiki.panel.v1';
export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export function createPanelClient(options = {}) {
  const channel = options.channel || PANEL_CHANNEL;
  const defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs)
    ? options.defaultTimeoutMs
    : DEFAULT_RPC_TIMEOUT_MS;
  const defaultTimeoutMessage = options.timeoutMessage || 'Request timed out';
  const defaultErrorMessage = options.errorMessage || 'Bridge error';
  const autoApplyPresentation = options.autoApplyPresentation !== false;

  const win = options.windowObj !== undefined
    ? options.windowObj
    : (typeof window !== 'undefined' ? window : null);
  const par = options.parentObj !== undefined
    ? options.parentObj
    : ((win && win.parent) || (typeof parent !== 'undefined' ? parent : null));

  let seq = 0;
  let parentOrigin = '';
  let ready = false;
  let visible = true;
  let disposed = false;
  const pending = new Map();

  const resolveTestBridge = () => {
    if (typeof options.testBridge === 'function') return options.testBridge;
    if (typeof options.testBridge === 'string' && win && typeof win[options.testBridge] === 'function') {
      return win[options.testBridge];
    }
    return null;
  };

  const isStandalone = () => {
    if (ready) return false;
    if (resolveTestBridge()) return false;
    if (!par || typeof par.postMessage !== 'function') return true;
    if (win && par === win && options.allowSelfParent !== true) return true;
    return false;
  };

  const handlePresentation = (data, event) => {
    const pres = data && typeof data.presentation === 'object' && data.presentation
      ? data.presentation
      : data;
    if (autoApplyPresentation && pres) {
      applyPresentation(pres, {
        fallbackTheme: data && data.theme,
        root: options.root,
        onLocale: options.onLocale,
      });
    }
    if (typeof options.onPresentation === 'function') {
      options.onPresentation(pres, data, event);
    }
  };

  const onMessage = (event) => {
    if (disposed || !event) return;
    if (par && event.source && event.source !== par) return;
    const data = event.data;
    if (!data || data.channel !== channel) return;
    if (parentOrigin && typeof event.origin === 'string' && event.origin && event.origin !== parentOrigin) return;
    if (typeof event.origin === 'string' && event.origin && event.origin !== 'null') {
      parentOrigin = event.origin;
    }

    if (data.kind === 'presentation' || data.kind === 'theme') {
      handlePresentation(data, event);
      return;
    }

    if (data.kind === 'visibility') {
      visible = data.visible !== false;
      if (typeof options.onVisibility === 'function') {
        options.onVisibility(visible, data, event);
      }
      return;
    }

    if (data.kind === 'init') {
      ready = true;
      visible = data.visible !== false;
      if (data.presentation || data.theme || data.colorScheme || data.tokens || data.locale) {
        handlePresentation(data, event);
      }
      if (typeof options.onInit === 'function') {
        options.onInit(data, event);
      }
      return;
    }

    if (data.kind === 'response') {
      const entry = pending.get(data.id);
      if (!entry) {
        if (event.ports && event.ports[0]) {
          try {
            event.ports[0].postMessage({ __kikiStreamControl: 'close' });
            event.ports[0].close();
          } catch {}
        }
        return;
      }
      pending.delete(data.id);
      if (entry.timer !== null && typeof clearTimeout === 'function') {
        clearTimeout(entry.timer);
      }
      if (data.ok === true) {
        if (entry.withPort) {
          entry.resolve({ result: data.result, port: (event.ports && event.ports[0]) || null });
        } else {
          entry.resolve(data.result);
        }
      } else {
        const msg = (typeof data.error === 'string' && data.error)
          || (data.error && typeof data.error.message === 'string' && data.error.message)
          || defaultErrorMessage;
        entry.reject(new Error(msg));
      }
      return;
    }

    if (typeof options.onEvent === 'function') {
      options.onEvent(data, event);
    }
  };

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('message', onMessage);
  }

  function request(method, payload = {}, opts = {}) {
    const withPort = Boolean(opts.withPort);
    const bridge = resolveTestBridge();
    if (bridge) {
      return Promise.resolve(bridge(method, payload, withPort));
    }
    if (disposed) {
      return Promise.reject(new Error('Panel bridge disposed'));
    }
    if (isStandalone()) {
      return Promise.reject(new Error(options.standaloneErrorMessage || 'Standalone preview mode'));
    }

    const id = ++seq;
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : defaultTimeoutMs;
    const targetOrigin = !parentOrigin || parentOrigin === 'null' ? '*' : parentOrigin;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (typeof setTimeout === 'function' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          const err = new Error(opts.timeoutMessage || defaultTimeoutMessage);
          err.code = 'timeout';
          reject(err);
        }, timeoutMs);
      }
      pending.set(id, { resolve, reject, timer, withPort });
      try {
        par.postMessage({ channel, kind: 'request', id, method, ...payload }, targetOrigin);
      } catch (err) {
        pending.delete(id);
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
        reject(err);
      }
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('message', onMessage);
    }
    for (const [id, entry] of pending) {
      pending.delete(id);
      if (entry.timer !== null && typeof clearTimeout === 'function') {
        clearTimeout(entry.timer);
      }
      entry.reject(new Error('Panel bridge disposed'));
    }
  }

  return {
    channel,
    request,
    call: (action, args = {}, opts = {}) => request('plugin.call', { action, args }, opts),
    getSettings: (opts = {}) => request('plugin.settings.get', {}, opts),
    patchSettings: (values, opts = {}) => request('plugin.settings.patch', { values }, opts),
    setDirty: (dirty, opts = {}) => request('plugin.dirty', { dirty: Boolean(dirty) }, opts),
    installPrerequisite: (prerequisiteId, consent = true, opts = {}) =>
      request('plugin.installPrerequisite', { prerequisiteId, consent }, opts),
    sendSessionMessage: (text, sessionId, opts = {}) =>
      request('session.sendMessage', { ...(sessionId ? { sessionId } : {}), text }, opts),
    openStream: (stream, args = {}, opts = {}) =>
      request('plugin.openStream', { stream, args }, { timeoutMs: 4000, ...opts, withPort: true }),
    isReady: () => ready,
    isVisible: () => visible,
    isStandalone,
    getOrigin: () => parentOrigin,
    pendingCount: () => pending.size,
    dispose,
  };
}

export async function openManagedStream(client, stream, args = {}, handlers = {}) {
  const { result, port } = await client.openStream(stream, args, handlers.openOpts || {});
  if (!port) {
    throw new Error('Host did not transfer a stream port');
  }

  let closed = false;
  const close = (notifyHost = true) => {
    if (closed) return;
    closed = true;
    try {
      if (notifyHost && typeof port.postMessage === 'function') {
        port.postMessage({ __kikiStreamControl: 'close' });
      }
    } catch {}
    try {
      port.onmessage = null;
      port.onmessageerror = null;
      if (typeof port.close === 'function') port.close();
    } catch {}
  };

  port.onmessage = (event) => {
    const data = event ? event.data : undefined;
    if (data && typeof data === 'object' && data.__kikiStreamEvent === 'close') {
      close(false);
      if (typeof handlers.onClose === 'function') {
        handlers.onClose(data.reason || 'closed');
      }
      return;
    }
    if (typeof handlers.onMessage === 'function') {
      handlers.onMessage(data, event);
    }
  };

  port.onmessageerror = (event) => {
    if (typeof handlers.onError === 'function') {
      handlers.onError(event);
    }
  };

  return { port, result, close };
}
