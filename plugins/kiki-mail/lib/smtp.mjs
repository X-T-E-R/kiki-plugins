import { coded } from './accounts.mjs';
import { createTransport } from './runtime.mjs';
import { connectionAccount } from './custom.mjs';

export async function sendSmtp(account, auth, message, deps = {}) {
  account = connectionAccount(account);
  const trace = { dataCommand: false, messageWritten: false };
  const logger = {
    trace() {},
    debug(entry, format) {
      if (typeof format === 'string' && /^DATA\b/.test(format)) trace.dataCommand = true;
    },
    info(entry, format) {
      if (entry?.tnx === 'message' && typeof format === 'string' && format.includes('bytes encoded')) trace.messageWritten = true;
    },
    warn() {},
    error() {},
    fatal() {},
  };
  const transport = (deps.createTransport ?? createTransport)({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    ignoreTLS: !account.smtpSecure && account.allowInsecureAuth,
    requireTLS: !account.smtpSecure && !account.allowInsecureAuth,
    name: 'kiki-mail',
    connectionTimeout: account.timeoutMs,
    greetingTimeout: account.timeoutMs,
    socketTimeout: account.timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger,
    debug: true,
    auth: auth.accessToken
      ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken, expires: auth.expires }
      : { user: auth.user, pass: auth.pass },
    tls: account.smtpSecure ? { servername: account.smtpHost } : undefined,
  });
  const abort = () => transport.close();
  deps.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (deps.signal?.aborted) throw coded('cancelled', 'Send was cancelled before it started.');
    const info = await transport.sendMail({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyTo,
      references: message.references,
      messageId: message.messageId,
      headers: account.headers,
      attachments: message.attachments,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return {
      outcome: 'accepted',
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      pending: info.pending ?? [],
      messageId: info.messageId,
      smtpResponse: typeof info.response === 'string' ? info.response : '',
      finalDelivery: false,
    };
  } catch (error) {
    const outcome = classifySendError(error, trace);
    if (deps.signal?.aborted && outcome !== 'uncertain') {
      const cancelled = coded('cancelled', 'Send was cancelled before the message data was submitted.');
      cancelled.outcome = 'cancelled';
      throw cancelled;
    }
    const wrapped = coded(outcome === 'uncertain' ? 'uncertain_send' : error.code === 'EAUTH' ? 'auth_failed' : 'send_failed', safeSendMessage(outcome, error));
    wrapped.outcome = outcome;
    wrapped.command = error?.command;
    throw wrapped;
  } finally {
    deps.signal?.removeEventListener('abort', abort);
    transport.close();
  }
}

export function classifySendError(error, trace) {
  const code = error?.code;
  if (code === 'EAUTH') return 'auth_failed';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'rejected';
  if (trace?.messageWritten || trace?.dataCommand) return 'uncertain';
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ETLS') return 'failed';
  return 'failed';
}

function safeSendMessage(outcome, error) {
  if (outcome === 'uncertain') return 'The SMTP server stopped responding after the message data was written. Acceptance is unknown, so the message was not sent again.';
  if (outcome === 'auth_failed') return 'SMTP authentication failed.';
  if (outcome === 'rejected') return 'The SMTP server rejected the message before accepting it.';
  if (error?.code === 'ECONNECTION' || error?.code === 'ESOCKET') return 'The SMTP connection closed before the message was written.';
  if (error?.code === 'ETIMEDOUT') return 'The SMTP server did not respond in time.';
  return 'The message was not accepted by the SMTP server.';
}
