export const hostImContract = Object.freeze({
  missingFrom: 'PluginAppContext',
  pluginEngine: '0.4.1',
  observedContext: Object.freeze(['settings', 'userHome', 'dataDir', 'signal', 'updateSettings', 'onActivity', 'focusSession']),
  requiredAddition: Object.freeze({
    name: 'im',
    send: '(input: { sessionId: string, text: string, idempotencyKey: string }) => Promise<{ delivered: true, id?: string } | { delivered: false, reason: string }>',
    consumer: 'kiki-mail App watcher, only after that account sets imEnabled and imSessionId',
  }),
  notASubstitute: Object.freeze(['panel session.sendMessage', 'focusSession', 'user-home token files', 'raw HTTP to an IM vendor']),
  credentials: 'Existing plugin settings with permissions.secrets. credentials is one secret string. No new secret API.',
});

export function resolveImSender(context, injected) {
  const candidate = injected ?? context?.im?.send;
  return typeof candidate === 'function' ? candidate : undefined;
}

export async function notifyIm(sender, input) {
  if (input.enabled !== true) return { delivered: false, skipped: true, reason: 'disabled' };
  if (!input.sessionId) return { delivered: false, skipped: true, reason: 'no-session' };
  if (typeof sender !== 'function') return { delivered: false, reason: 'host-im-unavailable' };
  const text = String(input.text ?? '');
  if (!text.trim()) return { delivered: false, reason: 'empty' };
  try {
    const result = await sender({ sessionId: input.sessionId, text, idempotencyKey: input.idempotencyKey });
    if (result?.delivered === true) return { delivered: true, id: typeof result.id === 'string' ? result.id : undefined };
    return { delivered: false, reason: typeof result?.reason === 'string' ? result.reason : 'rejected' };
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : 'im-send-failed' };
  }
}

export function summaryText(input) {
  const lines = [
    `New mail · ${input.label || input.accountId}`,
    `Folder: ${input.mailbox}`,
    `From: ${input.from || '(unknown)'}`,
    `Subject: ${input.subject || '(no subject)'}`,
  ];
  if (input.preview) lines.push('', input.preview);
  lines.push('', `Identity: ${input.identity.accountId} ${input.identity.mailbox} uidvalidity ${input.identity.uidValidity} uid ${input.identity.uid}`);
  return lines.join('\n').slice(0, 4000);
}
