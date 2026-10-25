export function formatErrorMessage(err) {
  if (err instanceof Error) {
    let formatted = err.message || err.name || 'Error';
    let cause = err.cause;
    const seen = new Set([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) { if (cause.message) formatted += ` | ${cause.message}`; cause = cause.cause; }
      else if (typeof cause === 'string') { formatted += ` | ${cause}`; break; }
      else break;
    }
    return formatted;
  }
  if (typeof err === 'string') return err;
  if (err === null || err === undefined || ['number', 'boolean', 'bigint'].includes(typeof err)) return String(err);
  try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
}
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
