export const KIKI_CUA_PLUGIN_ID = 'kiki-cua';

export function buildCuaGuiSlots(pluginId = KIKI_CUA_PLUGIN_ID, liveSummary = null) {
  const targets = Array.isArray(liveSummary?.targets) ? liveSummary.targets : [];
  const selectedId = liveSummary?.selectedTargetId || 'local:primary';
  const activeTarget = targets.find((t) => t.id === selectedId) || targets[0];
  const takeover = Boolean(activeTarget?.takeoverActive);

  const slots = [
    {
      slot: 'composer-toolbar',
      pluginId,
      id: 'cua-preview-toolbar',
      label: {
        default: 'Computer',
        en: 'Computer',
        zh: '电脑预览',
      },
      tooltip: {
        default: 'Open live desktop & remote computer-use preview in workspace',
        en: 'Open live desktop & remote computer-use preview in workspace',
        zh: '在工作区打开桌面与跨设备远控实时画面及接管控制',
      },
      icon: 'monitor',
      tone: takeover ? 'warning' : 'neutral',
      order: 36,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    },
    {
      slot: 'slash-command',
      pluginId,
      id: 'cua-preview-slash',
      icon: 'monitor',
      command: 'cua-preview',
      description: {
        default: 'Open the live Computer Preview workspace tab',
        en: 'Open the live Computer Preview workspace tab',
        zh: '打开电脑与远控实时预览工作区面板',
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
      id: 'cua-tool-card',
      icon: 'monitor',
      toolNames: ['cua_targets', 'cua_observe', 'cua_act', 'cua_windows'],
      actionVerb: {
        default: 'Computer Use',
        en: 'Computer Use',
        zh: '电脑操控',
      },
      targetFieldPath: 'args.targetId',
      summaryFields: [
        {
          label: { default: 'Target', en: 'Target', zh: '目标' },
          sourcePath: 'args.targetId',
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

  if (activeTarget) {
    slots.push({
      slot: 'status-capsule',
      pluginId,
      id: 'cua-target-capsule',
      icon: 'monitor',
      label: {
        default: activeTarget.id,
        en: activeTarget.id,
        zh: activeTarget.id,
      },
      valueText: takeover ? 'Takeover' : `${activeTarget.dimensions?.width || 0}×${activeTarget.dimensions?.height || 0}`,
      dotTone: takeover ? 'warn' : 'ok',
      order: 31,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'preview',
      },
    });
  }

  return slots;
}

export const CUA_HTTP_ROUTES = [
  { method: 'GET', subpath: '/preview/state', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/frame', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/action', scopeAcl: 'session' },
  { method: 'POST', subpath: '/preview/takeover', scopeAcl: 'session' },
];

export function createCuaSlotHandlers(cuaService, { pluginId = KIKI_CUA_PLUGIN_ID } = {}) {
  return {
    async 'E5:prompt-context'(payload = {}, context = {}) {
      try {
        const inv = typeof cuaService.peekTargets === 'function'
          ? await cuaService.peekTargets({ context, maxAgeMs: 15_000, waitBudgetMs: 200 })
          : await cuaService.collectAllTargets({ context, fast: true });
        const remote = inv.targets.filter((t) => t.providerId !== 'local' && t.online !== false);
        const active = inv.targets.find((t) => t.id === inv.selectedTargetId);
        if (remote.length === 0 && !active?.takeoverActive) {
          return { sections: [] };
        }
        const parts = [`Selected target: ${inv.selectedTargetId}`];
        if (active?.takeoverActive) {
          parts.push('Human Takeover is ACTIVE on selected target (cua_act will pause until released)');
        }
        if (remote.length > 0) {
          parts.push(`Remote CUA targets (${remote.length}): ${remote.map((t) => `${t.id} (${t.label}, ${t.dimensions?.width}x${t.dimensions?.height})`).join('; ')}`);
        }
        return {
          sections: [
            {
              id: 'cua-targets-context',
              title: 'Computer Use targets',
              content: parts.join('. ') + '.',
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
      const kind = payload?.kind ?? payload?.action ?? 'describe';

      if (kind === 'describe') {
        let liveSummary = null;
        try {
          liveSummary = typeof cuaService.peekTargets === 'function'
            ? await cuaService.peekTargets({ context, maxAgeMs: 15_000, waitBudgetMs: 200 })
            : await cuaService.collectAllTargets({ context, fast: true });
        } catch {}
        return {
          guiSlots: buildCuaGuiSlots(pluginId, liveSummary),
          routes: CUA_HTTP_ROUTES,
        };
      }

      if (kind === 'http-route') {
        const subpath = String(payload.subpath || '').replace(/^\/+|\/+$/g, '');
        const body = payload.body && typeof payload.body === 'object' ? payload.body : {};
        if (subpath === 'preview/state' && payload.method === 'GET') {
          return { status: 200, data: await cuaService.handlePanelRequest('state', { fast: true }, context) };
        }
        if (subpath === 'preview/frame' && payload.method === 'POST') {
          return { status: 200, data: await cuaService.handlePanelRequest('frame', body, context) };
        }
        if (subpath === 'preview/action' && payload.method === 'POST') {
          return { status: 200, data: await cuaService.handlePanelRequest('action', body, context) };
        }
        if (subpath === 'preview/takeover' && payload.method === 'POST') {
          return { status: 200, data: await cuaService.handlePanelRequest('takeover', body, context) };
        }
        return { status: 404, errorMessage: `Unknown CUA route: ${payload.method} /${subpath}` };
      }

      return {
        guiSlots: buildCuaGuiSlots(pluginId),
        routes: CUA_HTTP_ROUTES,
      };
    },
  };
}
