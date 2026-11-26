/**
 * Context-aware drag-and-drop file/APK overlay for Kiki remote panels.
 * Enforces Frame Audit Blocker 2:
 * - NEVER multiplexes bulk file bytes onto the interactive video/input stream.
 * - Routes uploads over chunked RPC (`uploadInit` -> `uploadChunk` -> `uploadFinish`)
 *   or a dedicated `'upload'` stream channel.
 */

const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const DEFAULT_UPLOAD_CHUNK_BYTES = 768 * 1024; // 768 KiB raw (~1 MiB base64, <=130 chunks for 100 MB)

export function sanitizeDropFileName(rawName, index = 0) {
  const base = String(rawName ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const fallback = base || `dropped-file-${index + 1}`;
  const dotIdx = fallback.lastIndexOf('.');
  const stem = dotIdx > 0 ? fallback.slice(0, dotIdx) : fallback;
  const ext = dotIdx > 0 ? fallback.slice(dotIdx) : '';
  const safeStem = WINDOWS_RESERVED_STEM.test(stem) ? `_${stem}` : stem;
  return `${safeStem.slice(0, 120)}${ext.slice(0, 24)}`;
}

function uint8ToBase64(bytes) {
  if (bytes && typeof bytes.toBase64 === 'function') {
    return bytes.toBase64();
  }
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + step));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

