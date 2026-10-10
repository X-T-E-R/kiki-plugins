import { CloudflareService } from './lib/service.mjs';
import { installBinary } from './lib/binary.mjs';

const service = new CloudflareService();
export function register() {}
export function activate(context) { return service.activate(context); }
export function deactivate() { return service.deactivate(); }
export function handlePanelRequest(action, args) { return service.panel(action, args); }
export function installPrerequisite(input) { return installBinary(input); }

export const connection = {
  accounts: () => service.account().accounts(),
  tunnels: () => service.tunnels(),
};
