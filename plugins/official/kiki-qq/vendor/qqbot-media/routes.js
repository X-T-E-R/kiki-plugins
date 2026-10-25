export function mediaUploadPath(scope, targetId) { return scope === 'c2c' ? `/v2/users/${encodeURIComponent(targetId)}/files` : `/v2/groups/${encodeURIComponent(targetId)}/files`; }
export function uploadPreparePath(scope, targetId) { return scope === 'c2c' ? `/v2/users/${encodeURIComponent(targetId)}/upload_prepare` : `/v2/groups/${encodeURIComponent(targetId)}/upload_prepare`; }
export function uploadPartFinishPath(scope, targetId) { return scope === 'c2c' ? `/v2/users/${encodeURIComponent(targetId)}/upload_part_finish` : `/v2/groups/${encodeURIComponent(targetId)}/upload_part_finish`; }
export const uploadCompletePath = mediaUploadPath;
export const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;
export const CHUNKED_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;
export function sanitizeFileName(name) {
  return String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() || 'file';
}