export function attachRemoteDropZone(stageEl, options = {}) {
  if (!stageEl || typeof stageEl.addEventListener !== 'function') {
    throw new Error('attachRemoteDropZone requires a stage element');
  }

  const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
  const isZh = options.isZh !== undefined
    ? Boolean(options.isZh)
    : /^zh\b/i.test(String(typeof navigator !== 'undefined' ? navigator.language : ''));
  const chunkBytes = Number.isFinite(options.chunkBytes) && options.chunkBytes > 0
    ? Math.floor(options.chunkBytes)
    : DEFAULT_UPLOAD_CHUNK_BYTES;

  let dragDepth = 0;
  let uploading = false;
  let disposed = false;

  let overlayEl = options.overlayEl || null;
  let titleEl = null;
  let subEl = null;
  let createdOverlay = false;

  if (!overlayEl && doc && typeof doc.createElement === 'function') {
    overlayEl = doc.createElement('div');
    overlayEl.className = 'kiki-remote-drop-overlay';
    overlayEl.hidden = true;
    const card = doc.createElement('div');
    card.className = 'kiki-remote-drop-card';
    titleEl = doc.createElement('div');
    titleEl.className = 'kiki-remote-drop-title';
    subEl = doc.createElement('div');
    subEl.className = 'kiki-remote-drop-sub';
    card.append(titleEl, subEl);
    overlayEl.appendChild(card);
    stageEl.appendChild(overlayEl);
    createdOverlay = true;
  }

  function showOverlay(title, subtitle = '') {
    if (!overlayEl) return;
    overlayEl.hidden = false;
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.hidden = true;
  }

  function hasFiles(ev) {
    const types = ev?.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  const onDragEnter = (ev) => {
    if (disposed || uploading || !hasFiles(ev)) return;
    if (typeof options.isEnabled === 'function' && !options.isEnabled()) return;
    ev.preventDefault?.();
    dragDepth += 1;
    showOverlay(
      options.dropTitle || (isZh ? '松开以投送文件至设备' : 'Drop files to send to device'),
      options.dropSubtitle || (isZh ? '.apk 自动安装 · 图片与文件推入 Download 并刷新媒体库' : '.apk installs automatically · files push to Download'),
    );
  };

  const onDragOver = (ev) => {
    if (disposed || uploading || !hasFiles(ev)) return;
    if (typeof options.isEnabled === 'function' && !options.isEnabled()) return;
    ev.preventDefault?.();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (ev) => {
    if (disposed || uploading) return;
    ev.preventDefault?.();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  };

  async function uploadSingleFile(file, idx, total) {
    const safeName = sanitizeDropFileName(file.name, idx);
    const isApk = /\.apk$/i.test(safeName);
    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);

    if (typeof options.uploadFile === 'function') {
      return options.uploadFile({
        fileName: safeName,
        byteLength: bytes.byteLength,
        isApk,
        bytes,
        chunkBytes,
        uint8ToBase64,
        onProgress(pct) {
          showOverlay(
            isZh ? `正在传输 ${safeName} (${pct}%)` : `Uploading ${safeName} (${pct}%)`,
            `${idx + 1} / ${total}`,
          );
        },
      });
    }

    if (typeof options.callRpc !== 'function') {
      throw new Error('DropZone requires uploadFile or callRpc handler');
    }

    const targetMeta = typeof options.getTargetMeta === 'function' ? options.getTargetMeta() : {};
    const initRes = await options.callRpc('uploadInit', {
      ...targetMeta,
      fileName: safeName,
      byteLength: bytes.byteLength,
      mode: isApk ? 'install_apk' : 'push_file',
    });
    if (!initRes || initRes.ok === false || !initRes.uploadId) {
      throw new Error(initRes?.error || 'Failed to initialize file transfer');
    }

    const uploadId = initRes.uploadId;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = Math.min(bytes.byteLength, offset + chunkBytes);
      const chunkB64 = uint8ToBase64(bytes.subarray(offset, end));
      const chunkRes = await options.callRpc('uploadChunk', {
        uploadId,
        offset,
        dataBase64: chunkB64,
      });
      if (!chunkRes || chunkRes.ok === false) {
        throw new Error(chunkRes?.error || 'Chunk upload failed');
      }
      offset = end;
      const pct = bytes.byteLength > 0 ? Math.round((offset / bytes.byteLength) * 100) : 100;
      showOverlay(
        isZh
          ? (pct >= 100 && isApk ? `正在安装 ${safeName}...` : `正在传输 ${safeName} (${pct}%)`)
          : (pct >= 100 && isApk ? `Installing ${safeName}...` : `Sending ${safeName} (${pct}%)`),
        `${idx + 1} / ${total}`,
      );
    }

    const finishRes = await options.callRpc('uploadFinish', {
      ...targetMeta,
      uploadId,
    });
    if (!finishRes || finishRes.ok === false) {
      throw new Error(finishRes?.error || 'File finalize failed');
    }
    return finishRes;
  }

  const onDrop = async (ev) => {
    if (disposed) return;
    ev.preventDefault?.();
    dragDepth = 0;
    if (uploading) return;
    if (typeof options.isEnabled === 'function' && !options.isEnabled()) {
      hideOverlay();
      return;
    }

    const rawFiles = ev?.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
    if (rawFiles.length === 0) {
      hideOverlay();
      return;
    }

    uploading = true;
    const results = [];
    try {
      for (let i = 0; i < rawFiles.length; i += 1) {
        const file = rawFiles[i];
        showOverlay(
          isZh ? `准备传输 ${file.name}...` : `Preparing ${file.name}...`,
          `${i + 1} / ${rawFiles.length}`,
        );
        const res = await uploadSingleFile(file, i, rawFiles.length);
        results.push(res);
      }
      options.onComplete?.(results);
    } catch (err) {
      options.onError?.(err);
    } finally {
      uploading = false;
      hideOverlay();
    }
  };

  stageEl.addEventListener('dragenter', onDragEnter);
  stageEl.addEventListener('dragover', onDragOver);
  stageEl.addEventListener('dragleave', onDragLeave);
  stageEl.addEventListener('drop', onDrop);

  return {
    isUploading: () => uploading,
    sanitizeDropFileName,
    dispose() {
      if (disposed) return;
      disposed = true;
      stageEl.removeEventListener('dragenter', onDragEnter);
      stageEl.removeEventListener('dragover', onDragOver);
      stageEl.removeEventListener('dragleave', onDragLeave);
      stageEl.removeEventListener('drop', onDrop);
      if (createdOverlay) overlayEl?.remove?.();
    },
  };
}
