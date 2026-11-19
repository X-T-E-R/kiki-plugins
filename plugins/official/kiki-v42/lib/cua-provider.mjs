import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cropAndScalePng, readPngDimensions } from './png-crop.mjs';

export const CUA_PROTOCOL = 'kiki.cua.provider.v1';
export const CUA_PROVIDER_ID = 'kiki-v42';
export const CUA_HEARTBEAT_MS = 10_000;
export const CUA_DEFAULT_TTL_MS = 35_000;

export function resolveCuaProviderBusDir({
  env = process.env,
  kikiHome,
  dataDir,
  pluginRoot,
} = {}) {
  if (typeof env?.KIKI_CUA_BUS_DIR === 'string' && env.KIKI_CUA_BUS_DIR.trim()) {
    return path.resolve(env.KIKI_CUA_BUS_DIR.trim());
  }

  const effectiveKikiHome = kikiHome || env?.KIKI_HOME || env?.KIMI_CODE_HOME;
  if (typeof effectiveKikiHome === 'string' && effectiveKikiHome.trim()) {
    return path.join(path.resolve(effectiveKikiHome.trim()), 'plugins', 'data', 'kiki-cua', 'providers');
  }

  if (typeof dataDir === 'string' && dataDir.trim()) {
    return path.join(path.dirname(path.resolve(dataDir.trim())), 'kiki-cua', 'providers');
  }

  const candidateRoot = pluginRoot || env?.KIKI_PLUGIN_ROOT;
  if (typeof candidateRoot === 'string' && candidateRoot.trim()) {
    const resolvedRoot = path.resolve(candidateRoot.trim());
    const normalized = resolvedRoot.replaceAll('\\', '/');
    if (/\/plugins\/managed\/[^/]+\/?$/.test(normalized)) {
      const inferredHome = path.resolve(resolvedRoot, '..', '..', '..');
      return path.join(inferredHome, 'plugins', 'data', 'kiki-cua', 'providers');
    }
  }

  return path.join(os.homedir(), '.kiki', 'plugins', 'data', 'kiki-cua', 'providers');
}

export function parseCuaTargetId(targetId) {
  const raw = String(targetId || '').trim();
  const desktopMatch = /^v42:([^:]+):desktop$/.exec(raw);
  if (desktopMatch) {
    return {
      kind: 'desktop',
      computer: desktopMatch[1],
      leaseKey: `desktop:${desktopMatch[1]}`,
    };
  }
  const mobileMatch = /^v42:([^:]+):mobile:(.+)$/.exec(raw);
  if (mobileMatch) {
    return {
      kind: 'mobile',
      computer: mobileMatch[1],
      deviceId: mobileMatch[2],
      leaseKey: `mobile:${mobileMatch[1]}:${mobileMatch[2]}`,
    };
  }
  return null;
}

