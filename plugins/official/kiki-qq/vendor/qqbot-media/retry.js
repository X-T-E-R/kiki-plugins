import { setTimeout as sleep } from 'node:timers/promises';
import { formatErrorMessage } from './format.js';

export async function withRetry(fn, policy, persistentPolicy, logger, signal) {
  let lastError = null;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    signal?.throwIfAborted();
    try { return await fn(); }
    catch (err) {
      signal?.throwIfAborted();
      lastError = err instanceof Error ? err : new Error(formatErrorMessage(err));
      if (persistentPolicy?.shouldPersistRetry(lastError)) return persistentRetryLoop(fn, persistentPolicy, logger, signal);
      if (policy.shouldRetry?.(lastError, attempt) === false) throw lastError;
      if (attempt < policy.maxRetries) {
        const delay = policy.backoff === 'exponential' ? policy.baseDelayMs * 2 ** attempt : policy.baseDelayMs;
        logger?.debug?.(`[qqbot:retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await sleep(delay, undefined, { signal });
      }
    }
  }
  throw lastError;
}
async function persistentRetryLoop(fn, policy, logger, signal) {
  const deadline = Date.now() + policy.timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try { return await fn(); }
    catch (err) {
      signal?.throwIfAborted();
      lastError = err instanceof Error ? err : new Error(formatErrorMessage(err));
      if (!policy.shouldPersistRetry(lastError)) throw lastError;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(policy.intervalMs, remaining), undefined, { signal });
    }
  }
  throw lastError ?? new Error('Persistent retry timed out');
}
export const COMPLETE_UPLOAD_RETRY_POLICY = { maxRetries: 2, baseDelayMs: 2000, backoff: 'exponential' };
export const PART_FINISH_RETRY_POLICY = { maxRetries: 2, baseDelayMs: 1000, backoff: 'exponential' };
export const PART_FINISH_RETRYABLE_CODES = new Set([40093001]);
export const UPLOAD_PREPARE_FALLBACK_CODE = 40093002;
export function buildPartFinishPersistentPolicy(retryTimeoutMs, retryableCodes = PART_FINISH_RETRYABLE_CODES) {
  return { timeoutMs: retryTimeoutMs ?? 2 * 60 * 1000, intervalMs: 1000,
    shouldPersistRetry: (error) => typeof error.bizCode === 'number' && retryableCodes.has(error.bizCode) };
}
