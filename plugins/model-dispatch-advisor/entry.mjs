import { definitions, dispatchAdvisorRecommendTool, dispatchPreferenceUpdateTool } from './lib/definitions.mjs';
import { createDispatchAdvisor } from './lib/advisor.mjs';

function formatFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'ADVISOR_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: JSON.stringify({
      ok: false,
      error: { code, message },
    }),
    isError: true,
  };
}

export function register(api) {
  if (typeof api?.registerTool !== 'function') {
    throw new Error('This plugin requires a Kiki host with tool registration support.');
  }
  const advisor = createDispatchAdvisor();

  api.registerTool(dispatchAdvisorRecommendTool, async (args, context) => {
    try {
      const result = await advisor.recommend(args ?? {}, context ?? {});
      return { output: JSON.stringify(result, null, 2) };
    } catch (error) {
      return formatFailure(error);
    }
  });

  api.registerTool(dispatchPreferenceUpdateTool, async (args, context) => {
    try {
      const result = await advisor.updatePreference(args ?? {}, context ?? {});
      return { output: JSON.stringify(result, null, 2) };
    } catch (error) {
      return formatFailure(error);
    }
  });
}

export {
  definitions,
  dispatchAdvisorRecommendTool,
  dispatchPreferenceUpdateTool,
};
