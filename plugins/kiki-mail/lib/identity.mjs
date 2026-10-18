export function messageIdentity(accountId, mailbox, uidValidity, uid) {
  return {
    accountId: String(accountId),
    mailbox: String(mailbox),
    uidValidity: normalizeId(uidValidity),
    uid: normalizeId(uid),
  };
}

export function normalizeId(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value ?? '').trim();
}

export function sameIdentity(left, right) {
  if (!left || !right) return false;
  return left.accountId === right.accountId
    && left.mailbox === right.mailbox
    && left.uidValidity === right.uidValidity
    && left.uid === right.uid;
}

export function idempotencyKey(identity) {
  return `${identity.accountId}\n${identity.mailbox}\n${identity.uidValidity}\n${identity.uid}`;
}
