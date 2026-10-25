const OFFICIAL_PREFIX = 'official:';
const ONEBOT_PREFIX = 'onebot:';

function required(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  if (/[:\u0000-\u001f]/u.test(text)) throw new Error(`${name} contains a reserved character`);
  return text;
}

function scoped(prefix, kind, value) {
  return `${prefix}${kind}:${required(value, kind)}`;
}

export function officialIdentity({ userOpenid, groupOpenid, topicId, senderName, chatTitle, topicTitle } = {}) {
  const user = required(userOpenid, 'official user_openid');
  const group = groupOpenid === undefined ? undefined : required(groupOpenid, 'official group_openid');
  const chatKind = group === undefined ? 'private' : 'group';
  const chatId = group === undefined ? scoped(OFFICIAL_PREFIX, 'c2c', user) : scoped(OFFICIAL_PREFIX, 'group', group);
  return {
    chatId,
    senderId: scoped(OFFICIAL_PREFIX, 'user', user),
    topicId: topicId === undefined || topicId === null || String(topicId).trim() === ''
      ? chatId
      : scoped(OFFICIAL_PREFIX, 'topic', topicId),
    chatKind,
    ...(senderName ? { senderName: String(senderName) } : {}),
    ...(chatTitle ? { chatTitle: String(chatTitle) } : {}),
    ...(topicTitle ? { topicTitle: String(topicTitle) } : {}),
  };
}

export function onebotIdentity({ userId, groupId, topicId, senderName, chatTitle, topicTitle } = {}) {
  const user = required(userId, 'OneBot user_id');
  const group = groupId === undefined ? undefined : required(groupId, 'OneBot group_id');
  const chatKind = group === undefined ? 'private' : 'group';
  const chatId = group === undefined ? scoped(ONEBOT_PREFIX, 'private', user) : scoped(ONEBOT_PREFIX, 'group', group);
  return {
    chatId,
    senderId: scoped(ONEBOT_PREFIX, 'user', user),
    topicId: topicId === undefined || topicId === null || String(topicId).trim() === ''
      ? chatId
      : scoped(ONEBOT_PREFIX, 'topic', topicId),
    chatKind,
    ...(senderName ? { senderName: String(senderName) } : {}),
    ...(chatTitle ? { chatTitle: String(chatTitle) } : {}),
    ...(topicTitle ? { topicTitle: String(topicTitle) } : {}),
  };
}

export function parseIdentity(identity, expectedPlatform) {
  if (!identity || typeof identity !== 'object') throw new Error('Identity is required');
  const prefix = expectedPlatform === 'official' ? OFFICIAL_PREFIX : expectedPlatform === 'onebot' ? ONEBOT_PREFIX : undefined;
  if (!prefix || typeof identity.chatId !== 'string' || typeof identity.senderId !== 'string' || typeof identity.topicId !== 'string') throw new Error('Malformed platform identity');
  if (!identity.chatId.startsWith(prefix) || !identity.senderId.startsWith(prefix) || !identity.topicId.startsWith(prefix)) throw new Error(`Identity belongs to a different QQ platform: expected ${expectedPlatform}`);
  const chatParts = identity.chatId.slice(prefix.length).split(':');
  const scopes = expectedPlatform === 'official' ? ['c2c', 'group'] : ['private', 'group'];
  if (chatParts.length !== 2 || !scopes.includes(chatParts[0])) throw new Error('Malformed chat identity');
  const targetId = required(chatParts[1], 'chat target');
  if (!identity.senderId.startsWith(`${prefix}user:`)) throw new Error('Malformed sender identity');
  required(identity.senderId.slice(`${prefix}user:`.length), 'sender');
  if (expectedPlatform === 'onebot' && !/^\d+$/.test(targetId)) throw new Error('OneBot target must be numeric');
  if (identity.topicId !== identity.chatId) throw Object.assign(new Error('This QQ protocol cannot address an independent topic; no message was sent'), { code: 'UNSUPPORTED', kind: 'topic' });
  return {
    scope: chatParts[0] === 'group' ? 'group' : 'c2c',
    targetId,
    chatId: identity.chatId,
  };
}

export function samePlatformIdentity(left, right) {
  return typeof left?.chatId === 'string' && typeof right?.chatId === 'string' && left.chatId.split(':', 1)[0] === right.chatId.split(':', 1)[0];
}

export const identityPrefixes = Object.freeze({ official: OFFICIAL_PREFIX, onebot: ONEBOT_PREFIX });
