import { configuration } from './lib/configuration.mjs';

export function register() {}

export function handlePanelRequest(action, _args, context) {
  if (action !== 'configuration') throw new Error(`Unknown output-layer action: ${action}`);
  return configuration(context.settings);
}
