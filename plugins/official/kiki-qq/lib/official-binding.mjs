import { randomUUID } from 'node:crypto';
import { startQrConnect, renderQrDataUrl } from '../vendor/qqbot-binding/binding.mjs';
import { BIND_ACTIONS, OFFICIAL_INSTANCE_ID } from './bind-contract.mjs';

const credentialKeys = ['official__appId', 'official__appSecret'];
const credentials = settings => credentialKeys.map(key => settings?.[key] ?? '');
const sameCredentials = (left, right) => left.every((value, index) => value === right[index]);
const validToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const validCredential = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);

export class OfficialBinding {
  constructor({ connect = startQrConnect, renderQr = renderQrDataUrl } = {}) {
    this.connect = connect;
    this.renderQr = renderQr;
    this.generation = 0;
    this.settings = {};
  }
  activate(context) {
    this.context = context;
    this.settings = { ...context.settings };
    if (this.signal !== context.signal) {
      this.detach?.();
      this.signal = context.signal;
      const abort = () => this.deactivate();
      context.signal.addEventListener('abort', abort, { once: true });
      this.detach = () => context.signal.removeEventListener('abort', abort);
    }
    if (context.signal.aborted) this.deactivate();
  }
  deactivate() {
    this.retire();
    this.detach?.();
    this.detach = undefined;
    this.context = undefined;
    this.settings = {};
  }
  stop(request) {
    request.controller.abort();
    request.stop?.();
    request.stop = undefined;
  }
  retire() {
    ++this.generation;
    if (this.request) {
      this.request.terminal = true;
      this.request.candidate = undefined;
      this.request.snapshot = undefined;
      this.stop(this.request);
    }
    this.request = undefined;
  }
  live(request) {
    return Boolean(this.context && this.request === request && request.generation === this.generation && !request.terminal);
  }
  view(settings, request, error) {
    const [appId, appSecret] = credentials(settings);
    const result = { schemaVersion: 1, ok: !error, instanceId: OFFICIAL_INSTANCE_ID,
      configured: Boolean(appId && appSecret), phase: request?.phase ?? 'idle' };
    if (appId) result.appId = String(appId);
    if (request) {
      result.requestId = request.id;
      if (request.phase === 'waiting') {
        result.qrUrl = request.qrUrl;
        if (request.qrDataUrl) result.qrDataUrl = request.qrDataUrl;
      }
      if (request.candidate && ['candidate', 'saving'].includes(request.phase)) result.candidateAppId = request.candidate.appId;
      if (request.error && !error) { result.ok = false; result.error = { code: request.error }; }
    }
    if (error) result.error = { code: error };
    return result;
  }
  finish(request, phase, error) {
    if (!this.live(request)) return;
    request.terminal = true;
    request.phase = phase;
    request.error = error;
    request.candidate = undefined;
    request.snapshot = undefined;
    request.qrUrl = undefined;
    request.qrDataUrl = undefined;
    this.stop(request);
  }
  start(args, settings) {
    if (this.request?.phase === 'saving') return this.view(settings, undefined, 'busy');
    this.retire();
    const request = { id: randomUUID(), clientId: args.clientId, generation: this.generation,
      phase: 'starting', terminal: false, controller: new AbortController(), snapshot: credentials(settings) };
    this.request = request;
    const callbacks = {
      onQrDisplayed: url => {
        if (!this.live(request) || !['starting', 'waiting'].includes(request.phase)) return;
        let parsed;
        try { parsed = new URL(url); } catch { this.finish(request, 'failed', 'invalid_qr_url'); return; }
        if (parsed.origin !== 'https://q.qq.com' || parsed.pathname !== '/qqbot/openclaw/connect.html' || parsed.username || parsed.password || !parsed.searchParams.get('task_id')) {
          this.finish(request, 'failed', 'invalid_qr_url'); return;
        }
        request.phase = 'waiting'; request.qrUrl = parsed.href;
        Promise.resolve().then(() => this.renderQr(parsed.href)).then(data => {
          if (this.live(request) && request.phase === 'waiting' && request.qrUrl === parsed.href) request.qrDataUrl = data;
        }).catch(() => {});
      },
      onQrExpired: () => { if (['starting', 'waiting'].includes(request.phase)) this.finish(request, 'expired'); },
      onFailure: () => { if (['starting', 'waiting'].includes(request.phase)) this.finish(request, 'failed', 'bind_failed'); },
      onSuccess: items => {
        if (!this.live(request) || !['starting', 'waiting'].includes(request.phase)) return;
        const candidate = items?.length === 1 ? items[0] : undefined;
        if (!candidate || !validCredential(candidate.appId) || !validCredential(candidate.appSecret)) {
          this.finish(request, 'failed', 'invalid_credentials'); return;
        }
        request.candidate = { appId: candidate.appId, appSecret: candidate.appSecret };
        request.phase = 'candidate'; request.qrUrl = undefined; request.qrDataUrl = undefined;
        this.stop(request);
      },
    };
    try {
      const stop = this.connect(callbacks, { displayQrCodeToConsole: false, signal: request.controller.signal, source: 'kiki-qq' });
      request.stop = stop;
      if (request.terminal || request.phase === 'candidate') this.stop(request);
    } catch { this.finish(request, 'failed', 'bind_failed'); }
    return this.view(settings, request);
  }
  async save(request, settings) {
    if (request.phase === 'saved') return this.view(settings, request);
    if (request.phase === 'saving') return request.savePromise;
    if (request.phase !== 'candidate' || !request.candidate) return this.view(settings, request, 'not_ready');
    if (!sameCredentials(request.snapshot, credentials(settings)) || !sameCredentials(request.snapshot, credentials(this.settings))) {
      request.error = 'settings_changed';
      return this.view(settings, request);
    }
    request.phase = 'saving'; request.error = undefined;
    const patch = { official__appId: request.candidate.appId, official__appSecret: request.candidate.appSecret };
    const context = this.context;
    request.savePromise = (async () => {
      try {
        await context.updateSettings(patch);
        if (this.live(request)) {
          this.settings = { ...this.settings, ...patch };
          this.finish(request, 'saved');
        }
        return this.view(this.settings, this.request === request ? request : undefined);
      } catch {
        if (this.live(request)) { request.phase = 'candidate'; request.error = 'save_failed'; }
        return this.view(this.settings, this.request === request ? request : undefined, 'save_failed');
      } finally { request.savePromise = undefined; }
    })();
    return request.savePromise;
  }
  async panel(action, args, context = {}) {
    const settings = context.settings ?? this.settings;
    if (!Object.values(BIND_ACTIONS).includes(action)) return this.view(settings, undefined, 'unknown_action');
    if (!args || typeof args !== 'object' || Array.isArray(args) || !validToken(args.clientId)) return this.view(settings, undefined, 'invalid_request');
    if (args.instanceId !== OFFICIAL_INSTANCE_ID) return this.view(settings, undefined, 'unsupported_instance');
    if (!this.context || this.signal?.aborted) return this.view(settings, undefined, 'inactive');
    if (action === BIND_ACTIONS.start) return this.start(args, settings);
    if (action === BIND_ACTIONS.status && args.requestId === undefined) return this.view(settings);
    const request = this.request;
    if (!request || args.requestId !== request.id || args.clientId !== request.clientId) return this.view(settings, undefined, 'stale_request');
    if (action === BIND_ACTIONS.status) return this.view(settings, request);
    if (action === BIND_ACTIONS.save) return this.save(request, settings);
    if (request.phase === 'saving') return this.view(settings, request, 'busy');
    if (!request.terminal) this.finish(request, 'cancelled');
    return this.view(settings, request);
  }
}
