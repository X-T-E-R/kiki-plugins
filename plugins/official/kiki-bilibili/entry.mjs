import { definitions } from './lib/definitions.mjs';
import { createBilibiliCore } from './lib/core.mjs';
import { fail } from './lib/errors.mjs';
import { renderResult } from './lib/output.mjs';

const methods = { bilibili_discover: 'discover', bilibili_watch: 'watch', bilibili_interact: 'interact', bilibili_inbox: 'inbox', bilibili_publish: 'publish', bilibili_account: 'account', bilibili_diagnose: 'diagnose' };
export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args, context) => {
      try {
        const core = createBilibiliCore({ settings: context.settings, workspaceRoot: context.workspaceRoot, context });
        context.progress({ kind: 'status', text: `${definition.name} running` });
        const result = await core[methods[definition.name]](args ?? {});
        return await renderResult(result, context.imageIn);
      } catch (error) {
        return { output: JSON.stringify(fail(error)), isError: true };
      }
    });
  }
}
