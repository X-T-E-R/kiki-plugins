import { harnessAccountSourceDefinition } from './lib/definitions.mjs';
import { CockpitHarnessService } from './lib/service.mjs';

const service = new CockpitHarnessService();

export function register(api) {
  if (typeof api?.registerHarnessAccountSource !== 'function') {
    throw new Error('This plugin needs a Kiki host with harness account source support (>=0.4.2).');
  }
  api.registerHarnessAccountSource(harnessAccountSourceDefinition, service.adapter);
}

export function handlePanelRequest(action, args, context) {
  return service.panel(action, args, context);
}

export function deactivate() {
  return service.deactivate();
}

export { harnessAccountSourceDefinition, service as cockpitHarnessService };