function mapPointToTargetPixels(x, y, coordinateMode, logicalSize, lastObs, zoomRelative = false) {
  const mode = coordinateMode || 'normalized_1000';
  const lw = Math.max(1, Number(logicalSize?.width) || 1920);
  const lh = Math.max(1, Number(logicalSize?.height) || 1080);

  let px;
  let py;
  if (mode === 'normalized_1000') {
    if (zoomRelative && lastObs?.cropBounds) {
      const cw = Math.max(1, Number(lastObs.cropBounds.width) || 1);
      const ch = Math.max(1, Number(lastObs.cropBounds.height) || 1);
      px = lastObs.cropBounds.x + (Number(x) / 1000) * (cw > 1 ? cw - 1 : 0);
      py = lastObs.cropBounds.y + (Number(y) / 1000) * (ch > 1 ? ch - 1 : 0);
    } else {
      px = lw <= 1 ? 0 : (Number(x) / 1000) * (lw - 1);
      py = lh <= 1 ? 0 : (Number(y) / 1000) * (lh - 1);
    }
  } else if (mode === 'normalized_01') {
    if (zoomRelative && lastObs?.cropBounds) {
      const cw = Math.max(1, Number(lastObs.cropBounds.width) || 1);
      const ch = Math.max(1, Number(lastObs.cropBounds.height) || 1);
      px = lastObs.cropBounds.x + Number(x) * (cw > 1 ? cw - 1 : 0);
      py = lastObs.cropBounds.y + Number(y) * (ch > 1 ? ch - 1 : 0);
    } else {
      px = lw <= 1 ? 0 : Number(x) * (lw - 1);
      py = lh <= 1 ? 0 : Number(y) * (lh - 1);
    }
  } else if (mode === 'image_pixels') {
    const iw = Math.max(1, Number(lastObs?.imageSize?.width) || lw);
    const ih = Math.max(1, Number(lastObs?.imageSize?.height) || lh);
    const bounds = lastObs?.cropBounds || { x: 0, y: 0, width: lw, height: lh };
    px = bounds.x + (iw <= 1 ? 0 : (Number(x) / (iw - 1)) * Math.max(0, bounds.width - 1));
    py = bounds.y + (ih <= 1 ? 0 : (Number(y) / (ih - 1)) * Math.max(0, bounds.height - 1));
  } else {
    px = Number(x);
    py = Number(y);
  }

  const clampedX = Math.max(0, Math.min(lw - 1, Math.round(px || 0)));
  const clampedY = Math.max(0, Math.min(lh - 1, Math.round(py || 0)));
  return {
    x: clampedX,
    y: clampedY,
    normX: lw <= 1 ? 0 : Math.round((clampedX / (lw - 1)) * 1000),
    normY: lh <= 1 ? 0 : Math.round((clampedY / (lh - 1)) * 1000),
  };
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body exceeds 1 MiB limit');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function mapMobileSystemKey(rawKey) {
  const first = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  const k = String(first || '').trim().toLowerCase();
  const table = {
    enter: 'enter',
    return: 'enter',
    home: 'home',
    back: 'back',
    escape: 'back',
    recent: 'recents',
    recents: 'recents',
    app_switch: 'recents',
    power: 'power',
    wake: 'wake',
    sleep: 'sleep',
    volumeup: 'volume-up',
    'volume-up': 'volume-up',
    volume_up: 'volume-up',
    volumedown: 'volume-down',
    'volume-down': 'volume-down',
    volume_down: 'volume-down',
    menu: 'menu',
    rotate: 'rotate',
    notifications: 'notifications',
    'quick-settings': 'quick-settings',
    quick_settings: 'quick-settings',
    shake: 'shake',
  };
  return table[k] || 'enter';
}

export class V42CuaProviderServer {
  constructor({
    v42Client,
    desktopSessions,
    leaseStore,
    pluginRoot,
    env = process.env,
    heartbeatMs = CUA_HEARTBEAT_MS,
    ttlMs = CUA_DEFAULT_TTL_MS,
  }) {
    this.v42Client = v42Client;
    this.desktopSessions = desktopSessions;
    this.leaseStore = leaseStore;
    this.pluginRoot = pluginRoot;
    this.env = env;
    this.heartbeatMs = heartbeatMs;
    this.ttlMs = ttlMs;

    this.server = null;
    this.endpoint = null;
    this.authToken = randomBytes(32).toString('hex');
    this.authTokenBuf = Buffer.from(this.authToken, 'utf8');
    this.startedAtMs = 0;
    this.updatedAtMs = 0;
    this.busDir = null;
    this.leaseFilePath = null;
    this.heartbeatTimer = null;
    this.settings = {};
    this.workspaceRoot = undefined;
    this.lastObservations = new Map();
    this.cursorPositions = new Map();
    this.startingPromise = null;
    this.targetsTtlMs = 15_000;
    this.targetsCache = { at: 0, value: null };
    this.targetsRefreshFlight = null;
  }

