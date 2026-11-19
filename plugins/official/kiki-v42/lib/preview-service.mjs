import { mapMobileSystemKey } from './cua-provider.mjs';
import { readPngDimensions } from './png-crop.mjs';
import { parseSeatRef } from './v42-client.mjs';

export class V42WorkbenchService {
  constructor({
    v42Client,
    desktopSessions,
    portForwards,
    leaseStore,
    cuaProvider,
    orchestrator,
  }) {
    this.v42Client = v42Client;
    this.desktopSessions = desktopSessions;
    this.portForwards = portForwards;
    this.leaseStore = leaseStore;
    this.cuaProvider = cuaProvider;
    this.orchestrator = orchestrator;
    this.activeStreams = new Set();

    this.unsubscribeStore = this.leaseStore.onChange((event) => {
      this.broadcastStreamEvent({ type: 'lease_changed', event, summary: this.buildLeaseSnapshot() });
    });
  }

  buildLeaseSnapshot() {
    const managed = this.leaseStore.getManagedSummary();
    return {
      selectedTarget: this.leaseStore.state.selectedTarget,
      seats: managed.seats.map((seat) => ({
        ...seat,
        takeover: this.leaseStore.getTakeover(`seat:${seat.seatRef}`),
      })),
      desktops: managed.desktops.map((desktop) => ({
        ...desktop,
        cuaTargetId: `v42:${desktop.computerId}:desktop`,
        takeover: this.leaseStore.getTakeover(`desktop:${desktop.computerId}`),
      })),
      mobiles: managed.mobiles.map((mobile) => ({
        ...mobile,
        cuaTargetId: `v42:${mobile.computerId}:mobile:${mobile.deviceId}`,
        takeover: this.leaseStore.getTakeover(`mobile:${mobile.key}`),
      })),
      forwards: managed.forwards,
      counts: managed.counts,
    };
  }

  broadcastStreamEvent(payload) {
    const text = JSON.stringify(payload);
    for (const session of this.activeStreams) {
      try {
        session.sendText(text);
      } catch {}
    }
  }

