import { readFileSync } from 'node:fs';
import { createMailService } from './lib/service.mjs';

const manifest = JSON.parse(readFileSync(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));
const service = createMailService();

export function register(api) {
  for (const definition of manifest['x-kiki'].tools) {
    api.registerTool(definition, (args, context) => service.tool(definition.name, args, context));
  }
}

export function activate(context) {
  return service.activate(context);
}

export function deactivate() {
  return service.deactivate();
}

export function handlePanelRequest(action, args, context) {
  return service.panel(action, args, context);
}

export function mailServiceForTests(deps) {
  return createMailService(deps);
}
