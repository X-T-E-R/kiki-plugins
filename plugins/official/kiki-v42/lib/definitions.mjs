const text = (description) => ({ type: 'string', description });

const tool = (name, description, properties, required = [], extra = {}) => ({
  schemaVersion: 1,
  name,
  description,
  parameters: {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
  disclosure: 'deferred',
  ...extra,
});

export const sessionSourceDefinition = {
  schemaVersion: 1,
  id: 'v42-agent-seat',
  label: 'Vibe42 Agent Seat',
  formatVersion: 'v42-seat-v1',
};

export const v42Fleet = tool(
  'v42_fleet',
  'Discover Vibe42 Computers, Workspaces, coding seats, mobile devices, workspace memos, and active loopback port forwards. Read-only discovery across managed leases and optional unmanaged seats.',
  {
    scope: {
      type: 'string',
      enum: ['summary', 'workspaces', 'seats', 'devices', 'memos', 'forwards'],
      default: 'summary',
      description: 'Resource view to inspect across the Vibe42 fleet.',
    },
    computer: text('Optional Computer ID or name filter; omit to inspect all Computers in the active Team.'),
    workspace: text('Optional Workspace ID or name filter.'),
    status_filter: {
      type: 'string',
      enum: ['all', 'working', 'blocked', 'done', 'idle'],
      default: 'all',
      description: 'Filter seats by current execution state.',
    },
    include_unmanaged: {
      type: 'boolean',
      default: true,
      description: 'Include active remote seats and devices not yet leased or pinned to this Kiki session.',
    },
  },
  [],
  { concurrencySafe: true, disclosure: 'inline' },
);

export const v42SeatRun = tool(
  'v42_seat_run',
  'Create, dispatch, steer, interrupt, configure, pin, or unpin a remote Vibe42 coding seat (or remote desktop/mobile target). Waits up to 25s by default in auto mode before returning a deterministic background receipt with seat_ref and cursor. Respects active human takeover leases.',
  {
    action: {
      type: 'string',
      enum: ['dispatch', 'steer', 'interrupt', 'control', 'pin', 'unpin'],
      description: 'Seat orchestration or session-lease action.',
    },
    seat_ref: text('Target reference: "<computer>:<terminalId>" for a seat, "<computer>:desktop" for a remote desktop, or "<computer>:mobile:<deviceId>" for a mobile target.'),
    expected_session: text('Optional expected remote agent session ID; fails with session_changed if the seat rotated sessions.'),
    computer: text('Computer ID or name when dispatching a new seat or pinning a target.'),
    workspace: text('Workspace ID or name on the target Computer.'),
    cwd: text('Working directory on the target Computer when not using a named Workspace.'),
    agent: {
      type: 'string',
      enum: ['claude-code', 'codex', 'opencode', 'omp', 'agy', 'grok', 'kiki'],
      description: 'Coding agent launcher for newly created seats.',
    },
    isolated_copy: {
      type: 'boolean',
      description: 'Run the new seat inside a copy-on-write isolated workspace copy when supported.',
    },
    title: text('Display title for a newly opened or pinned seat.'),
    prompt: text('Self-contained task assignment or follow-up instruction for dispatch/steer.'),
    steer_mode: {
      type: 'string',
      enum: ['auto', 'queue', 'interject'],
      default: 'auto',
      description: 'Mid-turn delivery mode: interject for Codex/OMP or queue for sequential turns.',
    },
    local_attachments: {
      type: 'array',
      maxItems: 16,
      items: text('Workspace-relative or approved local file path to upload and attach to the prompt.'),
      description: 'Local files staged to the remote Computer before sending the prompt.',
    },
    wait_mode: {
      type: 'string',
      enum: ['auto', 'async', 'turn'],
      default: 'auto',
      description: 'auto waits up to 25s streaming progress before returning a background receipt; async returns immediately; turn waits up to 120s.',
    },
    control: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['model', 'effort', 'mode', 'compact'],
          description: 'Seat runtime parameter or compaction trigger.',
        },
        value: text('Target model ID, effort level, mode name, or compaction note.'),
      },
      required: ['kind', 'value'],
      additionalProperties: false,
      description: 'Control payload used when action is "control".',
    },
    idempotency_key: text('Optional idempotency key deduplicated in the 64-slot ring buffer to prevent duplicate prompt injection on retry.'),
    override_human_lease: {
      type: 'boolean',
      default: false,
      description: 'Only set true when the user explicitly instructed overriding an active human takeover lock.',
    },
  },
  ['action'],
  { disclosure: 'inline' },
);

