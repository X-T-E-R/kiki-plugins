import { createCuaService } from './lib/cua-service.mjs';
import { definitions } from './lib/definitions.mjs';
import { createCuaSlotHandlers } from './lib/slots.mjs';

const cuaService = createCuaService();

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args, context) => {
      try {
        context?.signal?.throwIfAborted?.();
        return await cuaService.executeTool(definition.name, args ?? {}, context ?? {});
      } catch (error) {
        return {
          isError: true,
          output: JSON.stringify({
            ok: false,
            error: error?.message || String(error),
          }, null, 2),
        };
      }
    });
  }
}

export async function activate(context) {
  return cuaService.activate(context);
}

export async function deactivate() {
  await cuaService.dispose();
}

export async function handlePanelRequest(action, args, context) {
  return cuaService.handlePanelRequest(action, args, context);
}

export async function openPanelStream(stream, args, session, context) {
  return cuaService.openPanelStream(stream, args, session, context);
}

export const slots = createCuaSlotHandlers(cuaService);

export const __FAST_PANEL_BOOT_V2__ = true;
