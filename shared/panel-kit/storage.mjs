/**
 * Opaque ('null'-origin) sandbox-safe storage, clipboard copy, and ID helpers
 * for Kiki plugin panels running inside <iframe sandbox="allow-scripts">.
 */

export function createSafeStorage(targetWindow) {
  const mem = new Map();
  const resolveStorage = () => {
    const win = targetWindow !== undefined ? targetWindow : (typeof window !== 'undefined' ? window : null);
    if (!win) return null;
    try {
      return win.localStorage || null;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      const k = String(key);
      try {
        const s = resolveStorage();
        if (s) {
          const v = s.getItem(k);
          if (v !== null) return v;
        }
      } catch {}
      return mem.has(k) ? mem.get(k) : null;
    },
    set(key, value) {
      const k = String(key);
      const str = String(value);
      mem.set(k, str);
      try {
        const s = resolveStorage();
        if (s) s.setItem(k, str);
      } catch {}
    },
    remove(key) {
      const k = String(key);
      mem.delete(k);
      try {
        const s = resolveStorage();
        if (s) s.removeItem(k);
      } catch {}
    },
  };
}

export const safeStorage = createSafeStorage();

export async function copyTextSafe(text, options = {}) {
  const str = String(text ?? '');
  const feedbackEl = options.labelEl || options.button || null;
  const copiedLabel = typeof options.copiedLabel === 'string' ? options.copiedLabel : '';
  const resetMs = Number.isFinite(options.resetMs) ? options.resetMs : 1200;
  const markCopied = () => {
    if (!feedbackEl || !copiedLabel) return;
    const prev = feedbackEl.textContent;
    feedbackEl.textContent = copiedLabel;
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        feedbackEl.textContent = prev;
      }, resetMs);
    }
  };

  try {
    const nav = options.navigatorObj !== undefined
      ? options.navigatorObj
      : (typeof navigator !== 'undefined' ? navigator : null);
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(str);
      markCopied();
      return true;
    }
  } catch {}

  try {
    const doc = options.documentObj !== undefined
      ? options.documentObj
      : (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') {
      return false;
    }
    const ta = doc.createElement('textarea');
    ta.value = str;
    if (typeof ta.setAttribute === 'function') ta.setAttribute('readonly', '');
    if (ta.style) {
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
    }
    doc.body.append(ta);
    if (typeof ta.select === 'function') ta.select();
    let ok = false;
    try {
      ok = Boolean(doc.execCommand('copy'));
      if (ok) markCopied();
    } catch {}
    if (typeof ta.remove === 'function') ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function randomId(prefix = '') {
  const c = typeof crypto !== 'undefined' ? crypto : null;
  let core = '';
  if (c && typeof c.randomUUID === 'function') {
    core = c.randomUUID();
  } else if (c && typeof c.getRandomValues === 'function' && typeof Uint8Array === 'function') {
    const bytes = new Uint8Array(12);
    c.getRandomValues(bytes);
    core = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    core = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return prefix ? `${prefix}${core}` : core;
}
