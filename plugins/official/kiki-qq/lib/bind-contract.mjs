export const OFFICIAL_INSTANCE_ID = 'plugin:kiki-qq/qq-official';
export const BIND_ACTIONS = Object.freeze({
  start: 'official_bind_start', status: 'official_bind_status',
  save: 'official_bind_save', cancel: 'official_bind_cancel',
});
export const BIND_PHASES = Object.freeze(['idle', 'starting', 'waiting', 'candidate', 'saving', 'saved', 'expired', 'cancelled', 'failed']);

/**
 * panelBridge method: plugin.call, action: one of BIND_ACTIONS, args:
 * start: { instanceId: OFFICIAL_INSTANCE_ID, clientId: per-document random token }
 * status: same owner, optionally requestId; without it reads only current configuration.
 * save/cancel: { instanceId, clientId, requestId } from start.
 * Every response: { schemaVersion: 1, ok, instanceId, configured, appId?, requestId?,
 *   phase, qrUrl?, qrDataUrl?, candidateAppId?, error?: { code } }.
 * appId is the saved public ID; candidateAppId exists only in candidate/saving.
 * Errors are stable codes, never upstream strings. Secrets never cross this contract.
 * start supersedes the previous request; saving returns busy until the write settles.
 * status is read-only. save writes only the two official credential keys, once.
 */
export const BIND_ERROR_CODES = Object.freeze([
  'invalid_request', 'unsupported_instance', 'inactive', 'stale_request', 'busy',
  'not_ready', 'settings_changed', 'save_failed', 'bind_failed', 'invalid_credentials',
  'invalid_qr_url', 'unknown_action',
]);
