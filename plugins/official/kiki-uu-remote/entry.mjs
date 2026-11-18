import { createCuaProviderBridge } from './lib/cua-provider-bridge.mjs';
import { definitions } from './lib/definitions.mjs';
import { createUuPreviewService } from './lib/preview-service.mjs';
import { createUuSlotHandlers } from './lib/slots.mjs';
import { createUuRemoteService } from './lib/uu-service.mjs';

let providerBridge = null;

const uuService = createUuRemoteService({
  busInspector: (ctx) => providerBridge?.inspectStatus(ctx) ?? null,
});

providerBridge = createCuaProviderBridge({ uuService });

async function ensureProviderBus(context = {}) {
  try {
    return await providerBridge.start(context, { preferExistingPeer: true });
  } catch {
    return null;
  }
}

const previewService = createUuPreviewService({
  uuService,
  ensureProviderBus,
});

function formatToolResponse(result, context) {
  if (!result || result.ok === false) {
    const { status: _omitStatus, ...errPayload } = result || { ok: false, error: 'Unknown tool failure' };
    return {
      output: JSON.stringify(errPayload, null, 2),
      isError: true,
    };
  }

  const directImage = result.imageBase64 && result.mimeType
    ? { mimeType: result.mimeType, imageBase64: result.imageBase64 }
    : result.observation?.imageBase64 && result.observation?.mimeType
      ? { mimeType: result.observation.mimeType, imageBase64: result.observation.imageBase64 }
      : null;

  const sanitized = { ...result };
  delete sanitized.imageBase64;
  delete sanitized.pngBuffer;
  if (sanitized.observation) {
    sanitized.observation = { ...sanitized.observation };
    delete sanitized.observation.imageBase64;
  }

  if (directImage && context?.imageIn !== false) {
    return {
      output: [
        { type: 'text', text: JSON.stringify(sanitized, null, 2) },
        {
          type: 'image_url',
          imageUrl: { url: `data:${directImage.mimeType};base64,${directImage.imageBase64}` },
        },
      ],
    };
  }

  return { output: JSON.stringify(sanitized, null, 2) };
}

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args = {}, context = {}) => {
      await ensureProviderBus(context);
      try {
        if (definition.name === 'uu_status') {
          const res = await uuService.getStatus(args, context);
          return formatToolResponse(res, context);
        }
        if (definition.name === 'uu_sessions') {
          const res = await uuService.manageSessions(args, context);
          return formatToolResponse(res, context);
        }
        if (definition.name === 'uu_control') {
          const res = await uuService.controlSession(args, context);
          return formatToolResponse(res, context);
        }
        if (definition.name === 'uu_launch') {
          const res = await uuService.launchAction(args, context);
          return formatToolResponse(res, context);
        }
        return { output: `Unknown tool: ${definition.name}`, isError: true };
      } catch (error) {
        return {
          output: JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2),
          isError: true,
        };
      }
    });
  }
}

export async function activate(appContext = {}) {
  if (appContext?.dataDir) {
    uuService.setStateDir(appContext.dataDir);
  }
  const lease = await providerBridge.start(appContext, { preferExistingPeer: false });
  appContext?.signal?.addEventListener?.(
    'abort',
    () => {
      void deactivate();
    },
    { once: true },
  );
  return lease;
}

export async function deactivate() {
  await Promise.allSettled([
    previewService.dispose(),
    providerBridge.stop(),
    uuService.dispose(),
  ]);
}

export async function handlePanelRequest(action, args, context) {
  return previewService.handlePanelRequest(action, args, context);
}

export async function openPanelStream(stream, args, session, context) {
  return previewService.openPanelStream(stream, args, session, context);
}

export const slots = createUuSlotHandlers(previewService);