  verifyAuth(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice(7).trim(), 'utf8');
    if (supplied.length !== this.authTokenBuf.length) return false;
    return timingSafeEqual(supplied, this.authTokenBuf);
  }

  async ensureStarted(context = {}) {
    if (context.settings) this.settings = context.settings;
    if (context.workspaceRoot) this.workspaceRoot = context.workspaceRoot;

    const nextBusDir = resolveCuaProviderBusDir({
      env: this.env,
      kikiHome: context.kikiHome,
      dataDir: context.dataDir || this.leaseStore.dataDir,
      pluginRoot: this.pluginRoot,
    });

    if (this.server && this.busDir === nextBusDir) {
      return { endpoint: this.endpoint, leaseFilePath: this.leaseFilePath };
    }
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = (async () => {
      if (this.server) await this.stop();
      this.busDir = nextBusDir;
      this.leaseFilePath = path.join(this.busDir, `${CUA_PROVIDER_ID}.json`);
      await this.leaseStore.load(context);

      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      server.unref?.();

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      this.server = server;
      this.endpoint = `http://127.0.0.1:${port}`;
      this.startedAtMs = Date.now();
      this.updatedAtMs = this.startedAtMs;

      await this.writeLeaseFile();
      this.heartbeatTimer = setInterval(() => {
        void this.writeLeaseFile().catch(() => {});
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();

      return { endpoint: this.endpoint, leaseFilePath: this.leaseFilePath };
    })().finally(() => {
      this.startingPromise = null;
    });

    return this.startingPromise;
  }

  async writeLeaseFile() {
    if (!this.busDir || !this.endpoint || !this.leaseFilePath) return;
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(this.endpoint)) {
      throw new Error(`Refusing non-loopback CUA endpoint: ${this.endpoint}`);
    }
    this.updatedAtMs = Date.now();
    const record = {
      protocol: CUA_PROTOCOL,
      providerId: CUA_PROVIDER_ID,
      displayName: 'Vibe42 Remote Fleet',
      pid: process.pid,
      endpoint: this.endpoint,
      authToken: this.authToken,
      startedAtMs: this.startedAtMs,
      updatedAtMs: this.updatedAtMs,
      ttlMs: this.ttlMs,
      capabilities: ['targets', 'observe', 'act', 'clipboard', 'takeover'],
    };

    await mkdir(this.busDir, { recursive: true });
    const tmpFile = `${this.leaseFilePath}.${process.pid}.tmp`;
    await writeFile(tmpFile, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(tmpFile, this.leaseFilePath);
  }

  async stop() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const srv = this.server;
    this.server = null;
    this.endpoint = null;

    if (srv) {
      await new Promise((resolve) => srv.close(() => resolve()));
    }

    if (this.leaseFilePath) {
      try {
        const existing = JSON.parse(await readFile(this.leaseFilePath, 'utf8'));
        if (existing?.pid === process.pid) {
          await rm(this.leaseFilePath, { force: true });
        }
      } catch {}
    }
  }

  async handleRequest(req, res) {
    try {
      if (!this.verifyAuth(req)) {
        sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'Missing or invalid Bearer token' });
        return;
      }

      const url = new URL(req.url || '/', this.endpoint || 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(res, 200, {
          ok: true,
          providerId: CUA_PROVIDER_ID,
          pid: process.pid,
          updatedAtMs: this.updatedAtMs || Date.now(),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/targets') {
        const targets = await this.collectTargets();
        sendJson(res, 200, { ok: true, targets });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/observe') {
        const body = await readJsonBody(req);
        const result = await this.handleObserve(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/act') {
        const body = await readJsonBody(req);
        const result = await this.handleAct(body);
        sendJson(res, result.httpStatus || 200, result.payload);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/takeover') {
        const body = await readJsonBody(req);
        const result = await this.handleTakeover(body);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not_found', message: `Unknown route ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, {
        ok: false,
        code: err.code || 'internal_error',
        message: err.message || String(err),
      });
    }
  }

  _overlayLiveTakeover(targets) {
    if (!Array.isArray(targets)) return [];
    return targets.map((t) => {
      const parsed = parseCuaTargetId(t.id);
      if (!parsed) return t;
      const takeover = this.leaseStore.getTakeover(parsed.leaseKey);
      return {
        ...t,
        takeoverActive: takeover.active,
        controlledBy: takeover.controlledBy,
      };
    });
  }

  async _refreshTargets() {
    if (this.targetsRefreshFlight) return this.targetsRefreshFlight;
    this.targetsRefreshFlight = (async () => {
      await this.leaseStore.load();
      const byId = new Map();

      let liveComputers = [];
      try {
        liveComputers = await this.v42Client.listComputers({
          settings: this.settings,
          workspaceRoot: this.workspaceRoot,
          timeoutMs: 4_000,
        });
      } catch {}
      const computerMap = new Map(liveComputers.map((c) => [c.id, c]));
      for (const c of liveComputers) {
        if (c.name) computerMap.set(c.name, c);
      }

      for (const desktop of this.leaseStore.getManagedDesktops()) {
        const id = `v42:${desktop.computerId}:desktop`;
        const comp = computerMap.get(desktop.computerId);
        const takeover = this.leaseStore.getTakeover(`desktop:${desktop.computerId}`);
        byId.set(id, {
          id,
          providerId: CUA_PROVIDER_ID,
          kind: 'remote-desktop',
          label: `${desktop.computerName || comp?.name || desktop.computerId} Desktop`,
          platform: 'desktop',
          online: comp ? Boolean(comp.online) : true,
          takeoverActive: takeover.active,
          controlledBy: takeover.controlledBy,
          dimensions: {
            width: Number(desktop.width) || 1920,
            height: Number(desktop.height) || 1080,
            scaleFactor: 1,
          },
          capabilities: [
            'screenshot',
            'zoom',
            'click',
            'move',
            'drag',
            'scroll',
            'type',
            'key',
            'clipboard',
            'takeover',
          ],
        });
      }

      if (this.settings?.cuaExposeAllOnline !== false) {
        const mobileEligible = [];
        for (const comp of liveComputers) {
          if (comp.online === false) continue;
          const features = Array.isArray(comp.featureset) ? comp.featureset : null;
          if (!features || features.includes('desktop.v1')) {
            const id = `v42:${comp.id}:desktop`;
            if (!byId.has(id)) {
              const takeover = this.leaseStore.getTakeover(`desktop:${comp.id}`);
              byId.set(id, {
                id,
                providerId: CUA_PROVIDER_ID,
                kind: 'remote-desktop',
                label: `${comp.name || comp.id} Desktop`,
                platform: 'desktop',
                online: true,
                takeoverActive: takeover.active,
                controlledBy: takeover.controlledBy,
                dimensions: { width: 1920, height: 1080, scaleFactor: 1 },
                capabilities: [
                  'screenshot',
                  'zoom',
                  'click',
                  'move',
                  'drag',
                  'scroll',
                  'type',
                  'key',
                  'clipboard',
                  'takeover',
                ],
              });
            }
          }

          if (!features || features.includes('mobile.v1')) {
            mobileEligible.push(comp);
          }
        }

        const mobileResults = await Promise.allSettled(
          mobileEligible.map((comp) =>
            this.v42Client.mobileDevices({
              computer: comp.id,
              settings: this.settings,
              workspaceRoot: this.workspaceRoot,
              timeoutMs: 3_000,
            }).then((devs) => ({ comp, devs })),
          ),
        );

        for (const settled of mobileResults) {
          if (settled.status !== 'fulfilled') continue;
          const { comp, devs } = settled.value;
          for (const dev of Array.isArray(devs) ? devs : []) {
            if (dev.state && dev.state !== 'online') continue;
            const id = `v42:${comp.id}:mobile:${dev.id}`;
            if (!byId.has(id)) {
              const takeover = this.leaseStore.getTakeover(`mobile:${comp.id}:${dev.id}`);
              byId.set(id, {
                id,
                providerId: CUA_PROVIDER_ID,
                kind: 'remote-mobile',
                label: dev.name || `${comp.name || comp.id} ${dev.id}`,
                platform: dev.platform || 'android',
                online: true,
                takeoverActive: takeover.active,
                controlledBy: takeover.controlledBy,
                dimensions: {
                  width: Number(dev.width) || 1080,
                  height: Number(dev.height) || 2400,
                  scaleFactor: 1,
                },
                capabilities: [
                  'screenshot',
                  'zoom',
                  'click',
                  'drag',
                  'scroll',
                  'type',
                  'key',
                  'takeover',
                ],
              });
            }
          }
        }
      }

      for (const mobile of this.leaseStore.getManagedMobiles()) {
        const id = `v42:${mobile.computerId}:mobile:${mobile.deviceId}`;
        const takeover = this.leaseStore.getTakeover(`mobile:${mobile.key}`);
        byId.set(id, {
          id,
          providerId: CUA_PROVIDER_ID,
          kind: 'remote-mobile',
          label: mobile.name || `${mobile.computerId} ${mobile.deviceId}`,
          platform: mobile.platform || 'android',
          online: mobile.state ? mobile.state === 'online' : true,
          takeoverActive: takeover.active,
          controlledBy: takeover.controlledBy,
          dimensions: {
            width: Number(mobile.width) || 1080,
            height: Number(mobile.height) || 2400,
            scaleFactor: 1,
          },
          capabilities: [
            'screenshot',
            'zoom',
            'click',
            'drag',
            'scroll',
            'type',
            'key',
            'takeover',
          ],
        });
      }

      const list = [...byId.values()];
      this.targetsCache = { at: Date.now(), value: list };
      return list;
    })().finally(() => {
      this.targetsRefreshFlight = null;
    });
    return this.targetsRefreshFlight;
  }

  async collectTargets({ maxAgeMs = this.targetsTtlMs, forceRefresh = false } = {}) {
    const hasCached = Array.isArray(this.targetsCache.value);
    if (!forceRefresh && hasCached && Date.now() - this.targetsCache.at < maxAgeMs) {
      return this._overlayLiveTakeover(this.targetsCache.value);
    }
    if (!forceRefresh && hasCached) {
      void this._refreshTargets().catch(() => {});
      return this._overlayLiveTakeover(this.targetsCache.value);
    }
    const fresh = await this._refreshTargets();
    return this._overlayLiveTakeover(fresh);
  }

  async handleObserve(body = {}) {
    const parsed = parseCuaTargetId(body.targetId);
    if (!parsed) {
      const err = new Error(`Invalid Vibe42 targetId "${body.targetId}"`);
      err.statusCode = 404;
      err.code = 'target_not_found';
      throw err;
    }

    const takeover = this.leaseStore.getTakeover(parsed.leaseKey);
    const coordinateMode = body.coordinateMode || 'normalized_1000';
    const maxWidth = Number(body.maxWidth) || 0;
    const maxHeight = Number(body.maxHeight) || 0;

    if (parsed.kind === 'desktop') {
      const session = this.desktopSessions.acquire(parsed.computer, {
        settings: this.settings,
        workspaceRoot: this.workspaceRoot,
      });
      const shot = await session.screenshot();
      const processed = cropAndScalePng(shot.pngBuffer, {
        zoom: body.zoom || null,
        coordinateMode,
        logicalSize: shot.logicalSize,
        maxWidth,
        maxHeight,
      });

      await this.leaseStore.upsertDesktop(parsed.computer, {
        connectedByKiki: true,
        width: processed.logicalSize.width,
        height: processed.logicalSize.height,
      });

      const obs = {
        logicalSize: processed.logicalSize,
        imageSize: processed.imageSize,
        cropBounds: processed.cropBounds,
      };
      this.lastObservations.set(body.targetId, obs);
      const cursor = this.cursorPositions.get(body.targetId) || {
        x: Math.round(processed.logicalSize.width / 2),
        y: Math.round(processed.logicalSize.height / 2),
      };

      return {
        ok: true,
        targetId: body.targetId,
        capturedAtMs: Date.now(),
        mimeType: 'image/png',
        imageBase64: processed.pngBuffer.toString('base64'),
        imageSize: processed.imageSize,
        logicalSize: processed.logicalSize,
        cropBounds: processed.cropBounds,
        contentRect: {
          x: 0,
          y: 0,
          width: processed.logicalSize.width,
          height: processed.logicalSize.height,
        },
        cursor,
        takeoverActive: takeover.active,
        controlledBy: takeover.controlledBy,
        accessibility: [],
      };
    }

    const { meta, pngBuffer } = await this.v42Client.mobileScreenshot(parsed.deviceId, {
      computer: parsed.computer,
      settings: this.settings,
      workspaceRoot: this.workspaceRoot,
    });
    const pngDims = readPngDimensions(pngBuffer);
    const logicalSize = {
      width: Number(meta?.width) || pngDims.width,
      height: Number(meta?.height) || pngDims.height,
    };

    const processed = cropAndScalePng(pngBuffer, {
      zoom: body.zoom || null,
      coordinateMode,
      logicalSize,
      maxWidth,
      maxHeight,
    });

    await this.leaseStore.upsertMobile(parsed.computer, parsed.deviceId, {
      connectedByKiki: true,
      width: logicalSize.width,
      height: logicalSize.height,
    });

    this.lastObservations.set(body.targetId, {
      logicalSize,
      imageSize: processed.imageSize,
      cropBounds: processed.cropBounds,
    });

    let accessibility = [];
    if (body.includeAccessibility === true) {
      try {
        const tree = await this.v42Client.mobileUiTree(parsed.deviceId, {
          computer: parsed.computer,
          settings: this.settings,
          workspaceRoot: this.workspaceRoot,
        });
        accessibility = Array.isArray(tree?.nodes) ? tree.nodes : (tree ? [tree] : []);
      } catch {}
    }

    const cursor = this.cursorPositions.get(body.targetId) || {
      x: Math.round(logicalSize.width / 2),
      y: Math.round(logicalSize.height / 2),
    };

    return {
      ok: true,
      targetId: body.targetId,
      capturedAtMs: Date.now(),
      mimeType: 'image/png',
      imageBase64: processed.pngBuffer.toString('base64'),
      imageSize: processed.imageSize,
      logicalSize,
      cropBounds: processed.cropBounds,
      contentRect: {
        x: 0,
        y: 0,
        width: logicalSize.width,
        height: logicalSize.height,
      },
      cursor,
      takeoverActive: takeover.active,
      controlledBy: takeover.controlledBy,
      accessibility,
    };
  }

  async handleAct(body = {}) {
    const parsed = parseCuaTargetId(body.targetId);
    if (!parsed) {
      return {
        httpStatus: 404,
        payload: { ok: false, code: 'target_not_found', message: `Unknown targetId "${body.targetId}"` },
      };
    }

    const gate = this.leaseStore.checkAgentControlAllowed(parsed.leaseKey, body.overrideHumanTakeover === true);
    if (!gate.allowed) {
      return {
        httpStatus: 409,
        payload: {
          ok: false,
          code: 'human_takeover_active',
          message: gate.message,
          takeoverActive: true,
        },
      };
    }

    const actions = Array.isArray(body.actions) ? body.actions : [];
    const coordinateMode = body.coordinateMode || 'normalized_1000';
    const zoomRelative = body.zoomRelative === true;
    const lastObs = this.lastObservations.get(body.targetId) || null;
    const results = [];
    let lastPoint = null;

    if (parsed.kind === 'desktop') {
      const session = this.desktopSessions.acquire(parsed.computer, {
        settings: this.settings,
        workspaceRoot: this.workspaceRoot,
      });
      await session.ensureStarted();
      const display = session.lastStatus?.display;
      const logicalSize = lastObs?.logicalSize || {
        width: Number(display?.width) || 1920,
        height: Number(display?.height) || 1080,
      };
      let pendingMouseDown = null;
      const fallbackCursorPoint = () => {
        if (lastPoint) return lastPoint;
        const saved = this.cursorPositions.get(body.targetId);
        if (saved) return mapPointToTargetPixels(saved.x, saved.y, 'target_pixels', logicalSize, lastObs, false);
        return mapPointToTargetPixels(Math.round(logicalSize.width / 2), Math.round(logicalSize.height / 2), 'target_pixels', logicalSize, lastObs, false);
      };

      for (const act of actions) {
        const kind = act?.kind;
        if (kind === 'click') {
          pendingMouseDown = null;
          const pt = mapPointToTargetPixels(act.x, act.y, coordinateMode, logicalSize, lastObs, zoomRelative);
          await session.click(pt.x, pt.y, { button: act.button || 'left', count: act.count || 1 });
          lastPoint = pt;
          this.cursorPositions.set(body.targetId, { x: pt.x, y: pt.y });
          results.push({ kind, ok: true, point: pt });
        } else if (kind === 'move' || kind === 'mouse_down' || kind === 'mouse_up') {
          const pt = act.x !== undefined && act.y !== undefined
            ? mapPointToTargetPixels(act.x, act.y, coordinateMode, logicalSize, lastObs, zoomRelative)
            : fallbackCursorPoint();
          if (kind === 'move') {
            await session.move(pt.x, pt.y);
          } else if (kind === 'mouse_down') {
            pendingMouseDown = { pt, button: act.button || 'left' };
            await session.move(pt.x, pt.y);
          } else if (pendingMouseDown) {
            const down = pendingMouseDown;
            pendingMouseDown = null;
            if (Math.hypot(pt.x - down.pt.x, pt.y - down.pt.y) > 2) {
              await session.drag(down.pt.x, down.pt.y, pt.x, pt.y, { button: act.button || down.button || 'left', steps: 10 });
            } else {
              await session.click(pt.x, pt.y, { button: act.button || down.button || 'left', count: 1 });
            }
          } else {
            await session.click(pt.x, pt.y, { button: act.button || 'left', count: 1 });
          }
          lastPoint = pt;
          this.cursorPositions.set(body.targetId, { x: pt.x, y: pt.y });
          results.push({ kind, ok: true, point: pt });
        } else if (kind === 'drag') {
          pendingMouseDown = null;
          const start = mapPointToTargetPixels(act.startX, act.startY, coordinateMode, logicalSize, lastObs, zoomRelative);
          const end = mapPointToTargetPixels(act.endX, act.endY, coordinateMode, logicalSize, lastObs, zoomRelative);
          const steps = act.durationMs ? Math.max(4, Math.min(120, Math.round(act.durationMs / 16))) : 12;
          await session.drag(start.x, start.y, end.x, end.y, { button: act.button || 'left', steps });
          lastPoint = end;
          this.cursorPositions.set(body.targetId, { x: end.x, y: end.y });
          results.push({ kind, ok: true, start, end });
        } else if (kind === 'scroll') {
          const pt = act.x !== undefined && act.y !== undefined
            ? mapPointToTargetPixels(act.x, act.y, coordinateMode, logicalSize, lastObs, zoomRelative)
            : null;
          await session.scroll({
            x: pt?.x,
            y: pt?.y,
            dx: act.deltaX || 0,
            dy: act.deltaY || 0,
          });
          if (pt) {
            lastPoint = pt;
            this.cursorPositions.set(body.targetId, { x: pt.x, y: pt.y });
          }
          results.push({ kind, ok: true });
        } else if (kind === 'type') {
          if (act.mode === 'clipboard') {
            await session.clipboardSet(String(act.text ?? ''));
            await session.key('ctrl+v');
          } else {
            await session.type(String(act.text ?? ''));
          }
          if (act.submit === true) {
            await session.key('enter');
          }
          results.push({ kind, ok: true });
        } else if (kind === 'key') {
          await session.key(act.keys);
          results.push({ kind, ok: true });
        } else if (kind === 'hold_key') {
          await session.key(act.key);
          if (act.durationMs > 0) {
            await new Promise((r) => setTimeout(r, Math.min(5000, Number(act.durationMs))));
          }
          results.push({ kind, ok: true });
        } else if (kind === 'wait') {
          await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(0, Number(act.durationMs) || 200))));
          results.push({ kind, ok: true });
        } else if (kind === 'clipboard_set') {
          await session.clipboardSet(String(act.text ?? ''));
          results.push({ kind, ok: true });
        } else if (kind === 'clipboard_get') {
          results.push({ kind, ok: true, text: session.lastClipboard || '' });
        } else {
          results.push({ kind: String(kind), ok: false, error: `Unsupported action kind: ${kind}` });
        }
      }
    } else {
      const storedMobile = this.leaseStore.state.mobiles[`${parsed.computer}:${parsed.deviceId}`];
      const logicalSize = lastObs?.logicalSize || {
        width: Number(storedMobile?.width) || 1080,
        height: Number(storedMobile?.height) || 2400,
      };
      const callOpts = {
        computer: parsed.computer,
        settings: this.settings,
        workspaceRoot: this.workspaceRoot,
      };

      for (const act of actions) {
        const kind = act?.kind;
        if (kind === 'click') {
          const pt = mapPointToTargetPixels(act.x, act.y, coordinateMode, logicalSize, lastObs, zoomRelative);
          await this.v42Client.mobileTap(parsed.deviceId, pt.x, pt.y, { ...callOpts, pixel: true });
          lastPoint = pt;
          this.cursorPositions.set(body.targetId, { x: pt.x, y: pt.y });
          results.push({ kind, ok: true, point: pt });
        } else if (kind === 'move') {
          const pt = mapPointToTargetPixels(act.x, act.y, coordinateMode, logicalSize, lastObs, zoomRelative);
          lastPoint = pt;
          this.cursorPositions.set(body.targetId, { x: pt.x, y: pt.y });
          results.push({ kind, ok: true, point: pt });
        } else if (kind === 'drag') {
          const start = mapPointToTargetPixels(act.startX, act.startY, coordinateMode, logicalSize, lastObs, zoomRelative);
          const end = mapPointToTargetPixels(act.endX, act.endY, coordinateMode, logicalSize, lastObs, zoomRelative);
          await this.v42Client.mobileSwipe(parsed.deviceId, start.x, start.y, end.x, end.y, {
            ...callOpts,
            pixel: true,
            durationMs: act.durationMs || 300,
          });
          lastPoint = end;
          this.cursorPositions.set(body.targetId, { x: end.x, y: end.y });
          results.push({ kind, ok: true, start, end });
        } else if (kind === 'scroll') {
          const pt = mapPointToTargetPixels(
            act.x ?? 500,
            act.y ?? 500,
            coordinateMode,
            logicalSize,
            lastObs,
            zoomRelative,
          );
          const endX = Math.max(0, Math.min(logicalSize.width - 1, Math.round(pt.x - (Number(act.deltaX) || 0))));
          const endY = Math.max(0, Math.min(logicalSize.height - 1, Math.round(pt.y - (Number(act.deltaY) || 0))));
          await this.v42Client.mobileSwipe(parsed.deviceId, pt.x, pt.y, endX, endY, {
            ...callOpts,
            pixel: true,
            durationMs: 280,
          });
          lastPoint = pt;
          results.push({ kind, ok: true, point: pt });
        } else if (kind === 'type') {
          await this.v42Client.mobileType(parsed.deviceId, String(act.text ?? ''), {
            ...callOpts,
            enter: act.submit === true,
          });
          results.push({ kind, ok: true });
        } else if (kind === 'key' || kind === 'hold_key') {
          const sysKey = mapMobileSystemKey(act.keys ?? act.key);
          await this.v42Client.mobileKey(parsed.deviceId, sysKey, callOpts);
          results.push({ kind, ok: true });
        } else if (kind === 'wait') {
          await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(0, Number(act.durationMs) || 200))));
          results.push({ kind, ok: true });
        } else {
          results.push({ kind: String(kind), ok: false, error: `Unsupported mobile action: ${kind}` });
        }
      }
    }

    return {
      httpStatus: 200,
      payload: {
        ok: true,
        targetId: body.targetId,
        executed: results.filter((r) => r.ok).length,
        results,
        lastPoint,
        takeoverActive: false,
      },
    };
  }

  async handleTakeover(body = {}) {
    const parsed = parseCuaTargetId(body.targetId);
    if (!parsed) {
      const err = new Error(`Unknown targetId "${body.targetId}"`);
      err.statusCode = 404;
      err.code = 'target_not_found';
      throw err;
    }

    const status = await this.leaseStore.setTakeover(parsed.leaseKey, {
      active: Boolean(body.active),
      holder: body.holder || (body.active ? 'human' : 'agent'),
      reason: body.reason || null,
    });

    return {
      ok: true,
      targetId: body.targetId,
      takeoverActive: status.active,
      controlledBy: status.controlledBy,
    };
  }
}
