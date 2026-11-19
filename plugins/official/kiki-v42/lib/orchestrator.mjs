import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCuaTargetId } from './cua-provider.mjs';
import { readPngDimensions } from './png-crop.mjs';
import { parseSeatRef, V42CliError } from './v42-client.mjs';

function isWithinDir(targetPath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveAdmittedLocalPath(rawPath, context = {}) {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new V42CliError('local_path is required for file transfer actions', { code: 'missing_local_path' });
  }
  const baseRoot = context.workspaceRoot ? path.resolve(context.workspaceRoot) : process.cwd();
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(baseRoot, rawPath);
  if (context.workspaceRoot && isWithinDir(resolved, context.workspaceRoot)) {
    return resolved;
  }
  const approved = Array.isArray(context.approvedPaths) ? context.approvedPaths : [];
  if (approved.some((allowed) => isWithinDir(resolved, allowed))) {
    return resolved;
  }
  if (!context.workspaceRoot && path.isAbsolute(rawPath)) {
    return resolved;
  }
  throw new V42CliError(
    `Local path "${rawPath}" is outside workspaceRoot and not in approvedPaths. Pass a workspace-relative path or ask the user to approve the external directory first.`,
    { code: 'path_not_admitted', status: 403 },
  );
}

function normalizePinReference(args) {
  const ref = String(args.seat_ref || '').trim();
  if (ref.startsWith('v42:')) {
    const cua = parseCuaTargetId(ref);
    if (cua?.kind === 'desktop') return { kind: 'desktop', computer: cua.computer };
    if (cua?.kind === 'mobile') return { kind: 'mobile', computer: cua.computer, deviceId: cua.deviceId };
  }
  const desktopShort = /^([^:]+):desktop$/.exec(ref);
  if (desktopShort) {
    return { kind: 'desktop', computer: desktopShort[1] };
  }
  const mobileShort = /^([^:]+):mobile:(.+)$/.exec(ref);
  if (mobileShort) {
    return { kind: 'mobile', computer: mobileShort[1], deviceId: mobileShort[2] };
  }
  if (ref) {
    const parsed = parseSeatRef(ref);
    return { kind: 'seat', seatRef: `${parsed.computer}:${parsed.target}`, ...parsed };
  }
  if (args.computer) {
    return { kind: 'desktop', computer: String(args.computer) };
  }
  throw new V42CliError('pin/unpin requires seat_ref (or "<computer>:desktop" / "<computer>:mobile:<deviceId>")', {
    code: 'missing_seat_ref',
  });
}

