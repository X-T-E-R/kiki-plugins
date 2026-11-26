import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BilibiliError, assert } from './errors.mjs';
import { createCli, CLI_VERSION } from './cli.mjs';
import { resolveProfileHome, resolveProfileRegistry, verifyExpectedMid } from './profiles.mjs';

const required = (value, name) => {
  assert(typeof value === 'string' && value.trim(), 'ARGUMENT_INVALID', `${name} is required.`);
  return value;
};
const option = (args, flag, value) => { if (value !== undefined) args.push(flag, String(value)); };
const positional = (...values) => ['--', ...values.map(String)];

function buildCallOptions({ write = false, timeoutMs, profile } = {}) {
  const out = {};
  if (write) out.write = true;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  if (profile !== undefined) out.profile = profile;
  return Object.keys(out).length ? out : undefined;
}

export function createBilibiliCore({ settings = {}, workspaceRoot, context = {}, spawnImpl, cli } = {}) {
  const call = cli || createCli({ settings, workspaceRoot, signal: context.signal, spawnImpl });
  const configuredTimeoutMs = typeof settings.timeoutMs === 'number' && Number.isInteger(settings.timeoutMs) ? settings.timeoutMs : 600000;
  const pageArgs = (args) => ['--page', String(args.page ?? 1)];
  const video = (args) => required(args.video, 'video');

  async function runCli(command, { write = false, guardMid = write, timeoutMs, profile, expectedMid } = {}) {
    if (guardMid && expectedMid !== undefined) {
      await verifyExpectedMid({
        expectedMid,
        settings,
        requestedProfile: profile,
        probeStatus: () => call(['auth', 'status'], buildCallOptions({ profile })),
      });
    }
    const opts = buildCallOptions({ write, timeoutMs, profile });
    return opts ? call(command, opts) : call(command);
  }

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
    const dir = path.join(path.resolve(workspaceRoot), '.kiki-bilibili', 'frames');
    await mkdir(dir, { recursive: true });
    return mkdtemp(path.join(dir, 'capture-'));
  };

  async function visual(args) {
    const command = ['video', 'frames', ...pageArgs(args), '--quality', args.visual === 'preview' ? 'preview' : 'hd', '--out', await outputDir()];
    if (args.timestamps?.length) for (const time of args.timestamps) option(command, '--at', time);
    else option(command, '--count', args.count ?? 6);
    command.push(...positional(video(args)));
    const data = await runCli(command, { profile: args.profile });
    return { ...data, source: data.quality === 'hd' ? 'real-video-stream' : 'bilibili-preview-thumbnail' };
  }

  async function subtitle(args) {
    const command = ['video', 'subtitle', ...pageArgs(args)];
    option(command, '--lang', args.language);
    if (args.textOnly) command.push('--text');
    return { source: 'subtitle', ...await runCli([...command, ...positional(video(args))], { profile: args.profile }) };
  }

  async function transcribe(args) {
    const command = ['video', 'transcribe', ...pageArgs(args), '--engine', args.engine ?? 'local'];
    option(command, '--max-minutes', args.maxMinutes ?? 60);
    if (args.textOnly) command.push('--text');
    return { source: 'asr', ...await runCli([...command, ...positional(video(args))], { profile: args.profile }) };
  }

  async function digest(args) {
    const command = [
      'video', 'watch', ...pageArgs(args),
      '--frames', String(args.frames ?? 9),
      '--comments', String(args.comments ?? 5),
      '--transcript', args.transcript ?? 'auto',
      '--max-chars', String(args.maxChars ?? 6000),
    ];
    if (args.record) command.push('--record');
    return runCli([...command, ...positional(video(args))], { profile: args.profile });
  }

  async function watch(args) {
    if (args.action === 'metadata') return runCli(['video', 'info', ...positional(video(args))], { profile: args.profile });
    if (args.action === 'digest') return digest(args);
    if (args.action === 'summary') return runCli(['video', 'summary', ...pageArgs(args), ...positional(video(args))], { profile: args.profile });
    if (args.action === 'chapters') return runCli(['video', 'chapters', ...pageArgs(args), ...positional(video(args))], { profile: args.profile });
    if (args.action === 'danmaku') return runCli(['video', 'danmaku', ...pageArgs(args), '--limit', String(args.limit ?? 200), ...positional(video(args))], { profile: args.profile });
    if (args.action === 'subtitle') return subtitle(args);
    if (args.action === 'transcribe') return transcribe(args);
    if (args.action === 'visual') return visual(args);
    assert(args.action === 'all', 'ARGUMENT_INVALID', 'Choose metadata, digest, summary, chapters, danmaku, subtitle, transcribe, visual or all.');
    const metadata = await runCli(['video', 'info', ...positional(video(args))], { profile: args.profile });
    const loadTranscript = async () => {
      try {
        return await subtitle(args);
      } catch (error) {
        if (error.code !== 'not_found') throw error;
        return transcribe(args);
      }
    };
    const [transcript, frames, comments] = await Promise.all([
      loadTranscript(),
      visual(args),
      args.includeComments ? interact({ ...args, action: 'comments' }) : Promise.resolve(undefined),
    ]);
    return { metadata, transcript, visual: frames, comments };
  }

  async function discover(args) {
    const profile = args.profile;
    if (args.action === 'hot') return runCli(['hot', 'search', '--limit', String(args.limit ?? 20)], { profile });
    if (args.action === 'popular') {
      const command = ['hot', 'popular', ...pageArgs(args), '--size', String(args.limit ?? 20)];
      if (args.unseen) command.push('--unseen');
      return runCli(command, { profile });
    }
    if (args.action === 'weekly') {
      const command = ['hot', 'weekly'];
      option(command, '--issue', args.issue);
      if (args.unseen) command.push('--unseen');
      return runCli(command, { profile });
    }
    if (args.action === 'precious') {
      const command = ['hot', 'precious'];
      if (args.unseen) command.push('--unseen');
      return runCli(command, { profile });
    }
    if (args.action === 'rank') {
      const command = ['hot', 'rank', '--zone', args.zone ?? 'all', '--limit', String(args.limit ?? 30)];
      if (args.unseen) command.push('--unseen');
      return runCli(command, { profile });
    }
    if (args.action === 'recommend') {
      const command = ['feed', 'recommend', '--count', String(args.limit ?? 12), ...pageArgs(args)];
      if (args.unseen) command.push('--unseen');
      return runCli(command, { profile });
    }
    if (args.action === 'timeline') {
      const command = ['feed', 'timeline', '--type', args.kind ?? 'all', '--limit', String(args.limit ?? 20)];
      option(command, '--up', args.up);
      option(command, '--offset', args.cursor);
      return runCli(command, { profile });
    }
    if (args.action === 'users') return runCli(['search', 'user', ...pageArgs(args), ...positional(required(args.keyword, 'keyword'))], { profile });
    if (args.action === 'user_info') return runCli(['user', 'info', ...positional(required(args.up, 'up'))], { profile });
    if (args.action === 'user_videos') {
      const order = args.order ?? 'new';
      assert(['new', 'views', 'favorites'].includes(order), 'ARGUMENT_INVALID', 'user_videos order must be new, views or favorites.');
      const command = ['user', 'videos', '--order', order, ...pageArgs(args), '--size', String(args.limit ?? 20)];
      if (args.keyword) option(command, '--keyword', args.keyword);
      command.push(...positional(required(args.up, 'up')));
      return runCli(command, { profile });
    }
    assert(args.action === 'search', 'ARGUMENT_INVALID', 'Choose search, users, user_info, user_videos, hot, popular, weekly, precious, rank, recommend or timeline.');
    return runCli(['search', 'video', '--order', args.order ?? 'default', ...pageArgs(args), '--size', String(args.limit ?? 20), ...positional(required(args.keyword, 'keyword'))], { profile });
  }

  async function interact(args) {
    const id = video(args);
    const { profile, expectedMid } = args;
    if (args.action === 'check' || args.action === 'replies') {
      const command = ['comment', args.action];
      if (args.action === 'check') option(command, '--root', args.rootId);
      else command.push(...pageArgs(args));
      if (args.resourceType) option(command, '--type', args.resourceType);
      command.push(...positional(id, required(String(args.commentId ?? ''), 'commentId')));
      const data = await runCli(command, { profile });
      return args.action === 'check'
        ? { ...data, inspection: { perspective: 'configured-account', max_pages: args.rootId ? 2 : 3, other_accounts_visibility: 'not_measured' } }
        : data;
    }
    if (args.action === 'danmaku') {
      assert(typeof args.time === 'number' && args.time >= 0, 'ARGUMENT_INVALID', 'time (seconds) is required for danmaku.');
      const command = ['danmaku', 'send', ...pageArgs(args), '--time', String(args.time), '--mode', args.danmakuMode ?? 'scroll'];
      option(command, '--color', args.color);
      command.push(...positional(id, required(args.text, 'text')));
      const data = await runCli(command, { write: true, profile, expectedMid });
      return { ...data, submission: 'accepted' };
    }
    let command;
    if (args.action === 'comments') {
      command = ['comment', 'list', ...pageArgs(args), '--sort', args.sort ?? 'hot'];
      if (args.unreplied) command.push('--unreplied');
      if (args.supporters) command.push('--supporters');
      command.push(...positional(id));
    } else if (args.action === 'comment' || args.action === 'mention' || args.action === 'reply') {
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
    } else {
      throw new BilibiliError('ARGUMENT_INVALID', 'Unknown interaction action.');
    }
    if (args.resourceType && command[0] === 'comment') command.splice(2, 0, '--type', args.resourceType);
    const write = args.action !== 'comments';
    const data = await runCli(command, { write, profile, expectedMid });
    // Upstream's post hint overstates comment.check as proof of public visibility.
    if (write && command[0] === 'comment' && data.next) data.next = 'Use check to inspect the configured account’s recent comment lists; it does not measure visibility to other accounts.';
    return { ...data, ...(write ? { submission: 'accepted' } : {}) };
  }

  async function inbox(args) {
    const { profile, expectedMid } = args;
    if (args.action === 'notifications') return { ...await runCli(['feed', 'notifications'], { profile }), read_effect: 'counts-only' };
    if (['inbox', 'replies', 'mentions', 'likes', 'system'].includes(args.action)) {
      const command = ['feed', args.action, '--limit', String(args.limit ?? (args.action === 'inbox' ? 5 : 20))];
      if (['replies', 'mentions', 'likes'].includes(args.action)) option(command, '--cursor', args.cursor);
      return {
        ...await runCli(command, { write: true, profile, expectedMid }),
        read_effect: args.action === 'inbox' ? 'marks-notifications-read' : 'may-mark-notifications-read',
      };
    }
    if (args.action === 'list') return { ...await runCli(['dm', 'list', '--limit', String(args.limit ?? 20)], { profile }), marked_read: false };
    assert(['read', 'mark_read'].includes(args.action), 'ARGUMENT_INVALID', 'Choose notifications, inbox, replies, mentions, likes, system, list, read or mark_read.');
    const command = ['dm', 'read', '--limit', String(args.limit ?? 30)];
    if (args.action === 'mark_read') command.push('--mark-read');
    command.push(...positional(required(args.threadId, 'threadId')));
    return runCli(command, { write: args.action === 'mark_read', profile, expectedMid });
  }

  async function publish(args) {
    const { profile, expectedMid } = args;
    if (args.action === 'status') return runCli(['upload', 'status', ...positional(required(args.bvid, 'bvid'))], { profile });
    if (args.action === 'list') {
      const status = args.uploadStatus ?? 'all';
      assert(['all', 'published', 'reviewing', 'rejected'].includes(status), 'ARGUMENT_INVALID', 'uploadStatus must be all, published, reviewing or rejected.');
      return runCli(['upload', 'list', '--status', status, ...pageArgs(args), '--size', String(args.limit ?? 10)], { profile });
    }
    if (args.action === 'stats') return runCli(['upload', 'stats', ...positional(required(args.bvid, 'bvid'))], { profile });
    if (args.action === 'zones') return runCli(['upload', 'zones'], { profile });

    if (args.action === 'edit') {
      const bvid = required(args.bvid, 'bvid');
      const command = ['upload', 'edit'];
      if (args.title !== undefined) option(command, '--title', required(args.title, 'title'));
      if (args.description !== undefined) option(command, '--desc', args.description);
      if (args.tags !== undefined) {
        assert(Array.isArray(args.tags) && args.tags.length, 'ARGUMENT_INVALID', 'tags must be a non-empty array when provided.');
        for (const tag of args.tags) option(command, '--tag', required(tag, 'tag'));
      }
      if (args.cover) option(command, '--cover', await workspaceFile(args.cover));
      if (args.cover43) option(command, '--cover43', await workspaceFile(args.cover43));
      if (args.aiDeclare !== undefined) command.push(args.aiDeclare ? '--ai-declare' : '--no-ai-declare');
      if (args.video) option(command, '--video', await workspaceFile(args.video));
      assert(command.length > 2, 'ARGUMENT_INVALID', 'edit requires at least one change (title, description, tags, cover, cover43, aiDeclare or video).');
      command.push(...positional(bvid));
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }

    if (args.action === 'chapters_show') {
      return runCli(['upload', 'chapters', 'show', ...pageArgs(args), ...positional(required(args.bvid ?? args.video, 'bvid'))], { profile });
    }
    if (args.action === 'chapters_set') {
      assert(Array.isArray(args.chapters) && args.chapters.length, 'ARGUMENT_INVALID', 'chapters is required for chapters_set.');
      const command = ['upload', 'chapters', 'set', ...pageArgs(args)];
      for (const ch of args.chapters) option(command, '--chapter', required(ch, 'chapter'));
      command.push(...positional(required(args.bvid ?? args.video, 'bvid')));
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'chapters_clear') {
      const command = ['upload', 'chapters', 'clear', ...pageArgs(args), ...positional(required(args.bvid ?? args.video, 'bvid'))];
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }

    if (args.action === 'dynamic_post') {
      const text = required(args.text ?? args.dynamicText, 'text');
      const command = ['dynamic', 'post'];
      for (const img of args.images ?? []) option(command, '--image', await workspaceFile(img));
      if (args.topic !== undefined) {
        const topicId = String(args.topic).trim();
        assert(/^\d+$/.test(topicId), 'ARGUMENT_INVALID', 'dynamic_post topic must be a numeric topic ID.');
        option(command, '--topic', topicId);
      }
      for (const mention of args.mentions ?? []) option(command, '--at', mention);
      if (args.voteTitle !== undefined) {
        option(command, '--vote', required(args.voteTitle, 'voteTitle'));
        assert(Array.isArray(args.voteOptions) && args.voteOptions.length >= 2, 'ARGUMENT_INVALID', 'voteOptions (at least 2) is required when voteTitle is set.');
        for (const opt of args.voteOptions) option(command, '--option', required(opt, 'voteOption'));
        option(command, '--vote-multi', args.voteMulti ?? 1);
        option(command, '--vote-days', args.voteDays ?? 7);
      }
      command.push(...positional(text));
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'dynamic_list') {
      const command = ['dynamic', 'list'];
      if (args.up !== undefined) {
        const uid = String(args.up).trim();
        assert(/^\d+$/.test(uid), 'ARGUMENT_INVALID', 'up must be a numeric UID for dynamic_list.');
        option(command, '--mid', uid);
      }
      option(command, '--offset', args.cursor);
      return runCli(command, { profile });
    }
    if (args.action === 'dynamic_delete') {
      const dynId = required(String(args.dynamicId ?? ''), 'dynamicId').trim();
      assert(/^\d+$/.test(dynId), 'ARGUMENT_INVALID', 'dynamicId must be numeric.');
      return { ...await runCli(['dynamic', 'delete', ...positional(dynId)], { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'dynamic_vote') {
      assert(Number.isInteger(args.voteId) && args.voteId >= 1, 'ARGUMENT_INVALID', 'voteId is required.');
      return runCli(['dynamic', 'vote', ...positional(args.voteId)], { profile });
    }

    if (args.action === 'season_list') return runCli(['season', 'list'], { profile });
    if (args.action === 'season_create') {
      const title = required(args.title, 'title');
      const cover = await workspaceFile(required(args.cover, 'cover'));
      const command = ['season', 'create', '--cover', cover];
      option(command, '--desc', args.description);
      command.push(...positional(title));
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'season_add') {
      assert(Number.isInteger(args.season) && args.season >= 1, 'ARGUMENT_INVALID', 'season (integer ID) is required.');
      const vids = args.videos?.length ? args.videos.map((v) => required(v, 'videos')) : [required(args.bvid, 'bvid')];
      const command = ['season', 'add'];
      option(command, '--section', args.section);
      command.push(...positional(args.season, ...vids));
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }

    assert(args.action === 'submit', 'ARGUMENT_INVALID', 'Choose submit, status, list, stats, zones, edit, chapters_show, chapters_set, chapters_clear, dynamic_post, dynamic_list, dynamic_delete, dynamic_vote, season_list, season_create or season_add.');
    assert(workspaceRoot, 'WORKSPACE_REQUIRED', 'Select the workspace containing the videos.');
    assert(Array.isArray(args.files) && args.files.length, 'ARGUMENT_INVALID', 'files is required.');
    required(args.title, 'title');
    assert(args.tags?.length, 'ARGUMENT_INVALID', 'tags is required.');
    const files = [];
    for (const file of args.files) files.push(await workspaceFile(file));
    const command = ['upload', 'video', '--title', args.title];
    if (args.cover) option(command, '--cover', await workspaceFile(args.cover));
    if (args.cover43) option(command, '--cover43', await workspaceFile(args.cover43));
    for (const tag of args.tags) option(command, '--tag', tag);
    option(command, '--desc', args.description);
    option(command, '--tid', args.tid);
    option(command, '--zone', args.zone);
    option(command, '--schedule', args.schedule);
    option(command, '--topic', args.topic);
    option(command, '--season', args.season);
    option(command, '--dynamic', args.dynamicText);
    if (args.noReprint) command.push('--no-reprint');
    if (args.private) command.push('--private');
    command.push(args.aiDeclare === false ? '--no-ai-declare' : '--ai-declare', ...positional(...files));
    return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
  }

  async function account(args) {
    assert(
      ['login', 'status', 'logout', 'profile', 'profiles', 'stats', 'following', 'set_avatar', 'set_sign', 'set_name', 'asr_status'].includes(args.action),
      'ARGUMENT_INVALID',
      'Choose login, status, logout, profile, profiles, stats, following, set_avatar, set_sign, set_name or asr_status.',
    );
    const { profile, expectedMid } = args;
    if (args.action === 'asr_status') return runCli(['asr', 'status'], { profile });
    if (args.action === 'profile') return runCli(['me', 'show'], { profile });
    if (args.action === 'stats') {
      const period = args.period ?? 'week';
      assert(['yesterday', 'week', 'month', '3months'].includes(period), 'ARGUMENT_INVALID', 'period must be yesterday, week, month or 3months.');
      return runCli(['me', 'stats', '--period', period], { profile });
    }
    if (args.action === 'following') {
      return runCli(['user', 'following', ...pageArgs(args), '--size', String(args.limit ?? 50)], { profile });
    }
    if (args.action === 'profiles') {
      const registry = resolveProfileRegistry(settings);
      const currentProfile = profile !== undefined ? resolveProfileHome(settings, profile).name : registry.defaultName;
      const items = await Promise.all(
        [...registry.entries.entries()].map(async ([name, home]) => {
          try {
            const status = await runCli(['auth', 'status'], { profile: name });
            return { name, home, active: name === currentProfile, ...status };
          } catch (error) {
            if (['not_logged_in', 'auth_expired', 'login_pending', 'login_expired'].includes(error?.code)) {
              return {
                name,
                home,
                active: name === currentProfile,
                logged_in: false,
                code: error.code,
                ...(error.detail ? { detail: error.detail } : {}),
              };
            }
            throw error;
          }
        }),
      );
      return { profiles: items };
    }
    if (args.action === 'set_avatar') {
      const file = await workspaceFile(required(args.image, 'image'));
      return { ...await runCli(['me', 'set-avatar', ...positional(file)], { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'set_sign') {
      assert(typeof args.sign === 'string', 'ARGUMENT_INVALID', 'sign is required.');
      return { ...await runCli(['me', 'set-sign', ...positional(args.sign)], { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'set_name') {
      const command = ['me', 'set-name'];
      if (args.allowCost) command.push('--allow-cost');
      command.push(...positional(required(args.name, 'name')));
      return { ...await runCli(command, { write: true, profile, expectedMid }), submission: 'accepted' };
    }
    if (args.action === 'logout') {
      return runCli(['auth', 'logout'], { guardMid: expectedMid !== undefined, profile, expectedMid });
    }
    const waitSeconds = args.waitSeconds ?? 0;
    assert(Number.isInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 180, 'ARGUMENT_INVALID', 'waitSeconds must be an integer from 0 to 180.');
    const command = ['auth', args.action];
    let timeoutMs;
    if (waitSeconds > 0) {
      command.push('--wait', String(waitSeconds));
      const minTimeout = (waitSeconds + 15) * 1000;
      if (configuredTimeoutMs < minTimeout) timeoutMs = minTimeout;
    }
    return runCli(command, { profile, timeoutMs });
  }

  async function diagnose(args = {}) {
    const data = await runCli(['--version'], { timeoutMs: 10000, profile: args.profile });
    assert(data.version === CLI_VERSION, 'DEPENDENCY_VERSION', `Expected bili-agent ${CLI_VERSION}; installed ${data.version}.`);
    return { cli: data, profileConfigured: true, asr: await runCli(['asr', 'status'], { profile: args.profile }) };
  }

  return { discover, watch, interact, inbox, publish, account, diagnose };
}
