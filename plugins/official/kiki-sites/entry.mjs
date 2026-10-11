import { realpath } from 'node:fs/promises';
import { Sites } from './lib/sites.mjs';
import { dataDirectory, errorView, SitesError } from './lib/runtime.mjs';
import { definitions } from './lib/definitions.mjs';
const instances = new Map();
export function sitesInstance(settings = {}) {
  const directory = dataDirectory(settings);
  if (!instances.has(directory)) instances.set(directory, new Sites(settings));
  return instances.get(directory);
}
export async function handlePanelRequest(action, args, context = {}) {
  try { return await sitesInstance(context.settings).action(action, args); }
  catch (error) { return { ok: false, error: errorView(error) }; }
}
export function register(api) {
  for (const definition of definitions) api.registerTool(definition, async (args, context) => {
    try {
      const sites = sitesInstance(context.settings);
      if (!definition.parameters.properties.action.enum.includes(args.action)) throw new SitesError('unknown_action', 'Unsupported tool action.');
      if (definition.name === 'sites_project') {
        const project = await realpath(args.project);
        if (args.action === 'save_target') args = { ...args, target: { ...args.target, project } };
        else {
          const state = await sites.store.read(); const preview = state.previews.find(p => p.id === args.previewId);
          const target = state.targets.find(t => t.id === (args.id || preview?.targetId));
          if (!target || await realpath(target.project) !== project) throw new SitesError('project_mismatch', 'The admitted project does not match this deployment target.');
        }
      }
      let result = await sites.action(args.action, args, context);
      if (definition.name === 'sites_project' && args.action === 'deploy' && result.ok) {
        const running = sites.active.get(result.job.id);
        const cancel = () => running?.abort(); context.signal.addEventListener('abort', cancel, { once: true });
        if (context.signal.aborted) cancel();
        context.progress({ kind: 'status', text: 'Deploying with the selected official service.' });
        try { await running?.promise; } finally { context.signal.removeEventListener('abort', cancel); }
        result = await sites.action('job', { id: result.job.id });
      }
      return { output: JSON.stringify(result), isError: !result.ok || ['failed', 'unknown', 'cancelled'].includes(result.job?.state) };
    } catch (error) { return { output: JSON.stringify({ ok: false, error: errorView(error) }), isError: true }; }
  });
}
