/**
 * Sandbox-safe ('null'-origin) bidirectional clipboard & IME bridge for Kiki panels.
 * Enforces Frame Audit Blocker 1:
 * - Never relies on navigator.clipboard (dead in allow-scripts opaque-origin iframes).
 * - Host -> Remote: intercepts Ctrl+V / Cmd+V with a 60ms pasteHold window so browser
 *   fires a trusted `paste` event on the hidden input / window, plus binds a toolbar paste input.
 * - Remote -> Host: surfaces a compact `[远端剪贴板已更新 · 点击复制]` pill and writes to host
 *   clipboard inside a synchronous user-gesture `copy` / `execCommand('copy')` handler.
 */

export const PASTE_HOLD_WINDOW_MS = 60;

export function copyTextSyncGesture(text, options = {}) {
  const str = String(text ?? '');
  const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') {
    return false;
  }

  let copiedViaEvent = false;
  const onCopy = (ev) => {
    try {
      if (ev && ev.clipboardData && typeof ev.clipboardData.setData === 'function') {
        ev.clipboardData.setData('text/plain', str);
        ev.preventDefault?.();
        copiedViaEvent = true;
      }
    } catch {}
  };

  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('copy', onCopy, { once: true });
  }

  const ta = doc.createElement('textarea');
  ta.value = str;
  ta.setAttribute?.('readonly', '');
  ta.setAttribute?.('aria-hidden', 'true');
  if (ta.style) {
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
  }
  doc.body.append(ta);
  ta.focus?.({ preventScroll: true });
  ta.select?.();

  let ok = false;
  try {
    ok = Boolean(doc.execCommand('copy')) || copiedViaEvent;
  } catch {
    ok = copiedViaEvent;
  } finally {
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('copy', onCopy);
    }
    ta.remove?.();
  }
  return ok;
}

const SANDBOX_CLIPBOARD_OPTION_KEYS = new Set([
  'windowObj',
  'documentObj',
  'isZh',
  'pasteHoldMs',
  'initialMode',
  'hiddenInputEl',
  'pillEl',
  'pillLabelEl',
  'pillPreviewEl',
  'pillMountEl',
  'surfaceEl',
  'isInteractive',
  'onHostPaste',
  'onCommittedText',
  'onFallbackPasteChord',
  'onRemoteCopied',
  'onHiddenKeyDown',
  'onHiddenKeyUp',
]);

