import { downloadPublicMedia } from './media-download.mjs';
const MIME_BY_EXTENSION = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', silk: 'audio/silk', slk: 'audio/silk', slac: 'audio/silk', amr: 'audio/amr', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', mp4: 'video/mp4' };
const MIME_BY_KIND = {
  image: ['image/'],
  audio: ['audio/'],
  video: ['video/'],
  file: [],
};

export function mediaKindFromMime(mime, filename = '') {
  const type = String(mime ?? '').toLowerCase().split(';', 1)[0];
  if (type === 'voice') return 'audio';
  for (const [kind, prefixes] of Object.entries(MIME_BY_KIND)) if (prefixes.some((prefix) => type.startsWith(prefix))) return kind;
  const extension = String(filename).toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(extension)) return 'image';
  if (['mp3', 'wav', 'ogg', 'opus', 'silk', 'slk', 'slac', 'amr', 'm4a', 'aac', 'flac'].includes(extension)) return 'audio';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(extension)) return 'video';
  return 'file';
}

export function normalizeMediaDescriptor(value, { defaultName = 'attachment', defaultMime = 'application/octet-stream' } = {}) {
  if (!value || typeof value !== 'object') return undefined;
  const rawUrl = typeof value.url === 'string' ? value.url : typeof value.file === 'string' && /^https?:\/\//.test(value.file) ? value.file : undefined;
  const url = rawUrl?.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  const name = String(value.filename ?? value.name ?? value.fileName ?? defaultName).replace(/[\\/\u0000-\u001f]/gu, '_').slice(0, 255) || defaultName;
  const extensionMime = MIME_BY_EXTENSION[name.split('.').pop().toLowerCase()];
  const declared = String(value.content_type ?? value.contentType ?? value.mediaType ?? value.mime ?? extensionMime ?? defaultMime).split(';', 1)[0].toLowerCase();
  const mediaType = declared === 'voice' ? (extensionMime?.startsWith('audio/') ? extensionMime : 'audio/silk') : declared;
  const kind = value.kind ?? mediaKindFromMime(mediaType, name);
  const size = Number.isFinite(Number(value.size)) && Number(value.size) >= 0 ? Number(value.size) : undefined;
  return { name, mediaType, kind, url, size, ...(value.asr_refer_text ? { asrText: String(value.asr_refer_text) } : {}), ...(value.width ? { width: Number(value.width) } : {}), ...(value.height ? { height: Number(value.height) } : {}) };
}

export function attachmentListFromOfficial(event, { refMsgIdx } = {}) {
  const raw = [...(Array.isArray(event?.attachments) ? event.attachments : [])];
  for (const [index, element] of (event?.msg_elements ?? []).entries()) {
    if (refMsgIdx && (index === 0 || element.msg_idx === refMsgIdx)) continue;
    for (const item of element?.attachments ?? []) raw.push(item);
  }
  return raw.map((item) => normalizeMediaDescriptor(item, { defaultName: 'qq-attachment' })).filter(Boolean);
}

export function parseCqMessage(text) {
  const source = String(text ?? '');
  const segments = [];
  let cursor = 0;
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
  for (let match; (match = pattern.exec(source));) {
    if (match.index > cursor) segments.push({ type: 'text', data: { text: decodeCq(source.slice(cursor, match.index)) } });
    const data = {};
    for (const pair of String(match[2] ?? '').replace(/^,/, '').split(',')) {
      if (!pair) continue;
      const split = pair.indexOf('=');
      if (split <= 0) continue;
      data[pair.slice(0, split)] = decodeCq(pair.slice(split + 1));
    }
    segments.push({ type: match[1].toLowerCase(), data });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) segments.push({ type: 'text', data: { text: decodeCq(source.slice(cursor)) } });
  return segments.length > 0 ? segments : [{ type: 'text', data: { text: source } }];
}

function decodeCq(value) {
  return String(value).replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&#38;/g, '&');
}

export function normalizeOneBotSegments(message) {
  const source = Array.isArray(message) ? message : parseCqMessage(message);
  const text = [];
  const mentions = [];
  const media = [];
  let replyTo;
  for (const segment of source) {
    if (!segment || typeof segment !== 'object') continue;
    const type = String(segment.type ?? '').toLowerCase();
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
    if (type === 'text') {
      const value = String(data.text ?? '');
      if (value) text.push(value);
      continue;
    }
    if (type === 'at') {
      const qq = String(data.qq ?? '');
      if (qq) mentions.push({ id: qq, kind: qq === 'all' ? 'all' : 'user' });
      continue;
    }
    if (type === 'reply') {
      const id = data.id ?? data.message_id;
      if (id !== undefined) replyTo = String(id);
      continue;
    }
    if (['image', 'record', 'voice', 'video', 'file'].includes(type)) {
      const name = String(data.file ?? data.name ?? `${type}-attachment`);
      const descriptor = normalizeMediaDescriptor({ ...data, filename: name, kind: type === 'record' || type === 'voice' ? 'audio' : type });
      if (descriptor) media.push({ ...descriptor, url: descriptor.url ?? (/^https?:\/\//.test(name) ? name : undefined), file: name });
      if (type === 'record' || type === 'voice') {
        const transcript = data.asr_text ?? data.asr_refer_text;
        if (transcript) text.push(`[Voice] ${String(transcript)}`);
      }
      continue;
    }
    if (type === 'face') {
      const id = data.id === undefined ? '' : String(data.id);
      if (id) text.push(`[Face:${id}]`);
      continue;
    }
    if (type === 'json' || type === 'xml' || type === 'share') text.push(`[${type}]`);
  }
  return { text: text.join(''), mentions, media, replyTo };
}

function downloadedType(header, descriptor) {
  const type = String(header ?? '').split(';', 1)[0].trim().toLowerCase();
  return !type || type === 'application/octet-stream' || type === 'voice' ? descriptor.mediaType || 'application/octet-stream' : type;
}

export async function fetchMediaBytes(descriptor, { fetchImpl, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!descriptor?.url) throw Object.assign(new Error(`Attachment ${descriptor?.name ?? 'unknown'} has no downloadable URL`), { code: 'MEDIA_URL_MISSING' });
  const url = new URL(descriptor.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Attachment URL protocol is not allowed'), { code: 'MEDIA_URL_INVALID' });
  if (!fetchImpl) {
    const downloaded = await downloadPublicMedia(url, { signal, maxBytes });
    return { ...descriptor, bytes: downloaded.bytes, mediaType: downloadedType(downloaded.mediaType, descriptor) };
  }
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const response = await fetchImpl(url.href, { method: 'GET', signal, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status)) throw Object.assign(new Error('Attachment redirects are not followed'), { code: 'MEDIA_REDIRECT' });
  if (!response.ok) throw Object.assign(new Error(`Attachment HTTP ${response.status}`), { code: 'MEDIA_HTTP_ERROR', status: response.status });
  const length = Number(response.headers?.get?.('content-length') ?? 0);
  if (length > maxBytes) throw Object.assign(new Error('Attachment exceeds configured size limit'), { code: 'MEDIA_TOO_LARGE' });
  let bytes;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const parts = [];
    let total = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('Attachment exceeds configured size limit'), { code: 'MEDIA_TOO_LARGE' });
      }
      parts.push(Buffer.from(value));
    }
    bytes = Buffer.concat(parts);
  } else bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw Object.assign(new Error('Attachment exceeds configured size limit'), { code: 'MEDIA_TOO_LARGE' });
  const mediaType = downloadedType(response.headers?.get?.('content-type'), descriptor);
  return { ...descriptor, mediaType, bytes };
}
