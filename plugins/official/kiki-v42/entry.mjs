import { fileURLToPath } from 'node:url';
import { V42CuaProviderServer } from './lib/cua-provider.mjs';
import { definitions, sessionSourceDefinition } from './lib/definitions.mjs';
import { DesktopSessionManager } from './lib/desktop-session.mjs';
import { LeaseStore } from './lib/lease-store.mjs';
import { V42Orchestrator } from './lib/orchestrator.mjs';
import { PortForwardManager } from './lib/port-forward.mjs';
import { V42WorkbenchService } from './lib/preview-service.mjs';
import { createV42SessionSourceAdapter } from './lib/session-source.mjs';
import { createV42SlotHandlers } from './lib/slots.mjs';
import { V42Client } from './lib/v42-client.mjs';

const pluginRoot = fileURLToPath(new URL('./', import.meta.url));

export function createV42Runtime({
  env = process.env,
  dataDir,
  heartbeatMs,
  ttlMs,
} = {}) {
  const leaseStore = new LeaseStore({ dataDir });
  const v42Client = new V42Client({ env });
  const desktopSessions = new DesktopSessionManager({ env });
  const portForwards = new PortForwardManager({ env, leaseStore });
  const cuaProvider = new V42CuaProviderServer({
    v42Client,
    desktopSessions,
    leaseStore,
    pluginRoot,
    env,
    heartbeatMs,
    ttlMs,
  });
  const orchestrator = new V42Orchestrator({
    v42Client,
    desktopSessions,
    portForwards,
    leaseStore,
    cuaProvider,
    env,
  });
  const workbenchService = new V42WorkbenchService({
    v42Client,
    desktopSessions,
    portForwards,
    leaseStore,
    cuaProvider,
    orchestrator,
  });
  const sessionSourceAdapter = createV42SessionSourceAdapter();
  const slots = createV42SlotHandlers({ leaseStore, workbenchService });

  return {
    leaseStore,
    v42Client,
    desktopSessions,
    portForwards,
    cuaProvider,
    orchestrator,
    workbenchService,
    sessionSourceAdapter,
    slots,
    async activate(appContext = {}) {
      if (appContext.dataDir) {
        leaseStore.setDataDir(appContext.dataDir);
      }
      await leaseStore.load({
        dataDir: appContext.dataDir,
        env,
      });
      const cuaInfo = await cuaProvider.ensureStarted({
        settings: appContext.settings || {},
        dataDir: appContext.dataDir || leaseStore.dataDir,
      });
      return {
        ok: true,
        dataDir: leaseStore.dataDir,
        cuaEndpoint: cuaInfo.endpoint,
        cuaLeaseFile: cuaInfo.leaseFilePath,
      };
    },
    async deactivate() {
      await Promise.allSettled([
        workbenchService.dispose(),
        cuaProvider.stop(),
        portForwards.dispose(),
        desktopSessions.dispose(),
        v42Client.dispose(),
      ]);
    },
  };
}

const defaultRuntime = createV42Runtime();

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, (args, context) =>
      defaultRuntime.orchestrator.executeTool(definition.name, args, context),
    );
  }
  api.registerSessionSource(sessionSourceDefinition, defaultRuntime.sessionSourceAdapter);
}

export async function activate(context) {
  return defaultRuntime.activate(context);
}

export async function deactivate() {
  return defaultRuntime.deactivate();
}

export async function handlePanelRequest(action, args, context) {
  return defaultRuntime.workbenchService.handlePanelRequest(action, args, context);
}

export function openPanelStream(stream, args, session, context) {
  return defaultRuntime.workbenchService.openPanelStream(stream, args, session, context);
}

export const slots = defaultRuntime.slots;
export { defaultRuntime };
