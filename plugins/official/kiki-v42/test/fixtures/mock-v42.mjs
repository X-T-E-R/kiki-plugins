import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { createTestPng } from '../../lib/png-crop.mjs';

const statePath = process.env.MOCK_V42_STATE_FILE;
if (!statePath) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'missing_env', message: 'MOCK_V42_STATE_FILE unset' } }) + '\n');
  process.exit(1);
}

function defaultState() {
  const unmanaged = [];
  for (let i = 1; i <= 50; i += 1) {
    unmanaged.push({
      computer_id: 'mac-studio',
      window_id: `@${i}`,
      pane_id: `%${i}`,
      window_name: `bg-shell-${i}`,
      cwd: `/Users/dev/proj-${i}`,
      session: `sess_bg_${i}`,
      idle: true,
      agent: { app: i % 3 === 0 ? 'claude-code' : 'zsh', state: 'idle' },
      lines: [`$ echo pane-${i}`, `pane-${i}`],
      pending: null,
    });
  }
  return {
    nextPaneNum: 101,
    computers: [
      { id: 'mac-studio', name: 'Mac Studio M3', online: true, os: 'macos' },
      { id: 'linux-gpu', name: 'Linux A100', online: true, os: 'linux' },
    ],
    workspaces: [
      { id: 'ws-core', name: 'core-repo', computer_id: 'mac-studio', path: '/Users/dev/core' },
    ],
    memos: [
      { id: 'm1', workspace_id: 'ws-core', title: 'Deploy note', body: 'Port 3080 serves preview' },
    ],
    terminals: unmanaged,
    sentLog: [],
    desktopOps: [],
    mobileOps: [],
    copyOps: [],
  };
}

function loadState() {
  if (!existsSync(statePath)) {
    mkdirSync(path.dirname(statePath), { recursive: true });
    const init = defaultState();
    writeFileSync(statePath, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveState(st) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(st, null, 2));
}

function outOk(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  process.exit(0);
}

function outErr(code, message, exitCode = 1) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
  process.exit(exitCode);
}

const rawArgs = process.argv.slice(2);
const args = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  if (
    rawArgs[i] === '--format' ||
    rawArgs[i] === '--agent-name' ||
    rawArgs[i] === '--profile' ||
    rawArgs[i] === '--team' ||
    rawArgs[i] === '--companion-root' ||
    rawArgs[i] === '--data-dir'
  ) {
    i += 1;
    continue;
  }
  args.push(rawArgs[i]);
}

const cmd = args[0];
const sub = args[1];

if (cmd === 'whoami') {
  outOk({
    user_id: 'u-mock-1',
    display_name: 'Mock Operator',
    email: 'mock@vibecafe.ai',
    current_team_id: 'team-mock-1',
  });
}

if (cmd === 'resources') {
  const st = loadState();
  outOk({
    team_id: 'team-mock-1',
    computers: st.computers,
    workspaces: st.workspaces,
    terminals: st.terminals,
  });
}

if (cmd === 'computer' && sub === 'list') {
  outOk({ computers: loadState().computers });
}

if ((cmd === 'ws' || cmd === 'workspace') && sub === 'list') {
  outOk({ workspaces: loadState().workspaces });
}

if (cmd === 'memo' && sub === 'list') {
  outOk({ memos: loadState().memos });
}

