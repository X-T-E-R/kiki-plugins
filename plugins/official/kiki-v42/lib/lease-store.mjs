import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const IDEMPOTENCY_RING_CAPACITY = 64;
export const PROMPT_CONTEXT_MAX_BYTES = 2048;

export function resolvePluginDataDir({ dataDir, kikiHome, env = process.env } = {}) {
  if (dataDir && path.isAbsolute(dataDir)) return path.resolve(dataDir);
  const home = kikiHome || env.KIKI_HOME || env.KIMI_CODE_HOME;
  if (home) return path.join(path.resolve(home), 'plugins', 'data', 'kiki-v42');
  return path.join(os.homedir(), '.kiki', 'plugins', 'data', 'kiki-v42');
}

function emptyState() {
  return {
    schemaVersion: 1,
    updatedAtMs: Date.now(),
    seats: {},
    desktops: {},
    mobiles: {},
    forwards: {},
    takeovers: {},
    idempotencyRing: [],
    selectedTarget: null,
  };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export class LeaseStore {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.state = emptyState();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.listeners = new Set();
  }

  setDataDir(dataDir) {
    if (!dataDir) return;
    const resolved = path.resolve(dataDir);
    if (this.dataDir !== resolved) {
      this.dataDir = resolved;
      this.loaded = false;
    }
  }

  ensureDataDir(context = {}) {
    if (!this.dataDir) {
      this.dataDir = resolvePluginDataDir(context);
    }
    return this.dataDir;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange(event) {
    for (const listener of this.listeners) {
      try {
        listener(event, this.state);
      } catch {}
    }
  }

  async load(context = {}) {
    const dir = this.ensureDataDir(context);
    if (this.loaded) return this.state;
    const file = path.join(dir, 'state.json');
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          ...emptyState(),
          ...raw,
          seats: raw.seats && typeof raw.seats === 'object' ? raw.seats : {},
          desktops: raw.desktops && typeof raw.desktops === 'object' ? raw.desktops : {},
          mobiles: raw.mobiles && typeof raw.mobiles === 'object' ? raw.mobiles : {},
          forwards: raw.forwards && typeof raw.forwards === 'object' ? raw.forwards : {},
          takeovers: raw.takeovers && typeof raw.takeovers === 'object' ? raw.takeovers : {},
          idempotencyRing: Array.isArray(raw.idempotencyRing)
            ? raw.idempotencyRing.slice(-IDEMPOTENCY_RING_CAPACITY)
            : [],
        };
      }
    } catch {
      this.state = emptyState();
    }
    this.loaded = true;
    return this.state;
  }

  async save() {
    const dir = this.ensureDataDir();
    this.state.updatedAtMs = Date.now();
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    const next = this.writeQueue.then(async () => {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, 'state.json');
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, file);
    });
    this.writeQueue = next.catch(() => {});
    return next;
  }

  isManagedSeat(seat) {
    return Boolean(seat && (seat.pinned === true || seat.createdByKiki === true));
  }

  isManagedDesktop(desktop) {
    return Boolean(desktop && (desktop.pinned === true || desktop.connectedByKiki === true));
  }

  isManagedMobile(mobile) {
    return Boolean(mobile && (mobile.pinned === true || mobile.connectedByKiki === true));
  }

  isManagedForward(forward) {
    return Boolean(forward && (forward.pinned === true || forward.startedByKiki === true || forward.active === true));
  }

  getManagedSeats() {
    return Object.values(this.state.seats).filter((item) => this.isManagedSeat(item));
  }

  getManagedDesktops() {
    return Object.values(this.state.desktops).filter((item) => this.isManagedDesktop(item));
  }

  getManagedMobiles() {
    return Object.values(this.state.mobiles).filter((item) => this.isManagedMobile(item));
  }

  getManagedForwards() {
    return Object.values(this.state.forwards).filter((item) => this.isManagedForward(item));
  }

  async upsertSeat(seatRef, patch, { save = true } = {}) {
    await this.load();
    const prev = this.state.seats[seatRef] || {
      seatRef,
      pinned: false,
      createdByKiki: false,
      status: 'idle',
      updatedAtMs: Date.now(),
    };
    const merged = {
      ...prev,
      ...patch,
      seatRef,
      updatedAtMs: Date.now(),
    };
    this.state.seats[seatRef] = merged;
    if (!this.state.selectedTarget && this.isManagedSeat(merged)) {
      this.state.selectedTarget = { kind: 'seat', ref: seatRef };
    }
    if (save) await this.save();
    this.emitChange({ kind: 'seat', seatRef, seat: merged });
    return merged;
  }

  async unpinSeat(seatRef) {
    await this.load();
    const existing = this.state.seats[seatRef];
    if (!existing) return null;
    existing.pinned = false;
    existing.createdByKiki = false;
    delete this.state.seats[seatRef];
    if (this.state.selectedTarget?.ref === seatRef) {
      this.state.selectedTarget = null;
    }
    await this.save();
    this.emitChange({ kind: 'seat_unpinned', seatRef });
    return existing;
  }

  async upsertDesktop(computerId, patch, { save = true } = {}) {
    await this.load();
    const key = String(computerId);
    const prev = this.state.desktops[key] || {
      computerId: key,
      pinned: false,
      connectedByKiki: false,
      updatedAtMs: Date.now(),
    };
    const merged = {
      ...prev,
      ...patch,
      computerId: key,
      updatedAtMs: Date.now(),
    };
    this.state.desktops[key] = merged;
    if (save) await this.save();
    this.emitChange({ kind: 'desktop', computerId: key, desktop: merged });
    return merged;
  }

  async unpinDesktop(computerId) {
    await this.load();
    const key = String(computerId);
    const existing = this.state.desktops[key];
    if (!existing) return null;
    delete this.state.desktops[key];
    await this.save();
    this.emitChange({ kind: 'desktop_unpinned', computerId: key });
    return existing;
  }

  async upsertMobile(computerId, deviceId, patch, { save = true } = {}) {
    await this.load();
    const key = `${computerId}:${deviceId}`;
    const prev = this.state.mobiles[key] || {
      key,
      computerId: String(computerId),
      deviceId: String(deviceId),
      pinned: false,
      connectedByKiki: false,
      updatedAtMs: Date.now(),
    };
    const merged = {
      ...prev,
      ...patch,
      key,
      computerId: String(computerId),
      deviceId: String(deviceId),
      updatedAtMs: Date.now(),
    };
    this.state.mobiles[key] = merged;
    if (save) await this.save();
    this.emitChange({ kind: 'mobile', key, mobile: merged });
    return merged;
  }

  async unpinMobile(computerId, deviceId) {
    await this.load();
    const key = `${computerId}:${deviceId}`;
    const existing = this.state.mobiles[key];
    if (!existing) return null;
    delete this.state.mobiles[key];
    await this.save();
    this.emitChange({ kind: 'mobile_unpinned', key });
    return existing;
  }

  async upsertForward(computerId, remotePort, patch, { save = true } = {}) {
    await this.load();
    const key = `${computerId}:${remotePort}`;
    const prev = this.state.forwards[key] || {
      key,
      computerId: String(computerId),
      remotePort: Number(remotePort),
      pinned: false,
      startedByKiki: true,
      active: true,
      updatedAtMs: Date.now(),
    };
    const merged = {
      ...prev,
      ...patch,
      key,
      computerId: String(computerId),
      remotePort: Number(remotePort),
      updatedAtMs: Date.now(),
    };
    this.state.forwards[key] = merged;
    if (save) await this.save();
    this.emitChange({ kind: 'forward', key, forward: merged });
    return merged;
  }

  async removeForward(computerId, remotePort) {
    await this.load();
    const key = `${computerId}:${remotePort}`;
    const existing = this.state.forwards[key] || null;
    delete this.state.forwards[key];
    await this.save();
    this.emitChange({ kind: 'forward_removed', key });
    return existing;
  }

  getTakeover(targetKey) {
    const entry = this.state.takeovers[targetKey];
    if (!entry || entry.active !== true) {
      return {
        targetKey,
        active: false,
        controlledBy: 'agent',
        reason: null,
        updatedAtMs: entry?.updatedAtMs || 0,
      };
    }
    return {
      targetKey,
      active: true,
      controlledBy: entry.holder === 'agent' ? 'agent' : 'human',
      reason: entry.reason || null,
      updatedAtMs: entry.updatedAtMs || Date.now(),
    };
  }

  async setTakeover(targetKey, { active, holder, reason = null } = {}) {
    await this.load();
    const effectiveHolder = active
      ? (holder === 'agent' ? 'agent' : 'human')
      : 'agent';
    const isHuman = Boolean(active && effectiveHolder === 'human');
    this.state.takeovers[targetKey] = {
      targetKey,
      active: isHuman,
      holder: isHuman ? 'human' : 'agent',
      reason: isHuman ? reason : null,
      updatedAtMs: Date.now(),
    };
    await this.save();
    const status = this.getTakeover(targetKey);
    this.emitChange({ kind: 'takeover', targetKey, takeover: status });
    return status;
  }

  checkAgentControlAllowed(targetKey, overrideHumanLease = false) {
    const takeover = this.getTakeover(targetKey);
    if (takeover.active && takeover.controlledBy === 'human' && overrideHumanLease !== true) {
      return {
        allowed: false,
        status: 409,
        code: 'human_controlling',
        cuaCode: 'human_takeover_active',
        takeoverActive: true,
        controlledBy: 'human',
        message: `Target "${targetKey}" is under active human control in Vibe42 Workbench. Ask the user to click "Hand back" (or exit Interactive mode) in the Workbench, or get explicit confirmation before setting override_human_lease: true.`,
      };
    }
    return {
      allowed: true,
      takeoverActive: takeover.active,
      controlledBy: takeover.controlledBy,
    };
  }

  lookupIdempotency(seatRef, session, key) {
    if (!key) return null;
    const composite = `${seatRef}::${session || '*'}::${key}`;
    const hit = this.state.idempotencyRing.find((item) => item.composite === composite);
    return hit ? hit.receipt : null;
  }

  async recordIdempotency(seatRef, session, key, receipt) {
    if (!key) return;
    await this.load();
    const composite = `${seatRef}::${session || '*'}::${key}`;
    const filtered = this.state.idempotencyRing.filter((item) => item.composite !== composite);
    filtered.push({
      composite,
      seatRef,
      session: session || '*',
      key,
      recordedAtMs: Date.now(),
      receipt,
    });
    while (filtered.length > IDEMPOTENCY_RING_CAPACITY) {
      filtered.shift();
    }
    this.state.idempotencyRing = filtered;
    await this.save();
  }

  async setSelectedTarget(target) {
    await this.load();
    this.state.selectedTarget = target;
    await this.save();
    this.emitChange({ kind: 'selected', selectedTarget: target });
    return target;
  }

  getManagedSummary() {
    const seats = this.getManagedSeats();
    const desktops = this.getManagedDesktops();
    const mobiles = this.getManagedMobiles();
    const forwards = this.getManagedForwards();

    let workingCount = 0;
    let blockedCount = 0;
    let humanCount = 0;

    for (const seat of seats) {
      const takeover = this.getTakeover(`seat:${seat.seatRef}`);
      if (takeover.controlledBy === 'human') humanCount += 1;
      if (seat.status === 'working') workingCount += 1;
      if (seat.status === 'blocked' || seat.pending) blockedCount += 1;
    }
    for (const desktop of desktops) {
      if (this.getTakeover(`desktop:${desktop.computerId}`).controlledBy === 'human') humanCount += 1;
    }
    for (const mobile of mobiles) {
      if (this.getTakeover(`mobile:${mobile.key}`).controlledBy === 'human') humanCount += 1;
    }

    return {
      seats,
      desktops,
      mobiles,
      forwards,
      counts: {
        seats: seats.length,
        desktops: desktops.length,
        mobiles: mobiles.length,
        forwards: forwards.length,
        working: workingCount,
        blocked: blockedCount,
        humanControlling: humanCount,
        totalManaged: seats.length + desktops.length + mobiles.length + forwards.length,
      },
    };
  }

  renderPromptContextXml({ maxBytes = PROMPT_CONTEXT_MAX_BYTES } = {}) {
    const summary = this.getManagedSummary();
    if (summary.counts.totalManaged === 0) {
      return undefined;
    }

    const lines = ['<v42-context>'];
    for (const seat of summary.seats) {
      const takeover = this.getTakeover(`seat:${seat.seatRef}`);
      const attrs = [
        `ref="${xmlEscape(seat.seatRef)}"`,
        `agent="${xmlEscape(seat.agent || 'shell')}"`,
        `status="${xmlEscape(seat.status || 'idle')}"`,
        `controlled_by="${xmlEscape(takeover.controlledBy)}"`,
      ];
      if (seat.session) attrs.push(`session="${xmlEscape(seat.session)}"`);
      if (seat.cursor) attrs.push(`cursor="${xmlEscape(seat.cursor)}"`);
      if (seat.copyId) attrs.push(`copy="${xmlEscape(seat.copyId)}"`);
      if (seat.title) attrs.push(`title="${xmlEscape(String(seat.title).slice(0, 48))}"`);
      if (seat.pending?.kind) {
        attrs.push(`pending="${xmlEscape(seat.pending.kind)}:${xmlEscape(String(seat.pending.title || seat.pending.id || '').slice(0, 48))}"`);
      }
      const preview = seat.lastSummary ? xmlEscape(String(seat.lastSummary).slice(0, 96)) : '';
      lines.push(preview ? `  <seat ${attrs.join(' ')}>${preview}</seat>` : `  <seat ${attrs.join(' ')} />`);
    }

    for (const desktop of summary.desktops) {
      const takeover = this.getTakeover(`desktop:${desktop.computerId}`);
      const size = desktop.width && desktop.height ? ` size="${desktop.width}x${desktop.height}"` : '';
      lines.push(
        `  <desktop target="v42:${xmlEscape(desktop.computerId)}:desktop" computer="${xmlEscape(desktop.computerName || desktop.computerId)}"${size} controlled_by="${xmlEscape(takeover.controlledBy)}" />`,
      );
    }

    for (const mobile of summary.mobiles) {
      const takeover = this.getTakeover(`mobile:${mobile.key}`);
      const size = mobile.width && mobile.height ? ` size="${mobile.width}x${mobile.height}"` : '';
      lines.push(
        `  <mobile target="v42:${xmlEscape(mobile.computerId)}:mobile:${xmlEscape(mobile.deviceId)}" platform="${xmlEscape(mobile.platform || 'android')}"${size} controlled_by="${xmlEscape(takeover.controlledBy)}" />`,
      );
    }

    for (const fwd of summary.forwards) {
      lines.push(
        `  <forward computer="${xmlEscape(fwd.computerId)}" remote_port="${fwd.remotePort}" local="127.0.0.1:${fwd.localPort}" />`,
      );
    }

    lines.push('</v42-context>');

    const footer = '</v42-context>';
    const kept = [lines[0]];
    let used = Buffer.byteLength(`${lines[0]}\n${footer}`, 'utf8');
    let omitted = 0;

    for (let i = 1; i < lines.length - 1; i += 1) {
      const candidate = lines[i];
      const delta = Buffer.byteLength(`${candidate}\n`, 'utf8');
      if (used + delta + 48 <= maxBytes) {
        kept.push(candidate);
        used += delta;
      } else {
        omitted += 1;
      }
    }

    if (omitted > 0) {
      const moreLine = `  <omitted count="${omitted}" />`;
      if (used + Buffer.byteLength(`${moreLine}\n`, 'utf8') <= maxBytes) {
        kept.push(moreLine);
      }
    }
    kept.push(footer);
    return kept.join('\n');
  }
}
