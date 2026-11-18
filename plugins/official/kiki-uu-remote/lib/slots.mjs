export const KIKI_UU_REMOTE_PLUGIN_ID = 'kiki-uu-remote';

export function buildUuGuiSlots(pluginId = KIKI_UU_REMOTE_PLUGIN_ID, liveState = null) {
  const sessions = Array.isArray(liveState?.sessions) ? liveState.sessions : [];
  const activeSessions = sessions.filter((s) => s.state === 'active');
  const selectedSession = liveState?.selectedSessionId
    ? sessions.find((s) => s.id === liveState.selectedSessionId) || activeSessions[0]
    : activeSessions[0];

  const slots = [
    {
      slot: 'composer-toolbar',
      pluginId,
      id: 'uu-preview-toolbar',
      label: {
        default: 'UU Remote',
        en: 'UU Remote',
        zh: 'UU远程',
      },
      tooltip: {
        default: 'Open live NetEase UU Remote desktop preview in workspace',
        en: 'Open live NetEase UU Remote desktop preview in workspace',
        zh: '在右侧工作区打开 UU远程桌面实时预览与接管面板',
      },
      icon: 'monitor',
      tone: 'neutral',
      order: 36,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    },
    {
      slot: 'slash-command',
      pluginId,
      id: 'uu-preview-slash',
      icon: 'monitor',
      command: 'uu-remote',
      description: {
        default: 'Open the live NetEase UU Remote workspace preview tab',
        en: 'Open the live NetEase UU Remote workspace preview tab',
        zh: '打开网易 UU远程桌面实时预览标签页',
      },
      needsSession: false,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    },
    {
      slot: 'inspector-tab',
      pluginId,
      id: 'uu-preview-inspector',
      title: {
        default: 'UU Remote',
        en: 'UU Remote',
        zh: 'UU远程',
      },
      panelId: 'preview',
      icon: 'monitor',
      bridge: 'kiki.panel.v1',
      order: 41,
    },
    {
      slot: 'tool-card-renderer',
      pluginId,
      id: 'uu-tool-card',
      icon: 'monitor',
      toolNames: ['uu_status', 'uu_sessions', 'uu_control', 'uu_launch'],
      actionVerb: {
        default: 'UU Remote',
        en: 'UU Remote',
        zh: 'UU远程操控',
      },
      targetFieldPath: 'args.sessionId',
      summaryFields: [
        {
          label: { default: 'Session', en: 'Session', zh: '会话' },
          sourcePath: 'args.sessionId',
          format: 'code',
        },
        {
          label: { default: 'Action', en: 'Action', zh: '动作' },
          sourcePath: 'args.action',
          format: 'badge',
        },
        {
          label: { default: 'Device', en: 'Device', zh: '设备' },
          sourcePath: 'args.deviceId',
          format: 'code',
        },
      ],
      detailFields: [],
    },
  ];

  if (selectedSession) {
    const dims = selectedSession.contentRect?.width && selectedSession.contentRect?.height
      ? `${selectedSession.contentRect.width}×${selectedSession.contentRect.height}`
      : `${selectedSession.canvasBounds.width}×${selectedSession.canvasBounds.height}`;
    slots.push({
      slot: 'status-capsule',
      pluginId,
      id: 'uu-active-capsule',
      icon: 'monitor',
      label: {
        default: selectedSession.label,
        en: selectedSession.label,
        zh: selectedSession.label,
      },
      valueText: selectedSession.takeoverActive
        ? 'Takeover'
        : selectedSession.state === 'active'
          ? dims
          : selectedSession.state,
      dotTone: selectedSession.takeoverActive || selectedSession.state !== 'active' ? 'warn' : 'ok',
      order: 31,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    });
  }

  return slots;
}

export const UU_HTTP_ROUTES = [
  { method: 'GET', subpath: '/preview/state', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/frame', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/action', scopeAcl: 'session' },
];

export function createUuSlotHandlers(previewService, { pluginId = KIKI_UU_REMOTE_PLUGIN_ID } = {}) {
  return {
    async 'E5:prompt-context'(payload = {}, context = {}) {
      try {
        const state = await previewService.listState(
          { includeDevices: false },
          { ...context, settings: context?.settings ?? payload?.settings ?? {} },
        );
        if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
          return { sections: [] };
        }
        const summary = state.sessions
          .map((s) => {
            const w = s.contentRect?.width || s.canvasBounds.width;
            const h = s.contentRect?.height || s.canvasBounds.height;
            const flags = [
              s.state,
              `${w}x${h}`,
              s.takeoverActive ? 'takeover=human' : null,
              state.selectedSessionId === s.id ? 'selected' : null,
            ]
              .filter(Boolean)
              .join(', ');
            return `${s.label} (id=${s.id}, ${flags})`;
          })
          .join('; ');
        return {
          sections: [
            {
              id: 'uu-remote-sessions',
              title: 'UU Remote sessions',
              content: `Open UU Remote windows (${state.sessions.length}): ${summary}. Registered on kiki.cua.provider.v1 bus and controllable via uu_control or the UU Remote workspace tab.`,
            },
          ],
        };
      } catch {
        return { sections: [] };
      }
    },

    async 'E8:tool-pipeline'(payload = {}) {
      return { action: 'continue', args: payload?.args };
    },

    async 'E12:server-gui-slots'(payload = {}, context = {}) {
      const mergedCtx = { ...context, settings: context?.settings ?? payload?.settings ?? {} };
      const kind = payload?.kind ?? payload?.action ?? 'describe';

      if (kind === 'describe') {
        let liveState = null;
        try {
          liveState = await previewService.listState({ includeDevices: false }, mergedCtx);
        } catch {}
        return {
          guiSlots: buildUuGuiSlots(pluginId, liveState),
          routes: UU_HTTP_ROUTES,
        };
      }

      if (kind === 'http-route') {
        const subpath = String(payload.subpath || '').replace(/^\/+|\/+$/g, '');
        const body = payload.body && typeof payload.body === 'object' ? payload.body : {};
        if (subpath === 'preview/state' && payload.method === 'GET') {
          return { status: 200, data: await previewService.listState({}, mergedCtx) };
        }
        if (subpath === 'preview/frame' && payload.method === 'POST') {
          return { status: 200, data: await previewService.captureFrame(body, mergedCtx) };
        }
        if (subpath === 'preview/action' && payload.method === 'POST') {
          return { status: 200, data: await previewService.performAction(body, mergedCtx) };
        }
        return { status: 404, errorMessage: `Unknown UU Remote route: ${payload.method} /${subpath}` };
      }

      return {
        guiSlots: buildUuGuiSlots(pluginId),
        routes: UU_HTTP_ROUTES,
      };
    },
  };
}
