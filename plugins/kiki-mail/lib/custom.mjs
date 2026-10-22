// A deliberately small data language, not a shell or JavaScript execution surface.
import { coded } from './accounts.mjs';

function object(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw coded('account_invalid', `${field} must be an object.`);
  return value;
}
function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw coded('account_invalid', `${field} needs a single line of at most ${max} characters.`);
  return value.trim();
}
function keys(value, allowed, field) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw coded('account_invalid', `${field} contains an unsupported field.`);
}
export function customFields(input) {
  const imapId = object(input.imapId, 'imapId');
  keys(imapId, ['name', 'version'], 'imapId');
  const identity = Object.fromEntries(Object.entries(imapId).map(([key, value]) => [key, text(value, `imapId.${key}`, 100)]));
  const folders = object(input.folders, 'folders');
  keys(folders, ['sent', 'drafts', 'trash', 'archive'], 'folders');
  const mapping = Object.fromEntries(Object.entries(folders).map(([key, value]) => [key, text(value, `folders.${key}`, 500)]));
  const headers = object(input.headers, 'headers');
  if (Object.keys(headers).length > 20) throw coded('account_invalid', 'Use at most 20 custom headers.');
  const outgoing = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!/^X-[A-Za-z0-9-]{1,70}$/i.test(key) || /(?:auth|token|secret|password|cookie|api-key)/i.test(key)) throw coded('account_invalid', 'Custom headers must be non-secret X- headers.');
    if (Object.keys(outgoing).some((other) => other.toLowerCase() === key.toLowerCase())) throw coded('account_invalid', 'Custom header names must be unique.');
    outgoing[key] = text(value, `headers.${key}`, 998);
  }
  const hooks = input.hooks ?? [];
  if (!Array.isArray(hooks) || hooks.length > 8) throw coded('account_invalid', 'Use at most 8 declarative hooks.');
  const rules = hooks.map((hook) => {
    object(hook, 'hook');
    if (hook?.event === 'beforeConnect' && hook.action === 'setTimeout') {
      keys(hook, ['event', 'action', 'value'], 'hook');
      if (!Number.isInteger(hook.value) || hook.value < 200 || hook.value > 120000) throw coded('account_invalid', 'setTimeout needs 200-120000 milliseconds.');
    } else if (hook?.event === 'afterSend' && hook.action === 'recordEvent') {
      keys(hook, ['event', 'action', 'value'], 'hook');
      text(hook.value, 'hook.value', 80);
    } else throw coded('hook_not_allowed', 'Allowed hooks: beforeConnect/setTimeout and afterSend/recordEvent. Commands and scripts are not accepted.');
    return { event: hook.event, action: hook.action, value: hook.value };
  });
  return { imapId: identity, folders: mapping, headers: outgoing, hooks: rules };
}
export function connectionAccount(account) {
  const rule = account.hooks?.filter((hook) => hook.event === 'beforeConnect' && hook.action === 'setTimeout').at(-1);
  return rule ? { ...account, timeoutMs: rule.value } : account;
}
export function folderPath(account, mailbox) {
  return account.folders?.[mailbox] || mailbox;
}
export function mappedMailboxes(account, boxes) {
  const special = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', archive: '\\Archive' };
  return boxes.map((box) => {
    const role = Object.keys(account.folders || {}).find((key) => account.folders[key] === box.path);
    return role ? { ...box, specialUse: special[role], role } : box;
  });
}
