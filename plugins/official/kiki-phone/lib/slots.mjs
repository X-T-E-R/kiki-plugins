export const KIKI_PHONE_PLUGIN_ID = 'kiki-phone';

export function buildPhoneGuiSlots(pluginId = KIKI_PHONE_PLUGIN_ID, liveSummary = null) {
  const onlineCount = Array.isArray(liveSummary?.devices)
    ? liveSummary.devices.filter((d) => d.state === 'online').length
    : 0;
  const activeDevice = liveSummary?.selected
    ? liveSummary.devices?.find((d) => d.id === liveSummary.selected.id && d.platform === liveSummary.selected.platform)
    : undefined;

  const slots = [
    {
      slot: 'composer-toolbar',
      pluginId,
      id: 'phone-preview-toolbar',
      label: {
        default: 'Phone',
        en: 'Phone',
        zh: '手机预览',
      },
      tooltip: {
        default: 'Open live Android / iOS phone preview in workspace',
        en: 'Open live Android / iOS phone preview in workspace',
        zh: '在右侧预览区打开 Android / iOS 手机实时画面',
      },
      icon: 'smartphone',
      tone: 'neutral',
      order: 35,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    },
    {
      slot: 'slash-command',
      pluginId,
      id: 'phone-preview-slash',
      icon: 'smartphone',
      command: 'phone-preview',
      description: {
        default: 'Open the live Android & iOS phone preview workspace tab',
        en: 'Open the live Android & iOS phone preview workspace tab',
        zh: '打开 Android 与 iOS 手机实时预览标签页',
      },
      needsSession: false,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    },
    {
      slot: 'tool-card-renderer',
      pluginId,
      id: 'phone-tool-card',
      icon: 'smartphone',
      toolNames: ['phone_run', 'phone_prepare', 'android_connection', 'android_shell'],
      actionVerb: {
        default: 'Phone Control',
        en: 'Phone Control',
        zh: '手机操控',
      },
      targetFieldPath: 'args.device',
      summaryFields: [
        {
          label: { default: 'Platform', en: 'Platform', zh: '平台' },
          sourcePath: 'args.platform',
          format: 'badge',
        },
        {
          label: { default: 'Device', en: 'Device', zh: '设备' },
          sourcePath: 'args.device',
          format: 'code',
        },
        {
          label: { default: 'Action', en: 'Action', zh: '动作' },
          sourcePath: 'args.action',
          format: 'badge',
        },
      ],
      detailFields: [],
    },
  ];

  if (onlineCount > 0 && activeDevice) {
    slots.push({
      slot: 'status-capsule',
      pluginId,
      id: 'phone-online-capsule',
      icon: 'smartphone',
      label: {
        default: activeDevice.name,
        en: activeDevice.name,
        zh: activeDevice.name,
      },
      valueText: activeDevice.platform === 'ios' ? 'iOS' : 'Android',
      dotTone: 'ok',
      order: 30,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    });
  }

  return slots;
}

export const PHONE_HTTP_ROUTES = [
  { method: 'GET', subpath: '/preview/state', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/frame', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/tree', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/action', scopeAcl: 'session' },
];

export function createPhoneSlotHandlers(previewService, { pluginId = KIKI_PHONE_PLUGIN_ID } = {}) {
  const lastPromptByKey = new Map();
  return {
    async 'E5:prompt-context'(payload = {}, context = {}) {
      const settings = context.settings ?? payload?.settings ?? {};
      const cacheKey = String(settings?.adbPath ?? '');
      try {
        const state = typeof previewService.peekState === 'function'
          ? await previewService.peekState({ settings, maxAgeMs: 15_000 })
          : await previewService.listState({ settings, fast: true });
        if (state?.authoritative === false) {
          const prev = lastPromptByKey.get(cacheKey);
          return prev ? prev.result : { sections: [] };
        }
        const rankType = (t) => (t === 'real' ? 0 : 1);
        const online = (Array.isArray(state?.devices) ? state.devices : [])
          .filter((d) => d && d.state === 'online')
          .sort((a, b) =>
            rankType(a.type) - rankType(b.type)
            || String(a.name || a.id).localeCompare(String(b.name || b.id))
            || String(a.platform || '').localeCompare(String(b.platform || ''))
            || String(a.id || '').localeCompare(String(b.id || '')),
          );
        if (online.length === 0) {
          const empty = { sections: [] };
          lastPromptByKey.set(cacheKey, { content: '', result: empty });
          return empty;
        }
        const summary = online
          .map((d) => {
            const width = d.screenSize?.width ?? (d.platform === 'ios' ? 1179 : 1080);
            const height = d.screenSize?.height ?? (d.platform === 'ios' ? 2556 : 2400);
            const isSelected = state.selected?.id === d.id
              && (!state.selected?.platform || state.selected.platform === d.platform);
            return `${d.name} (${d.platform}, id=${d.id}, ${width}x${height}${isSelected ? ', selected' : ''})`;
          })
          .join('; ');
        const content = `Online devices (${online.length}): ${summary}. Users can also view and control the live screen in the Phone Preview workspace tab.`;
        const prev = lastPromptByKey.get(cacheKey);
        if (prev && prev.content === content) return prev.result;
        const result = {
          sections: [
            {
              id: 'connected-phones',
              title: 'Connected phones',
              content,
            },
          ],
        };
        lastPromptByKey.set(cacheKey, { content, result });
        return result;
      } catch {
        const prev = lastPromptByKey.get(cacheKey);
        return prev ? prev.result : { sections: [] };
      }
    },

    async 'E8:tool-pipeline'(payload = {}) {
      return { action: 'continue', args: payload?.args };
    },

    async 'E12:server-gui-slots'(payload = {}, context = {}) {
      const settings = context.settings ?? payload?.settings ?? {};
      const kind = payload?.kind ?? payload?.action ?? 'describe';

      if (kind === 'describe') {
        let liveSummary = null;
        try {
          liveSummary = typeof previewService.peekState === 'function'
            ? await previewService.peekState({ settings, maxAgeMs: 15_000 })
            : await previewService.listState({ settings, fast: true });
        } catch {}
        return {
          guiSlots: buildPhoneGuiSlots(pluginId, liveSummary),
          routes: PHONE_HTTP_ROUTES,
        };
      }

      if (kind === 'http-route') {
        const subpath = String(payload.subpath || '').replace(/^\/+|\/+$/g, '');
        const body = payload.body && typeof payload.body === 'object' ? payload.body : {};
        if (subpath === 'preview/state' && payload.method === 'GET') {
          return { status: 200, data: await previewService.listState({ settings }) };
        }
        if (subpath === 'preview/frame' && payload.method === 'POST') {
          return { status: 200, data: await previewService.captureFrame({ ...body, settings }) };
        }
        if (subpath === 'preview/tree' && payload.method === 'POST') {
          return { status: 200, data: await previewService.inspectHierarchy({ ...body, settings }) };
        }
        if (subpath === 'preview/action' && payload.method === 'POST') {
          return { status: 200, data: await previewService.performAction(body, { settings }) };
        }
        return { status: 404, errorMessage: `Unknown phone route: ${payload.method} /${subpath}` };
      }

      return {
        guiSlots: buildPhoneGuiSlots(pluginId),
        routes: PHONE_HTTP_ROUTES,
      };
    },
  };
}
