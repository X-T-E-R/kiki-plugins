/** Buffer-input adaptation of qqbot-nodejs 1.0.5 protocol/api/media-chunked.js. */
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, MediaFileType } from './types.js';
import { formatFileSize } from './format.js';
import { buildPartFinishPersistentPolicy, COMPLETE_UPLOAD_RETRY_POLICY, PART_FINISH_RETRY_POLICY, UPLOAD_PREPARE_FALLBACK_CODE, withRetry } from './retry.js';
import { CHUNKED_UPLOAD_MAX_SIZE, uploadCompletePath, uploadPartFinishPath, uploadPreparePath } from './routes.js';

const MAX_CONCURRENT_PARTS = 10;
const MAX_PART_FINISH_RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const PART_UPLOAD_TIMEOUT_MS = 300000;
const MD5_10M_SIZE = 10002432;
const PART_UPLOAD_MAX_RETRIES = 2;
export class UploadDailyLimitExceededError extends Error {
  name = 'UploadDailyLimitExceededError';
  constructor(filePath, fileSize, message) { super(message); Object.assign(this, { filePath, fileSize }); }
}
export class ChunkedMediaApi {
  constructor(client, tokenManager, config = {}) {
    this.client = client; this.tokenManager = tokenManager;
    this.logger = config.logger; this.sanitize = config.sanitizeFileName ?? ((name) => name);
    this.putPart = config.putPart ?? putToCOS;
  }
  async uploadChunked(input) {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const opts = { ...input, signal };
    try { return await this.uploadWithSignal(opts, controller); } finally { controller.abort(); }
  }
  async uploadWithSignal(opts, controller) {
    opts.signal.throwIfAborted();
    const data = opts.source.buffer;
    if (!Buffer.isBuffer(data) || !data.length || data.length > CHUNKED_UPLOAD_MAX_SIZE) throw new Error('Chunked upload requires 1 byte through 100 MiB of buffer data');
    const fileSize = data.length;
    const displayName = opts.fileName ?? opts.source.fileName ?? 'file';
    const hashes = computeHashes(data);
    opts.signal.throwIfAborted();
    const fileName = opts.fileType === MediaFileType.FILE ? this.sanitize(displayName) : displayName;
    const prepared = await this.callUploadPrepare(opts, fileName, fileSize, hashes);
    validatePrepare(prepared, fileSize);
    const { upload_id, block_size, parts } = prepared;
    const concurrency = Math.min(prepared.concurrency || 1, MAX_CONCURRENT_PARTS);
    const retryTimeoutMs = prepared.retry_timeout ? Math.min(prepared.retry_timeout * 1000, MAX_PART_FINISH_RETRY_TIMEOUT_MS) : undefined;
    this.logger?.debug?.(`Chunked upload prepared: ${parts.length} parts for ${formatFileSize(fileSize)}`);
    let completedParts = 0, uploadedBytes = 0;
    const tasks = parts.map((part) => async () => {
      try {
        opts.signal.throwIfAborted();
        const offset = (part.index - 1) * block_size;
        const length = Math.min(block_size, fileSize - offset);
        const partBuffer = data.subarray(offset, offset + length);
        const md5 = createHash('md5').update(partBuffer).digest('hex');
        await putToPresignedUrl(this.putPart, part.presigned_url, partBuffer, opts.signal);
        await this.callUploadPartFinish(opts, upload_id, part.index, length, md5, retryTimeoutMs);
        completedParts++; uploadedBytes += length;
        opts.onProgress?.({ completedParts, totalParts: parts.length, uploadedBytes, totalBytes: fileSize });
      } catch (error) { controller.abort(error); throw error; }
    });
    await runWithConcurrency(tasks, concurrency, opts.signal);
    opts.signal.throwIfAborted();
    return this.callCompleteUpload(opts, upload_id);
  }
  async token(opts) { opts.signal.throwIfAborted(); return this.tokenManager.getAccessToken(opts.creds.appId, opts.creds.clientSecret, opts.signal); }
  async callUploadPrepare(opts, fileName, fileSize, hashes) {
    const token = await this.token(opts);
    const path = uploadPreparePath(opts.scope, opts.targetId);
    try {
      return await this.client.request(token, 'POST', path, { file_type: opts.fileType, file_name: fileName, file_size: fileSize, ...hashes }, { uploadRequest: true, signal: opts.signal });
    } catch (error) {
      if (error instanceof ApiError && error.bizCode === UPLOAD_PREPARE_FALLBACK_CODE) throw new UploadDailyLimitExceededError('<buffer>', fileSize, error.message);
      throw error;
    }
  }
  async callUploadPartFinish(opts, uploadId, partIndex, blockSize, md5, retryTimeoutMs) {
    const path = uploadPartFinishPath(opts.scope, opts.targetId);
    await withRetry(async () => this.client.request(await this.token(opts), 'POST', path,
      { upload_id: uploadId, part_index: partIndex, block_size: blockSize, md5 }, { uploadRequest: true, signal: opts.signal }),
    PART_FINISH_RETRY_POLICY, buildPartFinishPersistentPolicy(retryTimeoutMs), this.logger, opts.signal);
  }
  async callCompleteUpload(opts, uploadId) {
    const path = uploadCompletePath(opts.scope, opts.targetId);
    return withRetry(async () => this.client.request(await this.token(opts), 'POST', path, { upload_id: uploadId }, { uploadRequest: true, signal: opts.signal }),
      COMPLETE_UPLOAD_RETRY_POLICY, undefined, this.logger, opts.signal);
  }
}
function computeHashes(data) {
  const md5 = createHash('md5').update(data).digest('hex');
  const sha1 = createHash('sha1').update(data).digest('hex');
  const md5_10m = data.length > MD5_10M_SIZE ? createHash('md5').update(data.subarray(0, MD5_10M_SIZE)).digest('hex') : md5;
  return { md5, sha1, md5_10m };
}
function validatePrepare(value, size) {
  if (typeof value?.upload_id !== 'string' || !value.upload_id || !Number.isSafeInteger(value.block_size) || value.block_size <= 0 || !Array.isArray(value.parts)) throw new Error('Invalid upload_prepare response');
  const count = Math.ceil(size / value.block_size);
  if (value.parts.length !== count || new Set(value.parts.map((part) => part?.index)).size !== count) throw new Error('Incomplete upload_prepare parts');
  if (value.concurrency !== undefined && (!Number.isSafeInteger(value.concurrency) || value.concurrency <= 0)) throw new Error('Invalid upload concurrency');
  if (value.retry_timeout !== undefined && (!Number.isFinite(value.retry_timeout) || value.retry_timeout <= 0)) throw new Error('Invalid upload retry timeout');
  for (const part of value.parts) {
    if (!Number.isSafeInteger(part?.index) || part.index < 1 || part.index > count) throw new Error('Invalid upload part index');
    const url = new URL(part.presigned_url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('COS upload URL must be credential-free HTTPS');
  }
}
export function putToCOS(presignedUrl, data, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const url = new URL(presignedUrl);
    if (url.protocol !== 'https:' || url.username || url.password) { reject(new Error('COS upload URL must be credential-free HTTPS')); return; }
    const req = httpsRequest(url, { method: 'PUT', headers: { 'Content-Length': String(data.length) }, signal }, (res) => {
      const chunks = []; let length = 0;
      res.on('data', (chunk) => { if (length < 4096) chunks.push(chunk.subarray(0, 4096 - length)); length += chunk.length; });
      res.on('aborted', () => reject(new Error('COS response ended before completion')));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, etag: String(res.headers.etag ?? '').replace(/"/g, ''), requestId: String(res.headers['x-cos-request-id'] ?? '-') });
        else reject(new Error(`COS PUT failed: ${res.statusCode} ${Buffer.concat(chunks).toString().slice(0, 120)}`));
      });
    });
    req.on('error', reject); req.end(data);
  });
}
async function putToPresignedUrl(putPart, url, data, signal) {
  let lastError;
  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    signal.throwIfAborted();
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(PART_UPLOAD_TIMEOUT_MS)]);
    try { await putPart(url, data, lifetime); return; }
    catch (error) {
      signal.throwIfAborted(); lastError = error;
      if (attempt < PART_UPLOAD_MAX_RETRIES) await sleep(1000 * 2 ** attempt, undefined, { signal });
    }
  }
  throw lastError;
}
async function runWithConcurrency(tasks, maxConcurrent, signal) {
  for (let index = 0; index < tasks.length; index += maxConcurrent) {
    signal.throwIfAborted();
    const results = await Promise.allSettled(tasks.slice(index, index + maxConcurrent).map((task) => task()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
