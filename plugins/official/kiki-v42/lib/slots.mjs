export const KIKI_V42_PLUGIN_ID = 'kiki-v42';

export function buildV42GuiSlots(pluginId = KIKI_V42_PLUGIN_ID, managedSummary = null) {
  const counts = managedSummary?.counts || {
    totalManaged: 0,
    seats: 0,
    working: 0,
    blocked: 0,
    humanControlling: 0,
  };

  const slots = [
    {
      slot: 'composer-toolbar',
      pluginId,
      id: 'v42-workbench-toolbar',
      label: {
        default: 'Vibe42',
        en: 'Vibe42',
        zh: '远端工位',
      },
      tooltip: {
        default: 'Open Vibe42 live remote workbench in workspace',
        en: 'Open Vibe42 live remote workbench in workspace',
        zh: '在右侧宽舞台打开 Vibe42 远端实况工作台',
      },
      icon: 'terminal',
      tone: counts.blocked > 0 ? 'warning' : (counts.working > 0 ? 'accent' : 'neutral'),
      ...(counts.totalManaged > 0 ? { badgeText: String(counts.totalManaged) } : {}),
      order: 32,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'workbench',
      },
    },
    {
      slot: 'slash-command',
      pluginId,
      id: 'v42-workbench-slash',
      icon: 'terminal',
      command: 'v42-workbench',
      description: {
        default: 'Open the Vibe42 remote seats, desktop, mobile, and port-forward workbench',
        en: 'Open the Vibe42 remote seats, desktop, mobile, and port-forward workbench',
        zh: '在宽舞台打开 Vibe42 远端工位、桌面、真机与端口转发工作台',
      },
      needsSession: false,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'workbench',
      },
    },
    {
      slot: 'tool-card-renderer',
      pluginId,
      id: 'v42-tool-card',
      icon: 'terminal',
      toolNames: [
        'v42_fleet',
        'v42_seat_run',
        'v42_seat_inspect',
        'v42_seat_resolve',
        'v42_env_transfer',
      ],
      actionVerb: {
        default: 'Vibe42 Fleet',
        en: 'Vibe42 Fleet',
        zh: '远端编排',
      },
      targetFieldPath: 'args.seat_ref',
      summaryFields: [
        {
          label: { default: 'Action', en: 'Action', zh: '动作' },
          sourcePath: 'args.action',
          format: 'badge',
        },
        {
          label: { default: 'Computer', en: 'Computer', zh: '设备' },
          sourcePath: 'args.computer',
          format: 'code',
        },
        {
          label: { default: 'Mode', en: 'Mode', zh: '模式' },
          sourcePath: 'args.mode',
          format: 'badge',
        },
      ],
      detailFields: [],
    },
  ];

  if (counts.totalManaged > 0) {
    let dotTone = 'ok';
    let valueText = `${counts.totalManaged} leased`;
    if (counts.blocked > 0) {
      dotTone = 'warn';
      valueText = `${counts.blocked} approval`;
    } else if (counts.humanControlling > 0) {
      dotTone = 'active';
      valueText = 'Human control';
    } else if (counts.working > 0) {
      dotTone = 'active';
      valueText = `${counts.working} active`;
    }

    slots.push({
      slot: 'status-capsule',
      pluginId,
      id: 'v42-leased-capsule',
      icon: 'terminal',
      label: {
        default: 'Vibe42',
        en: 'Vibe42',
        zh: 'Vibe42',
      },
      valueText: valueText.slice(0, 32),
      dotTone,
      order: 28,
      action: {
        kind: 'open_plugin_panel',
        panelId: 'workbench',
      },
    });
  }

  return slots;
}

export const V42_HTTP_ROUTES = [
  { method: 'GET', subpath: '/workbench/state', scopeAcl: 'session' },
  { method: 'POST', subpath: '/workbench/action', scopeAcl: 'session' },
];

export function createV42SlotHandlers({
  leaseStore,
  workbenchService,
  pluginId = KIKI_V42_PLUGIN_ID,
}) {
  return {
    async 'E5:prompt-context'(_payload = {}, context = {}) {
      try {
        await leaseStore.load({ kikiHome: context.kikiHome });
        const xml = leaseStore.renderPromptContextXml();
        if (!xml) return { sections: [] };
        return {
          sections: [
            {
              id: 'v42-leased-context',
              title: 'Vibe42 Leased Remote Targets',
              content: xml,
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
      const settings = context.settings ?? payload?.settings ?? {};
      const kind = payload?.kind ?? payload?.action ?? 'describe';

      await leaseStore.load({ kikiHome: context.kikiHome }).catch(() => {});

      if (kind === 'describe') {
        const managedSummary = leaseStore.getManagedSummary();
        return {
          guiSlots: buildV42GuiSlots(pluginId, managedSummary),
          routes: V42_HTTP_ROUTES,
        };
      }

      if (kind === 'http-route') {
        const subpath = String(payload.subpath || '').replace(/^\/+|\/+$/g, '');
        const body = payload.body && typeof payload.body === 'object' ? payload.body : {};
        if (subpath === 'workbench/state' && payload.method === 'GET') {
          return {
            status: 200,
            data: await workbenchService.getState({
              includeUnmanaged: payload.query?.includeUnmanaged === '1',
              computer: payload.query?.computer,
              settings,
            }),
          };
        }
        if (subpath === 'workbench/action' && payload.method === 'POST') {
          return {
            status: 200,
            data: await workbenchService.handlePanelRequest(body.action, body.args || {}, { settings }),
          };
        }
        return { status: 404, errorMessage: `Unknown Vibe42 route: ${payload.method} /${subpath}` };
      }

      return {
        guiSlots: buildV42GuiSlots(pluginId, leaseStore.getManagedSummary()),
        routes: V42_HTTP_ROUTES,
      };
    },
  };
}
