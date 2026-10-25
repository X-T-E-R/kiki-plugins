/** Per-connection adaptation of DSH QQ msgid-cache/reply-limiter; no Host sessions. */
export function createReplyContext({ now = Date.now } = {}) {
  const targets = new Map();
  const keyFor = (identity) => `${identity.chatId}/${identity.topicId}`;
  function observe(event) {
    const kind = event.kind === 'callback' ? 'event' : 'msg';
    const id = kind === 'event' ? event.callbackQueryId : event.sourceMessageId;
    if (!id) return;
    const key = keyFor(event.identity);
    const entries = targets.get(key) ?? [];
    if (entries.some((entry) => entry.id === id && entry.kind === kind)) return;
    entries.push({ id, kind, seenAt: now(), count: 0 });
    if (entries.length > 10) entries.shift();
    targets.delete(key); targets.set(key, entries);
    if (targets.size > 200) targets.delete(targets.keys().next().value);
  }
  function reserve(identity, { allowEvent = true } = {}) {
    const entries = targets.get(keyFor(identity)) ?? [];
    const ttl = identity.chatKind === 'group' || identity.chatId.startsWith('official:group:') ? 300000 : 1800000;
    for (const entry of [...entries].reverse()) {
      if (now() - entry.seenAt >= ttl || entry.count >= 4 || (!allowEvent && entry.kind === 'event')) continue;
      entry.count += 1;
      return entry.kind === 'event'
        ? { event_id: entry.id.startsWith('INTERACTION_CREATE:') ? entry.id : `INTERACTION_CREATE:${entry.id}`, msg_seq: entry.count }
        : { msg_id: entry.id, msg_seq: entry.count };
    }
    return { msg_seq: 1 };
  }
  return { observe, reserve, clear() { targets.clear(); } };
}