if (cmd === 'term') {
  const st = loadState();
  if (sub === 'list') {
    const comp = args[2] && !args[2].startsWith('--') ? args[2] : null;
    const list = comp ? st.terminals.filter((t) => t.computer_id === comp) : st.terminals;
    outOk({ terminals: list, computers: st.computers });
  }
  if (sub === 'new') {
    const computer = args[2];
    const flagVal = (f) => {
      const idx = args.indexOf(f);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const paneId = `%${st.nextPaneNum++}`;
    const agentApp = flagVal('--agent') || 'claude-code';
    const cwd = flagVal('--cwd') || '/Users/dev/core';
    const title = flagVal('--name') || `${agentApp}-${paneId}`;
    const workspaceId = flagVal('--workspace') || 'ws-core';
    const isUnisolated = workspaceId === 'ws-no-isolation' || cwd.includes('no-isolation');
    const term = {
      computer_id: computer,
      window_id: `@${paneId.slice(1)}`,
      pane_id: paneId,
      window_name: title,
      workspace_id: workspaceId,
      cwd,
      session: `sess_${paneId.slice(1)}_v1`,
      copy_id: isUnisolated ? null : '1',
      terminal_isolation: !isUnisolated,
      idle: true,
      agent: { app: agentApp, state: 'idle' },
      lines: [`[${agentApp}] ready in ${cwd}`],
      pending: null,
    };
    st.terminals.push(term);
    saveState(st);
    outOk(term);
  }
  if (sub === 'status') {
    const pos = [];
    for (let i = 2; i < args.length; i += 1) {
      if (args[i].startsWith('-')) continue;
      pos.push(args[i]);
    }
    const [computer, target] = pos;
    const t = st.terminals.find((x) => x.computer_id === computer && (x.pane_id === target || x.window_id === target));
    if (!t) outErr('pane_not_found', `No pane ${target}`, 2);
    outOk({
      computer_id: t.computer_id,
      window_id: t.window_id,
      pane_id: t.pane_id,
      window_name: t.window_name,
      cwd: t.cwd,
      session: t.session,
      idle: t.agent.state === 'idle' || t.agent.state === 'done',
      agent: t.agent,
      pending: t.pending,
    });
  }
  if (sub === 'read') {
    const pos = [];
    for (let i = 2; i < args.length; i += 1) {
      if (args[i] === '--history') { i += 1; continue; }
      if (args[i].startsWith('-')) continue;
      pos.push(args[i]);
    }
    const [computer, target] = pos;
    const t = st.terminals.find((x) => x.computer_id === computer && (x.pane_id === target || x.window_id === target));
    if (!t) outErr('pane_not_found', `No pane ${target}`, 2);
    outOk({
      computer_id: computer,
      window_id: t.window_id,
      pane_id: t.pane_id,
      rows: 40,
      cols: 120,
      lines: t.lines,
    });
  }
  if (sub === 'send') {
    const keys = [];
    const pos = [];
    let afterDash = false;
    for (let i = 2; i < args.length; i += 1) {
      if (!afterDash && args[i] === '--') { afterDash = true; continue; }
      if (!afterDash && args[i] === '--key') { keys.push(args[i + 1]); i += 1; continue; }
      if (!afterDash && args[i].startsWith('-')) continue;
      pos.push(args[i]);
    }
    const [computer, target, inlineText] = pos;
    const t = st.terminals.find((x) => x.computer_id === computer && (x.pane_id === target || x.window_id === target));
    if (!t) outErr('pane_not_found', `No pane ${target}`, 2);
    let text = inlineText || '';
    if (args.includes('--stdin')) {
      text = readFileSync(0, 'utf8');
    }
    st.sentLog.push({ computer, target, text, keys, ts: Date.now() });
    if (text) t.lines.push(`> ${text}`);

    if (keys.includes('ctrl+c') || keys.includes('escape')) {
      t.agent.state = 'idle';
      t.pending = null;
    } else if (text.includes('TRIGGER_APPROVAL')) {
      t.agent.state = 'blocked';
      t.pending = {
        id: 'pend-rm-1',
        kind: 'approval',
        title: 'Run destructive command',
        command: 'rm -rf ./dist',
        confirm: true,
      };
      t.lines.push('[approval] Allow Bash(rm -rf ./dist)? (y/n)');
    } else if (text.includes('TRIGGER_QUESTION')) {
      t.agent.state = 'blocked';
      t.pending = {
        id: 'pend-q-1',
        kind: 'questions',
        title: 'Target environment?',
      };
      t.lines.push('[question] Target environment?');
    } else if (text.includes('ROTATE_SESSION')) {
      t.session = `${t.session}_rotated`;
      t.agent.state = 'idle';
    } else if (text.includes('TRIGGER_LONG_TURN')) {
      t.agent.state = 'working';
      t.pending = null;
      t.lines.push('[working] Running full cargo build...');
    } else {
      t.pending = null;
      t.agent.state = 'done';
      t.lines.push(`Completed: ${text.slice(0, 80)}`);
    }
    saveState(st);
    outOk({ sent: true, pane_id: t.pane_id });
  }
  if (sub === 'desktop' || cmd === 'desktop') {}
  if (sub === 'wait') {
    const computer = args[args.length - 2];
    const target = args[args.length - 1];
    const t = st.terminals.find((x) => x.computer_id === computer && (x.pane_id === target || x.window_id === target));
    if (!t) outErr('pane_not_found', `No pane ${target}`, 2);
    if (t.agent.state === 'working') {
      outErr('wait_timeout', 'Timed out waiting for seat to settle', 8);
    }
    outOk({ status: t.agent.state, pane_id: t.pane_id });
  }
  if (sub === 'close') {
    const pos = args.slice(2).filter((a) => !a.startsWith('-'));
    outOk({ closed: pos.slice(1) });
  }
}

if (cmd === 'copy') {
  const st = loadState();
  st.copyOps.push({ sub, args: args.slice(2) });
  saveState(st);
  if (sub === 'status') outOk({ copy_id: '1', dirty_files: 2 });
  if (sub === 'changes') outOk({ files: [{ path: 'src/lib.rs', status: 'modified' }] });
  if (sub === 'diff') outOk({ diff: '--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n' });
  if (sub === 'save') outOk({ snapshot_id: 'snap-01' });
  if (sub === 'apply') outOk({ applied_files: ['src/lib.rs'] });
  if (sub === 'push') outOk({ pushed: true });
}

if (cmd === 'cp' || cmd === 'sync') {
  const clean = args.slice(1).filter((a) => !a.startsWith('-'));
  const [src, dst] = clean;
  const resolveSide = (spec) => {
    const m = /^([a-zA-Z0-9_-]+):(.+)$/.exec(spec);
    if (!m || /^[a-zA-Z]:[\\/]/.test(spec)) return spec;
    const remoteRoot = path.join(path.dirname(statePath), 'remote-fs', m[1]);
    return path.join(remoteRoot, m[2].replace(/^\/+/, ''));
  };
  const srcFile = resolveSide(src);
  const dstFile = resolveSide(dst);
  mkdirSync(path.dirname(dstFile), { recursive: true });
  if (existsSync(srcFile)) {
    copyFileSync(srcFile, dstFile);
  } else {
    writeFileSync(dstFile, createTestPng(64, 64));
  }
  outOk({ transferred: true, from: src, to: dst });
}

if (cmd === 'desktop') {
  if (sub === 'windows') {
    outOk({
      displays: [{ id: 0, width: 1600, height: 900, primary: true }],
      windows: [{ id: 10, title: 'Xcode' }],
    });
  }
  if (sub === 'control') {
    const pos = [];
    for (let i = 2; i < args.length; i += 1) {
      if (args[i] === '--quality' || args[i] === '--display' || args[i] === '--max-width' || args[i] === '--max-height') {
        i += 1;
        continue;
      }
      if (args[i].startsWith('-')) continue;
      pos.push(args[i]);
    }
    const computer = pos[0] || args[args.length - 1];
    const pngBase64 = createTestPng(320, 180).toString('base64');
    process.stdout.write(
      JSON.stringify({
        event: 'status',
        computer_id: computer,
        display: { id: 0, width: 1600, height: 900 },
        control: true,
        locked: false,
      }) + '\n',
    );

    const ALLOWED_KEYS = {
      screenshot: ['id', 'op', 'path'],
      move: ['id', 'op', 'x', 'y'],
      click: ['id', 'op', 'x', 'y', 'button', 'count'],
      drag: ['id', 'op', 'x1', 'y1', 'x2', 'y2', 'button', 'steps'],
      scroll: ['id', 'op', 'x', 'y', 'dx', 'dy'],
      key: ['id', 'op', 'keys'],
      type: ['id', 'op', 'text'],
      clipboard_set: ['id', 'op', 'text'],
      clipboard_watch: ['id', 'op'],
      select_display: ['id', 'op', 'display'],
      select_window: ['id', 'op', 'window'],
      status: ['id', 'op'],
      close: ['id', 'op'],
    };

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const req = JSON.parse(line);
      const allowed = ALLOWED_KEYS[req.op];
      if (!allowed || Object.keys(req).some((k) => !allowed.includes(k))) {
        process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: 'unknown_field', message: `Invalid fields for ${req.op}` } }) + '\n');
        return;
      }
      const st = loadState();
      st.desktopOps.push({ computer, ...req });
      saveState(st);

      if (req.op === 'close') {
        process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { closed: true } }) + '\n');
        process.exit(0);
      }
      if (req.op === 'screenshot') {
        process.stdout.write(JSON.stringify({
          id: req.id,
          ok: true,
          data: {
            computer_id: computer,
            width: 1600,
            height: 900,
            display: { id: 0, width: 1600, height: 900 },
            window: null,
            control: true,
            png_base64: pngBase64,
          },
        }) + '\n');
        return;
      }
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { applied: req.op } }) + '\n');
    });
  }
}

