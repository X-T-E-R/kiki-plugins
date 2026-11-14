import { createHash } from 'node:crypto';

const KEY_SAFE = /^[A-Za-z0-9_.:-]{1,200}$/;

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
  const mailbox = Buffer.from(String(identity.mailbox), 'utf8').toString('hex');
  const key = `${identity.accountId}:${mailbox}:${identity.uidValidity}:${identity.uid}`;
  if (KEY_SAFE.test(key)) return key;
  return `${identity.accountId}:${createHash('sha256').update(key).digest('hex')}`.slice(0, 200);
}
