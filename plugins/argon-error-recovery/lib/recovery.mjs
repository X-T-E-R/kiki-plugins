// Public builds ship with no deployment-specific model aliases. Add private aliases downstream.
const TARGET_MODEL_ALIASES = new Set([]);
const MISSING_TERMINAL_MESSAGE_RE = /^(?:Anthropic error:\s*)?antigravity_missing_terminal\s*:/;
export const MAX_STDIN_BYTES = 1024 * 1024;

export async function readStdinEvent(stream = process.stdin, maxBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) return undefined;
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function recoveryFor(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (event.hook_event_name !== 'StopFailure' || event.recoverable !== true || event.recovery_attempts !== 0) return undefined;
  const missingTerminal = event.upstream_error_code === 'antigravity_missing_terminal' || (
    event.upstream_error_code == null &&
    event.error_code === 'provider.api_error' &&
    typeof event.error_message === 'string' &&
    MISSING_TERMINAL_MESSAGE_RE.test(event.error_message)
  );
  const argonFailure = TARGET_MODEL_ALIASES.has(event.model_alias) && (
    event.upstream_error_code === 'gateway_stream_terminal_error' ||
    (event.error_code === 'provider.connection_error' && event.error_details?.retry_exhausted === true)
  );
  if (!missingTerminal && !argonFailure) return undefined;
  const recovery = event.has_partial_output === true
    ? { action: 'continue', userMessage: '继续' }
    : { action: 'retry' };
  return { hookSpecificOutput: { recovery } };
}