if (cmd === 'mobile') {
  let idx = 1;
  let computer = 'mac-studio';
  if (args[idx] === '-c') {
    computer = args[idx + 1];
    idx += 2;
  }
  const mSub = args[idx];
  if (mSub === 'devices') {
    outOk({
      devices: [
        { id: 'adb:pixel9', name: 'Pixel 9 Pro', platform: 'android', state: 'online', width: 1080, height: 2400 },
      ],
    });
  }
  if (mSub === 'screenshot') {
    const outIdx = args.indexOf('-o');
    const outFile = args[outIdx + 1];
    const deviceId = args[args.length - 1];
    writeFileSync(outFile, createTestPng(180, 360));
    outOk({ device_id: deviceId, width: 1080, height: 2400, path: outFile });
  }
  const st = loadState();
  const stdinText = args.includes('--stdin') ? readFileSync(0, 'utf8') : undefined;
  st.mobileOps.push({ computer, op: mSub, args: args.slice(idx + 1), stdinText });
  saveState(st);
  outOk({ ok: true, op: mSub });
}

if (cmd === 'forward') {
  const [remoteSpec, localSpec] = [args[1], args[2]];
  const [computer, remotePortStr] = remoteSpec.split(':');
  const [, localPortStr] = localSpec.split(':');
  const remotePort = Number(remotePortStr);
  const localPort = Number(localPortStr);

  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ forwarded: true, computer, remotePort }));
  });
  srv.listen(localPort, '127.0.0.1', () => {
    process.stderr.write(
      JSON.stringify({
        event: 'forward_listening',
        computer_id: computer,
        remote_host: '127.0.0.1',
        remote_port: remotePort,
        listen: `127.0.0.1:${localPort}`,
        max_connections: 64,
      }) + '\n',
    );
  });
  const shutdown = () => srv.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
