/**
 * Per-target Lease & Human Takeover status bar controller for Kiki remote panels.
 * Synchronizes `AI 控制中 · 接管` <-> `人工接管中 · 交还 AI` per target without blocking
 * sibling devices/VMs.
 */

export function createRemoteLeaseBar(options = {}) {
  const win = options.windowObj || (typeof window !== 'undefined' ? window : null);
  const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
  const buttonEl = options.buttonEl || null;
  const labelEl = options.labelEl || null;
  const dotEl = options.dotEl || null;
  const shortcutKey = String(options.shortcutKey || 'i').toLowerCase();
  const isZh = options.isZh !== undefined
    ? Boolean(options.isZh)
    : /^zh\b/i.test(String(win?.navigator?.language || ''));

  const stateByTarget = new Map();
  let currentTargetKey = options.initialTargetKey || '';
  let online = true;
  let disposed = false;

  function getEntry(targetKey = currentTargetKey) {
    const key = String(targetKey || '');
    if (!key) return { active: false, controlledBy: 'agent', reason: null };
    return stateByTarget.get(key) || { active: false, controlledBy: 'agent', reason: null };
  }

  function formatLabel(active) {
    if (options.labels) {
      return active ? options.labels.active : options.labels.idle;
    }
    if (isZh) {
      return active ? '人工接管中 · 交还 AI' : 'AI 控制中 · 接管';
    }
    return active ? 'Human Takeover · Hand back' : 'AI Ready · Take over';
  }

  function render() {
    const entry = getEntry(currentTargetKey);
    const active = Boolean(entry.active);
    if (buttonEl) {
      buttonEl.disabled = !online || !currentTargetKey;
      buttonEl.classList?.toggle?.('takeover-locked', active);
      buttonEl.classList?.toggle?.('interactive-on', active);
      buttonEl.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    }
    if (labelEl) {
      labelEl.textContent = formatLabel(active);
    }
    if (dotEl) {
      dotEl.className = 'status-dot ' + (!online ? 'warn' : (active ? 'warn' : 'online'));
    }
    options.onRender?.({
      targetKey: currentTargetKey,
      takeoverActive: active,
      controlledBy: active ? 'human' : 'agent',
      online,
    });
  }

  async function setTakeover(nextActive, { targetKey = currentTargetKey, syncBackend = true, reason } = {}) {
    const key = String(targetKey || '');
    if (!key) return { active: false, targetKey: '' };
    const active = Boolean(nextActive);
    stateByTarget.set(key, {
      active,
      controlledBy: active ? 'human' : 'agent',
      reason: reason || null,
    });
    if (key === currentTargetKey) {
      render();
    }
    if (syncBackend && typeof options.onToggleBackend === 'function') {
      const res = await options.onToggleBackend({ targetKey: key, active, reason });
      if (res && typeof res.takeoverActive === 'boolean') {
        stateByTarget.set(key, {
          active: Boolean(res.takeoverActive),
          controlledBy: res.takeoverActive ? 'human' : 'agent',
          reason: res.reason || null,
        });
        if (key === currentTargetKey) render();
      }
    }
    return getEntry(key);
  }

  function syncFromBackend(targetKey, takeoverActive, extra = {}) {
    const key = String(targetKey || currentTargetKey || '');
    if (!key) return;
    stateByTarget.set(key, {
      active: Boolean(takeoverActive),
      controlledBy: takeoverActive ? 'human' : (extra.controlledBy || 'agent'),
      reason: extra.reason || null,
    });
    if (key === currentTargetKey) render();
  }

  function setTarget(targetKey, { isOnline = true, initialActive } = {}) {
    currentTargetKey = String(targetKey || '');
    online = Boolean(isOnline);
    if (currentTargetKey && typeof initialActive === 'boolean' && !stateByTarget.has(currentTargetKey)) {
      stateByTarget.set(currentTargetKey, {
        active: initialActive,
        controlledBy: initialActive ? 'human' : 'agent',
        reason: null,
      });
    }
    render();
  }

  const onButtonClick = () => {
    if (disposed || !online || !currentTargetKey) return;
    const cur = getEntry(currentTargetKey);
    void setTakeover(!cur.active, { targetKey: currentTargetKey, syncBackend: true });
  };

  const onWindowKeyDown = (ev) => {
    if (disposed || !ev || !ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const tag = String(doc?.activeElement?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (String(ev.key || '').toLowerCase() === shortcutKey) {
      ev.preventDefault?.();
      onButtonClick();
    }
  };

  buttonEl?.addEventListener?.('click', onButtonClick);
  win?.addEventListener?.('keydown', onWindowKeyDown);

  return {
    getTarget: () => currentTargetKey,
    setTarget,
    isTakeoverActive: (targetKey = currentTargetKey) => Boolean(getEntry(targetKey).active),
    setTakeover,
    syncFromBackend,
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      buttonEl?.removeEventListener?.('click', onButtonClick);
      win?.removeEventListener?.('keydown', onWindowKeyDown);
    },
  };
}