export const v42SeatInspect = tool(
  'v42_seat_inspect',
  'Inspect structured AgentView turns, transcript rows, folded output tokens, subagent traces, media artifacts, copy-on-write diffs, or live terminal screen lines for a Vibe42 seat.',
  {
    seat_ref: text('Seat reference in "<computer>:<terminalId>" format.'),
    mode: {
      type: 'string',
      enum: ['turns', 'rows', 'more', 'subagent', 'media', 'copy_diff', 'terminal_screen'],
      default: 'turns',
      description: 'Inspection view to retrieve.',
    },
    since_cursor: text('Monotonic cursor from an earlier receipt for incremental turn or row reads.'),
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Maximum turns, rows, or terminal scrollback lines to return.',
    },
    more_token: text('Expansion token when mode is "more".'),
    subagent_id: text('Remote subagent identifier when mode is "subagent".'),
    media_id: text('Remote media artifact identifier or path when mode is "media".'),
    copy_id: text('Optional isolated copy number or directory when mode is "copy_diff".'),
    path: text('Optional relative file path when inspecting a specific file diff in mode "copy_diff".'),
  },
  ['seat_ref'],
  { concurrencySafe: true, disclosure: 'deferred' },
);

export const v42SeatResolve = tool(
  'v42_seat_resolve',
  'Answer non-privileged technical questions on a blocked Vibe42 seat or manage its copy-on-write isolated workspace copy. Security rule: approval and login requests can never be approved by the model and require human action in the Vibe42 Workbench.',
  {
    seat_ref: text('Seat reference in "<computer>:<terminalId>" format.'),
    expected_session: text('Optional expected remote agent session ID.'),
    pending_id: text('Identifier of the pending question interaction on the seat.'),
    resolution: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['answers', 'dismiss'],
          description: 'Allowed model resolution kinds. Privileged approvals are intentionally excluded.',
        },
        answers: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          description: 'Question key to selected answer(s) map when kind is "answers".',
        },
      },
      required: ['kind'],
      additionalProperties: false,
      description: 'Structured response for a non-privileged pending question.',
    },
    copy_action: {
      type: 'string',
      enum: ['status', 'save_snapshot', 'apply_to_workspace', 'push'],
      description: 'Copy-on-write isolated workspace operation.',
    },
    copy_message: text('Snapshot note for save_snapshot or branch/commit context for push.'),
    copy_branch: text('Target Git branch name when copy_action is "push".'),
    copy_id: text('Optional isolated copy number or directory.'),
  },
  ['seat_ref'],
  { disclosure: 'deferred' },
);

export const v42EnvTransfer = tool(
  'v42_env_transfer',
  'Transfer or synchronize files between the local workspace and a remote Vibe42 Computer, capture remote desktop or mobile screenshots, and start, stop, or list loopback port-forward tunnels.',
  {
    action: {
      type: 'string',
      enum: [
        'pull',
        'push',
        'sync_to_remote',
        'desktop_screenshot',
        'mobile_screenshot',
        'port_forward_start',
        'port_forward_stop',
        'port_forward_list',
      ],
      description: 'Cross-device file, visual capture, or loopback tunnel action.',
    },
    computer: text('Target Vibe42 Computer ID or name.'),
    local_path: text('Workspace-relative or approved absolute local file/directory path for pull, push, or sync_to_remote.'),
    remote_path: text('Absolute path on the remote Computer for pull, push, or sync_to_remote.'),
    mobile_device_id: text('Mobile device ID (for example "adb:serial" or simulator UDID) for mobile_screenshot.'),
    window_id: {
      type: 'integer',
      minimum: 1,
      description: 'Optional remote desktop window ID from desktop windows discovery.',
    },
    display_id: {
      type: 'integer',
      minimum: 0,
      description: 'Optional remote desktop display ID.',
    },
    remote_port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description: 'Remote loopback TCP port on the Computer for port_forward_start or port_forward_stop.',
    },
    local_port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description: 'Optional local loopback TCP port on 127.0.0.1; auto-allocated when omitted.',
    },
  },
  ['action', 'computer'],
  { disclosure: 'deferred' },
);

export const definitions = [
  v42Fleet,
  v42SeatRun,
  v42SeatInspect,
  v42SeatResolve,
  v42EnvTransfer,
];
