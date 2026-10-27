import { createOfficialAdapter, createOneBotAdapter } from './lib/adapters.mjs';
import { officialAdapterDefinition, onebotAdapterDefinition, toolDefinitions } from './lib/definitions.mjs';

export function register(api) {
  const onebot = createOneBotAdapter();
  api.registerImAdapter(officialAdapterDefinition, createOfficialAdapter());
  api.registerImAdapter(onebotAdapterDefinition, onebot);
  for (const definition of toolDefinitions) api.registerTool(definition, async (args, context) => {
    try {
      context.progress({ kind: 'status', text: 'Reading OneBot group data' });
      const result = await onebot.readGroups(definition.name === 'qq_list_groups' ? {} : { groupId: args.groupId }, context);
      return { output: JSON.stringify(result) };
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  });
}
