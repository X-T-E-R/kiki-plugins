const CHANNEL_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_KINDS = new Set(['auth', 'forbidden', 'not_found', 'rate_limited', 'transient', 'too_long', 'bad_format', 'dependency_missing', 'configuration', 'protocol', 'unknown']);
const DIGEST_MAX_UTF8_BYTES = 16384;
const OPEN_FAILURE = new Set(['im_unsupported', 'notifications_disabled', 'route_unavailable', 'route_disabled', 'route_changed', 'provider_unavailable', 'credential_unavailable', 'bad_format', 'too_long', 'idempotency_conflict', 'cancelled']);
const settled = new Map();

export function bridgeFrom(context) {
  const im = context?.im;
  if (!im || typeof im.capabilities !== 'function' || typeof im.listRoutes !== 'function' || typeof im.send !== 'function') return undefined;
  return im;
}

export function idleBridgeView(bridge) {
  return { supported: Boolean(bridge), outbound: false, inbound: false, probed: false };
}

export async function inspectIm(bridge, signal, { list = false } = {}) {
  if (!bridge) return { supported: false, outbound: false, inbound: false, probed: true, reason: 'unsupported', routes: [] };
  const caps = await bridge.capabilities(signal);
  const outbound = caps?.outbound === true;
  const view = { supported: true, outbound, inbound: false, probed: true, routes: [] };
  if (!outbound) view.reason = 'outbound-unavailable';
  if (list && outbound) view.routes = sanitizeRoutes(await bridge.listRoutes(signal));
  if (outbound && list && view.routes.length === 0) view.reason = 'no-route';
  return view;
}

export async function forwardMailDigest(bridge, input, signal) {
  if (input?.enabled !== true) return { status: 'skipped', reason: 'disabled', sent: false, attempts: 0 };
  const request = {
    channelId: input?.channelId,
    routeRevision: input?.routeRevision,
    idempotencyKey: input?.idempotencyKey,
    accountRef: input?.accountRef,
    text: digestText(input?.text),
  };
  if (typeof request.accountRef === 'string' && typeof request.idempotencyKey === 'string') {
    const prior = settled.get(receiptKey(request));
    if (prior) return { ...prior, sent: false, attempts: 0, duplicate: true };
  }
  if (!bridge) return unsupported();
  if (!CHANNEL_RE.test(request.accountRef || '') || !KEY_RE.test(request.idempotencyKey || '') || !request.text) {
    return { status: 'failed', retryable: true, diagnosticCode: 'bad_format', errorKind: 'bad_format', sent: false, attempts: 0 };
  }
  if (Buffer.byteLength(request.text) > DIGEST_MAX_UTF8_BYTES) {
    return { status: 'failed', retryable: true, diagnosticCode: 'too_long', errorKind: 'too_long', sent: false, attempts: 0 };
  }
  if (!CHANNEL_RE.test(request.channelId || '') || !REVISION_RE.test(request.routeRevision || '')) {
    return { status: 'skipped', reason: 'no-route', sent: false, attempts: 0 };
  }
  let caps;
  try {
    caps = await bridge.capabilities(signal);
  } catch (error) {
    if (signal?.aborted || error?.message === 'cancelled') return cancelledReceipt(0);
    return unsupported();
  }
  if (caps?.outbound !== true) return unsupported();
  let attempts = 0;
  const once = async () => {
    attempts += 1;
    return bridge.send(request, signal);
  };
  try {
    const receipt = normalizeReceipt(await once());
    if (receipt.diagnosticCode === 'route_changed') return routeChanged(bridge, receipt, signal, attempts);
    remember(request, receipt);
    return { ...receipt, sent: true, attempts };
  } catch (error) {
    if (timedOut(error)) {
      try {
        const receipt = normalizeReceipt(await once());
        if (receipt.diagnosticCode === 'route_changed') {
          const changed = await routeChanged(bridge, receipt, signal, attempts);
          return { ...changed, lookedUp: true };
        }
        remember(request, receipt);
        return { ...receipt, sent: true, attempts, lookedUp: true };
      } catch {
        const receipt = { status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' };
        remember(request, receipt);
        return { ...receipt, sent: true, attempts };
      }
    }
    if (signal?.aborted || error?.message === 'cancelled') return cancelledReceipt(attempts);
    const receipt = { status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' };
    remember(request, receipt);
    return { ...receipt, sent: true, attempts };
  }
}

export function digestText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
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
  return digestText(lines.join('\n'));
}

function receiptKey(request) {
  return `${request.accountRef}\0${request.idempotencyKey}`;
}

function remember(request, receipt) {
  if (['accepted', 'unknown', 'suppressed', 'queued'].includes(receipt.status)) settled.set(receiptKey(request), receipt);
  else if (receipt.status === 'failed' && receipt.diagnosticCode && !OPEN_FAILURE.has(receipt.diagnosticCode)) settled.set(receiptKey(request), receipt);
}

function unsupported() {
  return { status: 'failed', retryable: false, diagnosticCode: 'im_unsupported', errorKind: 'dependency_missing', sent: false, attempts: 0 };
}

function cancelledReceipt(attempts) {
  return { status: 'cancelled', retryable: false, diagnosticCode: 'cancelled', sent: false, attempts };
}

async function routeChanged(bridge, receipt, signal, attempts) {
  let routes = [];
  try { routes = sanitizeRoutes(await bridge.listRoutes(signal)); } catch { routes = []; }
  return { ...receipt, routes, resent: false, sent: false, attempts };
}

function sanitizeRoutes(value) {
  if (!Array.isArray(value)) return [];
  return value.map((route) => {
    if (!route || !CHANNEL_RE.test(route.channelId || '') || !REVISION_RE.test(route.routeRevision || '')) return undefined;
    const next = {
      channelId: route.channelId,
      providerId: typeof route.providerId === 'string' ? route.providerId : '',
      routeRevision: route.routeRevision,
    };
    if (typeof route.label === 'string' && route.label.length > 0 && route.label.length <= 80 && !/[\r\n\0]/.test(route.label)) next.label = route.label;
    return next;
  }).filter(Boolean);
}

function normalizeReceipt(receipt) {
  const status = ['queued', 'accepted', 'failed', 'unknown', 'suppressed', 'cancelled'].includes(receipt?.status) ? receipt.status : 'unknown';
  const next = { status, retryable: receipt?.retryable === true && !['accepted', 'unknown', 'suppressed', 'queued', 'cancelled'].includes(status) };
  if (CODE_RE.test(receipt?.diagnosticCode || '')) next.diagnosticCode = receipt.diagnosticCode;
  if (ERROR_KINDS.has(receipt?.errorKind)) next.errorKind = receipt.errorKind;
  return next;
}

function timedOut(error) {
  return error instanceof Error && error.message.includes('IM bridge timed out');
}
