import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BilibiliError, assert } from './errors.mjs';
import { createCli, CLI_VERSION } from './cli.mjs';

const required = (value, name) => {
  assert(typeof value === 'string' && value.trim(), 'ARGUMENT_INVALID', `${name} is required.`);
  return value;
};
const option = (args, flag, value) => { if (value !== undefined) args.push(flag, String(value)); };
const positional = (...values) => ['--', ...values.map(String)];

export function createBilibiliCore({ settings = {}, workspaceRoot, context = {}, spawnImpl, cli } = {}) {
  const call = cli || createCli({ settings, workspaceRoot, signal: context.signal, spawnImpl });
  const pageArgs = (args) => ['--page', String(args.page ?? 1)];
  const video = (args) => required(args.video, 'video');
  async function workspaceFile(file) {
    assert(workspaceRoot, 'WORKSPACE_REQUIRED', 'Select the workspace containing the media.');
    const root = await realpath(workspaceRoot);
    const full = await realpath(path.resolve(root, file)).catch(() => { throw new BilibiliError('FILE_MISSING', `Media does not exist: ${file}`); });
    const relative = path.relative(root, full);
    assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'PATH_OUTSIDE_WORKSPACE', 'Media must be inside the workspace, including symlink targets.');
    assert((await stat(full)).isFile(), 'FILE_MISSING', 'Media must be a file.');
    return full;
  }
  const outputDir = async () => {
    assert(workspaceRoot, 'WORKSPACE_REQUIRED', 'Select a workspace for frame artifacts.');
    const dir = path.join(workspaceRoot, '.kiki-bilibili', 'frames');
    await mkdir(dir, { recursive: true });
    return mkdtemp(path.join(dir, 'capture-'));
  };
  async function visual(args) {
    const command = ['video', 'frames', ...pageArgs(args), '--quality', args.visual === 'preview' ? 'preview' : 'hd', '--out', await outputDir()];
    if (args.timestamps?.length) for (const time of args.timestamps) option(command, '--at', time);
    else option(command, '--count', args.count ?? 6);
    command.push(...positional(video(args)));
    const data = await call(command);
    return { ...data, source: data.quality === 'hd' ? 'real-video-stream' : 'bilibili-preview-thumbnail' };
  }
  async function subtitle(args) {
    const command = ['video', 'subtitle', ...pageArgs(args)];
    option(command, '--lang', args.language);
    return { source: 'subtitle', ...await call([...command, ...positional(video(args))]) };
  }
  async function transcribe(args) {
    const command = ['video', 'transcribe', ...pageArgs(args), '--engine', args.engine ?? 'local'];
    option(command, '--max-minutes', args.maxMinutes ?? 60);
    return { source: 'asr', ...await call([...command, ...positional(video(args))]) };
  }
  async function watch(args) {
    if (args.action === 'metadata') return call(['video', 'info', ...positional(video(args))]);
    if (args.action === 'subtitle') return subtitle(args);
    if (args.action === 'transcribe') return transcribe(args);
    if (args.action === 'visual') return visual(args);
    assert(args.action === 'all', 'ARGUMENT_INVALID', 'Choose metadata, subtitle, transcribe, visual or all.');
    const metadata = await call(['video', 'info', ...positional(video(args))]);
    let transcript;
    try { transcript = await subtitle(args); }
    catch (error) {
      if (error.code !== 'not_found') throw error;
      transcript = await transcribe(args);
    }
    const frames = await visual(args);
    const comments = args.includeComments ? await interact({ ...args, action: 'comments' }) : undefined;
    return { metadata, transcript, visual: frames, comments };
  }
  async function discover(args) {
    if (args.action === 'hot') return call(['hot', 'search', '--limit', String(args.limit ?? 20)]);
    if (args.action === 'recommend') return call(['feed', 'recommend', '--count', String(args.limit ?? 12), ...pageArgs(args)]);
    if (args.action === 'timeline') {
      const command = ['feed', 'timeline', '--type', args.kind ?? 'all', '--limit', String(args.limit ?? 20)];
      option(command, '--up', args.up); option(command, '--offset', args.cursor);
      return call(command);
    }
    if (args.action === 'users') return call(['search', 'user', ...pageArgs(args), ...positional(required(args.keyword, 'keyword'))]);
    assert(args.action === 'search', 'ARGUMENT_INVALID', 'Choose search, users, hot, recommend or timeline.');
    return call(['search', 'video', '--order', args.order ?? 'default', ...pageArgs(args), '--size', String(args.limit ?? 20), ...positional(required(args.keyword, 'keyword'))]);
  }
  async function interact(args) {
    const id = video(args);
    if (args.action === 'check' || args.action === 'replies') {
      const command = ['comment', args.action];
      if (args.action === 'check') option(command, '--root', args.rootId);
      else command.push(...pageArgs(args));
      if (args.resourceType) option(command, '--type', args.resourceType);
      command.push(...positional(id, required(String(args.commentId ?? ''), 'commentId')));
      const data = await call(command);
      return args.action === 'check' ? { ...data, inspection: { perspective: 'configured-account', max_pages: args.rootId ? 2 : 3, other_accounts_visibility: 'not_measured' } } : data;
    }
    let command;
    if (args.action === 'comments') command = ['comment', 'list', ...pageArgs(args), '--sort', args.sort ?? 'hot', ...positional(id)];
    else if (args.action === 'comment' || args.action === 'mention' || args.action === 'reply') {
      command = ['comment', args.action === 'reply' ? 'reply' : 'post'];
      for (const mention of args.mentions ?? []) option(command, '--at', mention);
      option(command, '--root', args.action === 'reply' ? args.rootId : undefined);
      command.push(...positional(id, ...(args.action === 'reply' ? [required(String(args.commentId ?? ''), 'commentId')] : []), required(args.text, 'text')));
    } else if (args.action === 'like') {
      command = args.commentId ? ['comment', 'like'] : ['video', 'like'];
      if (args.undo) command.push('--undo');
      command.push(...positional(id, ...(args.commentId ? [args.commentId] : [])));
    } else if (args.action === 'favorite') {
      command = ['video', 'fav'];
      if (args.folder) option(command, '--folder', args.folder);
      if (args.undo) command.push('--remove');
      command.push(...positional(id));
    } else throw new BilibiliError('ARGUMENT_INVALID', 'Unknown interaction action.');
    if (args.resourceType && command[0] === 'comment') command.splice(2, 0, '--type', args.resourceType);
    const write = args.action !== 'comments';
    const data = await call(command, { write });
    // Upstream's post hint overstates comment.check as proof of public visibility.
    if (write && command[0] === 'comment' && data.next) data.next = 'Use check to inspect the configured account’s recent comment lists; it does not measure visibility to other accounts.';
    return { ...data, ...(write ? { submission: 'accepted' } : {}) };
  }
  async function inbox(args) {
    if (args.action === 'notifications') return { ...await call(['feed', 'notifications']), read_effect: 'counts-only' };
    if (['inbox', 'replies', 'mentions', 'likes', 'system'].includes(args.action)) {
      const command = ['feed', args.action, '--limit', String(args.limit ?? (args.action === 'inbox' ? 5 : 20))];
      if (['replies', 'mentions', 'likes'].includes(args.action)) option(command, '--cursor', args.cursor);
      return { ...await call(command, { write: true }), read_effect: args.action === 'inbox' ? 'marks-notifications-read' : 'may-mark-notifications-read' };
    }
    if (args.action === 'list') return { ...await call(['dm', 'list', '--limit', String(args.limit ?? 20)]), marked_read: false };
    assert(['read', 'mark_read'].includes(args.action), 'ARGUMENT_INVALID', 'Choose list, read or mark_read.');
    const command = ['dm', 'read', '--limit', String(args.limit ?? 30)];
    if (args.action === 'mark_read') command.push('--mark-read');
    command.push(...positional(required(args.threadId, 'threadId')));
    return call(command, { write: args.action === 'mark_read' });
  }
  async function publish(args) {
    if (args.action === 'status') return call(['upload', 'status', ...positional(required(args.bvid, 'bvid'))]);
    assert(args.action === 'submit', 'ARGUMENT_INVALID', 'Choose submit or status.');
    assert(workspaceRoot, 'WORKSPACE_REQUIRED', 'Select the workspace containing the videos.');
    assert(Array.isArray(args.files) && args.files.length, 'ARGUMENT_INVALID', 'files is required.');
    required(args.title, 'title');
    assert(args.tags?.length, 'ARGUMENT_INVALID', 'tags is required.');
    const files = [];
    for (const file of args.files) files.push(await workspaceFile(file));
    const command = ['upload', 'video', '--title', args.title];
    if (args.cover) option(command, '--cover', await workspaceFile(args.cover));
    for (const tag of args.tags) option(command, '--tag', tag);
    option(command, '--desc', args.description);
    option(command, '--tid', args.tid);
    option(command, '--zone', args.zone);
    option(command, '--schedule', args.schedule);
    if (args.private) command.push('--private');
    command.push(args.aiDeclare === false ? '--no-ai-declare' : '--ai-declare', ...positional(...files));
    return { ...await call(command, { write: true }), submission: 'accepted' };
  }
  async function account(args) {
    assert(['login', 'status', 'logout', 'asr_status'].includes(args.action), 'ARGUMENT_INVALID', 'Choose login, status, logout or asr_status.');
    return call(args.action === 'asr_status' ? ['asr', 'status'] : ['auth', args.action]);
  }
  async function diagnose() {
    const data = await call(['--version'], { timeoutMs: 10000 });
    assert(data.version === CLI_VERSION, 'DEPENDENCY_VERSION', `Expected bili-agent ${CLI_VERSION}; installed ${data.version}.`);
    return { cli: data, profileConfigured: true, asr: await call(['asr', 'status']) };
  }
  return { discover, watch, interact, inbox, publish, account, diagnose };
}
