function requestTarget(request, accountId) {
  if (!request || typeof request !== 'object' || Object.keys(request).some((key) => !['chatId', 'topicId', 'cursor', 'limit'].includes(key))
    || typeof request.chatId !== 'string' || !request.chatId.length || request.chatId.length > 1024
    || typeof request.topicId !== 'string' || !request.topicId.length || request.topicId.length > 1024
    || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50) throw new Error('Invalid QQ history request');
  const group = /^onebot:group:([1-9]\d*)$/u.exec(request.chatId);
  if (!group) return undefined;
  let anchor, sourceMessageId;
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/u.test(request.cursor)) throw new Error('Invalid QQ history cursor');
    let cursor;
    try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid QQ history cursor'); }
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).some((key) => !['v', 'accountId', 'chatId', 'topicId', 'anchor', 'sourceMessageId'].includes(key))
      || cursor.v !== 1 || cursor.accountId !== accountId || cursor.chatId !== request.chatId || cursor.topicId !== request.topicId
      || typeof cursor.anchor !== 'string' || !/^-?\d{1,1024}$/u.test(cursor.anchor)
      || typeof cursor.sourceMessageId !== 'string' || !/^-?\d{1,1024}$/u.test(cursor.sourceMessageId)) throw new Error('QQ history cursor does not belong to this account/chat/topic');
    anchor = cursor.anchor; sourceMessageId = cursor.sourceMessageId;
  }
  return { groupId: group[1], anchor, sourceMessageId };
}
function projectedMessage(message, accountId) {
  let partial = false;
  const bounded = (value, limit) => {
    if (typeof value !== 'string') return undefined;
    if (value.length > limit) { partial = true; return value.slice(0, limit); }
    return value;
  };
  const identity = message.identity;
  if (typeof message.sourceMessageId !== 'string' || !message.sourceMessageId.length || message.sourceMessageId.length > 1024
    || ['chatId', 'senderId', 'topicId'].some((key) => typeof identity?.[key] !== 'string' || !identity[key].length || identity[key].length > 1024)) return { partial: true };
  const mentions = (message.mentionIds ?? []).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 1024);
  if (mentions.length !== (message.mentionIds?.length ?? 0) || mentions.length > 1000 || message.attachments.length > 4) partial = true;
  const replyToMessageId = message.replyToMessageId?.length > 1024 ? undefined : message.replyToMessageId;
  if (message.replyToMessageId !== replyToMessageId) partial = true;
  const timestamp = message.time * 1000;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) partial = true;
  const media = message.deleted ? [] : message.attachments.slice(0, 4).map((item) => ({ kind: bounded(item.kind, 128), name: bounded(item.name, 1024), mediaType: bounded(item.mediaType, 128) }));
  const result = { sourceMessageId: message.sourceMessageId, identity: { chatId: identity.chatId, senderId: identity.senderId, topicId: identity.topicId,
    chatKind: identity.chatKind, chatTitle: bounded(identity.chatTitle, 4096), senderName: bounded(identity.senderName, 4096), topicTitle: bounded(identity.topicTitle, 4096) },
    kind: message.text || !media.length ? 'text' : media[0].kind,
    operation: message.deleted ? 'retract' : 'create', isSelf: identity.senderId === `onebot:user:${accountId}`,
    timestamp: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined,
    text: message.deleted ? undefined : bounded(message.text, 16384), mentioned: message.mentioned,
    mentionIds: mentions.slice(0, 1000), replyToMessageId, media: media.length ? media : undefined };
  return { message: result, partial };
}

export async function readOneBotHistory(client, request, signal) {
  const accountId = client.accountId;
  const target = requestTarget(request, accountId);
  if (!target) return { status: 'unsupported', detail: 'QQ adapter history is only available for OneBot group chats' };
  signal?.throwIfAborted();
  const count = request.limit + (target.anchor === undefined ? 0 : 1);
  const page = await client.getGroupHistory({ groupId: target.groupId, messageSeq: target.anchor, count, topicId: request.topicId, signal });
  signal?.throwIfAborted();
  if (page.status === 'unsupported') return { status: 'unsupported', detail: String(page.detail ?? 'OneBot history is unsupported').slice(0, 4096) };
  if (!['ok', 'empty', 'partial'].includes(page.status)) throw new Error(`QQ history ${page.status}: ${page.reason ?? ''}; ${page.detail ?? ''}`.slice(0, 4096));
  if (page.accountId !== accountId) throw new Error('QQ history account changed while reading');
  let partial = page.status === 'partial' || page.messages.length > count;
  const boundary = target.anchor === undefined ? -1 : page.messages.findIndex((item) => item.sourceMessageId === target.sourceMessageId || item.messageSeq === target.anchor);
  const candidates = boundary < 0 ? page.messages : page.messages.slice(0, boundary);
  const messages = [], selected = candidates.slice(-request.limit);
  for (const item of selected) {
    const projected = projectedMessage(item, accountId);
    partial ||= projected.partial;
    if (projected.message) messages.push(projected.message);
  }
  const anchor = selected[0]?.messageSeq, sourceMessageId = selected[0]?.sourceMessageId;
  const nextCursor = typeof anchor === 'string' && /^-?\d{1,1024}$/u.test(anchor) && anchor !== target.anchor
    && typeof sourceMessageId === 'string' && /^-?\d{1,1024}$/u.test(sourceMessageId) && sourceMessageId !== target.sourceMessageId
    ? Buffer.from(JSON.stringify({ v: 1, accountId, chatId: request.chatId, topicId: request.topicId, anchor, sourceMessageId })).toString('base64url') : undefined;
  return { status: 'ok', messages, order: 'chronological', nextCursor, coverage: partial ? 'partial' : 'unknown', end: 'unknown' };
}
