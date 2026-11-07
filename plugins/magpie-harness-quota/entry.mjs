import { antigravityQuotaSourceDefinition, harnessQuotaSourceDefinitions } from './lib/definitions.mjs';
import { MagpieQuotaService } from './lib/magpie.mjs';

const service = new MagpieQuotaService({
  minRefreshIntervalMs: antigravityQuotaSourceDefinition.minRefreshIntervalMs,
});

export function register(api) {
  if (typeof api?.registerHarnessQuotaSource !== 'function') {
    throw new Error('This plugin requires a Kiki host with harness quota source support.');
  }
  api.registerHarnessQuotaSource(antigravityQuotaSourceDefinition, service.adapter);
}

export {
  antigravityQuotaSourceDefinition,
  harnessQuotaSourceDefinitions,
  service as magpieQuotaService,
};
