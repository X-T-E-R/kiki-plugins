import { definitions, errorPulseReportTool } from './lib/definitions.mjs';
import { createErrorPulseService } from './lib/scanner.mjs';
import { redactSecrets } from './lib/signature.mjs';

const service = createErrorPulseService();

function formatFailureBody(error) {
  const code = typeof error?.code === 'string' ? error.code : 'ERROR_PULSE_FAILED';
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Error pulse request failed.');
  return {
    ok: false,
    error: {
      code,
      message: redactSecrets(rawMessage),
    },
  };
}

export function register(api) {
  if (typeof api?.registerTool !== 'function') {
    throw new Error('This plugin requires a Kiki host with tool registration support.');
  }
  api.registerTool(errorPulseReportTool, async (args, context) => {
    try {
      const result = await service.executeTool(args ?? {}, context ?? {});
      return { output: JSON.stringify(result, null, 2) };
    } catch (error) {
      return {
        output: JSON.stringify(formatFailureBody(error)),
        isError: true,
      };
    }
  });
}

export function activate(context) {
  return service.activate(context);
}

export function deactivate() {
  return service.deactivate();
}

export async function handlePanelRequest(action, args, context) {
  try {
    return await service.handlePanel(action, args ?? {}, context ?? {});
  } catch (error) {
    return formatFailureBody(error);
  }
}

export function errorPulseServiceForTests(deps) {
  return createErrorPulseService(deps);
}

export { definitions, errorPulseReportTool };
