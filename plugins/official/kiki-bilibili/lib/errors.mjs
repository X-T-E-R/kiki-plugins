export class BilibiliError extends Error {
  constructor(code, message, { suggestion, submission = 'not_sent', detail, state, retry = false } = {}) {
    super(message);
    this.name = 'BilibiliError';
    this.code = code;
    this.suggestion = suggestion;
    this.submission = submission;
    this.detail = detail;
    this.state = state;
    this.retry = retry;
  }
}

export function errorInfo(error, fallbackCode = 'PLUGIN_ERROR') {
  if (error instanceof BilibiliError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      submission: error.submission,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.state ? { state: error.state } : {}),
      retry: error.retry === true,
    };
  }
  return {
    code: error?.code ?? fallbackCode,
    message: String(error?.message ?? error),
    submission: error?.submission ?? 'not_sent',
    ...(error?.detail === undefined ? {} : { detail: error.detail }),
    retry: false,
  };
}

export function ok(data) {
  return { success: true, data };
}

export function fail(error, fallbackCode) {
  return { success: false, error: errorInfo(error, fallbackCode) };
}

export function assert(condition, code, message, options) {
  if (!condition) throw new BilibiliError(code, message, options);
}

export function normalizeOutboundState(value) {
  const state = String(value?.state ?? '').toLowerCase();
  if (['success', 'complete', 'completed', 'ok'].includes(state)) return 'success';
  if (['failure', 'failed', 'rejected', 'error'].includes(state)) return 'failure';
  if (['timeout', 'timed_out'].includes(state)) return 'timeout';
  if (state === 'unknown') return 'unknown';
  return undefined;
}