  async getState({ includeUnmanaged = false, computer, settings = {}, workspaceRoot, kikiHome } = {}) {
    await this.orchestrator.prepareRuntimeContext({ settings, workspaceRoot, kikiHome });
    const ctx = { settings, workspaceRoot, timeoutMs: 10_000 };

    let connectionError = null;
    const [targetInfo, computers, workspaces, rawForwards, termSummary] = await Promise.all([
      this.v42Client.resolveTarget(ctx).catch(() => null),
      this.v42Client.listComputers(ctx).catch((err) => {
        connectionError = {
          code: err?.code || 'v42_unavailable',
          exitCode: err?.exitCode,
          message: err?.message || String(err),
        };
        return [];
      }),
      this.v42Client.listWorkspaces(ctx).catch(() => []),
      this.portForwards.list({ computer }),
      this.v42Client.listTerminals({ computer, ...ctx }).catch(() => ({ terminals: [] })),
    ]);

    const compNameById = new Map(computers.map((c) => [c.id, c.name || c.id]));
    const forwards = rawForwards.map((fwd) => {
      const compId = fwd.computer || fwd.computerId || '';
      const stored = this.leaseStore.state.forwards[`${compId}:${Number(fwd.remotePort)}`];
      return {
        ...fwd,
        computerName: compNameById.get(compId) || compId,
        pinned: Boolean(stored?.pinned),
      };
    });

    const liveSeats = (termSummary?.terminals || []).slice(0, 120).map((term) => {
      const compId = term.computer_id || computer || computers[0]?.id || 'default';
      const target = term.pane_id || term.window_id || term.target;
      const seatRef = `${compId}:${target}`;
      const isPinned = this.leaseStore.isManagedSeat(this.leaseStore.state.seats[seatRef]);
      return {
        seatRef,
        computerId: compId,
        computerName: term.computer_name || compNameById.get(compId) || compId,
        target,
        windowId: term.window_id || target,
        paneId: term.pane_id || null,
        workspaceId: term.workspace_id || null,
        title: term.window_name || term.title || target,
        agent: term.agent?.app || term.current_command || 'shell',
        cwd: term.cwd || null,
        status: term.agent?.state || (term.idle ? 'idle' : 'working'),
        leased: isPinned,
      };
    });

    const snapshot = this.buildLeaseSnapshot();
    let unmanaged = null;
    if (includeUnmanaged) {
      const candidateMobiles = [];
      const onlineComps = computer
        ? computers.filter((c) => c.id === computer || c.name === computer)
        : computers.filter((c) => c.online !== false);
      if (targetInfo?.capabilities?.hasMobile !== false) {
        const mobileSettled = await Promise.allSettled(
          onlineComps.slice(0, 6).map((comp) =>
            this.v42Client.mobileDevices({ computer: comp.id, ...ctx })
              .then((devs) => ({ comp, devs })),
          ),
        );
        for (const item of mobileSettled) {
          if (item.status !== 'fulfilled') continue;
          const { comp, devs } = item.value;
          for (const dev of devs) {
            const key = `${comp.id}:${dev.id}`;
            candidateMobiles.push({
              key,
              computerId: comp.id,
              computerName: comp.name || comp.id,
              deviceId: dev.id,
              name: dev.name || dev.model || dev.id,
              platform: dev.platform || 'android',
              width: dev.width || 1080,
              height: dev.height || 2400,
              leased: this.leaseStore.isManagedMobile(this.leaseStore.state.mobiles[key]),
            });
          }
        }
      }

      unmanaged = {
        seats: liveSeats,
        desktops: onlineComps.map((c) => ({
          computerId: c.id,
          computerName: c.name || c.id,
          platform: c.platform || c.os || null,
          leased: this.leaseStore.isManagedDesktop(this.leaseStore.state.desktops[c.id]),
        })),
        mobiles: candidateMobiles,
      };
    }

    const onlineComputers = computers.filter((c) => c.online !== false).length;
    const connection = connectionError
      ? {
          online: false,
          configured: connectionError.code !== 'ENOENT',
          signedIn: connectionError.code !== 'not_logged_in' && connectionError.exitCode !== 3,
          code: connectionError.code,
          message: connectionError.message,
          totalComputers: 0,
          onlineComputers: 0,
        }
      : {
          online: onlineComputers > 0,
          configured: true,
          signedIn: true,
          code: onlineComputers > 0 ? 'ready' : 'no_online_computers',
          message: null,
          totalComputers: computers.length,
          onlineComputers,
        };

    return {
      ok: true,
      connection,
      account: targetInfo?.whoami
        ? {
            displayName: targetInfo.whoami.display_name || null,
            email: targetInfo.whoami.email || null,
            teamId: targetInfo.whoami.current_team_id || null,
          }
        : null,
      capabilities: targetInfo?.capabilities
        ? {
            desktop: Boolean(targetInfo.capabilities.hasDesktop),
            mobile: Boolean(targetInfo.capabilities.hasMobile),
            termRead: Boolean(targetInfo.capabilities.hasTermRead),
            termSend: Boolean(targetInfo.capabilities.hasTermSend),
          }
        : null,
      computers: computers.map((c) => ({
        id: c.id,
        name: c.name || c.id,
        online: c.online !== false,
        platform: c.platform || c.os || '',
        activeTerminals: Number(c.active_terminals ?? c.activeTerminals ?? 0),
        featureset: Array.isArray(c.featureset) ? c.featureset : [],
      })),
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name || w.id,
        path: w.path || '',
        computerId: w.computer_id || w.computerId || '',
        computerName: compNameById.get(w.computer_id || w.computerId) || w.computer_name || w.computer_id || '',
        terminalIsolation: Boolean(w.terminal_isolation),
      })),
      liveSeats,
      totalSeats: Array.isArray(termSummary?.terminals) ? termSummary.terminals.length : liveSeats.length,
      leased: snapshot,
      forwards,
      unmanaged,
    };
  }

  async handlePanelRequest(action, args = {}, context = {}) {
    const settings = context.settings || {};
    const workspaceRoot = context.workspaceRoot;
    const kikiHome = context.kikiHome;
    await this.orchestrator.prepareRuntimeContext({ settings, workspaceRoot, kikiHome });
    const ctx = { settings, workspaceRoot };

    switch (action) {
      case 'state':
        return this.getState({
          includeUnmanaged: Boolean(args.includeUnmanaged),
          computer: args.computer,
          settings,
          workspaceRoot,
          kikiHome,
        });

      case 'selectTarget': {
        await this.leaseStore.setSelectedTarget(args.target || null);
        return { ok: true, selectedTarget: this.leaseStore.state.selectedTarget };
      }

      case 'pin': {
        if (args.kind === 'forward' && args.computer && args.remotePort) {
          const forward = await this.leaseStore.upsertForward(args.computer, Number(args.remotePort), {
            computerName: args.title || String(args.computer),
            ...(args.localPort ? {
              localPort: Number(args.localPort),
              listen: `127.0.0.1:${Number(args.localPort)}`,
            } : {}),
            pinned: true,
            active: true,
          });
          return { ok: true, forward };
        }
        if (args.kind === 'desktop' && args.computer) {
          const desktop = await this.leaseStore.upsertDesktop(args.computer, {
            computerName: args.title || args.computer,
            pinned: true,
          });
          return { ok: true, desktop };
        }
        if (args.kind === 'mobile' && args.computer && args.deviceId) {
          const mobile = await this.leaseStore.upsertMobile(args.computer, args.deviceId, {
            name: args.title || args.deviceId,
            platform: args.platform || 'android',
            width: args.width || 1080,
            height: args.height || 2400,
            pinned: true,
          });
          return { ok: true, mobile };
        }
        if (args.seatRef) {
          const { computer, target } = parseSeatRef(args.seatRef);
          const seat = await this.leaseStore.upsertSeat(`${computer}:${target}`, {
            computerId: computer,
            terminalId: target,
            title: args.title || target,
            agent: args.agent || 'shell',
            pinned: true,
          });
          return { ok: true, seat };
        }
        throw new Error('Invalid pin target');
      }

      case 'unpin': {
        if (args.kind === 'forward' && args.computer && args.remotePort) {
          const key = `${args.computer}:${Number(args.remotePort)}`;
          if (this.leaseStore.state.forwards[key]) {
            const forward = await this.leaseStore.upsertForward(args.computer, Number(args.remotePort), {
              pinned: false,
            });
            return { ok: true, forward };
          }
          return { ok: true };
        }
        if (args.kind === 'desktop' && args.computer) {
          await this.leaseStore.unpinDesktop(args.computer);
          return { ok: true };
        }
        if (args.kind === 'mobile' && args.computer && args.deviceId) {
          await this.leaseStore.unpinMobile(args.computer, args.deviceId);
          return { ok: true };
        }
        if (args.seatRef) {
          await this.leaseStore.unpinSeat(args.seatRef);
          return { ok: true };
        }
        throw new Error('Invalid unpin target');
      }

      case 'takeover': {
        const status = await this.leaseStore.setTakeover(String(args.targetKey), {
          active: Boolean(args.active),
          holder: args.active ? 'human' : 'agent',
          reason: args.reason || 'workbench',
        });
        return { ok: true, takeover: status };
      }

      case 'seatInspect': {
        const { computer, target } = parseSeatRef(args.seatRef);
        const [viewRes, screenRes] = await Promise.all([
          this.v42Client.fetchAgentView(computer, target, { limit: 60, ...ctx }),
          this.v42Client.terminalRead(computer, target, { history: 120, ...ctx }).catch(() => ({ lines: [] })),
        ]);
        const seatRef = `${computer}:${target}`;
        await this.leaseStore.upsertSeat(
          seatRef,
          {
            computerId: computer,
            terminalId: target,
            session: viewRes.envelope.session,
            cursor: viewRes.envelope.cursor,
            status: viewRes.envelope.state?.status || 'idle',
            pending: viewRes.envelope.pending || null,
          },
          { save: Boolean(this.leaseStore.state.seats[seatRef]) },
        );
        return {
          ok: true,
          seatRef,
          envelope: viewRes.envelope,
          terminalLines: screenRes.lines || [],
          takeover: this.leaseStore.getTakeover(`seat:${seatRef}`),
        };
      }

      case 'humanSeatSend': {
        const { computer, target } = parseSeatRef(args.seatRef);
        const seatRef = `${computer}:${target}`;
        await this.leaseStore.setTakeover(`seat:${seatRef}`, {
          active: true,
          holder: 'human',
          reason: 'human_composer',
        });
        const gwSend = await this.v42Client.gatewayRequest('POST', '/api/agent-view/send', {
          body: {
            computer,
            terminal: target,
            text: String(args.text || ''),
            actor: { kind: 'human' },
          },
          ...ctx,
        });
        if (!gwSend) {
          await this.v42Client.terminalSend(computer, target, {
            text: args.text,
            keys: args.keys || [],
            enter: args.enter !== false,
            paste: Boolean(args.text && String(args.text).includes('\n')),
            ...ctx,
          });
        }
        return {
          ok: true,
          seatRef,
          takeover: this.leaseStore.getTakeover(`seat:${seatRef}`),
        };
      }

      case 'humanApprovePending': {
        const { computer, target } = parseSeatRef(args.seatRef);
        const seatRef = `${computer}:${target}`;
        const decision = args.decision === 'allow_once' ? 'allow_once' : 'deny';
        const gwAns = await this.v42Client.gatewayRequest('POST', '/api/agent-view/answer', {
          body: {
            computer,
            terminal: target,
            pendingId: args.pendingId,
            resolution: {
              kind: 'approval',
              decision,
              note: args.note || undefined,
            },
          },
          ...ctx,
        });
        if (!gwAns) {
          const key = decision === 'allow_once' ? 'y' : 'n';
          await this.v42Client.terminalSend(computer, target, {
            text: key,
            enter: true,
            ...ctx,
          });
        }
        await this.leaseStore.upsertSeat(seatRef, {
          pending: null,
          status: decision === 'allow_once' ? 'working' : 'idle',
        });
        return { ok: true, seatRef, decision };
      }

      case 'desktopWindows': {
        const data = await this.v42Client.desktopWindows(args.computer, ctx);
        return { ok: true, ...(data || {}) };
      }

      case 'desktopFrame': {
        const session = this.desktopSessions.acquire(args.computer, {
          displayId: args.displayId,
          settings,
          workspaceRoot,
        });
        if (args.displayId !== undefined && args.displayId !== null) {
          await session.selectDisplay(args.displayId);
        }
        const shot = await session.screenshot();
        return {
          ok: true,
          computer: args.computer,
          dataUrl: `data:image/png;base64,${shot.pngBase64}`,
          imageSize: shot.imageSize,
          logicalSize: shot.logicalSize,
          display: shot.display,
          takeover: this.leaseStore.getTakeover(`desktop:${args.computer}`),
        };
      }

      case 'desktopAct': {
        const computer = String(args.computer);
        await this.leaseStore.setTakeover(`desktop:${computer}`, {
          active: true,
          holder: 'human',
          reason: 'workbench_desktop_input',
        });
        const session = this.desktopSessions.acquire(computer, { settings, workspaceRoot });
        await session.ensureStarted();
        const kind = args.op;
        if (kind === 'click') {
          await session.click(args.x, args.y, { button: args.button || 'left', count: args.count || 1 });
        } else if (kind === 'move') {
          await session.move(args.x, args.y);
        } else if (kind === 'drag') {
          await session.drag(args.x1, args.y1, args.x2, args.y2, {
            button: args.button || 'left',
            steps: args.steps || 12,
          });
        } else if (kind === 'scroll') {
          await session.scroll({ x: args.x, y: args.y, dx: args.dx || 0, dy: args.dy || 0 });
        } else if (kind === 'type') {
          await session.type(args.text || '');
          if (args.enter === true) {
            await session.key('enter');
          }
        } else if (kind === 'paste') {
          await session.clipboardSet(args.text || '');
          await session.key(args.pasteKey || 'ctrl+v');
          if (args.enter === true) {
            await session.key('enter');
          }
        } else if (kind === 'clipboard_set') {
          await session.clipboardSet(args.text || '');
        } else if (kind === 'key') {
          await session.key(args.keys || 'enter');
        } else {
          throw new Error(`Unsupported desktopAct op: ${kind}`);
        }

        const takeover = this.leaseStore.getTakeover(`desktop:${computer}`);
        if (args.includeFrame === true) {
          const settleMs = Math.max(0, Math.min(400, Number(args.settleMs ?? 60)));
          if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
          const shot = await session.screenshot();
          return {
            ok: true,
            takeover,
            frame: {
              ok: true,
              computer,
              dataUrl: `data:image/png;base64,${shot.pngBase64}`,
              imageSize: shot.imageSize,
              logicalSize: shot.logicalSize,
              display: shot.display,
              takeover,
            },
          };
        }
        return {
          ok: true,
          takeover,
        };
      }

      case 'mobileFrame': {
        const { meta, pngBuffer } = await this.v42Client.mobileScreenshot(args.deviceId, {
          computer: args.computer,
          ...ctx,
        });
        const dims = readPngDimensions(pngBuffer);
        const key = `${args.computer}:${args.deviceId}`;
        return {
          ok: true,
          computer: args.computer,
          deviceId: args.deviceId,
          dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
          screenSize: {
            width: Number(meta?.width) || dims.width,
            height: Number(meta?.height) || dims.height,
          },
          takeover: this.leaseStore.getTakeover(`mobile:${key}`),
        };
      }

      case 'mobileAct': {
        const key = `${args.computer}:${args.deviceId}`;
        await this.leaseStore.setTakeover(`mobile:${key}`, {
          active: true,
          holder: 'human',
          reason: 'workbench_mobile_input',
        });
        const op = args.op;
        if (op === 'tap') {
          await this.v42Client.mobileTap(args.deviceId, args.x, args.y, {
            computer: args.computer,
            pixel: true,
            ...ctx,
          });
        } else if (op === 'longPress' || op === 'long_press') {
          await this.v42Client.mobileLongPress(args.deviceId, args.x, args.y, {
            computer: args.computer,
            pixel: true,
            durationMs: args.durationMs || 620,
            ...ctx,
          });
        } else if (op === 'swipe') {
          await this.v42Client.mobileSwipe(args.deviceId, args.x1, args.y1, args.x2, args.y2, {
            computer: args.computer,
            pixel: true,
            durationMs: args.durationMs || 280,
            ...ctx,
          });
        } else if (op === 'scroll') {
          const storedMob = this.leaseStore.state.mobiles[key];
          const maxW = Math.max(1, Number(args.screenWidth) || Number(storedMob?.width) || 1080);
          const maxH = Math.max(1, Number(args.screenHeight) || Number(storedMob?.height) || 2400);
          const x1 = Math.max(0, Math.min(maxW - 1, Math.round(Number(args.x) || maxW / 2)));
          const y1 = Math.max(0, Math.min(maxH - 1, Math.round(Number(args.y) || maxH / 2)));
          const dx = Math.round(Number(args.dx) || 0);
          const dy = Math.round(Number(args.dy) || 0);
          const x2 = Math.max(0, Math.min(maxW - 1, x1 - dx));
          const y2 = Math.max(0, Math.min(maxH - 1, y1 - dy));
          await this.v42Client.mobileSwipe(args.deviceId, x1, y1, x2, y2, {
            computer: args.computer,
            pixel: true,
            durationMs: args.durationMs || 240,
            ...ctx,
          });
        } else if (op === 'type' || op === 'paste') {
          await this.v42Client.mobileType(args.deviceId, args.text || '', {
            computer: args.computer,
            enter: Boolean(args.enter),
            ...ctx,
          });
        } else if (op === 'key') {
          await this.v42Client.mobileKey(args.deviceId, mapMobileSystemKey(args.key || 'home'), {
            computer: args.computer,
            ...ctx,
          });
        } else if (op === 'wake') {
          await this.v42Client.mobileWake(args.deviceId, { computer: args.computer, ...ctx });
        } else if (op === 'unlock') {
          await this.v42Client.mobileUnlock(args.deviceId, { computer: args.computer, ...ctx });
        } else {
          throw new Error(`Unsupported mobileAct op: ${op}`);
        }

        const takeover = this.leaseStore.getTakeover(`mobile:${key}`);
        if (args.includeFrame === true) {
          const settleMs = Math.max(0, Math.min(500, Number(args.settleMs ?? 80)));
          if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
          const { meta, pngBuffer } = await this.v42Client.mobileScreenshot(args.deviceId, {
            computer: args.computer,
            ...ctx,
          });
          const dims = readPngDimensions(pngBuffer);
          return {
            ok: true,
            takeover,
            frame: {
              ok: true,
              computer: args.computer,
              deviceId: args.deviceId,
              dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
              screenSize: {
                width: Number(meta?.width) || dims.width,
                height: Number(meta?.height) || dims.height,
              },
              takeover,
            },
          };
        }
        return {
          ok: true,
          takeover,
        };
      }

      case 'forwardStart': {
        const tunnel = await this.portForwards.start({
          computer: args.computer,
          remotePort: Number(args.remotePort),
          localPort: args.localPort ? Number(args.localPort) : undefined,
          settings,
          workspaceRoot,
        });
        return { ok: true, tunnel };
      }

      case 'forwardStop': {
        const result = await this.portForwards.stop({
          computer: args.computer,
          remotePort: args.remotePort ? Number(args.remotePort) : undefined,
          localPort: args.localPort ? Number(args.localPort) : undefined,
        });
        return { ok: true, ...result };
      }

      default:
        throw new Error(`Unknown Vibe42 workbench action: ${action}`);
    }
  }

  openPanelStream(streamName, args = {}, session, context = {}) {
    this.activeStreams.add(session);
    session.sendText({
      type: 'hello',
      stream: streamName,
      leased: this.buildLeaseSnapshot(),
    });

    return {
      result: {
        protocol: 'kiki.v42.workbench.v1',
        stream: streamName,
      },
      onText: async (rawText) => {
        let msg;
        try {
          msg = JSON.parse(rawText);
        } catch {
          return;
        }
        if (msg?.action) {
          try {
            const res = await this.handlePanelRequest(msg.action, msg.args || {}, context);
            session.sendText({ type: 'rpc_result', id: msg.id, ok: true, result: res });
          } catch (err) {
            session.sendText({
              type: 'rpc_result',
              id: msg.id,
              ok: false,
              error: err?.message || String(err),
            });
          }
        }
      },
      onClose: () => {
        this.activeStreams.delete(session);
      },
    };
  }

  async dispose() {
    this.unsubscribeStore?.();
    for (const stream of this.activeStreams) {
      try { stream.close('Plugin deactivated'); } catch {}
    }
    this.activeStreams.clear();
  }
}
