import { attachmentListFromOfficial, normalizeOneBotSegments } from './attachments.mjs';
import { officialIdentity, onebotIdentity } from './identity.mjs';
import { quotePreview } from './official-references.mjs';
import { dispatchEvent } from '../vendor/qqbot-gateway/event-dispatcher.js';

const OFFICIAL_MESSAGE_TYPES = new Set(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']);
function unixTimestamp(value) {
  const seconds = typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : NaN;
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
function messageId(value) {
  return typeof value === 'string' && /^-?\d+$/u.test(value) || typeof value === 'number' && Number.isSafeInteger(value);
}
function messageEvent(base, text, media, { maxInboundBytes = 8 * 1024 * 1024, keepEmpty = false } = {}) {
  const { preview, ...metadata } = base;
  const parts = [];
  if (text || (!media.length && keepEmpty)) parts.push({ kind: 'text', text: text || '' });
  if (preview) parts.push({ kind: 'text', text: preview });
  for (const descriptor of media) parts.push({ kind: descriptor.kind,
    text: descriptor.asrText ? `[QQ ASR reference] ${descriptor.asrText}` : undefined,
    tooLarge: descriptor.size > maxInboundBytes || undefined, attachment: descriptor });
  return parts.length ? [{ ...metadata, kind: 'message', parts }] : [];
}
export function normalizeOfficialEvent(raw, { eventType, cursor, maxInboundBytes, message, references } = {}) {
  if (!raw || typeof raw !== 'object' || !raw.id) return [];
  const type = eventType ?? raw.t ?? raw.event_type;
  if (type === 'INTERACTION_CREATE') return interaction(raw, cursor);
  if (!OFFICIAL_MESSAGE_TYPES.has(type)) return [];
  const group = type !== 'C2C_MESSAGE_CREATE';
  const userOpenid = raw.author?.user_openid ?? raw.author?.member_openid;
  if (!userOpenid || (group && !raw.group_openid)) return [];
  const metadata = { ...dispatchEvent(type, raw, '').msg, ...message };
  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
  const mentionIds = mentions.map((item) => item.user_openid ?? item.member_openid ?? item.id).filter(Boolean).map(String);
  const identity = officialIdentity({ userOpenid, groupOpenid: group ? raw.group_openid : undefined,
    topicId: raw.topic_id ?? raw.message_thread_id ?? raw.thread_id, senderName: raw.author?.username ?? raw.author?.nickname, chatTitle: raw.group_name });
  const refMsgIdx = metadata?.refMsgIdx;
  const resolved = refMsgIdx ? references?.resolve(identity, refMsgIdx) : undefined;
  references?.record(identity, metadata?.msgIdx, String(raw.id));
  const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  const base = { eventId: `official:${raw.id}`, sourceMessageId: String(raw.id), cursor, identity, operation: 'create',
    timestamp: Number.isSafeInteger(at) && at >= 0 ? at : undefined,
    mentioned: type === 'GROUP_AT_MESSAGE_CREATE' || mentions.some((item) => item.is_you === true), mentionIds,
    replyToMessageId: typeof raw.message_reference?.message_id === 'string' && raw.message_reference.message_id ? raw.message_reference.message_id : resolved,
    preview: quotePreview(raw, refMsgIdx, resolved) };
  const text = base.mentioned ? String(raw.content ?? '').replace(/^\s*<@!?[^>]+>\s*/u, '').trim() : String(raw.content ?? '').trim();
  return messageEvent(base, text, attachmentListFromOfficial(raw, { refMsgIdx }), { maxInboundBytes, keepEmpty: base.mentioned || Boolean(refMsgIdx) });
}
function interaction(raw, cursor) {
  const userOpenid = raw.user_openid ?? raw.group_member_openid ?? raw.member_openid;
  if (!userOpenid) return [];
  const data = raw.data?.resolved ?? raw.data ?? {};
  if (data.button_data === undefined && data.button_id === undefined) return [];
  return [{ eventId: `official:${raw.id}`, cursor, identity: officialIdentity({ userOpenid, groupOpenid: raw.group_openid }),
    kind: 'callback', callbackData: String(data.button_data ?? data.button_id), callbackQueryId: String(raw.id),
    replyToMessageId: data.message_id ? String(data.message_id) : undefined }];
}
export function normalizeOneBotEvent(raw, { cursor, selfId, maxInboundBytes } = {}) {
  if (!raw || !messageId(raw.message_id)) return [];
  if (raw.post_type === 'notice' && ['group_recall', 'friend_recall'].includes(raw.notice_type)) {
    const groupId = raw.notice_type === 'group_recall' ? raw.group_id : undefined;
    if (raw.user_id === undefined || raw.notice_type === 'group_recall' && groupId === undefined) return [];
    return [{ eventId: `onebot:retract:${raw.notice_type}:${raw.message_id}:${raw.time ?? ''}`, sourceMessageId: String(raw.message_id), cursor,
      identity: onebotIdentity({ userId: raw.user_id, groupId }), kind: 'text', operation: 'retract',
      isSelf: selfId === undefined ? undefined : String(raw.user_id) === String(selfId), timestamp: unixTimestamp(raw.time) }];
  }
  if (!['message', 'message_sent'].includes(raw.post_type) || !['private', 'group'].includes(raw.message_type)) return [];
  const userId = raw.user_id ?? raw.sender?.user_id;
  const groupId = raw.message_type === 'group' ? raw.group_id : undefined;
  if (userId === undefined || (raw.message_type === 'group' && groupId === undefined)) return [];
  const parsed = normalizeOneBotSegments(raw.message ?? raw.raw_message ?? '', { includeAsrText: false });
  const mentioned = parsed.mentions.some((item) => item.kind === 'all' || (selfId !== undefined && String(item.id) === String(selfId)));
  const identity = onebotIdentity({ userId, groupId, topicId: raw.topic_id ?? raw.thread_id, senderName: raw.sender?.card || raw.sender?.nickname, chatTitle: raw.group_name });
  const isSelf = selfId === undefined ? undefined : String(userId) === String(selfId);
  if (raw.message_type === 'private' && isSelf) return [];
  const base = { eventId: `onebot:${raw.message_id}`, sourceMessageId: String(raw.message_id), cursor, identity,
    operation: 'create', isSelf, timestamp: unixTimestamp(raw.time),
    mentioned, mentionIds: parsed.mentions.map((item) => String(item.id)), replyToMessageId: parsed.replyTo };
  return messageEvent(base, parsed.text, parsed.media, { maxInboundBytes, keepEmpty: mentioned || Boolean(parsed.replyTo) });
}
export function normalizeGatewayPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return [];
  const data = payload.d ?? payload.data ?? payload;
  if (options.platform === 'official') return normalizeOfficialEvent(data, { ...options, eventType: payload.t ?? payload.event_type, cursor: payload.s ?? options.cursor });
  if (options.platform === 'onebot') return normalizeOneBotEvent(data, options);
  return [];
}
