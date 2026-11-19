(() => {
  const kit = (typeof window !== 'undefined' && window.KikiPanelKit) || null;
  const CHANNEL = kit?.PANEL_CHANNEL || 'kiki.panel.v1';
  const SURFACES = ['fleet', 'chat', 'terminal', 'desktop', 'mobile', 'ports'];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '');

  const memoryStorage = new Map();
  const safeStorage = kit?.createSafeStorage
    ? kit.createSafeStorage(window)
    : {
        get(key) {
          try {
            const store = window.localStorage;
            const val = store ? store.getItem(key) : null;
            return val !== null ? val : (memoryStorage.has(key) ? memoryStorage.get(key) : null);
          } catch {
            return memoryStorage.has(key) ? memoryStorage.get(key) : null;
          }
        },
        set(key, value) {
          const str = String(value);
          memoryStorage.set(key, str);
          try {
            window.localStorage?.setItem(key, str);
          } catch {}
        },
        remove(key) {
          memoryStorage.delete(key);
          try {
            window.localStorage?.removeItem(key);
          } catch {}
        },
      };

  async function copyTextSafe(text) {
    const value = String(text ?? '');
    if (!value) return false;
    if (kit?.copyTextSafe) {
      return kit.copyTextSafe(value);
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select?.();
      ta.setSelectionRange?.(0, value.length);
      return Boolean(document.execCommand('copy'));
    } catch {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  /**
   * Compute remote target pixel coordinates and viewport-local overlay coordinates
   * after deducting `object-fit: contain` letterbox/pillarbox margins.
   */
  function mapContainedCanvasPoint(rect, naturalWidth, naturalHeight, targetWidth, targetHeight, clientX, clientY, options = {}) {
    const clampToContent = Boolean(options.clampToContent);
    const frameRect = options.frameRect || rect;
    const boxW = Math.max(1, Number(rect?.width) || 1);
    const boxH = Math.max(1, Number(rect?.height) || 1);
    const natW = Math.max(1, Number(naturalWidth) || Number(targetWidth) || 1);
    const natH = Math.max(1, Number(naturalHeight) || Number(targetHeight) || 1);
    const boxAspect = boxW / boxH;
    const imgAspect = natW / natH;

    let renderW = boxW;
    let renderH = boxH;
    let offsetX = 0;
    let offsetY = 0;
    if (boxAspect > imgAspect) {
      renderW = boxH * imgAspect;
      offsetX = (boxW - renderW) / 2;
    } else if (boxAspect < imgAspect) {
      renderH = boxW / imgAspect;
      offsetY = (boxH - renderH) / 2;
    }

    const rawU = (clientX - (Number(rect?.left) || 0) - offsetX) / Math.max(1, renderW);
    const rawV = (clientY - (Number(rect?.top) || 0) - offsetY) / Math.max(1, renderH);
    const inside = rawU >= 0 && rawU <= 1 && rawV >= 0 && rawV <= 1;
    if (!inside && !clampToContent) {
      return null;
    }

    const u = Math.max(0, Math.min(1, rawU));
    const v = Math.max(0, Math.min(1, rawV));
    const tw = Math.max(1, Math.round(Number(targetWidth) || natW));
    const th = Math.max(1, Math.round(Number(targetHeight) || natH));
    const x = tw <= 1 ? 0 : Math.max(0, Math.min(tw - 1, Math.round(u * (tw - 1))));
    const y = th <= 1 ? 0 : Math.max(0, Math.min(th - 1, Math.round(v * (th - 1))));
    const localX = ((Number(rect?.left) || 0) + offsetX + u * renderW) - (Number(frameRect?.left) || 0);
    const localY = ((Number(rect?.top) || 0) + offsetY + v * renderH) - (Number(frameRect?.top) || 0);

    return {
      x,
      y,
      u,
      v,
      localX,
      localY,
      inside,
      contentBox: { offsetX, offsetY, width: renderW, height: renderH },
    };
  }

  window.__V42_PANEL_TEST_HOOKS__ = {
    safeStorage,
    copyTextSafe,
    mapContainedCanvasPoint,
  };

  let reqSeq = 0;
  let booted = false;
  const pending = new Map();

  const state = {
    surface: safeStorage.get('v42.surface') || 'fleet',
    connection: { online: true, configured: true, signedIn: true, code: 'ready', message: null },
    account: null,
    capabilities: null,
    computers: [],
    workspaces: [],
    liveSeats: [],
    totalSeats: 0,
    fleetComputerFilter: '',
    fleetShowAllWs: false,
    fleetShowAllSeats: false,
    leased: { seats: [], desktops: [], mobiles: [], forwards: [], counts: {} },
    forwards: [],
    unmanaged: null,
    selectedValue: safeStorage.get('v42.selectedTarget') || '',
    seatView: null,
    desktopFrame: null,
    mobileFrame: null,
    interactive: {
      desktop: false,
      mobile: false,
    },
    previewLocalPort: null,
    previewPath: safeStorage.get('v42.previewPath') || '/',
    streamHandle: null,
    streamPort: null,
    scrollTopBySurface: { fleet: 0, chat: 0, terminal: 0, ports: 0 },
    chatStickBottom: true,
    termStickBottom: true,
    termHistoryBySeat: {},
    termHistoryCursor: -1,
    termLiveDraft: '',
    drafts: loadSavedDrafts(),
  };

  function loadSavedDrafts() {
    try {
      const raw = safeStorage.get('v42.drafts');
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistDraft(key, val) {
    if (!key) return;
    if (val) state.drafts[key] = val;
    else delete state.drafts[key];
    safeStorage.set('v42.drafts', JSON.stringify(state.drafts));
  }

  function getSeatHistory(seatRef) {
    const key = seatRef || '_default';
    if (!state.termHistoryBySeat[key]) {
      try {
        const raw = safeStorage.get(`v42.termHist.${key}`);
        const arr = raw ? JSON.parse(raw) : [];
        state.termHistoryBySeat[key] = Array.isArray(arr) ? arr.slice(-50) : [];
      } catch {
        state.termHistoryBySeat[key] = [];
      }
    }
    return state.termHistoryBySeat[key];
  }

  function pushSeatHistory(seatRef, cmd) {
    const trimmed = String(cmd || '').trim();
    if (!trimmed) return;
    const key = seatRef || '_default';
    const list = getSeatHistory(key);
    if (list[list.length - 1] !== trimmed) {
      list.push(trimmed);
      while (list.length > 50) list.shift();
      safeStorage.set(`v42.termHist.${key}`, JSON.stringify(list));
    }
    state.termHistoryCursor = -1;
    state.termLiveDraft = '';
  }

  function applyTheme(theme) {
    if (kit?.applyThemeName) {
      const applied = kit.applyThemeName(theme);
      if (applied === 'dark' || applied === 'light') safeStorage.set('v42.theme', applied);
      return;
    }
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
      safeStorage.set('v42.theme', theme);
    }
  }

  if (kit?.initThemeFromUrl) {
    kit.initThemeFromUrl();
  } else {
    const queryTheme = new URLSearchParams(window.location.search).get('theme');
    if (queryTheme === 'dark' || queryTheme === 'light') {
      applyTheme(queryTheme);
    }
  }
  const urlParams = new URLSearchParams(window.location.search);
  const querySurface = urlParams.get('surface');
  if (querySurface && SURFACES.includes(querySurface)) {
    state.surface = querySurface;
  }
  if (!SURFACES.includes(state.surface)) {
    state.surface = 'fleet';
  }

  const panelClient = kit?.createPanelClient
    ? kit.createPanelClient({
        channel: CHANNEL,
        defaultTimeoutMs: 18_000,
        testBridge: (method, payload) => {
          if (typeof window.__V42_DIRECT_RPC__ !== 'function') return undefined;
          if (method === 'plugin.call') {
            return window.__V42_DIRECT_RPC__(payload.action, payload.args || {});
          }
          if (method === 'plugin.openExternal') {
            return window.__V42_DIRECT_RPC__('__openExternal', { url: payload.url });
          }
          return null;
        },
        onInit: () => { void boot(); },
      })
    : null;

  if (!panelClient) {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.channel !== CHANNEL) return;
      if (data.kind === 'presentation') {
        applyTheme(data.presentation?.theme || data.theme);
        return;
      }
      if (data.kind === 'init') {
        applyTheme(data.presentation?.theme || data.theme);
        void boot();
        return;
      }
      if (data.kind !== 'response') return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) {
        entry.resolve(entry.withPort ? { result: data.result, port: event.ports?.[0] || null } : data.result);
      } else {
        entry.reject(new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Request failed'));
      }
    });
  }

  function bridgeCall(method, payload = {}, timeoutMs = 15000, withPort = false) {
    if (typeof window.__V42_DIRECT_RPC__ === 'function') {
      if (method === 'plugin.call') {
        return Promise.resolve(window.__V42_DIRECT_RPC__(payload.action, payload.args || {}));
      }
      if (method === 'plugin.openExternal') {
        return Promise.resolve(window.__V42_DIRECT_RPC__('__openExternal', { url: payload.url }));
      }
      if (method === 'plugin.openStream') {
        return Promise.resolve({ result: null, port: null });
      }
    }
    if (panelClient) {
      return panelClient.request(method, payload, { timeoutMs, withPort });
    }
    const id = ++reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Panel bridge timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, withPort });
      window.parent.postMessage({ channel: CHANNEL, kind: 'request', id, method, ...payload }, '*');
    });
  }

  const panelCall = (action, args = {}) => bridgeCall('plugin.call', { action, args });

  function currentTargetObject() {
    const val = state.selectedValue;
    if (!val) return null;
    if (val.startsWith('seat:')) {
      const ref = val.slice(5);
      return { kind: 'seat', key: val, seatRef: ref, record: state.leased.seats.find((s) => s.seatRef === ref) };
    }
    if (val.startsWith('desktop:')) {
      const comp = val.slice(8);
      return { kind: 'desktop', key: val, computer: comp, record: state.leased.desktops.find((d) => d.computerId === comp) };
    }
    if (val.startsWith('mobile:')) {
      const rest = val.slice(7);
      const idx = rest.indexOf(':');
      const computer = rest.slice(0, idx);
      const deviceId = rest.slice(idx + 1);
      return {
        kind: 'mobile',
        key: val,
        computer,
        deviceId,
        record: state.leased.mobiles.find((m) => m.key === rest),
      };
    }
    return null;
  }

  function resolveDesktopComputer() {
    const target = currentTargetObject();
    if (target?.kind === 'desktop') return target.computer;
    return state.leased.desktops[0]?.computerId || state.computers.find((c) => c.online !== false)?.id || state.computers[0]?.id || '';
  }

  function resolveMobileTarget() {
    const target = currentTargetObject();
    if (target?.kind === 'mobile') {
      return { computer: target.computer, deviceId: target.deviceId, key: `mobile:${target.computer}:${target.deviceId}` };
    }
    const first = state.leased.mobiles[0];
    if (first) {
      return { computer: first.computerId, deviceId: first.deviceId, key: `mobile:${first.key}` };
    }
    return null;
  }

  function isTakeoverOn(tk) {
    return Boolean(tk && (tk.active || tk.takeoverActive || tk.controlledBy === 'human'));
  }

  function activeTakeover() {
    if (state.surface === 'desktop') {
      const comp = state.desktopFrame?.computer || resolveDesktopComputer();
      if (comp && (state.interactive.desktop || isTakeoverOn(state.desktopFrame?.takeover))) {
        return { key: `desktop:${comp}`, takeover: state.desktopFrame?.takeover || { active: true } };
      }
    }
    if (state.surface === 'mobile') {
      const mob = resolveMobileTarget();
      if (mob && (state.interactive.mobile || isTakeoverOn(state.mobileFrame?.takeover))) {
        return { key: mob.key, takeover: state.mobileFrame?.takeover || { active: true } };
      }
    }
    const target = currentTargetObject();
    if (!target) return null;
    if (target.kind === 'seat' && isTakeoverOn(state.seatView?.takeover)) {
      return { key: target.key, takeover: state.seatView.takeover };
    }
    if (target.kind === 'desktop' && isTakeoverOn(state.desktopFrame?.takeover)) {
      return { key: target.key, takeover: state.desktopFrame.takeover };
    }
    if (target.kind === 'mobile' && isTakeoverOn(state.mobileFrame?.takeover)) {
      return { key: target.key, takeover: state.mobileFrame.takeover };
    }
    if (isTakeoverOn(target.record?.takeover)) {
      return { key: target.key, takeover: target.record.takeover };
    }
    return null;
  }

  function buildTargetOptions() {
    const opts = [];
    for (const seat of state.leased.seats || []) {
      const compId = seat.computerId || seat.computer || String(seat.seatRef || '').split(':')[0] || '';
      const compLabel = seat.computerName || state.computers.find((c) => c.id === compId)?.name || compId;
      opts.push({
        value: `seat:${seat.seatRef}`,
        label: `${compLabel} / ${seat.title || seat.terminalId || seat.target} (${seat.status || 'idle'})`,
      });
    }
    for (const desk of state.leased.desktops || []) {
      opts.push({
        value: `desktop:${desk.computerId}`,
        label: `${desk.computerName || desk.computerId} / Desktop`,
      });
    }
    for (const mob of state.leased.mobiles || []) {
      opts.push({
        value: `mobile:${mob.key}`,
        label: `${mob.computerId} / ${mob.name || mob.deviceId}`,
      });
    }
    return opts;
  }

  function saveCurrentSurfaceState() {
    const fleetScroll = document.getElementById('fleetScroll');
    const chatScroll = document.getElementById('chatScroll');
    const termScreen = document.getElementById('terminalScreen');
    const portsScroll = document.getElementById('portsScroll');
    if (state.surface === 'fleet' && fleetScroll) state.scrollTopBySurface.fleet = fleetScroll.scrollTop;
    if (state.surface === 'chat' && chatScroll) state.scrollTopBySurface.chat = chatScroll.scrollTop;
    if (state.surface === 'terminal' && termScreen) state.scrollTopBySurface.terminal = termScreen.scrollTop;
    if (state.surface === 'ports' && portsScroll) state.scrollTopBySurface.ports = portsScroll.scrollTop;

    const targetKey = state.selectedValue || '_global';
    persistDraft(`chat:${targetKey}`, document.getElementById('chatInput')?.value || '');
    persistDraft(`term:${targetKey}`, document.getElementById('terminalInput')?.value || '');
    persistDraft('deskText', document.getElementById('desktopTextInput')?.value || '');
    persistDraft('mobText', document.getElementById('mobileTextInput')?.value || '');
    persistDraft('remotePort', document.getElementById('remotePortInput')?.value || '');
    persistDraft('localPort', document.getElementById('localPortInput')?.value || '');
  }

  function restoreDraftInputs() {
    const targetKey = state.selectedValue || '_global';
    const chatInput = document.getElementById('chatInput');
    const termInput = document.getElementById('terminalInput');
    const deskText = document.getElementById('desktopTextInput');
    const mobText = document.getElementById('mobileTextInput');
    const remPort = document.getElementById('remotePortInput');
    const locPort = document.getElementById('localPortInput');
    const pathEl = document.getElementById('portPreviewPath');

    if (chatInput && document.activeElement !== chatInput) chatInput.value = state.drafts[`chat:${targetKey}`] || '';
    if (termInput && document.activeElement !== termInput) termInput.value = state.drafts[`term:${targetKey}`] || '';
    if (deskText && document.activeElement !== deskText) deskText.value = state.drafts.deskText || '';
    if (mobText && document.activeElement !== mobText) mobText.value = state.drafts.mobText || '';
    if (remPort && document.activeElement !== remPort && !remPort.value) remPort.value = state.drafts.remotePort || '';
    if (locPort && document.activeElement !== locPort && !locPort.value) locPort.value = state.drafts.localPort || '';
    if (pathEl && document.activeElement !== pathEl && state.previewPath) pathEl.value = state.previewPath;
  }

  function restoreSurfaceScroll() {
    requestAnimationFrame(() => {
      if (state.surface === 'fleet') {
        const el = document.getElementById('fleetScroll');
        if (el) el.scrollTop = state.scrollTopBySurface.fleet;
      } else if (state.surface === 'chat') {
        const el = document.getElementById('chatScroll');
        if (el) {
          el.scrollTop = state.chatStickBottom ? el.scrollHeight : state.scrollTopBySurface.chat;
        }
      } else if (state.surface === 'terminal') {
        const el = document.getElementById('terminalScreen');
        if (el) {
          el.scrollTop = state.termStickBottom ? el.scrollHeight : state.scrollTopBySurface.terminal;
        }
      } else if (state.surface === 'ports') {
        const el = document.getElementById('portsScroll');
        if (el) el.scrollTop = state.scrollTopBySurface.ports;
      }
    });
  }

  function switchSurface(nextSurface, { focusTarget } = {}) {
    if (!SURFACES.includes(nextSurface)) return;
    saveCurrentSurfaceState();
    state.surface = nextSurface;
    safeStorage.set('v42.surface', nextSurface);
    void refreshActiveSurface().then(() => {
      restoreSurfaceScroll();
      if (focusTarget) {
        document.getElementById(focusTarget)?.focus();
      }
    });
  }

  async function refreshState() {
    try {
      const res = await panelCall('state', { includeUnmanaged: false });
      state.connection = res.connection || {
        online: Array.isArray(res.computers) && res.computers.some((c) => c.online !== false),
        configured: true,
        signedIn: true,
        code: 'ready',
      };
      state.account = res.account || null;
      state.capabilities = res.capabilities || null;
      state.computers = res.computers || [];
      state.workspaces = res.workspaces || [];
      state.liveSeats = res.liveSeats || [];
      state.totalSeats = Number(res.totalSeats ?? state.liveSeats.length);
      state.leased = res.leased || state.leased;
      state.forwards = res.forwards || [];
      if (state.fleetComputerFilter && !state.computers.some((c) => c.id === state.fleetComputerFilter)) {
        state.fleetComputerFilter = '';
      }
    } catch (err) {
      state.connection = {
        online: false,
        configured: !/not found|ENOENT/i.test(err.message),
        signedIn: !/not_logged_in|v42 login/i.test(err.message),
        code: /not found|ENOENT/i.test(err.message)
          ? 'ENOENT'
          : (/companion_unavailable|Companion daemon is not running/i.test(err.message)
            ? 'companion_unavailable'
            : 'bridge_error'),
        message: err.message,
      };
    }

    const options = buildTargetOptions();
    if (!state.selectedValue || !options.some((o) => o.value === state.selectedValue)) {
      const preferredPrefix = state.surface === 'desktop'
        ? 'desktop:'
        : (state.surface === 'mobile' ? 'mobile:' : '');
      const match = preferredPrefix ? options.find((o) => o.value.startsWith(preferredPrefix)) : null;
      state.selectedValue = match?.value || options[0]?.value || '';
      safeStorage.set('v42.selectedTarget', state.selectedValue);
    }
    restoreDraftInputs();
    renderTopbar();
    await refreshActiveSurface();
  }

  let frameRefreshInFlight = null;
  let frameRefreshQueued = false;

  async function refreshActiveSurface() {
    const target = currentTargetObject();
    try {
      if ((state.surface === 'chat' || state.surface === 'terminal') && target?.kind === 'seat') {
        state.seatView = await panelCall('seatInspect', { seatRef: target.seatRef });
      } else if (state.surface === 'desktop') {
        const comp = resolveDesktopComputer();
        if (comp && state.connection.configured !== false) {
          state.desktopFrame = await panelCall('desktopFrame', { computer: comp });
        } else {
          state.desktopFrame = null;
        }
      } else if (state.surface === 'mobile') {
        const mob = resolveMobileTarget();
        if (mob && state.connection.configured !== false) {
          state.mobileFrame = await panelCall('mobileFrame', {
            computer: mob.computer,
            deviceId: mob.deviceId,
          });
        } else {
          state.mobileFrame = null;
        }
      }
    } catch {
      if (state.surface === 'desktop') state.desktopFrame = null;
      if (state.surface === 'mobile') state.mobileFrame = null;
    }
    renderTopbar();
    renderStage();
  }

  async function queueCanvasFrameRefresh() {
    if (frameRefreshInFlight) {
      frameRefreshQueued = true;
      return frameRefreshInFlight;
    }
    frameRefreshInFlight = refreshActiveSurface().finally(() => {
      frameRefreshInFlight = null;
      if (frameRefreshQueued) {
        frameRefreshQueued = false;
        void queueCanvasFrameRefresh();
      }
    });
    return frameRefreshInFlight;
  }

  function formatPlatformLabel(raw) {
    const val = String(raw || '').toLowerCase();
    if (val === 'macos' || val === 'darwin') return 'macOS';
    if (val === 'windows' || val === 'win32') return 'Windows';
    if (val === 'linux') return 'Linux';
    return raw || 'host';
  }

  function renderEmptyRecoveryMarkup(kindLabel) {
    if (state.connection.configured === false || state.connection.code === 'ENOENT') {
      return `
        <h3>Vibe42 CLI not configured</h3>
        <p>Set <code class="mono">v42BinPath</code> in Plugin Settings or install Vibe42 Companion.</p>
        <button class="btn btn-primary" type="button" data-empty-action="retry">Retry</button>
      `;
    }
    if (state.connection.signedIn === false || state.connection.code === 'not_logged_in') {
      return `
        <h3>Sign in to Vibe42</h3>
        <p>Open the Vibe42 app or run <code class="mono">v42 login</code>, then refresh.</p>
        <button class="btn btn-primary" type="button" data-empty-action="retry">Refresh</button>
      `;
    }
    if (state.connection.code === 'companion_unavailable') {
      return `
        <h3>Vibe42 Companion offline</h3>
        <p>Launch the Vibe42 desktop app or Companion service, then refresh.</p>
        <button class="btn btn-primary" type="button" data-empty-action="retry">Refresh</button>
      `;
    }
    if (!state.computers.length || state.computers.every((c) => c.online === false)) {
      return `
        <h3>Remote host offline</h3>
        <p>Bring a Vibe42 Computer online, then refresh.</p>
        <button class="btn btn-primary" type="button" data-empty-action="retry">Refresh</button>
      `;
    }
    return `
      <h3>No ${escapeHtml(kindLabel)} pinned</h3>
      <p>Pin an online ${escapeHtml(kindLabel)} to work on it here.</p>
      <button class="btn btn-primary" type="button" data-empty-action="pin">Pin target</button>
    `;
  }

  function renderFleet() {
    const bodyEl = document.getElementById('fleetBody');
    const titleEl = document.getElementById('fleetAccountName');
    const ratioEl = document.getElementById('fleetRatio');
    const clearBtn = document.getElementById('fleetClearFilterBtn');
    if (!bodyEl || !titleEl || !ratioEl) return;

    const onlineCount = state.computers.filter((c) => c.online !== false).length;
    titleEl.textContent = state.account?.displayName || 'Vibe42 Fleet';
    const ratioParts = [];
    if (state.computers.length > 0) ratioParts.push(`${onlineCount}/${state.computers.length} online`);
    if (state.workspaces.length > 0) ratioParts.push(`${state.workspaces.length} workspaces`);
    if (state.totalSeats > 0) ratioParts.push(`${state.totalSeats} terminals`);
    ratioEl.textContent = ratioParts.join(' · ');

    const filterId = state.fleetComputerFilter;
    const filteredComp = filterId ? state.computers.find((c) => c.id === filterId) : null;
    if (clearBtn) {
      clearBtn.hidden = !filteredComp;
      if (filteredComp) clearBtn.textContent = `Clear filter (${filteredComp.name})`;
    }

    if (state.connection.configured === false || state.connection.signedIn === false || state.computers.length === 0) {
      bodyEl.innerHTML = `<div class="empty-quiet">${renderEmptyRecoveryMarkup('computer')}</div>`;
      return;
    }

    const sortedComps = [...state.computers].sort((a, b) => {
      const onDiff = (b.online !== false ? 1 : 0) - (a.online !== false ? 1 : 0);
      if (onDiff !== 0) return onDiff;
      return (b.activeTerminals || 0) - (a.activeTerminals || 0);
    });

    const canDesktop = state.capabilities?.desktop !== false;
    const compTiles = sortedComps.map((c) => {
      const isOnline = c.online !== false;
      const isSel = c.id === filterId;
      const terms = Number(c.activeTerminals || 0);
      const termLabel = terms === 1 ? '1 terminal' : `${terms} terminals`;
      const compCanDesktop = canDesktop && (!Array.isArray(c.featureset) || c.featureset.length === 0 || c.featureset.includes('desktop'));
      return `
        <div class="comp-tile ${isSel ? 'is-selected' : ''} ${isOnline ? '' : 'is-offline'}" data-fleet-comp="${escapeHtml(c.id)}" role="button" tabindex="0">
          <div class="comp-tile-top">
            <div class="comp-tile-name">
              <span class="status-dot ${isOnline ? 'online' : ''}" title="${isOnline ? 'Online' : 'Offline'}"></span>
              <span>${escapeHtml(c.name || c.id)}</span>
            </div>
            <span class="pill-tag">${escapeHtml(formatPlatformLabel(c.platform))}</span>
          </div>
          <div class="comp-tile-foot">
            <span class="comp-tile-stat mono">${escapeHtml(isOnline ? termLabel : 'offline')}</span>
            <div class="comp-tile-actions">
              ${isOnline && compCanDesktop ? `<button class="btn btn-compact" type="button" data-fleet-desktop="${escapeHtml(c.id)}" data-fleet-comp-name="${escapeHtml(c.name || c.id)}" title="Open remote desktop">Desktop</button>` : ''}
              ${isOnline ? `<button class="btn btn-compact" type="button" data-fleet-ports="${escapeHtml(c.id)}" title="Forward a TCP port">Ports</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    const sections = [`
      <div class="fleet-section">
        <div class="fleet-sec-head">
          <span class="fleet-sec-label">Computers</span>
        </div>
        <div class="fleet-computer-grid">${compTiles}</div>
      </div>
    `];

    const activeForwards = filterId
      ? state.forwards.filter((f) => (f.computer || f.computerId) === filterId)
      : state.forwards;
    if (activeForwards.length > 0) {
      sections.push(`
        <div class="fleet-section">
          <div class="fleet-sec-head">
            <span class="fleet-sec-label">Port Forwards (${activeForwards.length})</span>
          </div>
          <div class="fleet-list">
            ${activeForwards.map((f) => {
              const comp = f.computer || f.computerId || '';
              const lp = Number(f.localPort);
              const rp = Number(f.remotePort);
              const url = `http://127.0.0.1:${lp}/`;
              return `
                <div class="fleet-row">
                  <div class="fleet-row-main">
                    <div class="fleet-row-top">
                      <span class="status-dot ${f.healthy !== false ? 'online' : 'offline'}"></span>
                      <span class="fleet-row-title mono">127.0.0.1:${lp}</span>
                      <span class="pill-tag">${escapeHtml(f.computerName || comp)}:${rp}</span>
                    </div>
                  </div>
                  <div class="fleet-row-actions">
                    <button class="btn btn-compact" type="button" data-fleet-preview-port="${lp}">Preview</button>
                    <button class="btn btn-compact" type="button" data-fleet-copy-url="${escapeHtml(url)}">Copy</button>
                    <button class="btn btn-compact btn-danger" type="button" data-fleet-stop-comp="${escapeHtml(comp)}" data-fleet-stop-port="${lp}">Stop</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `);
    }

    const visibleWorkspaces = filterId
      ? state.workspaces.filter((w) => w.computerId === filterId)
      : state.workspaces;
    if (visibleWorkspaces.length > 0) {
      const wsCap = state.fleetShowAllWs ? visibleWorkspaces.length : 8;
      const wsSlice = visibleWorkspaces.slice(0, wsCap);
      sections.push(`
        <div class="fleet-section">
          <div class="fleet-sec-head">
            <span class="fleet-sec-label">Workspaces (${visibleWorkspaces.length})</span>
          </div>
          <div class="fleet-list">
            ${wsSlice.map((w) => `
              <div class="fleet-row">
                <div class="fleet-row-main">
                  <div class="fleet-row-top">
                    <span class="fleet-row-title">${escapeHtml(w.name || w.id)}</span>
                    <span class="pill-tag">${escapeHtml(w.computerName || w.computerId)}</span>
                    ${w.terminalIsolation ? '<span class="pill-tag is-accent">COW</span>' : ''}
                  </div>
                  ${w.path ? `<span class="fleet-row-sub mono">${escapeHtml(w.path)}</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
          ${visibleWorkspaces.length > wsCap ? `<button class="btn btn-compact fleet-more-btn" type="button" data-fleet-expand="ws">Show all ${visibleWorkspaces.length} workspaces</button>` : ''}
        </div>
      `);
    }

    const seatMap = new Map();
    for (const live of state.liveSeats || []) {
      seatMap.set(live.seatRef, { ...live });
    }
    for (const leasedSeat of state.leased.seats || []) {
      const existing = seatMap.get(leasedSeat.seatRef);
      const compId = leasedSeat.computerId || leasedSeat.computer || existing?.computerId || String(leasedSeat.seatRef || '').split(':')[0] || '';
      const target = leasedSeat.terminalId || leasedSeat.target || existing?.target || String(leasedSeat.seatRef || '').split(':').slice(1).join(':') || '';
      seatMap.set(leasedSeat.seatRef, {
        seatRef: leasedSeat.seatRef,
        computerId: compId,
        computerName: leasedSeat.computerName || existing?.computerName || state.computers.find((c) => c.id === compId)?.name || compId,
        target,
        title: leasedSeat.title || existing?.title || target,
        agent: leasedSeat.agent || existing?.agent || 'shell',
        cwd: leasedSeat.cwd || existing?.cwd || null,
        status: leasedSeat.status || existing?.status || 'idle',
        leased: true,
      });
    }
    const allSeats = [...seatMap.values()]
      .filter((s) => !filterId || s.computerId === filterId)
      .sort((a, b) => {
        const leaseDiff = (b.leased ? 1 : 0) - (a.leased ? 1 : 0);
        if (leaseDiff !== 0) return leaseDiff;
        const activeDiff = (b.status === 'working' || b.status === 'blocked' ? 1 : 0) - (a.status === 'working' || a.status === 'blocked' ? 1 : 0);
        return activeDiff;
      });

    if (allSeats.length > 0) {
      const seatCap = state.fleetShowAllSeats ? allSeats.length : 12;
      const seatSlice = allSeats.slice(0, seatCap);
      sections.push(`
        <div class="fleet-section">
          <div class="fleet-sec-head">
            <span class="fleet-sec-label">Active Seats &amp; Terminals (${allSeats.length})</span>
          </div>
          <div class="fleet-list">
            ${seatSlice.map((s) => `
              <div class="fleet-row">
                <div class="fleet-row-main">
                  <div class="fleet-row-top">
                    <span class="status-dot ${s.status === 'working' ? 'online' : (s.status === 'blocked' ? 'offline' : '')}" title="${escapeHtml(s.status || 'idle')}"></span>
                    <span class="fleet-row-title">${escapeHtml(s.title || s.target)}</span>
                    <span class="pill-tag ${s.leased ? 'is-accent' : ''}">${escapeHtml(s.agent || 'shell')}</span>
                  </div>
                  <span class="fleet-row-sub mono">${escapeHtml([s.computerName || s.computerId, s.target, s.cwd].filter(Boolean).join(' · '))}</span>
                </div>
                <div class="fleet-row-actions">
                  ${s.leased
                    ? `<button class="btn btn-compact btn-primary" type="button" data-fleet-open-seat="${escapeHtml(s.seatRef)}">Open</button>`
                    : `<button class="btn btn-compact" type="button" data-fleet-pin-seat="${escapeHtml(s.seatRef)}" data-fleet-seat-title="${escapeHtml(s.title || s.target)}" data-fleet-seat-agent="${escapeHtml(s.agent || 'shell')}">Pin</button>`}
                </div>
              </div>
            `).join('')}
          </div>
          ${allSeats.length > seatCap ? `<button class="btn btn-compact fleet-more-btn" type="button" data-fleet-expand="seats">Show all ${allSeats.length} terminals</button>` : ''}
        </div>
      `);
    }

    bodyEl.innerHTML = sections.join('');
  }

  function renderTopbar() {
    const connDot = document.getElementById('connDot');
    const isOnline = state.connection.configured !== false && state.computers.some((c) => c.online !== false);
    connDot.classList.toggle('online', isOnline);
    connDot.classList.toggle('offline', !isOnline);
    connDot.title = state.connection.configured === false
      ? 'v42 CLI not found — configure v42BinPath in Plugin Settings'
      : (isOnline ? `${state.computers.filter((c) => c.online !== false).length} Computer(s) online` : 'No online Vibe42 Computers');

    const select = document.getElementById('leasedTargetSelect');
    const options = buildTargetOptions();
    select.innerHTML = '';
    if (options.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No pinned targets';
      select.appendChild(opt);
    } else {
      for (const item of options) {
        const opt = document.createElement('option');
        opt.value = item.value;
        opt.textContent = item.label;
        if (item.value === state.selectedValue) opt.selected = true;
        select.appendChild(opt);
      }
    }

    document.getElementById('unpinBtn').hidden = !state.selectedValue;

    for (const btn of document.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', btn.dataset.surface === state.surface);
    }

    const pill = document.getElementById('takeoverPill');
    const tk = activeTakeover();
    pill.hidden = !tk;

    const refreshBtn = document.getElementById('refreshBtn');
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    refreshBtn.title = `Refresh workbench (${stamp})`;
  }

  function renderChatAndTerminal() {
    const chatList = document.getElementById('chatColumn');
    const approvalBox = document.getElementById('approvalGate');
    const termPre = document.getElementById('terminalScreen');
    const termMeta = document.getElementById('terminalMeta');
    const followBtn = document.getElementById('termFollowBtn');
    const target = currentTargetObject();

    const chordLabel = isMac ? '⌘E' : 'Ctrl+E';
    document.getElementById('termQuickSwitchBtn').textContent = chordLabel;
    document.getElementById('termBackChatBtn').textContent = chordLabel;

    if (!target || target.kind !== 'seat') {
      chatList.innerHTML = `<div class="empty-quiet">${renderEmptyRecoveryMarkup('coding seat')}</div>`;
      approvalBox.hidden = true;
      termMeta.textContent = 'No coding seat selected';
      termPre.textContent = '$ # Pin a coding seat to attach to its PTY.';
      followBtn.hidden = true;
      return;
    }

    const env = state.seatView?.envelope;
    const rows = env?.rows || [];
    if (rows.length === 0) {
      chatList.innerHTML = `<div class="empty-quiet"><h3>${escapeHtml(target.seatRef)}</h3><p>Seat is ready for instructions.</p></div>`;
    } else {
      chatList.innerHTML = rows.map((row) => {
        if (row.kind === 'tool') {
          return `<div class="msg-tool">${escapeHtml(row.title || row.toolName || 'tool')} ${escapeHtml(row.text || '')}</div>`;
        }
        const cls = row.kind === 'user' ? 'msg-user' : 'msg-assistant';
        const role = row.kind === 'user' ? 'You' : (env?.agent?.kind || 'Agent');
        return `<div class="msg-row ${cls}"><span class="msg-role">${escapeHtml(role)}</span><div class="msg-body">${escapeHtml(row.text || '')}</div></div>`;
      }).join('');
    }
    if (state.surface === 'chat' && state.chatStickBottom) {
      const chatScroll = document.getElementById('chatScroll');
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }

    const pend = env?.pending;
    if (pend && (pend.kind === 'approval' || pend.kind === 'login' || pend.kind === 'permission' || pend.confirm)) {
      approvalBox.hidden = false;
      document.getElementById('approvalTitle').textContent = pend.kind === 'login' ? 'Sign-in Required' : 'Approval Required';
      document.getElementById('approvalCommand').textContent = pend.command || pend.title || pend.message || 'Confirm remote action';
    } else {
      approvalBox.hidden = true;
    }

    const lines = state.seatView?.terminalLines || env?.screenLines || [];
    termMeta.textContent = `${target.seatRef} · ${env?.agent?.kind || 'shell'}${env?.cwd ? ` · ${env.cwd}` : ''}`;
    const prevTop = termPre.scrollTop;
    termPre.textContent = lines.length > 0 ? lines.join('\n') : `$ # Connected to ${target.seatRef}`;
    if (state.termStickBottom) {
      termPre.scrollTop = termPre.scrollHeight;
      followBtn.hidden = true;
    } else {
      termPre.scrollTop = prevTop;
      followBtn.hidden = false;
    }
  }

  function renderDesktop() {
    const viewport = document.getElementById('desktopViewport');
    const bar = document.getElementById('desktopControlBar');
    const img = document.getElementById('desktopImg');
    const empty = document.getElementById('desktopEmpty');
    const toggleBtn = document.getElementById('desktopInteractiveBtn');
    const toggleLabel = document.getElementById('desktopInteractiveLabel');
    const badge = document.getElementById('desktopCoordBadge');

    if (!state.desktopFrame?.dataUrl) {
      viewport.hidden = true;
      bar.hidden = true;
      empty.hidden = false;
      empty.innerHTML = renderEmptyRecoveryMarkup('remote desktop');
      return;
    }

    empty.hidden = true;
    bar.hidden = false;
    viewport.hidden = false;
    if (img.getAttribute('src') !== state.desktopFrame.dataUrl) {
      img.src = state.desktopFrame.dataUrl;
    }

    const active = state.interactive.desktop;
    viewport.classList.toggle('is-interactive', active);
    toggleBtn.classList.toggle('is-active', active);
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggleLabel.textContent = active ? 'Controlling' : 'Interactive';

    const lw = state.desktopFrame.logicalSize?.width || 1920;
    const lh = state.desktopFrame.logicalSize?.height || 1080;
    if (!badge.dataset.hovering) {
      badge.textContent = `${lw}×${lh}`;
    }
  }

  function renderMobile() {
    const viewport = document.getElementById('mobileViewport');
    const bar = document.getElementById('mobileControlBar');
    const hwBar = document.getElementById('mobileHwBar');
    const img = document.getElementById('mobileImg');
    const empty = document.getElementById('mobileEmpty');
    const toggleBtn = document.getElementById('mobileInteractiveBtn');
    const toggleLabel = document.getElementById('mobileInteractiveLabel');
    const badge = document.getElementById('mobileCoordBadge');

    if (!state.mobileFrame?.dataUrl) {
      viewport.hidden = true;
      bar.hidden = true;
      hwBar.hidden = true;
      empty.hidden = false;
      empty.innerHTML = renderEmptyRecoveryMarkup('mobile device');
      return;
    }

    empty.hidden = true;
    bar.hidden = false;
    viewport.hidden = false;
    hwBar.hidden = false;
    if (img.getAttribute('src') !== state.mobileFrame.dataUrl) {
      img.src = state.mobileFrame.dataUrl;
    }

    const active = state.interactive.mobile;
    viewport.classList.toggle('is-interactive', active);
    toggleBtn.classList.toggle('is-active', active);
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggleLabel.textContent = active ? 'Controlling' : 'Interactive';

    const sw = state.mobileFrame.screenSize?.width || 1080;
    const sh = state.mobileFrame.screenSize?.height || 2400;
    if (!badge.dataset.hovering) {
      badge.textContent = `${sw}×${sh}`;
    }
  }

  function buildPreviewUrl(localPort, rawPath) {
    const trimmed = String(rawPath || '/').trim() || '/';
    const normPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return {
      normPath,
      url: `http://127.0.0.1:${Number(localPort)}${normPath}`,
    };
  }

  function updatePortPreviewFrame(forceReload = false) {
    const shell = document.getElementById('portPreviewShell');
    const frame = document.getElementById('portPreviewFrame');
    const originEl = document.getElementById('portPreviewOrigin');
    const pathEl = document.getElementById('portPreviewPath');
    const activeTunnel = state.forwards.find((f) => Number(f.localPort) === Number(state.previewLocalPort));
    if (!activeTunnel) {
      state.previewLocalPort = null;
      shell.hidden = true;
      frame.removeAttribute('src');
      return;
    }
    shell.hidden = false;
    const { normPath, url } = buildPreviewUrl(activeTunnel.localPort, pathEl.value);
    state.previewPath = normPath;
    safeStorage.set('v42.previewPath', normPath);
    originEl.textContent = `http://127.0.0.1:${Number(activeTunnel.localPort)}`;
    if (forceReload) {
      frame.setAttribute('src', url);
    } else if (frame.getAttribute('src') !== url) {
      frame.setAttribute('src', url);
    }
  }

  function setPortNotice(text, isError = false) {
    const el = document.getElementById('portStatusNotice');
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-error');
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('is-error', isError);
  }

  function renderPorts() {
    const compSelect = document.getElementById('portComputerSelect');
    const prevComp = compSelect.value;
    if (state.computers.length === 0) {
      compSelect.innerHTML = `<option value="">No online computers</option>`;
    } else {
      compSelect.innerHTML = state.computers.map((c) =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</option>`,
      ).join('');
      if (prevComp && state.computers.some((c) => c.id === prevComp)) {
        compSelect.value = prevComp;
      }
    }

    const tbody = document.getElementById('portsTbody');
    if (!state.forwards.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="color:var(--ink-faint)">No active port forwards. Enter a remote port above to open a 127.0.0.1 tunnel.</td></tr>`;
      updatePortPreviewFrame(false);
      return;
    }
    tbody.innerHTML = state.forwards.map((f) => {
      const comp = f.computer || f.computerId || '';
      const lp = Number(f.localPort);
      const rp = Number(f.remotePort);
      const url = `http://127.0.0.1:${lp}/`;
      const isPreviewing = Number(state.previewLocalPort) === lp;
      const isPinned = Boolean(f.pinned);
      return `
      <tr>
        <td class="mono">
          <span class="port-cell-inline">
            <span class="status-dot ${f.healthy !== false ? 'online' : 'offline'}" title="${f.healthy !== false ? 'Tunnel listening' : 'Tunnel unreachable'}"></span>
            <span>127.0.0.1:${lp}</span>
            <button class="copy-inline-btn" type="button" data-copy-url="${escapeHtml(url)}" title="Copy local URL">Copy</button>
          </span>
        </td>
        <td class="mono">${escapeHtml(comp)}:${rp}</td>
        <td style="text-align:right">
          <div class="port-row-actions">
            <button class="btn btn-compact ${isPinned ? 'btn-pinned' : ''}" type="button" data-pin-forward-comp="${escapeHtml(comp)}" data-pin-forward-remote="${rp}" data-pin-forward-local="${lp}" data-pinned="${isPinned ? '1' : '0'}" title="Pin tunnel to session lease">${isPinned ? 'Pinned' : '+ Pin'}</button>
            <button class="btn btn-compact ${isPreviewing ? 'btn-primary' : ''}" type="button" data-preview-local="${lp}">Preview</button>
            <button class="btn btn-compact btn-icon" type="button" data-open-external="${escapeHtml(url)}" title="Open in external browser" aria-label="Open in external browser">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
            </button>
            <button class="btn btn-compact btn-danger" type="button" data-stop-comp="${escapeHtml(comp)}" data-stop-local="${lp}">Stop</button>
          </div>
        </td>
      </tr>
    `;
    }).join('');
    updatePortPreviewFrame(false);
  }

  function renderStage() {
    for (const pane of document.querySelectorAll('.surface-pane')) {
      pane.classList.toggle('active', pane.id === `pane-${state.surface}`);
    }
    if (state.surface === 'fleet') renderFleet();
    renderChatAndTerminal();
    if (state.surface === 'desktop') renderDesktop();
    if (state.surface === 'mobile') renderMobile();
    if (state.surface === 'ports') renderPorts();
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function spawnRipple(fxLayer, localX, localY, variant = 'tap') {
    if (!fxLayer) return;
    const node = document.createElement('span');
    node.className = `canvas-ripple ${variant}`;
    node.style.left = `${Math.round(localX)}px`;
    node.style.top = `${Math.round(localY)}px`;
    fxLayer.appendChild(node);
    const cleanup = () => {
      if (node.parentNode) node.parentNode.removeChild(node);
    };
    node.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 650);
  }

  function drawVectorTrail(svgEl, x1, y1, x2, y2) {
    if (!svgEl) return;
    svgEl.innerHTML = `
      <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="3.5" fill="var(--accent)" opacity="0.78" />
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-dasharray="4 3" />
      <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="4.5" fill="none" stroke="var(--accent)" stroke-width="1.75" />
    `;
  }

  function clearVectorTrail(svgEl, fadeMs = 220) {
    if (!svgEl || !svgEl.innerHTML) return;
    if (fadeMs <= 0) {
      svgEl.innerHTML = '';
      return;
    }
    svgEl.style.transition = `opacity ${fadeMs}ms ease`;
    svgEl.style.opacity = '0';
    setTimeout(() => {
      svgEl.innerHTML = '';
      svgEl.style.opacity = '1';
      svgEl.style.transition = '';
    }, fadeMs);
  }

  async function setInteractiveMode(kind, nextActive) {
    const active = Boolean(nextActive);
    state.interactive[kind] = active;
    if (kind === 'desktop') {
      const comp = state.desktopFrame?.computer || resolveDesktopComputer();
      renderDesktop();
      if (active) document.getElementById('desktopViewport')?.focus();
      if (comp) {
        await panelCall('takeover', {
          targetKey: `desktop:${comp}`,
          active,
          reason: active ? 'interactive_desktop' : 'hand_back',
        }).catch(() => {});
        if (state.desktopFrame) {
          state.desktopFrame.takeover = { active, controlledBy: active ? 'human' : 'agent' };
        }
      }
    } else if (kind === 'mobile') {
      const mob = resolveMobileTarget();
      renderMobile();
      if (active) document.getElementById('mobileViewport')?.focus();
      if (mob) {
        await panelCall('takeover', {
          targetKey: mob.key,
          active,
          reason: active ? 'interactive_mobile' : 'hand_back',
        }).catch(() => {});
        if (state.mobileFrame) {
          state.mobileFrame.takeover = { active, controlledBy: active ? 'human' : 'agent' };
        }
      }
    }
    renderTopbar();
  }

  function mapDesktopKeyCombo(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.metaKey) mods.push('super');
    if (e.shiftKey && (e.key.length > 1 || mods.length > 0)) mods.push('shift');

    const keyMap = {
      Enter: 'enter',
      Backspace: 'backspace',
      Tab: 'tab',
      Escape: 'escape',
      Delete: 'delete',
      Home: 'home',
      End: 'end',
      PageUp: 'pageup',
      PageDown: 'pagedown',
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ' ': 'space',
    };
    const base = keyMap[e.key] || (e.key.length === 1 ? e.key.toLowerCase() : '');
    if (!base) return null;
    return mods.length ? `${mods.join('+')}+${base}` : base;
  }

  function bindInteractiveCanvas({
    kind,
    viewportId,
    imgId,
    svgId,
    fxId,
    badgeId,
    toggleBtnId,
    textInputId,
    sendBtnId,
  }) {
    const viewport = document.getElementById(viewportId);
    const imgEl = document.getElementById(imgId);
    const svgEl = document.getElementById(svgId);
    const fxLayer = document.getElementById(fxId);
    const badgeEl = document.getElementById(badgeId);
    const toggleBtn = document.getElementById(toggleBtnId);
    const textInput = document.getElementById(textInputId);
    const sendBtn = document.getElementById(sendBtnId);

    let gesture = null;
    let pendingSingleClick = null;
    let wheelAccum = { dx: 0, dy: 0, pt: null, timer: null };
    let typeBuffer = '';
    let typeTimer = null;

    function getFrameMeta() {
      if (kind === 'desktop') {
        const f = state.desktopFrame;
        if (!f) return null;
        return {
          width: f.logicalSize?.width || 1920,
          height: f.logicalSize?.height || 1080,
          computer: f.computer,
        };
      }
      const f = state.mobileFrame;
      if (!f) return null;
      return {
        width: f.screenSize?.width || 1080,
        height: f.screenSize?.height || 2400,
        computer: f.computer,
        deviceId: f.deviceId,
      };
    }

    function resolvePoint(clientX, clientY, clampToContent = false) {
      const meta = getFrameMeta();
      if (!meta) return null;
      const imgRect = imgEl.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      return mapContainedCanvasPoint(
        imgRect,
        imgEl.naturalWidth,
        imgEl.naturalHeight,
        meta.width,
        meta.height,
        clientX,
        clientY,
        { clampToContent, frameRect: vpRect },
      );
    }

    async function dispatchCanvasOp(opPayload) {
      const meta = getFrameMeta();
      if (!meta) return;
      if (kind === 'desktop') {
        const res = await panelCall('desktopAct', {
          computer: meta.computer,
          includeFrame: true,
          settleMs: 50,
          ...opPayload,
        });
        if (res?.frame?.dataUrl) {
          state.desktopFrame = res.frame;
          renderDesktop();
          renderTopbar();
        } else {
          await queueCanvasFrameRefresh();
        }
      } else {
        const res = await panelCall('mobileAct', {
          computer: meta.computer,
          deviceId: meta.deviceId,
          includeFrame: true,
          settleMs: 70,
          ...opPayload,
        });
        if (res?.frame?.dataUrl) {
          state.mobileFrame = res.frame;
          renderMobile();
          renderTopbar();
        } else {
          await queueCanvasFrameRefresh();
        }
      }
    }

    toggleBtn.addEventListener('click', () => {
      void setInteractiveMode(kind, !state.interactive[kind]);
    });

    viewport.addEventListener('contextmenu', (e) => {
      if (state.interactive[kind]) e.preventDefault();
    });

    viewport.addEventListener('pointerdown', (e) => {
      if (!state.interactive[kind]) return;
      const pt = resolvePoint(e.clientX, e.clientY, false);
      if (!pt) return;
      e.preventDefault();
      viewport.focus();
      try { viewport.setPointerCapture(e.pointerId); } catch {}

      const g = {
        pointerId: e.pointerId,
        button: e.button,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPt: pt,
        lastPt: pt,
        moved: false,
        longPressed: false,
        holdTimer: null,
      };

      if (kind === 'mobile' && e.button === 0) {
        g.holdTimer = setTimeout(() => {
          if (!gesture || gesture !== g || g.moved) return;
          g.longPressed = true;
          spawnRipple(fxLayer, pt.localX, pt.localY, 'hold');
          void dispatchCanvasOp({
            op: 'longPress',
            x: pt.x,
            y: pt.y,
            durationMs: 650,
          });
        }, 520);
      }
      gesture = g;
    });

    viewport.addEventListener('pointermove', (e) => {
      if (!state.interactive[kind]) return;
      const hoverPt = resolvePoint(e.clientX, e.clientY, Boolean(gesture));
      if (hoverPt) {
        badgeEl.dataset.hovering = '1';
        badgeEl.textContent = `${hoverPt.x}, ${hoverPt.y}`;
      }
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const dist = Math.hypot(e.clientX - gesture.startClientX, e.clientY - gesture.startClientY);
      if (dist > 7) {
        gesture.moved = true;
        if (gesture.holdTimer) {
          clearTimeout(gesture.holdTimer);
          gesture.holdTimer = null;
        }
      }
      if (gesture.moved && hoverPt && !gesture.longPressed) {
        gesture.lastPt = hoverPt;
        drawVectorTrail(svgEl, gesture.startPt.localX, gesture.startPt.localY, hoverPt.localX, hoverPt.localY);
      }
    });

    viewport.addEventListener('pointerleave', () => {
      delete badgeEl.dataset.hovering;
      const meta = getFrameMeta();
      if (meta) badgeEl.textContent = `${meta.width}×${meta.height}`;
    });

    viewport.addEventListener('pointerup', (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const g = gesture;
      gesture = null;
      if (g.holdTimer) clearTimeout(g.holdTimer);
      try { viewport.releasePointerCapture(e.pointerId); } catch {}
      if (g.longPressed) return;

      const endPt = resolvePoint(e.clientX, e.clientY, true) || g.lastPt;
      if (g.moved) {
        clearVectorTrail(svgEl, 240);
        spawnRipple(fxLayer, endPt.localX, endPt.localY, 'tap');
        if (kind === 'desktop') {
          const btnName = g.button === 2 ? 'right' : (g.button === 1 ? 'middle' : 'left');
          void dispatchCanvasOp({
            op: 'drag',
            x1: g.startPt.x,
            y1: g.startPt.y,
            x2: endPt.x,
            y2: endPt.y,
            button: btnName,
          });
        } else {
          void dispatchCanvasOp({
            op: 'swipe',
            x1: g.startPt.x,
            y1: g.startPt.y,
            x2: endPt.x,
            y2: endPt.y,
            durationMs: 280,
          });
        }
        return;
      }

      if (kind === 'mobile') {
        spawnRipple(fxLayer, endPt.localX, endPt.localY, 'tap');
        void dispatchCanvasOp({ op: 'tap', x: endPt.x, y: endPt.y });
        return;
      }

      if (g.button === 2) {
        spawnRipple(fxLayer, endPt.localX, endPt.localY, 'hold');
        void dispatchCanvasOp({ op: 'click', x: endPt.x, y: endPt.y, button: 'right', count: 1 });
        return;
      }
      if (g.button === 1) {
        spawnRipple(fxLayer, endPt.localX, endPt.localY, 'tap');
        void dispatchCanvasOp({ op: 'click', x: endPt.x, y: endPt.y, button: 'middle', count: 1 });
        return;
      }

      const now = Date.now();
      if (
        pendingSingleClick &&
        now - pendingSingleClick.ts <= 240 &&
        Math.hypot(e.clientX - pendingSingleClick.clientX, e.clientY - pendingSingleClick.clientY) <= 10
      ) {
        clearTimeout(pendingSingleClick.timer);
        pendingSingleClick = null;
        spawnRipple(fxLayer, endPt.localX, endPt.localY, 'double');
        void dispatchCanvasOp({ op: 'click', x: endPt.x, y: endPt.y, button: 'left', count: 2 });
        return;
      }

      spawnRipple(fxLayer, endPt.localX, endPt.localY, 'tap');
      const timer = setTimeout(() => {
        pendingSingleClick = null;
        void dispatchCanvasOp({ op: 'click', x: endPt.x, y: endPt.y, button: 'left', count: 1 });
      }, 190);
      pendingSingleClick = { ts: now, clientX: e.clientX, clientY: e.clientY, pt: endPt, timer };
    });

    viewport.addEventListener('dblclick', (e) => {
      if (!state.interactive[kind] || kind !== 'desktop') return;
      const pt = resolvePoint(e.clientX, e.clientY, false);
      if (!pt) return;
      if (pendingSingleClick) {
        clearTimeout(pendingSingleClick.timer);
        pendingSingleClick = null;
        spawnRipple(fxLayer, pt.localX, pt.localY, 'double');
        void dispatchCanvasOp({ op: 'click', x: pt.x, y: pt.y, button: 'left', count: 2 });
      }
    });

    viewport.addEventListener('wheel', (e) => {
      if (!state.interactive[kind]) return;
      const pt = resolvePoint(e.clientX, e.clientY, false);
      if (!pt) return;
      e.preventDefault();
      wheelAccum.dx += e.deltaX;
      wheelAccum.dy += e.deltaY;
      wheelAccum.pt = pt;
      if (!wheelAccum.timer) {
        spawnRipple(fxLayer, pt.localX, pt.localY, 'scroll');
        wheelAccum.timer = setTimeout(() => {
          const { dx, dy, pt: origin } = wheelAccum;
          wheelAccum = { dx: 0, dy: 0, pt: null, timer: null };
          const meta = getFrameMeta();
          if (!origin || !meta) return;
          if (kind === 'desktop') {
            void dispatchCanvasOp({
              op: 'scroll',
              x: origin.x,
              y: origin.y,
              dx: Math.round(dx),
              dy: Math.round(dy),
            });
          } else {
            void dispatchCanvasOp({
              op: 'scroll',
              x: origin.x,
              y: origin.y,
              dx: Math.round(dx * 1.35),
              dy: Math.round(dy * 1.35),
              screenWidth: meta.width,
              screenHeight: meta.height,
            });
          }
        }, 90);
      }
    }, { passive: false });

    function flushTypedChars() {
      if (typeTimer) {
        clearTimeout(typeTimer);
        typeTimer = null;
      }
      if (!typeBuffer) return;
      const text = typeBuffer;
      typeBuffer = '';
      void dispatchCanvasOp({ op: 'type', text });
    }

    viewport.addEventListener('paste', (e) => {
      if (!state.interactive[kind]) return;
      const pasted = e.clipboardData?.getData('text/plain') || '';
      if (!pasted) return;
      e.preventDefault();
      flushTypedChars();
      void dispatchCanvasOp({ op: 'paste', text: pasted });
    });

    viewport.addEventListener('keydown', (e) => {
      if (!state.interactive[kind]) return;
      if (e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        void setInteractiveMode(kind, false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && e.key !== ' ') {
        e.preventDefault();
        e.stopPropagation();
        typeBuffer += e.key;
        if (typeTimer) clearTimeout(typeTimer);
        typeTimer = setTimeout(flushTypedChars, 110);
        return;
      }

      const combo = mapDesktopKeyCombo(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      flushTypedChars();
      if (kind === 'desktop') {
        void dispatchCanvasOp({ op: 'key', keys: combo });
      } else if (combo === 'enter' || combo === 'escape' || combo === 'backspace') {
        void dispatchCanvasOp({ op: 'key', key: combo === 'escape' ? 'back' : combo });
      } else if (combo === 'space') {
        void dispatchCanvasOp({ op: 'type', text: ' ' });
      }
    });

    async function sendInlineText() {
      const val = textInput.value;
      if (val) {
        textInput.value = '';
        persistDraft(kind === 'desktop' ? 'deskText' : 'mobText', '');
        await dispatchCanvasOp({ op: 'type', text: val });
        return;
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          const clip = await navigator.clipboard.readText();
          if (clip) {
            await dispatchCanvasOp({ op: 'paste', text: clip });
          }
        }
      } catch {}
    }

    sendBtn.addEventListener('click', () => void sendInlineText());
    textInput.addEventListener('input', () => {
      persistDraft(kind === 'desktop' ? 'deskText' : 'mobText', textInput.value);
    });
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void sendInlineText();
      }
    });
  }

  async function openPinModal() {
    const backdrop = document.getElementById('pinModalBackdrop');
    const listEl = document.getElementById('pinList');
    backdrop.hidden = false;
    listEl.innerHTML = `<div class="pin-group-label">Loading remote targets...</div>`;
    try {
      const res = await panelCall('state', { includeUnmanaged: true });
      const un = res.unmanaged || { seats: [], desktops: [], mobiles: [] };

      const groups = [];
      if (un.seats.length) {
        groups.push(`<div class="pin-group-label">Coding Seats</div>` + un.seats.map((s) => `
          <div class="pin-item">
            <div class="pin-item-meta">
              <span>${escapeHtml(s.title)} (${escapeHtml(s.agent)})</span>
              <span class="pin-item-sub">${escapeHtml(s.seatRef)} · ${escapeHtml(s.status)}</span>
            </div>
            <button class="btn btn-compact ${s.leased ? 'btn-pinned' : 'btn-primary'}" type="button" data-pin-seat="${escapeHtml(s.seatRef)}" data-pin-title="${escapeHtml(s.title)}" data-pin-agent="${escapeHtml(s.agent)}" data-leased="${s.leased ? '1' : '0'}">${s.leased ? 'Pinned' : 'Pin'}</button>
          </div>
        `).join(''));
      }
      if (un.desktops.length) {
        groups.push(`<div class="pin-group-label">Remote Desktops</div>` + un.desktops.map((d) => `
          <div class="pin-item">
            <div class="pin-item-meta">
              <span>${escapeHtml(d.computerName)}</span>
              <span class="pin-item-sub">v42:${escapeHtml(d.computerId)}:desktop</span>
            </div>
            <button class="btn btn-compact ${d.leased ? 'btn-pinned' : 'btn-primary'}" type="button" data-pin-desktop="${escapeHtml(d.computerId)}" data-pin-title="${escapeHtml(d.computerName)}" data-leased="${d.leased ? '1' : '0'}">${d.leased ? 'Pinned' : 'Pin'}</button>
          </div>
        `).join(''));
      }
      if (un.mobiles.length) {
        groups.push(`<div class="pin-group-label">Mobile Devices</div>` + un.mobiles.map((m) => `
          <div class="pin-item">
            <div class="pin-item-meta">
              <span>${escapeHtml(m.name)}</span>
              <span class="pin-item-sub">v42:${escapeHtml(m.computerId)}:mobile:${escapeHtml(m.deviceId)}</span>
            </div>
            <button class="btn btn-compact ${m.leased ? 'btn-pinned' : 'btn-primary'}" type="button" data-pin-mobile-comp="${escapeHtml(m.computerId)}" data-pin-mobile-dev="${escapeHtml(m.deviceId)}" data-pin-title="${escapeHtml(m.name)}" data-leased="${m.leased ? '1' : '0'}">${m.leased ? 'Pinned' : 'Pin'}</button>
          </div>
        `).join(''));
      }
      listEl.innerHTML = groups.join('') || `<div class="pin-group-label">No online targets discovered.</div>`;
    } catch (err) {
      listEl.innerHTML = `<div class="pin-group-label">${escapeHtml(err.message)}</div>`;
    }
  }

  function flashCopiedButton(btn, restoreLabel = null) {
    if (!btn) return;
    const prevHtml = btn.innerHTML;
    btn.classList.add('copied');
    if (restoreLabel !== null) {
      btn.textContent = 'Copied';
    }
    setTimeout(() => {
      btn.classList.remove('copied');
      if (restoreLabel !== null) btn.textContent = restoreLabel;
      else btn.innerHTML = prevHtml;
    }, 1200);
  }

  function bindEvents() {
    document.getElementById('leasedTargetSelect').addEventListener('change', (e) => {
      saveCurrentSurfaceState();
      state.selectedValue = e.target.value;
      safeStorage.set('v42.selectedTarget', state.selectedValue);
      state.termHistoryCursor = -1;
      if (state.selectedValue.startsWith('desktop:')) state.surface = 'desktop';
      else if (state.selectedValue.startsWith('mobile:')) state.surface = 'mobile';
      else if (state.selectedValue.startsWith('seat:') && state.surface !== 'terminal') state.surface = 'chat';
      safeStorage.set('v42.surface', state.surface);
      restoreDraftInputs();
      void refreshActiveSurface();
    });

    for (const btn of document.querySelectorAll('.seg-btn')) {
      btn.addEventListener('click', () => {
        switchSurface(btn.dataset.surface);
      });
    }

    document.getElementById('termQuickSwitchBtn').addEventListener('click', () => {
      switchSurface('terminal', { focusTarget: 'terminalInput' });
    });
    document.getElementById('termBackChatBtn').addEventListener('click', () => {
      switchSurface('chat', { focusTarget: 'chatInput' });
    });

    document.addEventListener('keydown', (e) => {
      const keyLower = e.key.toLowerCase();
      if (((e.ctrlKey || e.metaKey) && !e.altKey && keyLower === 'e')) {
        e.preventDefault();
        if (state.surface === 'terminal') {
          switchSurface('chat', { focusTarget: 'chatInput' });
        } else {
          switchSurface('terminal', { focusTarget: 'terminalInput' });
        }
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && keyLower === 'i') {
        if (state.surface === 'desktop' || state.surface === 'mobile') {
          e.preventDefault();
          void setInteractiveMode(state.surface, !state.interactive[state.surface]);
        }
        return;
      }
      if (e.key === 'Escape' && !document.getElementById('pinModalBackdrop').hidden) {
        document.getElementById('pinModalBackdrop').hidden = true;
      }
    });

    document.getElementById('fleetClearFilterBtn')?.addEventListener('click', () => {
      state.fleetComputerFilter = '';
      state.fleetShowAllWs = false;
      state.fleetShowAllSeats = false;
      renderFleet();
    });
    document.getElementById('fleetPinBtn')?.addEventListener('click', () => void openPinModal());

    document.getElementById('fleetBody')?.addEventListener('click', async (e) => {
      const expandBtn = e.target.closest('button[data-fleet-expand]');
      if (expandBtn) {
        if (expandBtn.dataset.fleetExpand === 'ws') state.fleetShowAllWs = true;
        if (expandBtn.dataset.fleetExpand === 'seats') state.fleetShowAllSeats = true;
        renderFleet();
        return;
      }

      const openSeatBtn = e.target.closest('button[data-fleet-open-seat]');
      if (openSeatBtn) {
        state.selectedValue = `seat:${openSeatBtn.dataset.fleetOpenSeat}`;
        safeStorage.set('v42.selectedTarget', state.selectedValue);
        switchSurface('chat');
        return;
      }

      const pinSeatBtn = e.target.closest('button[data-fleet-pin-seat]');
      if (pinSeatBtn) {
        pinSeatBtn.disabled = true;
        await panelCall('pin', {
          seatRef: pinSeatBtn.dataset.fleetPinSeat,
          title: pinSeatBtn.dataset.fleetSeatTitle,
          agent: pinSeatBtn.dataset.fleetSeatAgent,
        });
        state.selectedValue = `seat:${pinSeatBtn.dataset.fleetPinSeat}`;
        safeStorage.set('v42.selectedTarget', state.selectedValue);
        state.surface = 'chat';
        safeStorage.set('v42.surface', 'chat');
        await refreshState();
        return;
      }

      const deskBtn = e.target.closest('button[data-fleet-desktop]');
      if (deskBtn) {
        e.stopPropagation();
        const compId = deskBtn.dataset.fleetDesktop;
        const compName = deskBtn.dataset.fleetCompName || compId;
        await panelCall('pin', { kind: 'desktop', computer: compId, title: compName });
        state.selectedValue = `desktop:${compId}`;
        safeStorage.set('v42.selectedTarget', state.selectedValue);
        state.surface = 'desktop';
        safeStorage.set('v42.surface', 'desktop');
        await refreshState();
        return;
      }

      const portsBtn = e.target.closest('button[data-fleet-ports]');
      if (portsBtn) {
        e.stopPropagation();
        const compSelect = document.getElementById('portComputerSelect');
        if (compSelect) compSelect.value = portsBtn.dataset.fleetPorts;
        switchSurface('ports', { focusTarget: 'remotePortInput' });
        return;
      }

      const previewPortBtn = e.target.closest('button[data-fleet-preview-port]');
      if (previewPortBtn) {
        state.previewLocalPort = Number(previewPortBtn.dataset.fleetPreviewPort);
        switchSurface('ports');
        return;
      }

      const copyUrlBtn = e.target.closest('button[data-fleet-copy-url]');
      if (copyUrlBtn) {
        if (await copyTextSafe(copyUrlBtn.dataset.fleetCopyUrl)) {
          flashCopiedButton(copyUrlBtn, 'Copy');
        }
        return;
      }

      const stopPortBtn = e.target.closest('button[data-fleet-stop-port]');
      if (stopPortBtn) {
        stopPortBtn.disabled = true;
        await panelCall('forwardStop', {
          computer: stopPortBtn.dataset.fleetStopComp,
          localPort: Number(stopPortBtn.dataset.fleetStopPort),
        });
        await refreshState();
        return;
      }

      const compTile = e.target.closest('[data-fleet-comp]');
      if (compTile) {
        const compId = compTile.dataset.fleetComp;
        state.fleetComputerFilter = state.fleetComputerFilter === compId ? '' : compId;
        state.fleetShowAllWs = false;
        state.fleetShowAllSeats = false;
        renderFleet();
      }
    });

    document.querySelector('.stage').addEventListener('click', (e) => {
      const actBtn = e.target.closest('button[data-empty-action]');
      if (!actBtn) return;
      if (actBtn.dataset.emptyAction === 'pin') void openPinModal();
      else if (actBtn.dataset.emptyAction === 'retry') void refreshState();
    });

    document.getElementById('pinOpenBtn').addEventListener('click', () => void openPinModal());
    document.getElementById('pinCloseBtn').addEventListener('click', () => {
      document.getElementById('pinModalBackdrop').hidden = true;
    });
    document.getElementById('pinModalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'pinModalBackdrop') e.target.hidden = true;
    });

    document.getElementById('pinList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.dataset.leased === '1') return;
      btn.disabled = true;
      if (btn.dataset.pinSeat) {
        await panelCall('pin', { seatRef: btn.dataset.pinSeat, title: btn.dataset.pinTitle, agent: btn.dataset.pinAgent });
        state.selectedValue = `seat:${btn.dataset.pinSeat}`;
        state.surface = 'chat';
      } else if (btn.dataset.pinDesktop) {
        await panelCall('pin', { kind: 'desktop', computer: btn.dataset.pinDesktop, title: btn.dataset.pinTitle });
        state.selectedValue = `desktop:${btn.dataset.pinDesktop}`;
        state.surface = 'desktop';
      } else if (btn.dataset.pinMobileComp) {
        await panelCall('pin', {
          kind: 'mobile',
          computer: btn.dataset.pinMobileComp,
          deviceId: btn.dataset.pinMobileDev,
          title: btn.dataset.pinTitle,
        });
        state.selectedValue = `mobile:${btn.dataset.pinMobileComp}:${btn.dataset.pinMobileDev}`;
        state.surface = 'mobile';
      }
      safeStorage.set('v42.selectedTarget', state.selectedValue);
      safeStorage.set('v42.surface', state.surface);
      document.getElementById('pinModalBackdrop').hidden = true;
      await refreshState();
    });

    document.getElementById('unpinBtn').addEventListener('click', async () => {
      const target = currentTargetObject();
      if (!target) return;
      if (target.kind === 'seat') await panelCall('unpin', { seatRef: target.seatRef });
      if (target.kind === 'desktop') {
        state.interactive.desktop = false;
        await panelCall('unpin', { kind: 'desktop', computer: target.computer });
      }
      if (target.kind === 'mobile') {
        state.interactive.mobile = false;
        await panelCall('unpin', { kind: 'mobile', computer: target.computer, deviceId: target.deviceId });
      }
      state.selectedValue = '';
      safeStorage.remove('v42.selectedTarget');
      await refreshState();
    });

    document.getElementById('takeoverPill').addEventListener('click', async () => {
      const tk = activeTakeover();
      state.interactive.desktop = false;
      state.interactive.mobile = false;
      if (tk) {
        await panelCall('takeover', { targetKey: tk.key, active: false, reason: 'hand_back' });
      }
      await refreshState();
    });

    document.getElementById('refreshBtn').addEventListener('click', () => void refreshState());

    const chatScroll = document.getElementById('chatScroll');
    chatScroll.addEventListener('scroll', () => {
      state.scrollTopBySurface.chat = chatScroll.scrollTop;
      state.chatStickBottom = (chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight) <= 28;
    });

    const chatInput = document.getElementById('chatInput');
    chatInput.addEventListener('input', () => {
      persistDraft(`chat:${state.selectedValue || '_global'}`, chatInput.value);
    });
    const sendChat = async () => {
      const text = chatInput.value.trim();
      const target = currentTargetObject();
      if (!text || target?.kind !== 'seat') return;
      chatInput.value = '';
      persistDraft(`chat:${state.selectedValue || '_global'}`, '');
      state.chatStickBottom = true;
      await panelCall('humanSeatSend', { seatRef: target.seatRef, text });
      await refreshActiveSurface();
    };
    document.getElementById('chatSendBtn').addEventListener('click', () => void sendChat());
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendChat();
      }
    });

    document.getElementById('allowOnceBtn').addEventListener('click', async () => {
      const target = currentTargetObject();
      const pend = state.seatView?.envelope?.pending;
      if (target?.kind !== 'seat' || !pend) return;
      await panelCall('humanApprovePending', { seatRef: target.seatRef, pendingId: pend.id, decision: 'allow_once' });
      await refreshActiveSurface();
    });
    document.getElementById('denyBtn').addEventListener('click', async () => {
      const target = currentTargetObject();
      const pend = state.seatView?.envelope?.pending;
      if (target?.kind !== 'seat' || !pend) return;
      await panelCall('humanApprovePending', { seatRef: target.seatRef, pendingId: pend.id, decision: 'deny' });
      await refreshActiveSurface();
    });

    /* Terminal scroll lock, copy, and history navigation */
    const termScreen = document.getElementById('terminalScreen');
    const followBtn = document.getElementById('termFollowBtn');
    termScreen.addEventListener('scroll', () => {
      state.scrollTopBySurface.terminal = termScreen.scrollTop;
      const nearBottom = (termScreen.scrollHeight - termScreen.scrollTop - termScreen.clientHeight) <= 24;
      state.termStickBottom = nearBottom;
      followBtn.hidden = nearBottom;
    });
    followBtn.addEventListener('click', () => {
      state.termStickBottom = true;
      termScreen.scrollTop = termScreen.scrollHeight;
      followBtn.hidden = true;
    });

    document.getElementById('termCopyBtn').addEventListener('click', async () => {
      const ok = await copyTextSafe(termScreen.textContent || '');
      if (ok) {
        const lbl = document.getElementById('termCopyLabel');
        lbl.textContent = 'Copied';
        setTimeout(() => { lbl.textContent = 'Copy'; }, 1200);
      }
    });

    const termInput = document.getElementById('terminalInput');
    termInput.addEventListener('input', () => {
      persistDraft(`term:${state.selectedValue || '_global'}`, termInput.value);
    });
    termInput.addEventListener('keydown', async (e) => {
      const target = currentTargetObject();
      const seatRef = target?.kind === 'seat' ? target.seatRef : '_default';
      if (e.key === 'ArrowUp') {
        const hist = getSeatHistory(seatRef);
        if (!hist.length) return;
        e.preventDefault();
        if (state.termHistoryCursor === -1) {
          state.termLiveDraft = termInput.value;
          state.termHistoryCursor = hist.length - 1;
        } else if (state.termHistoryCursor > 0) {
          state.termHistoryCursor -= 1;
        }
        termInput.value = hist[state.termHistoryCursor] || '';
        return;
      }
      if (e.key === 'ArrowDown') {
        const hist = getSeatHistory(seatRef);
        if (state.termHistoryCursor === -1) return;
        e.preventDefault();
        if (state.termHistoryCursor < hist.length - 1) {
          state.termHistoryCursor += 1;
          termInput.value = hist[state.termHistoryCursor] || '';
        } else {
          state.termHistoryCursor = -1;
          termInput.value = state.termLiveDraft || '';
        }
        return;
      }
      if (e.key === 'Enter') {
        if (target?.kind !== 'seat') return;
        const cmd = termInput.value;
        pushSeatHistory(target.seatRef, cmd);
        termInput.value = '';
        persistDraft(`term:${state.selectedValue || '_global'}`, '');
        state.termStickBottom = true;
        await panelCall('humanSeatSend', { seatRef: target.seatRef, text: cmd, enter: true });
        await refreshActiveSurface();
      }
    });
    document.getElementById('termInterruptBtn').addEventListener('click', async () => {
      const target = currentTargetObject();
      if (target?.kind !== 'seat') return;
      await panelCall('humanSeatSend', { seatRef: target.seatRef, keys: ['ctrl+c'], enter: false });
      await refreshActiveSurface();
    });

    /* Desktop & Mobile Direct Interactive Canvases */
    bindInteractiveCanvas({
      kind: 'desktop',
      viewportId: 'desktopViewport',
      imgId: 'desktopImg',
      svgId: 'desktopTrailSvg',
      fxId: 'desktopFxLayer',
      badgeId: 'desktopCoordBadge',
      toggleBtnId: 'desktopInteractiveBtn',
      textInputId: 'desktopTextInput',
      sendBtnId: 'desktopPasteSendBtn',
    });

    bindInteractiveCanvas({
      kind: 'mobile',
      viewportId: 'mobileViewport',
      imgId: 'mobileImg',
      svgId: 'mobileTrailSvg',
      fxId: 'mobileFxLayer',
      badgeId: 'mobileCoordBadge',
      toggleBtnId: 'mobileInteractiveBtn',
      textInputId: 'mobileTextInput',
      sendBtnId: 'mobilePasteSendBtn',
    });

    for (const hwBtn of document.querySelectorAll('[data-mob-key], [data-mob-op]')) {
      hwBtn.addEventListener('click', async () => {
        if (!state.mobileFrame) return;
        const op = hwBtn.dataset.mobOp || 'key';
        const res = await panelCall('mobileAct', {
          computer: state.mobileFrame.computer,
          deviceId: state.mobileFrame.deviceId,
          op,
          key: hwBtn.dataset.mobKey,
          includeFrame: true,
          settleMs: 70,
        });
        if (res?.frame?.dataUrl) {
          state.mobileFrame = res.frame;
          renderMobile();
          renderTopbar();
        } else {
          await queueCanvasFrameRefresh();
        }
      });
    }

    /* Ports Surface */
    const startForward = async () => {
      const computer = document.getElementById('portComputerSelect').value;
      const remotePort = Number(document.getElementById('remotePortInput').value);
      const localPortRaw = document.getElementById('localPortInput').value.trim();
      if (!computer || !remotePort) {
        setPortNotice('Select an online Computer and enter a remote TCP port (1–65535).', true);
        return;
      }
      setPortNotice('');
      try {
        const created = await panelCall('forwardStart', {
          computer,
          remotePort,
          localPort: localPortRaw ? Number(localPortRaw) : undefined,
        });
        const lp = created?.tunnel?.localPort || created?.localPort;
        if (lp) {
          state.previewLocalPort = Number(lp);
        }
        document.getElementById('remotePortInput').value = '';
        document.getElementById('localPortInput').value = '';
        persistDraft('remotePort', '');
        persistDraft('localPort', '');
        await refreshState();
      } catch (err) {
        setPortNotice(err.message, true);
      }
    };

    document.getElementById('portStartBtn').addEventListener('click', () => void startForward());
    for (const id of ['remotePortInput', 'localPortInput']) {
      const el = document.getElementById(id);
      el.addEventListener('input', () => {
        persistDraft(id === 'remotePortInput' ? 'remotePort' : 'localPort', el.value);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void startForward();
        }
      });
    }

    document.getElementById('portsTbody').addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('button[data-copy-url]');
      if (copyBtn) {
        if (await copyTextSafe(copyBtn.dataset.copyUrl)) {
          flashCopiedButton(copyBtn, 'Copy');
        }
        return;
      }

      const pinBtn = e.target.closest('button[data-pin-forward-comp]');
      if (pinBtn) {
        const comp = pinBtn.dataset.pinForwardComp;
        const remotePort = Number(pinBtn.dataset.pinForwardRemote);
        const localPort = Number(pinBtn.dataset.pinForwardLocal);
        const wasPinned = pinBtn.dataset.pinned === '1';
        pinBtn.disabled = true;
        pinBtn.textContent = wasPinned ? '+ Pin' : 'Pinned';
        pinBtn.classList.toggle('btn-pinned', !wasPinned);
        try {
          await panelCall(wasPinned ? 'unpin' : 'pin', {
            kind: 'forward',
            computer: comp,
            remotePort,
            localPort,
          });
          if (!wasPinned) {
            state.previewLocalPort = localPort;
          }
          await refreshState();
        } catch (err) {
          setPortNotice(err.message, true);
          await refreshState();
        }
        return;
      }

      const previewBtn = e.target.closest('button[data-preview-local]');
      if (previewBtn) {
        const lp = Number(previewBtn.dataset.previewLocal);
        state.previewLocalPort = Number(state.previewLocalPort) === lp ? null : lp;
        renderPorts();
        return;
      }

      const extBtn = e.target.closest('button[data-open-external]');
      if (extBtn) {
        try {
          await bridgeCall('plugin.openExternal', { url: extBtn.dataset.openExternal });
        } catch (err) {
          setPortNotice(err.message, true);
        }
        return;
      }

      const stopBtn = e.target.closest('button[data-stop-local]');
      if (!stopBtn) return;
      stopBtn.disabled = true;
      await panelCall('forwardStop', {
        computer: stopBtn.dataset.stopComp,
        localPort: Number(stopBtn.dataset.stopLocal),
      });
      await refreshState();
    });

    document.getElementById('portPreviewPath').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        updatePortPreviewFrame(true);
      }
    });
    document.getElementById('portPreviewCopyBtn').addEventListener('click', async (e) => {
      if (!state.previewLocalPort) return;
      const { url } = buildPreviewUrl(state.previewLocalPort, document.getElementById('portPreviewPath').value);
      if (await copyTextSafe(url)) {
        flashCopiedButton(e.currentTarget, null);
      }
    });
    document.getElementById('portPreviewReloadBtn').addEventListener('click', () => {
      updatePortPreviewFrame(true);
    });
    document.getElementById('portPreviewExternalBtn').addEventListener('click', async () => {
      if (!state.previewLocalPort) return;
      const { url } = buildPreviewUrl(state.previewLocalPort, document.getElementById('portPreviewPath').value);
      try {
        await bridgeCall('plugin.openExternal', { url });
      } catch (err) {
        setPortNotice(err.message, true);
      }
    });
    document.getElementById('portPreviewCloseBtn').addEventListener('click', () => {
      state.previewLocalPort = null;
      renderPorts();
    });

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        if (state.surface === 'terminal' && state.termStickBottom) {
          termScreen.scrollTop = termScreen.scrollHeight;
        }
      });
      ro.observe(document.querySelector('.stage'));
    }

    window.addEventListener('pagehide', () => {
      if (state.streamHandle) {
        const handle = state.streamHandle;
        state.streamHandle = null;
        state.streamPort = null;
        try { handle.close(); } catch {}
      } else if (state.streamPort) {
        const port = state.streamPort;
        state.streamPort = null;
        try {
          port.postMessage({ __kikiStreamControl: 'close' });
          port.close();
        } catch {}
      }
      panelClient?.dispose?.();
    });
  }

  async function boot() {
    if (booted) return;
    booted = true;
    bindEvents();
    restoreDraftInputs();
    try {
      if (kit?.openManagedStream && panelClient && typeof window.__V42_DIRECT_RPC__ !== 'function') {
        state.streamHandle = await kit.openManagedStream(panelClient, 'workbench', {}, {
          openOpts: { timeoutMs: 2500 },
          onMessage: (raw) => {
            try {
              const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (msg?.type === 'lease_changed') void refreshState();
            } catch {}
          },
        });
        state.streamPort = state.streamHandle.port;
      } else {
        const { port } = await bridgeCall('plugin.openStream', { stream: 'workbench', args: {} }, 2500, true);
        if (port) {
          state.streamPort = port;
          port.onmessage = (ev) => {
            try {
              const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
              if (msg?.type === 'lease_changed') void refreshState();
            } catch {}
          };
        }
      }
    } catch {}
    await refreshState();
  }

  setTimeout(() => {
    if (!booted) void boot();
  }, 120);
})();
