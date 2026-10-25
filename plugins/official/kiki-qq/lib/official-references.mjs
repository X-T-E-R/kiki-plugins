/** Adapted from qqbot-nodejs 1.0.5 quote-ref: bounded per-account, per-chat ref-index association. */
export function createOfficialReferences() {
  const entries = new Map();
  const key = (identity, index) => JSON.stringify([identity.chatId, identity.topicId, index]);
  function record(identity, index, messageId) {
    if (typeof index !== 'string' || !index || typeof messageId !== 'string' || !messageId) return;
    const name = key(identity, index);
    entries.delete(name); entries.set(name, messageId);
    if (entries.size > 500) entries.delete(entries.keys().next().value);
  }
  function resolve(identity, index) { return entries.get(key(identity, index)); }
  return { record, resolve, clear() { entries.clear(); } };
}

export function quotePreview(raw, refMsgIdx, resolvedId) {
  if (!refMsgIdx) return undefined;
  const quote = (raw.msg_elements ?? []).find((element) => element.msg_idx === refMsgIdx) ?? raw.msg_elements?.[0];
  const lines = [`[QQ quoted message ref_index=${JSON.stringify(refMsgIdx)}${resolvedId ? ` message_id=${JSON.stringify(resolvedId)}` : ' (message ID unavailable)'}]`];
  if (quote?.content) lines.push(String(quote.content));
  for (const attachment of quote?.attachments ?? []) {
    lines.push(`[Quoted attachment: ${JSON.stringify(attachment.filename ?? 'attachment')}; type=${JSON.stringify(attachment.content_type ?? 'unknown')}; not a new attachment from the current sender]`);
    if (attachment.asr_refer_text) lines.push(`[QQ quoted ASR reference] ${String(attachment.asr_refer_text)}`);
  }
  return lines.join('\n');
}