function detectImageMime(buf, filePath = '') {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function jsonToolResult(payload, isError = false) {
  return {
    output: JSON.stringify(payload, null, 2),
    isError,
  };
}

export class V42Orchestrator {
  constructor({
    v42Client,
    desktopSessions,
    portForwards,
    leaseStore,
    cuaProvider,
    env = process.env,
  }) {
    this.v42Client = v42Client;
    this.desktopSessions = desktopSessions;
    this.portForwards = portForwards;
    this.leaseStore = leaseStore;
    this.cuaProvider = cuaProvider;
    this.env = env;
  }

  async prepareRuntimeContext(context = {}) {
    await this.leaseStore.load({
      kikiHome: context.kikiHome,
      env: this.env,
    });
    await this.cuaProvider?.ensureStarted({
      settings: context.settings,
      workspaceRoot: context.workspaceRoot,
      kikiHome: context.kikiHome,
      dataDir: this.leaseStore.dataDir,
    }).catch(() => {});
  }

  async executeTool(toolName, args = {}, context = {}) {
    try {
      await this.prepareRuntimeContext(context);
      switch (toolName) {
        case 'v42_fleet':
          return await this.executeFleet(args, context);
        case 'v42_seat_run':
          return await this.executeSeatRun(args, context);
        case 'v42_seat_inspect':
          return await this.executeSeatInspect(args, context);
        case 'v42_seat_resolve':
          return await this.executeSeatResolve(args, context);
        case 'v42_env_transfer':
          return await this.executeEnvTransfer(args, context);
        default:
          return jsonToolResult({ ok: false, code: 'unknown_tool', message: `Unknown tool: ${toolName}` }, true);
      }
    } catch (err) {
      const code = err?.code || 'v42_error';
      const status = err?.status || undefined;
      return jsonToolResult(
        {
          ok: false,
          code,
          status,
          exitCode: err?.exitCode,
          message: err?.message || String(err),
          details: err?.details ?? undefined,
        },
        true,
      );
    }
  }

  async executeFleet(args = {}, context = {}) {
    const scope = args.scope || 'summary';
    const includeUnmanaged = args.include_unmanaged !== false;
    const statusFilter = args.status_filter || 'all';
    const ctx = { settings: context.settings, workspaceRoot: context.workspaceRoot, signal: context.signal };

    if (scope === 'forwards') {
      const forwards = await this.portForwards.list({ computer: args.computer });
      return jsonToolResult({ ok: true, scope, forwards });
    }

    if (scope === 'memos') {
      if (!args.workspace) {
        const workspaces = await this.v42Client.listWorkspaces(ctx);
        const targetWs = args.computer
          ? workspaces.filter((w) => w.computer_id === args.computer || w.computer_name === args.computer)
          : workspaces;
        const memoLists = await Promise.all(
          targetWs.slice(0, 10).map(async (ws) => ({
            workspace: ws.name || ws.id,
            memos: await this.v42Client.listMemos(ws.id || ws.name, ctx).catch(() => []),
          })),
        );
        return jsonToolResult({ ok: true, scope, workspaces: memoLists });
      }
      const memos = await this.v42Client.listMemos(args.workspace, ctx);
      return jsonToolResult({ ok: true, scope, workspace: args.workspace, memos });
    }

    if (scope === 'workspaces') {
      const workspaces = await this.v42Client.listWorkspaces(ctx);
      const filtered = args.computer
        ? workspaces.filter((w) => w.computer_id === args.computer || w.computer_name === args.computer)
        : workspaces;
      return jsonToolResult({ ok: true, scope, workspaces: filtered });
    }

    if (scope === 'devices') {
      const computers = args.computer
        ? [{ id: args.computer, name: args.computer, online: true }]
        : await this.v42Client.listComputers(ctx);
      const allDevices = [];
      for (const comp of computers) {
        if (comp.online === false) continue;
        const devs = await this.v42Client.mobileDevices({ computer: comp.id, ...ctx }).catch(() => []);
        for (const dev of devs) {
          const key = `${comp.id}:${dev.id}`;
          const leased = this.leaseStore.isManagedMobile(this.leaseStore.state.mobiles[key]);
          if (!includeUnmanaged && !leased) continue;
          const takeover = this.leaseStore.getTakeover(`mobile:${key}`);
          allDevices.push({
            ...dev,
            computer_id: comp.id,
            computer_name: comp.name || comp.id,
            cua_target_id: `v42:${comp.id}:mobile:${dev.id}`,
            leased,
            controlled_by: takeover.controlledBy,
          });
        }
      }
      return jsonToolResult({ ok: true, scope, devices: allDevices });
    }

    const [computers, workspaces, termListing, forwards, targetInfo] = await Promise.all([
      this.v42Client.listComputers(ctx),
      scope === 'summary' ? this.v42Client.listWorkspaces(ctx).catch(() => []) : Promise.resolve([]),
      this.v42Client.listTerminals({
        computer: args.computer,
        workspace: args.workspace,
        ...ctx,
      }),
      this.portForwards.list({ computer: args.computer }),
      this.v42Client.resolveTarget(ctx).catch(() => null),
    ]);

    const compById = new Map(computers.map((c) => [c.id, c]));
    const seats = [];
    for (const term of termListing.terminals) {
      const compId = term.computer_id || args.computer || 'default';
      const targetId = term.pane_id || term.window_id || term.target;
      const seatRef = `${compId}:${targetId}`;
      const stored = this.leaseStore.state.seats[seatRef];
      const leased = this.leaseStore.isManagedSeat(stored);
      if (!includeUnmanaged && !leased) continue;

      const agentState = term.agent?.state || stored?.status || (term.idle ? 'idle' : 'working');
      if (statusFilter !== 'all' && agentState !== statusFilter) continue;

      const takeover = this.leaseStore.getTakeover(`seat:${seatRef}`);
      seats.push({
        seat_ref: seatRef,
        computer_id: compId,
        computer_name: term.computer_name || compById.get(compId)?.name || compId,
        window_id: term.window_id,
        pane_id: term.pane_id,
        workspace_id: term.workspace_id || stored?.workspaceId || null,
        cwd: term.cwd || stored?.cwd || null,
        title: term.window_name || term.title || stored?.title || targetId,
        agent: term.agent?.app || stored?.agent || term.current_command || 'shell',
        session: stored?.session || term.session || 'tmux',
        status: agentState,
        cursor: stored?.cursor || null,
        leased,
        pinned: Boolean(stored?.pinned),
        controlled_by: takeover.controlledBy,
      });
    }

    if (scope === 'seats') {
      return jsonToolResult({
        ok: true,
        scope,
        include_unmanaged: includeUnmanaged,
        total_seats: seats.length,
        seats,
      });
    }

    const filteredComputers = args.computer
      ? computers.filter((c) => c.id === args.computer || c.name === args.computer)
      : computers;
    const matchedCompIds = new Set(filteredComputers.map((c) => c.id));
    const filteredWorkspaces = args.computer
      ? workspaces.filter((w) => w.computer_id === args.computer || w.computer_name === args.computer || matchedCompIds.has(w.computer_id))
      : workspaces;

    return jsonToolResult({
      ok: true,
      scope: 'summary',
      account: targetInfo?.whoami
        ? {
            display_name: targetInfo.whoami.display_name || null,
            email: targetInfo.whoami.email || null,
            current_team_id: targetInfo.whoami.current_team_id || null,
          }
        : undefined,
      computers: filteredComputers,
      workspaces: filteredWorkspaces,
      leased_counts: this.leaseStore.getManagedSummary().counts,
      seats,
      forwards,
    });
  }

  async executeSeatRun(args = {}, context = {}) {
    const { action } = args;
    const ctx = { settings: context.settings, workspaceRoot: context.workspaceRoot, signal: context.signal };

    if (action === 'pin' || action === 'unpin') {
      const pinTarget = normalizePinReference(args);
      if (action === 'pin') {
        if (pinTarget.kind === 'desktop') {
          const desktop = await this.leaseStore.upsertDesktop(pinTarget.computer, {
            computerName: args.title || pinTarget.computer,
            pinned: true,
          });
          return jsonToolResult({
            ok: true,
            action: 'pin',
            target_kind: 'desktop',
            cua_target_id: `v42:${pinTarget.computer}:desktop`,
            desktop,
          });
        }
        if (pinTarget.kind === 'mobile') {
          const mobile = await this.leaseStore.upsertMobile(pinTarget.computer, pinTarget.deviceId, {
            name: args.title || pinTarget.deviceId,
            pinned: true,
          });
          return jsonToolResult({
            ok: true,
            action: 'pin',
            target_kind: 'mobile',
            cua_target_id: `v42:${pinTarget.computer}:mobile:${pinTarget.deviceId}`,
            mobile,
          });
        }
        const live = await this.v42Client.fetchAgentView(pinTarget.computer, pinTarget.target, ctx).catch(() => null);
        const env = live?.envelope;
        const seat = await this.leaseStore.upsertSeat(pinTarget.seatRef, {
          computerId: pinTarget.computer,
          terminalId: pinTarget.target,
          windowId: env?.windowId || pinTarget.target,
          paneId: env?.paneId || null,
          title: args.title || env?.title || pinTarget.target,
          cwd: env?.cwd || args.cwd || null,
          agent: env?.agent?.kind || args.agent || 'shell',
          session: env?.session || 'tmux',
          cursor: env?.cursor || null,
          status: env?.state?.status || 'idle',
          pending: env?.pending || null,
          pinned: true,
        });
        return jsonToolResult({ ok: true, action: 'pin', target_kind: 'seat', seat_ref: seat.seatRef, seat });
      }

      if (pinTarget.kind === 'desktop') {
        await this.leaseStore.unpinDesktop(pinTarget.computer);
        return jsonToolResult({ ok: true, action: 'unpin', target_kind: 'desktop', computer: pinTarget.computer });
      }
      if (pinTarget.kind === 'mobile') {
        await this.leaseStore.unpinMobile(pinTarget.computer, pinTarget.deviceId);
        return jsonToolResult({
          ok: true,
          action: 'unpin',
          target_kind: 'mobile',
          computer: pinTarget.computer,
          mobile_device_id: pinTarget.deviceId,
        });
      }
      await this.leaseStore.unpinSeat(pinTarget.seatRef);
      return jsonToolResult({ ok: true, action: 'unpin', target_kind: 'seat', seat_ref: pinTarget.seatRef });
    }

    let seatRef = args.seat_ref ? String(args.seat_ref).trim() : '';
    let computer;
    let target;

    if (seatRef) {
      const parsed = parseSeatRef(seatRef);
      computer = parsed.computer;
      target = parsed.target;
      seatRef = `${computer}:${target}`;

      const takeoverGate = this.leaseStore.checkAgentControlAllowed(
        `seat:${seatRef}`,
        args.override_human_lease === true,
      );
      if (!takeoverGate.allowed) {
        return jsonToolResult(
          {
            ok: false,
            status: 409,
            code: 'human_controlling',
            seat_ref: seatRef,
            controlled_by: 'human',
            message: takeoverGate.message,
          },
          true,
        );
      }
    }

    if (action === 'interrupt') {
      if (!seatRef) throw new V42CliError('interrupt requires seat_ref', { code: 'missing_seat_ref' });
      const gwRes = await this.v42Client.gatewayRequest('POST', '/api/agent-view/interrupt', {
        body: { computer, terminal: target, expectedSession: args.expected_session },
        ...ctx,
      });
      if (!gwRes) {
        await this.v42Client.terminalSend(computer, target, { keys: ['escape', 'ctrl+c'], ...ctx });
      }
      const updated = await this.leaseStore.upsertSeat(seatRef, {
        computerId: computer,
        terminalId: target,
        status: 'idle',
        createdByKiki: this.leaseStore.state.seats[seatRef]?.createdByKiki ?? true,
      });
      return jsonToolResult({
        ok: true,
        action: 'interrupt',
        seat_ref: seatRef,
        status: updated.status,
      });
    }

    if (action === 'control') {
      if (!seatRef) throw new V42CliError('control requires seat_ref', { code: 'missing_seat_ref' });
      if (!args.control?.kind || args.control?.value === undefined) {
        throw new V42CliError('control action requires control: { kind, value }', { code: 'missing_control' });
      }
      const gwRes = await this.v42Client.gatewayRequest('POST', '/api/agent-view/control', {
        body: {
          computer,
          terminal: target,
          expectedSession: args.expected_session,
          kind: args.control.kind,
          value: args.control.value,
        },
        ...ctx,
      });
      if (!gwRes) {
        const slashCmd = args.control.kind === 'compact'
          ? `/compact ${args.control.value}`.trim()
          : `/${args.control.kind} ${args.control.value}`;
        await this.v42Client.terminalSend(computer, target, { text: slashCmd, enter: true, ...ctx });
      }
      return jsonToolResult({
        ok: true,
        action: 'control',
        seat_ref: seatRef,
        applied: args.control,
      });
    }

    if (!seatRef) {
      if (action !== 'dispatch') {
        throw new V42CliError(`${action} requires an existing seat_ref`, { code: 'missing_seat_ref' });
      }
      computer = args.computer;
      if (!computer) {
        const comps = await this.v42Client.listComputers(ctx);
        const online = comps.filter((c) => c.online !== false);
        if (online.length === 1) computer = online[0].id;
        else {
          throw new V42CliError(
            'Specify computer when creating a new seat (multiple or zero online Computers found). Call v42_fleet({ scope: "summary" }) to inspect online Computer IDs.',
            { code: 'missing_computer' },
          );
        }
      }

      if (args.idempotency_key) {
        const preHit = this.leaseStore.lookupIdempotency(`new:${computer}`, '*', args.idempotency_key);
        if (preHit) {
          return jsonToolResult({ ...preHit, deduplicated: true });
        }
      }

      context.progress?.({ kind: 'status', text: `Opening coding seat on ${computer}` });
      const created = await this.v42Client.createTerminal({
        computer,
        workspace: args.workspace,
        cwd: args.cwd,
        title: args.title,
        agent: args.agent || 'claude-code',
        ...ctx,
      });
      target = created?.pane_id || created?.window_id || created?.target;
      if (!target) {
        throw new V42CliError('v42 term new did not return a terminal target ID', { code: 'create_seat_failed' });
      }
      if (args.isolated_copy === true) {
        let hasIsolation = Boolean(created?.terminal_isolation || created?.copy_id);
        if (!hasIsolation) {
          const st = await this.v42Client.terminalStatus(computer, target, ctx).catch(() => null);
          hasIsolation = Boolean(st?.terminal_isolation || st?.copy_id);
        }
        if (!hasIsolation) {
          await this.v42Client.terminalClose(computer, target, { force: true, ...ctx }).catch(() => {});
          return jsonToolResult(
            {
              ok: false,
              status: 409,
              code: 'isolated_copy_unavailable',
              computer,
              workspace: args.workspace || null,
              message: `Workspace copy-on-write terminal isolation is not enabled on "${computer}"${args.workspace ? ` (${args.workspace})` : ''}. Enable terminal isolation on the target Vibe42 Workspace before requesting isolated_copy=true, or omit isolated_copy.`,
            },
            true,
          );
        }
      }
      seatRef = `${computer}:${target}`;
      await this.leaseStore.upsertSeat(seatRef, {
        computerId: computer,
        terminalId: target,
        windowId: created?.window_id || target,
        paneId: created?.pane_id || null,
        workspaceId: created?.workspace_id || args.workspace || null,
        cwd: args.cwd || null,
        title: args.title || `${args.agent || 'claude-code'} seat`,
        agent: args.agent || created?.agent || 'claude-code',
        session: created?.session || 'tmux',
        copyId: created?.copy_id || (created?.terminal_isolation ? '1' : null),
        createdByKiki: true,
        status: 'idle',
      });
    }

    const preView = await this.v42Client.fetchAgentView(computer, target, ctx).catch(() => null);
    const currentSession = preView?.envelope?.session || this.leaseStore.state.seats[seatRef]?.session || 'tmux';

    if (args.expected_session && currentSession && args.expected_session !== currentSession) {
      return jsonToolResult(
        {
          ok: false,
          status: 409,
          code: 'session_changed',
          seat_ref: seatRef,
          expected_session: args.expected_session,
          actual_session: currentSession,
          message: `Seat ${seatRef} rotated session from "${args.expected_session}" to "${currentSession}". Inspect the seat before sending new instructions.`,
        },
        true,
      );
    }

    if (args.idempotency_key) {
      const cached = this.leaseStore.lookupIdempotency(seatRef, currentSession, args.idempotency_key);
      if (cached) {
        return jsonToolResult({ ...cached, deduplicated: true });
      }
    }

    const stagedAttachments = [];
    if (Array.isArray(args.local_attachments) && args.local_attachments.length > 0) {
      const stageId = Date.now().toString(36);
      for (const item of args.local_attachments) {
        const localAbs = resolveAdmittedLocalPath(item, context);
        const remoteDest = `/tmp/kiki-v42-stage-${stageId}-${path.basename(localAbs)}`;
        await this.v42Client.copyTransfer(localAbs, `${computer}:${remoteDest}`, { recursive: false, ...ctx });
        stagedAttachments.push({ localPath: localAbs, stagingPath: remoteDest, name: path.basename(localAbs) });
      }
    }

    const promptText = String(args.prompt || '').trim();
    if (promptText || stagedAttachments.length > 0) {
      const attachmentSuffix = stagedAttachments.length > 0
        ? `\n\nAttached files on this Computer:\n${stagedAttachments.map((a) => `- ${a.stagingPath}`).join('\n')}`
        : '';
      const fullPrompt = `${promptText}${attachmentSuffix}`.trim();

      const gwSend = await this.v42Client.gatewayRequest('POST', '/api/agent-view/send', {
        body: {
          computer,
          terminal: target,
          expectedSession: args.expected_session || undefined,
          text: promptText,
          steerMode: args.steer_mode || 'auto',
          attachments: stagedAttachments.map((a) => ({ stagingPath: a.stagingPath, name: a.name })),
          actor: { kind: 'orchestrator', label: 'Kiki' },
          idempotencyKey: args.idempotency_key || undefined,
        },
        ...ctx,
      });

      if (!gwSend) {
        await this.v42Client.terminalSend(computer, target, {
          text: fullPrompt,
          enter: true,
          paste: true,
          useStdin: true,
          ...ctx,
        });
      }
    }

    await this.leaseStore.upsertSeat(seatRef, {
      computerId: computer,
      terminalId: target,
      session: currentSession,
      createdByKiki: true,
      status: 'working',
    });

    const waitMode = args.wait_mode || 'auto';
    if (waitMode === 'async') {
      const asyncView = await this.v42Client.fetchAgentView(computer, target, ctx).catch(() => preView);
      const env = asyncView?.envelope;
      const receipt = {
        ok: true,
        action,
        wait_mode: 'async',
        background: true,
        seat_ref: seatRef,
        session: env?.session || currentSession,
        cursor: env?.cursor || `${target}:${currentSession}:0`,
        copy_id: this.leaseStore.state.seats[seatRef]?.copyId || null,
        status: 'working',
        staged_attachments: stagedAttachments.map((a) => a.stagingPath),
      };
      if (args.idempotency_key) {
        await this.leaseStore.recordIdempotency(seatRef, currentSession, args.idempotency_key, receipt);
        if (!args.seat_ref) {
          await this.leaseStore.recordIdempotency(`new:${computer}`, '*', args.idempotency_key, receipt);
        }
      }
      return jsonToolResult(receipt);
    }

    const defaultAutoMs = Number(this.env.KIKI_V42_AUTO_WAIT_MS) || Number(context.settings?.autoWaitMs) || 25_000;
    const waitMs = waitMode === 'turn' ? 120_000 : defaultAutoMs;
    const waitSec = Math.max(1, Math.ceil(waitMs / 1000));

    context.progress?.({
      kind: 'progress',
      percent: 30,
      text: `Waiting up to ${waitSec}s for seat ${seatRef}`,
    });

    const waitOutcome = await this.v42Client.terminalWait(computer, target, {
      until: 'done',
      timeoutSec: waitSec,
      ...ctx,
    });

    const postView = await this.v42Client.fetchAgentView(computer, target, ctx).catch(() => preView);
    const env = postView?.envelope;
    const finalStatus = waitOutcome.timedOut
      ? (env?.state?.status === 'blocked' || env?.state?.status === 'error' ? env.state.status : 'working')
      : (env?.state?.status === 'idle' ? 'done' : (env?.state?.status || 'done'));
    const lastRow = Array.isArray(env?.rows) && env.rows.length > 0 ? env.rows[env.rows.length - 1] : null;
    const summary = lastRow?.text
      ? String(lastRow.text).slice(-600)
      : (Array.isArray(env?.screenLines) ? env.screenLines.slice(-12).join('\n') : '');

    await this.leaseStore.upsertSeat(seatRef, {
      computerId: computer,
      terminalId: target,
      session: env?.session || currentSession,
      cursor: env?.cursor || null,
      status: finalStatus,
      pending: env?.pending || null,
      lastSummary: summary.slice(0, 240),
      createdByKiki: true,
    });

    const receipt = {
      ok: true,
      action,
      wait_mode: waitMode,
      background: waitOutcome.timedOut && finalStatus === 'working',
      wait_timed_out: waitOutcome.timedOut,
      seat_ref: seatRef,
      session: env?.session || currentSession,
      cursor: env?.cursor || `${target}:${currentSession}:1`,
      copy_id: this.leaseStore.state.seats[seatRef]?.copyId || null,
      status: finalStatus,
      pending: env?.pending || null,
      summary,
      staged_attachments: stagedAttachments.map((a) => a.stagingPath),
    };

    if (args.idempotency_key) {
      await this.leaseStore.recordIdempotency(seatRef, currentSession, args.idempotency_key, receipt);
      if (!args.seat_ref) {
        await this.leaseStore.recordIdempotency(`new:${computer}`, '*', args.idempotency_key, receipt);
      }
    }

    return jsonToolResult(receipt);
  }

  async executeSeatInspect(args = {}, context = {}) {
    const { computer, target } = parseSeatRef(args.seat_ref);
    const seatRef = `${computer}:${target}`;
    const mode = args.mode || 'turns';
    const limit = Number(args.limit) || (mode === 'turns' ? 10 : 50);
    const ctx = { settings: context.settings, workspaceRoot: context.workspaceRoot, signal: context.signal };

    if (mode === 'terminal_screen') {
      const readData = await this.v42Client.terminalRead(computer, target, { history: limit, ...ctx });
      return jsonToolResult({
        ok: true,
        seat_ref: seatRef,
        mode: 'terminal_screen',
        rows: readData?.rows,
        cols: readData?.cols,
        lines: readData?.lines || [],
      });
    }

    if (mode === 'copy_diff') {
      const storedSeat = this.leaseStore.state.seats[seatRef];
      const copyScope = {
        workspace: storedSeat?.workspaceId || undefined,
        computer: storedSeat?.workspaceId ? undefined : computer,
        root: storedSeat?.workspaceId ? undefined : storedSeat?.cwd || undefined,
        copy: args.copy_id || storedSeat?.copyId || '1',
      };
      if (args.path) {
        const diffData = await this.v42Client.copyDiff(args.path, copyScope, ctx);
        return jsonToolResult({ ok: true, seat_ref: seatRef, mode: 'copy_diff', path: args.path, diff: diffData });
      }
      const changes = await this.v42Client.copyChanges(copyScope, ctx);
      return jsonToolResult({ ok: true, seat_ref: seatRef, mode: 'copy_diff', changes });
    }

    if (mode === 'more') {
      if (!args.more_token) {
        throw new V42CliError('mode "more" requires more_token', { code: 'missing_more_token' });
      }
      const gwMore = await this.v42Client.gatewayRequest('GET', '/api/agent-view/content', {
        query: { computer, terminal: target, token: args.more_token },
        ...ctx,
      });
      if (gwMore) return jsonToolResult({ ok: true, seat_ref: seatRef, mode: 'more', content: gwMore });
      const fallbackScreen = await this.v42Client.terminalRead(computer, target, { history: 250, ...ctx });
      return jsonToolResult({
        ok: true,
        seat_ref: seatRef,
        mode: 'more',
        more_token: args.more_token,
        lines: fallbackScreen?.lines || [],
      });
    }

    if (mode === 'subagent') {
      if (!args.subagent_id) {
        throw new V42CliError('mode "subagent" requires subagent_id', { code: 'missing_subagent_id' });
      }
      const gwSub = await this.v42Client.gatewayRequest('GET', '/api/agent-view/subagent', {
        query: { computer, terminal: target, subagentId: args.subagent_id, limit },
        ...ctx,
      });
      return jsonToolResult({
        ok: true,
        seat_ref: seatRef,
        mode: 'subagent',
        subagent_id: args.subagent_id,
        subagent: gwSub || { available: false, reason: 'Subagent trace requires structured AgentView link.' },
      });
    }

    if (mode === 'media') {
      if (!args.media_id) {
        throw new V42CliError('mode "media" requires media_id', { code: 'missing_media_id' });
      }
      let mediaBytes = null;
      let mimeType = 'image/png';

      const gwMedia = await this.v42Client.gatewayRequest('GET', '/api/agent-view/media', {
        query: { computer, terminal: target, mediaId: args.media_id },
        ...ctx,
      });
      if (gwMedia?.base64) {
        mediaBytes = Buffer.from(gwMedia.base64, 'base64');
        mimeType = gwMedia.mimeType || detectImageMime(mediaBytes, args.media_id);
      } else {
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kiki-v42-media-'));
        const tmpFile = path.join(tmpDir, path.basename(args.media_id) || 'artifact.png');
        try {
          await this.v42Client.copyTransfer(`${computer}:${args.media_id}`, tmpFile, { recursive: false, ...ctx });
          mediaBytes = await readFile(tmpFile);
          mimeType = detectImageMime(mediaBytes, tmpFile);
        } finally {
          await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      }

      const meta = {
        ok: true,
        seat_ref: seatRef,
        mode: 'media',
        media_id: args.media_id,
        mimeType,
        bytes: mediaBytes.length,
      };
      if (context.imageIn === true && /^image\/(?:png|jpeg|webp)$/.test(mimeType)) {
        return {
          output: [
            { type: 'text', text: JSON.stringify(meta) },
            { type: 'image_url', imageUrl: { url: `data:${mimeType};base64,${mediaBytes.toString('base64')}` } },
          ],
        };
      }
      return jsonToolResult(meta);
    }

    const { source, envelope } = await this.v42Client.fetchAgentView(computer, target, {
      sinceCursor: args.since_cursor,
      limit,
      mode,
      ...ctx,
    });

    await this.leaseStore.upsertSeat(
      seatRef,
      {
        computerId: computer,
        terminalId: target,
        session: envelope.session,
        cursor: envelope.cursor,
        status: envelope.state?.status || 'idle',
        pending: envelope.pending || null,
      },
      { save: Boolean(this.leaseStore.state.seats[seatRef]) },
    );

    return jsonToolResult({
      ok: true,
      seat_ref: seatRef,
      mode,
      source,
      session: envelope.session,
      cursor: envelope.cursor,
      state: envelope.state,
      pending: envelope.pending,
      rows: envelope.rows,
    });
  }

  async executeSeatResolve(args = {}, context = {}) {
    const { computer, target } = parseSeatRef(args.seat_ref);
    const seatRef = `${computer}:${target}`;
    const ctx = { settings: context.settings, workspaceRoot: context.workspaceRoot, signal: context.signal };

    if (args.resolution !== undefined) {
      const kind = args.resolution?.kind;
      if (kind !== 'answers' && kind !== 'dismiss') {
        return jsonToolResult(
          {
            ok: false,
            status: 403,
            code: 'approval_forbidden_for_model',
            seat_ref: seatRef,
            attempted_kind: kind,
            message:
              'Security violation blocked: v42_seat_resolve only permits "answers" or "dismiss". Remote approvals ("approval", "always") and "login" prompts must be approved by a human in the Vibe42 Workbench panel.',
          },
          true,
        );
      }

      const takeoverGate = this.leaseStore.checkAgentControlAllowed(`seat:${seatRef}`, false);
      if (!takeoverGate.allowed) {
        return jsonToolResult(
          {
            ok: false,
            status: 409,
            code: 'human_controlling',
            seat_ref: seatRef,
            message: takeoverGate.message,
          },
          true,
        );
      }

      const liveView = await this.v42Client.fetchAgentView(computer, target, ctx);
      const env = liveView.envelope;
      if (args.expected_session && env.session && args.expected_session !== env.session) {
        return jsonToolResult(
          {
            ok: false,
            status: 409,
            code: 'session_changed',
            seat_ref: seatRef,
            expected_session: args.expected_session,
            actual_session: env.session,
          },
          true,
        );
      }

      const storedPending = this.leaseStore.state.seats[seatRef]?.pending;
      const pending = env.pending || storedPending || null;
      const pendingKind = String(pending?.kind || env.state?.kind || '').toLowerCase();

      if (
        pendingKind === 'approval' ||
        pendingKind === 'login' ||
        pendingKind === 'permission' ||
        pending?.confirm === true ||
        pending?.secret === true
      ) {
        return jsonToolResult(
          {
            ok: false,
            status: 403,
            code: 'human_approval_required',
            seat_ref: seatRef,
            pending_id: pending?.id || args.pending_id || null,
            pending_kind: pendingKind || 'approval',
            message:
              `Seat ${seatRef} is blocked on "${pendingKind || 'approval'}" (${pending?.title || pending?.message || 'privileged action'}). ` +
              'LLM self-approval is strictly prohibited. Instruct the user to review and click Allow once or Deny in the Vibe42 Workbench panel.',
          },
          true,
        );
      }

      const gwAnswer = await this.v42Client.gatewayRequest('POST', '/api/agent-view/answer', {
        body: {
          computer,
          terminal: target,
          expectedSession: args.expected_session,
          pendingId: args.pending_id || pending?.id,
          resolution: args.resolution,
        },
        ...ctx,
      });

      if (!gwAnswer) {
        if (kind === 'dismiss') {
          await this.v42Client.terminalSend(computer, target, { keys: ['escape'], ...ctx });
        } else {
          const formatted = Object.entries(args.resolution.answers || {})
            .map(([q, ans]) => `${q}: ${Array.isArray(ans) ? ans.join(', ') : ans}`)
            .join('\n');
          await this.v42Client.terminalSend(computer, target, {
            text: formatted,
            enter: true,
            paste: true,
            useStdin: true,
            ...ctx,
          });
        }
      }

      await this.leaseStore.upsertSeat(seatRef, {
        computerId: computer,
        terminalId: target,
        pending: null,
        status: 'working',
      });

      return jsonToolResult({
        ok: true,
        seat_ref: seatRef,
        resolved_kind: kind,
        pending_id: args.pending_id || pending?.id || null,
      });
    }

    if (args.copy_action) {
      const storedSeat = this.leaseStore.state.seats[seatRef];
      const scope = {
        workspace: storedSeat?.workspaceId || undefined,
        computer: storedSeat?.workspaceId ? undefined : computer,
        root: storedSeat?.workspaceId ? undefined : storedSeat?.cwd || undefined,
        copy: args.copy_id || storedSeat?.copyId || '1',
      };

      if (args.copy_action === 'status') {
        const [status, changes] = await Promise.all([
          this.v42Client.copyStatus(scope, ctx),
          this.v42Client.copyChanges(scope, ctx).catch(() => null),
        ]);
        return jsonToolResult({ ok: true, seat_ref: seatRef, copy_action: 'status', status, changes });
      }
      if (args.copy_action === 'save_snapshot') {
        const saved = await this.v42Client.copySave({ ...scope, message: args.copy_message }, ctx);
        return jsonToolResult({ ok: true, seat_ref: seatRef, copy_action: 'save_snapshot', saved });
      }
      if (args.copy_action === 'apply_to_workspace') {
        const applied = await this.v42Client.copyApply({ ...scope, all: true }, ctx);
        return jsonToolResult({ ok: true, seat_ref: seatRef, copy_action: 'apply_to_workspace', applied });
      }
      if (args.copy_action === 'push') {
        const branch = args.copy_branch || args.copy_message || `v42/${target.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const pushed = await this.v42Client.copyPush({ ...scope, branch }, ctx);
        return jsonToolResult({ ok: true, seat_ref: seatRef, copy_action: 'push', branch, pushed });
      }
    }

    throw new V42CliError('Provide either resolution ({ kind: "answers" | "dismiss" }) or copy_action', {
      code: 'missing_resolve_operation',
    });
  }

  async executeEnvTransfer(args = {}, context = {}) {
    const { action, computer } = args;
    const ctx = { settings: context.settings, workspaceRoot: context.workspaceRoot, signal: context.signal };

    if (action === 'pull') {
      if (!args.remote_path) throw new V42CliError('pull requires remote_path', { code: 'missing_remote_path' });
      const localAbs = resolveAdmittedLocalPath(args.local_path, context);
      await mkdir(path.dirname(localAbs), { recursive: true });
      const result = await this.v42Client.copyTransfer(`${computer}:${args.remote_path}`, localAbs, {
        recursive: true,
        ...ctx,
      });
      return jsonToolResult({ ok: true, action: 'pull', computer, remote_path: args.remote_path, local_path: localAbs, result });
    }

    if (action === 'push') {
      if (!args.remote_path) throw new V42CliError('push requires remote_path', { code: 'missing_remote_path' });
      const localAbs = resolveAdmittedLocalPath(args.local_path, context);
      const result = await this.v42Client.copyTransfer(localAbs, `${computer}:${args.remote_path}`, {
        recursive: true,
        ...ctx,
      });
      return jsonToolResult({ ok: true, action: 'push', computer, local_path: localAbs, remote_path: args.remote_path, result });
    }

    if (action === 'sync_to_remote') {
      if (!args.remote_path) throw new V42CliError('sync_to_remote requires remote_path', { code: 'missing_remote_path' });
      const localAbs = resolveAdmittedLocalPath(args.local_path, context);
      const result = await this.v42Client.syncTransfer(localAbs, `${computer}:${args.remote_path}`, ctx);
      return jsonToolResult({
        ok: true,
        action: 'sync_to_remote',
        computer,
        local_path: localAbs,
        remote_path: args.remote_path,
        result,
      });
    }

    if (action === 'desktop_screenshot') {
      const session = this.desktopSessions.acquire(computer, {
        displayId: args.display_id,
        settings: context.settings,
        workspaceRoot: context.workspaceRoot,
      });
      if (args.window_id !== undefined && args.window_id !== null) {
        await session.selectWindow(args.window_id);
      } else if (args.display_id !== undefined && args.display_id !== null) {
        await session.selectDisplay(args.display_id);
      }
      const shot = await session.screenshot();
      await this.leaseStore.upsertDesktop(computer, {
        connectedByKiki: true,
        width: shot.logicalSize.width,
        height: shot.logicalSize.height,
      });
      const summary = {
        ok: true,
        action: 'desktop_screenshot',
        computer,
        cua_target_id: `v42:${computer}:desktop`,
        image_size: shot.imageSize,
        logical_size: shot.logicalSize,
        display: shot.display,
        window: shot.window,
      };
      if (context.imageIn !== false && shot.pngBase64) {
        return {
          output: [
            { type: 'text', text: JSON.stringify(summary) },
            { type: 'image_url', imageUrl: { url: `data:image/png;base64,${shot.pngBase64}` } },
          ],
        };
      }
      return jsonToolResult(summary);
    }

    if (action === 'mobile_screenshot') {
      let deviceId = args.mobile_device_id;
      if (!deviceId) {
        const devices = await this.v42Client.mobileDevices({ computer, ...ctx });
        const online = devices.filter((d) => d.state === 'online' || !d.state);
        if (online.length === 1) deviceId = online[0].id;
        else {
          throw new V42CliError(
            `mobile_screenshot requires mobile_device_id (${online.length} online devices found). Call v42_fleet({ scope: "devices", computer: "${computer}" }) first.`,
            { code: 'missing_mobile_device_id' },
          );
        }
      }
      const { meta, pngBuffer } = await this.v42Client.mobileScreenshot(deviceId, { computer, ...ctx });
      const dims = readPngDimensions(pngBuffer);
      await this.leaseStore.upsertMobile(computer, deviceId, {
        connectedByKiki: true,
        width: Number(meta?.width) || dims.width,
        height: Number(meta?.height) || dims.height,
      });
      const summary = {
        ok: true,
        action: 'mobile_screenshot',
        computer,
        mobile_device_id: deviceId,
        cua_target_id: `v42:${computer}:mobile:${deviceId}`,
        image_size: dims,
        meta,
      };
      if (context.imageIn !== false) {
        return {
          output: [
            { type: 'text', text: JSON.stringify(summary) },
            { type: 'image_url', imageUrl: { url: `data:image/png;base64,${pngBuffer.toString('base64')}` } },
          ],
        };
      }
      return jsonToolResult(summary);
    }

    if (action === 'port_forward_start') {
      const tunnel = await this.portForwards.start({
        computer,
        remotePort: args.remote_port,
        localPort: args.local_port,
        settings: context.settings,
        workspaceRoot: context.workspaceRoot,
      });
      return jsonToolResult({ ok: true, action: 'port_forward_start', tunnel });
    }

    if (action === 'port_forward_stop') {
      const result = await this.portForwards.stop({
        computer,
        remotePort: args.remote_port,
        localPort: args.local_port,
      });
      return jsonToolResult({ ok: true, action: 'port_forward_stop', ...result });
    }

    if (action === 'port_forward_list') {
      const forwards = await this.portForwards.list({ computer });
      return jsonToolResult({ ok: true, action: 'port_forward_list', computer, forwards });
    }

    throw new V42CliError(`Unsupported v42_env_transfer action "${action}"`, { code: 'invalid_action' });
  }
}
