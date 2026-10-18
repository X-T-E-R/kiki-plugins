import { createHash } from 'node:crypto';
import { PostalMime } from './runtime.mjs';

const INLINE_LIMIT = 20_000;

export async function parseMessage(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const parsed = await new PostalMime().parse(bytes);
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  return {
    subject: parsed.subject || '',
    from: formatAddresses(parsed.from),
    to: formatAddresses(parsed.to),
    cc: formatAddresses(parsed.cc),
    replyTo: formatAddresses(parsed.replyTo),
    messageId: parsed.messageId || '',
    inReplyTo: parsed.inReplyTo || '',
    references: parsed.references || '',
    date: parsed.date || '',
    text,
    html,
    textInline: text.length <= INLINE_LIMIT ? text : text.slice(0, 4_000),
    htmlInline: html.length <= INLINE_LIMIT ? html : html.slice(0, 4_000),
    textComplete: text.length <= INLINE_LIMIT,
    htmlComplete: html.length <= INLINE_LIMIT,
    attachments: (parsed.attachments ?? []).map((item, index) => ({
      partId: String(item.partId ?? index + 1),
      filename: item.filename || `attachment-${index + 1}`,
      mimeType: item.mimeType || 'application/octet-stream',
      disposition: item.disposition || 'attachment',
      size: contentBytes(item.content).length,
      sha256: createHash('sha256').update(contentBytes(item.content)).digest('hex'),
      content: contentBytes(item.content),
    })),
  };
}

export function contentBytes(content) {
  if (content == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (typeof content === 'string') return Buffer.from(content);
  return Buffer.from(content);
}

function formatAddresses(value) {
  if (!value) return '';
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (typeof item === 'string') return item;
    return item?.name ? `${item.name} <${item.address}>` : item?.address || '';
  }).filter(Boolean).join(', ');
}