export function attachSandboxClipboard(options = {}) {
  if (options && typeof options === 'object') {
    for (const key of Object.keys(options)) {
      if (!SANDBOX_CLIPBOARD_OPTION_KEYS.has(key)) {
        throw new TypeError(`attachSandboxClipboard received unknown option "${key}"`);
      }
    }
  }
  const win = options.windowObj || (typeof window !== 'undefined' ? window : null);
  const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
  const isZh = options.isZh !== undefined
    ? Boolean(options.isZh)
    : /^zh\b/i.test(String(win?.navigator?.language || ''));
  const holdMs = Number.isFinite(options.pasteHoldMs) ? options.pasteHoldMs : PASTE_HOLD_WINDOW_MS;

  let latestRemoteText = '';
  let pasteHoldTimer = null;
  let awaitingPasteHold = false;
  let composing = false;
  let mode = options.initialMode === 'raw' ? 'raw' : 'compose';
  let disposed = false;

  // Create offscreen 1x1 textarea for Host IME composition & trusted paste capture
  let hiddenInput = options.hiddenInputEl || null;
  let createdHiddenInput = false;
  if (!hiddenInput && doc && doc.body && typeof doc.createElement === 'function') {
    hiddenInput = doc.createElement('textarea');
    hiddenInput.className = 'kiki-remote-ime-trap';
    hiddenInput.setAttribute?.('autocapitalize', 'off');
    hiddenInput.setAttribute?.('autocomplete', 'off');
    hiddenInput.setAttribute?.('autocorrect', 'off');
    hiddenInput.setAttribute?.('spellcheck', 'false');
    hiddenInput.setAttribute?.('tabindex', '-1');
    hiddenInput.setAttribute?.('aria-label', 'Remote input capture');
    doc.body.append(hiddenInput);
    createdHiddenInput = true;
  }

  // Optional remote clipboard pill UI
  let pillEl = options.pillEl || null;
  let pillLabelEl = options.pillLabelEl || null;
  let pillPreviewEl = options.pillPreviewEl || null;
  let resetPillTimer = null;

  if (!pillEl && options.pillMountEl && doc && typeof doc.createElement === 'function') {
    pillEl = doc.createElement('button');
    pillEl.type = 'button';
    pillEl.className = 'kiki-remote-clip-pill';
    pillEl.hidden = true;
    pillLabelEl = doc.createElement('span');
    pillLabelEl.className = 'kiki-remote-clip-pill-label';
    pillPreviewEl = doc.createElement('span');
    pillPreviewEl.className = 'kiki-remote-clip-pill-preview';
    pillEl.append(pillLabelEl, pillPreviewEl);
    options.pillMountEl.appendChild(pillEl);
  }

  function renderPillIdle() {
    if (!pillEl) return;
    if (!latestRemoteText) {
      pillEl.hidden = true;
      return;
    }
    pillEl.hidden = false;
    const label = isZh ? '远端剪贴板已更新 · 点击复制' : 'Remote clipboard updated · Copy';
    const compact = latestRemoteText.replace(/\s+/g, ' ').trim().slice(0, 22);
    if (pillLabelEl) {
      pillLabelEl.textContent = label;
    } else {
      pillEl.textContent = compact ? `${label} (${compact})` : label;
    }
    if (pillPreviewEl) {
      pillPreviewEl.textContent = compact ? `「${compact}${latestRemoteText.length > 22 ? '...' : ''}」` : '';
    }
  }

  const onPillClick = (ev) => {
    ev?.stopPropagation?.();
    if (!latestRemoteText) return;
    const ok = copyTextSyncGesture(latestRemoteText, { documentObj: doc });
    if (resetPillTimer) clearTimeout(resetPillTimer);
    const doneMsg = ok
      ? (isZh ? '已复制到本机剪贴板' : 'Copied to host clipboard')
      : (isZh ? '复制受限 · 请在抽屉查看' : 'Copy blocked in sandbox');
    if (pillLabelEl) pillLabelEl.textContent = doneMsg;
    else if (pillEl) pillEl.textContent = doneMsg;
    options.onRemoteCopied?.(latestRemoteText, ok);
    resetPillTimer = setTimeout(() => {
      resetPillTimer = null;
      if (ok && pillEl) {
        pillEl.hidden = true;
      } else {
        renderPillIdle();
      }
    }, 1400);
  };

  if (pillEl && typeof pillEl.addEventListener === 'function') {
    pillEl.addEventListener('click', onPillClick);
  }

  function isEditableElement(target) {
    if (!target || target === hiddenInput) return false;
    const tag = String(target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable);
  }

  function clearPasteHold() {
    if (pasteHoldTimer) {
      clearTimeout(pasteHoldTimer);
      pasteHoldTimer = null;
    }
    awaitingPasteHold = false;
  }

  /**
   * Call inside surface/hiddenInput keydown handler. Returns true when Ctrl+V / Cmd+V
   * was intercepted for the 60ms pasteHold window (caller must NOT preventDefault!).
   */
  function handleKeyDownForPasteHold(ev) {
    if (!ev || ev.altKey || ev.shiftKey) return false;
    const key = String(ev.key || '');
    if (!(ev.ctrlKey || ev.metaKey) || (key !== 'v' && key !== 'V')) return false;
    if (typeof options.isInteractive === 'function' && !options.isInteractive()) return false;

    clearPasteHold();
    awaitingPasteHold = true;
    // Focus hidden textarea right before browser dispatches native paste event so opaque
    // sandboxes reliably fire `paste` even when user focus was on a <canvas> or <div>.
    if (hiddenInput && doc?.activeElement !== hiddenInput && !isEditableElement(doc?.activeElement)) {
      try {
        hiddenInput.value = '';
        hiddenInput.focus?.({ preventScroll: true });
      } catch {}
    }
    pasteHoldTimer = setTimeout(() => {
      pasteHoldTimer = null;
      if (!awaitingPasteHold) return;
      awaitingPasteHold = false;
      restoreSurfaceFocusIfRaw();
      options.onFallbackPasteChord?.();
    }, holdMs);
    return true;
  }

  function restoreSurfaceFocusIfRaw() {
    if (mode === 'raw' && options.surfaceEl) {
      try {
        options.surfaceEl.focus?.({ preventScroll: true });
      } catch {}
    }
  }

  const onWindowPaste = (ev) => {
    if (disposed) return;
    if (typeof options.isInteractive === 'function' && !options.isInteractive()) return;
    if (isEditableElement(doc?.activeElement)) return;

    const text = ev?.clipboardData?.getData?.('text/plain') || '';
    const wasHolding = awaitingPasteHold;
    clearPasteHold();

    if (hiddenInput) hiddenInput.value = '';
    restoreSurfaceFocusIfRaw();

    if (text) {
      ev?.preventDefault?.();
      options.onHostPaste?.(text, { source: wasHolding ? 'paste_hold' : 'paste_event' });
    } else if (wasHolding) {
      options.onFallbackPasteChord?.();
    }
  };

  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = (ev) => {
    composing = false;
    const committed = String(ev?.data || hiddenInput?.value || '');
    if (hiddenInput) hiddenInput.value = '';
    if (!committed) return;
    if (typeof options.isInteractive === 'function' && !options.isInteractive()) return;
    options.onCommittedText?.(committed, { source: 'ime_composition' });
  };

  const onHiddenInput = () => {
    if (composing || awaitingPasteHold || !hiddenInput) return;
    const val = hiddenInput.value;
    if (!val) return;
    hiddenInput.value = '';
    if (typeof options.isInteractive === 'function' && !options.isInteractive()) return;
    options.onCommittedText?.(val, { source: 'input' });
  };

  if (hiddenInput && typeof hiddenInput.addEventListener === 'function') {
    hiddenInput.addEventListener('compositionstart', onCompositionStart);
    hiddenInput.addEventListener('compositionend', onCompositionEnd);
    hiddenInput.addEventListener('input', onHiddenInput);
    if (typeof options.onHiddenKeyDown === 'function') {
      hiddenInput.addEventListener('keydown', (ev) => {
        if (composing || ev.isComposing || ev.keyCode === 229) return;
        if (handleKeyDownForPasteHold(ev)) return;
        options.onHiddenKeyDown(ev);
      });
    }
    if (typeof options.onHiddenKeyUp === 'function') {
      hiddenInput.addEventListener('keyup', (ev) => {
        if (composing || ev.isComposing) return;
        options.onHiddenKeyUp(ev);
      });
    }
  }

  win?.addEventListener?.('paste', onWindowPaste);

  function focusInteractiveTarget() {
    if (mode === 'compose' && hiddenInput) {
      try {
        hiddenInput.focus?.({ preventScroll: true });
        return;
      } catch {}
    }
    try {
      options.surfaceEl?.focus?.({ preventScroll: true });
    } catch {}
  }

  function setMode(nextMode) {
    mode = nextMode === 'raw' ? 'raw' : 'compose';
    if (options.surfaceEl && typeof options.surfaceEl.setAttribute === 'function') {
      options.surfaceEl.setAttribute('inputmode', mode === 'raw' ? 'none' : 'text');
    }
    if (typeof options.isInteractive === 'function' && options.isInteractive()) {
      focusInteractiveTarget();
    }
    return mode;
  }

  function notifyRemoteClipboard(text) {
    const str = String(text ?? '');
    if (!str) return;
    latestRemoteText = str;
    renderPillIdle();
  }

  function bindToolbarPasteForm(formEl, inputEl, { clearOnSend = true } = {}) {
    if (!formEl || !inputEl || typeof formEl.addEventListener !== 'function') return;
    formEl.addEventListener('submit', (ev) => {
      ev.preventDefault?.();
      const val = String(inputEl.value || '');
      if (!val) return;
      options.onHostPaste?.(val, { source: 'toolbar_box', submit: false });
      if (clearOnSend) inputEl.value = '';
    });
  }

  return {
    getMode: () => mode,
    setMode,
    isComposing: () => composing,
    focusInteractiveTarget,
    handleKeyDownForPasteHold,
    notifyRemoteClipboard,
    getLatestRemoteClipboard: () => latestRemoteText,
    bindToolbarPasteForm,
    getHiddenInput: () => hiddenInput,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPasteHold();
      if (resetPillTimer) clearTimeout(resetPillTimer);
      win?.removeEventListener?.('paste', onWindowPaste);
      pillEl?.removeEventListener?.('click', onPillClick);
      if (createdHiddenInput) hiddenInput?.remove?.();
    },
  };
}
