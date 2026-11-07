export const ANTIGRAVITY_ENGINE_IDS = ['agy-cli'];
export const DEFAULT_MIN_REFRESH_INTERVAL_MS = 300_000;

export const antigravityQuotaSourceDefinition = {
  schemaVersion: 1,
  id: 'antigravity',
  label: 'Magpie · Antigravity',
  engineIds: ANTIGRAVITY_ENGINE_IDS,
  minRefreshIntervalMs: DEFAULT_MIN_REFRESH_INTERVAL_MS,
};

export const harnessQuotaSourceDefinitions = [antigravityQuotaSourceDefinition];
