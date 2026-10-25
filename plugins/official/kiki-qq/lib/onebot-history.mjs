import { normalizeOneBotSegments, parseCqMessage } from './attachments.mjs';
import { onebotIdentity } from './identity.mjs';

function protocolId(value, name, { signed = false } = {}) {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!(signed ? /^-?\d+$/u : /^[1-9]\d*$/u).test(text)) throw Object.assign(new Error(`${name} is not a valid protocol ID`), { code: 'INVALID_RESPONSE' });
  return text;
}
function chatId(value) {
  if (typeof value !== 'string' || !/^onebot:(group|private):[1-9]\d*$/u.test(value)) throw Object.assign(new Error('chatId must be a OneBot group/private identity'), { code: 'CONFIGURATION' });
  return value;
}
function messageRecord(raw, { accountId, expectedChatId, expectedTopicId, sourceMessageId } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Message is not an object');
  if (raw.self_id !== undefined && protocolId(raw.self_id, 'self_id') !== accountId) throw Object.assign(new Error('Message belongs to another OneBot account'), { code: 'ACCOUNT_CHANGED' });
  const id = protocolId(raw.message_id, 'message_id', { signed: true });
  if (sourceMessageId !== undefined && id !== sourceMessageId) throw new Error('Returned source message ID differs from the requested ID');
  const senderId = protocolId(raw.user_id ?? raw.sender?.user_id, 'sender user_id');
  if (raw.sender?.user_id !== undefined && protocolId(raw.sender.user_id, 'sender user_id') !== senderId) throw new Error('Message has inconsistent sender IDs');
  if (!['group', 'private'].includes(raw.message_type)) throw new Error('Message has no supported message_type');
  const groupId = raw.message_type === 'group' ? protocolId(raw.group_id, 'group_id') : undefined;
  if (raw.message_type === 'private' && senderId === accountId) throw new Error('Outgoing private message has no proven peer identity');
  const identity = onebotIdentity({ userId: senderId, groupId, topicId: raw.topic_id ?? raw.thread_id,
    senderName: raw.sender?.card || raw.sender?.nickname, chatTitle: raw.group_name });
  if (identity.chatId !== expectedChatId || expectedTopicId !== undefined && identity.topicId !== expectedTopicId) throw new Error('Message chat/topic differs from the requested source identity');
  const time = typeof raw.time === 'number' ? raw.time : typeof raw.time === 'string' && /^\d+$/u.test(raw.time) ? Number(raw.time) : NaN;
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Message has no valid Unix-seconds time');
  if (typeof raw.message !== 'string' && !Array.isArray(raw.message)) throw new Error('Message has no string/segment content');
  const segments = Array.isArray(raw.message) ? raw.message : parseCqMessage(raw.message);
  const parsed = normalizeOneBotSegments(segments);
  const mediaSegments = segments.filter((item) => ['image', 'record', 'voice', 'video', 'file'].includes(String(item?.type ?? '').toLowerCase()));
  const attachments = parsed.media.map((item, index) => {
    const data = mediaSegments[index]?.data;
    const size = Number(data?.file_size);
    return { ...item, size: item.size ?? (Number.isSafeInteger(size) && size >= 0 ? size : undefined),
      fileId: typeof data?.file_id === 'string' ? data.file_id : undefined };
  });
  const replyToMessageId = parsed.replyTo === undefined ? undefined : protocolId(parsed.replyTo, 'reply ID', { signed: true });
  return { sourceMessageId: id, identity, time, text: parsed.text, segments,
    messageSeq: raw.message_seq === undefined ? undefined : protocolId(raw.message_seq, 'message_seq', { signed: true }),
    mentioned: parsed.mentions.some((item) => item.kind === 'all' || item.id === accountId),
    mentionIds: parsed.mentions.map((item) => item.id), replyToMessageId,
    attachments, deleted: raw.status === 'deleted' || undefined };
}
function readFailure(error, action, signal) {
  const detail = String(error?.message ?? error);
  const evidence = { detail, providerCode: Number.isFinite(error?.bizCode) ? error.bizCode : undefined, httpStatus: error?.status || undefined };
  if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled', ...evidence };
  if (error?.code === 'ACCOUNT_CHANGED') return { status: 'unavailable', reason: 'account_mismatch', ...evidence };
  if (error?.readPhase === 'identity') return { status: 'unavailable', reason: 'identity_unavailable', ...evidence };
  const missingAction = error?.status === 404 || error?.bizCode === 1404
    || error?.bizCode === 200 && new RegExp(`^不支持的api\\s+${action}$`, 'iu').test(detail);
  if (missingAction) return { status: 'unsupported', reason: 'endpoint_unsupported', ...evidence };
  if (!error?.code || ['TIMEOUT', 'NETWORK_ERROR', 'OUTCOME_UNKNOWN', 'INVALID_RESPONSE', 'REDIRECT'].includes(error.code) || error?.status >= 500) return { status: 'unknown', reason: 'response_unavailable', ...evidence };
  return { status: 'unavailable', reason: 'provider_rejected', ...evidence };
}

export function createOneBotHistory({ read, getAccountId, transport }) {
  const envelope = (result) => ({ ...result, accountId: getAccountId(), transport, end: 'unknown' });
  async function getMessage({ sourceMessageId, chatId: expected, topicId, signal } = {}) {
    const id = protocolId(sourceMessageId, 'sourceMessageId', { signed: true });
    const expectedChatId = chatId(expected);
    try {
      const raw = await read('get_msg', { message_id: id }, signal);
      const message = messageRecord(raw, { accountId: getAccountId(), expectedChatId, expectedTopicId: topicId, sourceMessageId: id });
      return envelope({ status: 'ok', messages: [message] });
    } catch (error) { return envelope({ ...readFailure(error, 'get_msg', signal), messages: [] }); }
  }
  async function getGroupHistory({ groupId, messageSeq, count = 20, topicId, signal } = {}) {
    const group = protocolId(groupId, 'groupId');
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw Object.assign(new Error('count must be an integer from 1 to 100'), { code: 'CONFIGURATION' });
    const anchor = messageSeq === undefined ? undefined : protocolId(messageSeq, 'messageSeq', { signed: true });
    try {
      const raw = await read('get_group_msg_history', { group_id: group, count, message_seq: anchor,
        reverse_order: false, reverseOrder: false, disable_get_url: true, parse_mult_msg: false }, signal);
      if (!raw || !Array.isArray(raw.messages)) throw Object.assign(new Error('Group history response has no messages array'), { code: 'INVALID_RESPONSE' });
      const messages = [], issues = [], seen = new Set();
      for (const [index, item] of raw.messages.entries()) {
        try {
          const message = messageRecord(item, { accountId: getAccountId(), expectedChatId: `onebot:group:${group}`, expectedTopicId: topicId });
          if (seen.has(message.sourceMessageId)) continue;
          seen.add(message.sourceMessageId); messages.push(message);
        } catch (error) {
          if (error.code === 'ACCOUNT_CHANGED') throw error;
          issues.push({ index, detail: error.message });
        }
      }
      messages.sort((left, right) => left.time - right.time);
      return envelope({ status: issues.length ? 'partial' : messages.length ? 'ok' : 'empty', messages,
        order: 'oldest_first', anchor, receivedCount: raw.messages.length, omittedCount: issues.length,
        ...(issues.length ? { issues } : {}) });
    } catch (error) { return envelope({ ...readFailure(error, 'get_group_msg_history', signal), messages: [] }); }
  }
  return { getMessage, getGroupHistory };
}
