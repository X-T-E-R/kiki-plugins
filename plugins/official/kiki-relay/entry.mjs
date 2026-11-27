import { definitions } from './lib/definitions.mjs';
import { generateRelayDeployGuide, RelayPluginService } from './lib/service.mjs';

const service = new RelayPluginService();

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args = {}) => {
      try {
        if (definition.name === 'relay_status') {
          if (args.probe === true) {
            const current = await service.status();
            await Promise.allSettled(
              current.nodes.filter((n) => n.enabled).map((n) => service.probe(n.url)),
            );
          }
          return { output: JSON.stringify(await service.status()), isError: false };
        }
        if (definition.name === 'relay_deploy_guide') {
          return { output: JSON.stringify(generateRelayDeployGuide(args)), isError: false };
        }
        return { output: JSON.stringify({ ok: false, error: 'unknown_tool' }), isError: true };
      } catch (err) {
        return {
          output: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    });
  }
}

export function activate(context) {
  return service.activate(context);
}

export function deactivate() {
  return service.deactivate();
}

export function handlePanelRequest(action, args) {
  return service.panel(action, args);
}

export { service };
