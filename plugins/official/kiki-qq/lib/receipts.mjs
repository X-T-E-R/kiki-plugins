export function delivered(messageIds = [], detail) {
  const receipt = { status: 'delivered' };
  if (messageIds.length > 0) receipt.messageIds = [...messageIds];
  if (detail !== undefined) receipt.detail = detail;
  return receipt;
}

export function partial(messageIds = [], detail, unsupported = []) {
  const receipt = { status: 'partial' };
  if (messageIds.length > 0) receipt.messageIds = [...messageIds];
  if (unsupported.length > 0) receipt.unsupported = [...unsupported];
  if (detail !== undefined) receipt.detail = detail;
  return receipt;
}

export function unsupported(kind, detail = `${kind} is not supported by this QQ adapter`) {
  return { status: 'unsupported', unsupported: [kind], detail };
}

export function failed(detail, kind = 'provider_error') {
  return { status: 'failed', detail: `${kind}: ${detail}` };
}

export function unknown(detail = 'Network outcome is unknown; do not resend automatically') {
  return { status: 'unknown', detail };
}

export function receiptFromError(error) {
  const status = Number(error?.status ?? 0);
  if (error?.code === 'UNSUPPORTED') return unsupported(error.kind ?? 'action', error.message);
  if (status === 429) {
    const delay = error.retryAfterMs;
    const canRetry = Number.isSafeInteger(delay) && delay >= 0 && delay <= 60000;
    const wait = delay === undefined ? '' : `retryAfterMs=${String(delay)}${canRetry ? '' : '; automatic retry disabled'}; `;
    const detail = `rate_limited: ${wait}${String(error.message ?? error)}`.slice(0, 4096);
    return { status: 'failed', detail, errorKind: 'rate_limited', ...(canRetry ? { retryAfterMs: delay } : {}) };
  }
  if (['NETWORK_ERROR', 'TIMEOUT', 'OUTCOME_UNKNOWN', 'INVALID_RESPONSE', 'REDIRECT'].includes(error?.code) || status >= 500) return unknown(String(error.message ?? error));
  if (status === 401 || status === 403) return failed(String(error.message ?? error), 'forbidden');
  if (status === 404) return failed(String(error.message ?? error), 'not_found');
  if (status === 413) return failed(String(error.message ?? error), 'too_large');
  return failed(String(error?.message ?? error));
}
