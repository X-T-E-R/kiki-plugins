export const uuStatusTool = {
  schemaVersion: 1,
  name: 'uu_status',
  description:
    'Detect local NetEase UU Remote (GameViewer & uuyc-cli) installation, running client/service processes, uuremote:// URI registration, official uuyc-cli diagnostics, registered Proxmox VE QMP VM targets, CUA Provider Bus lease status, and active remote desktop session summary.',
  parameters: {
    type: 'object',
    properties: {
      includeCliStatus: {
        type: 'boolean',
        default: true,
        description: 'Query official uuyc-cli status --json when uuyc-cli is installed.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
  concurrencySafe: true,
  disclosure: 'inline',
};

export const uuSessionsTool = {
  schemaVersion: 1,
  name: 'uu_sessions',
  description:
    'List open UU Remote streaming windows (uu:<hwnd>) and registered Proxmox VE QMP VMs (pve:<ssh_host>:<vmid>) with live status, resolution, contentRect, and takeover state alongside paired uuyc-cli devices; select default session; or toggle Human Takeover.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'select', 'takeover'],
        default: 'list',
        description: 'List sessions and paired devices, select default uu:<hwnd> or pve:<ssh_host>:<vmid> session, or toggle Human Takeover lock.',
      },
      sessionId: {
        type: 'string',
        description: 'Target session ID (uu:<hwnd> or pve:<ssh_host>:<vmid>) for select or takeover.',
      },
      active: {
        type: 'boolean',
        description: 'For action="takeover": true locks Human Takeover (pausing agent input), false releases back to agent.',
      },
      reason: {
        type: 'string',
        maxLength: 300,
        description: 'Optional note recorded when engaging or releasing Human Takeover.',
      },
      probeContentRect: {
        type: 'boolean',
        default: false,
        description: 'Capture a background frame on active windows to compute exact black-bar contentRect.',
      },
      includeDevices: {
        type: 'boolean',
        default: true,
        description: 'Include paired online/offline devices from uuyc-cli device list/status.',
      },
      includeTerminals: {
        type: 'boolean',
        default: false,
        description: 'Query uuyc-cli term -d <deviceId> ls --json for remote terminal sessions.',
      },
      deviceId: {
        type: 'string',
        description: 'Optional paired device ID filter when includeTerminals=true.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
  concurrencySafe: true,
  disclosure: 'inline',
};

const zoomRectSchema = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', exclusiveMinimum: 0 },
    height: { type: 'number', exclusiveMinimum: 0 },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
};

const batchActionItemSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [
        'click',
        'double_click',
        'right_click',
        'move',
        'mouse_down',
        'mouse_up',
        'drag',
        'scroll',
        'type',
        'key',
        'hold_key',
        'wait',
        'clipboard_get',
        'clipboard_set',
        'focus',
        'restore',
      ],
    },
    x: { type: 'number' },
    y: { type: 'number' },
    startX: { type: 'number' },
    startY: { type: 'number' },
    endX: { type: 'number' },
    endY: { type: 'number' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    modifiers: { type: 'array', items: { type: 'string' } },
    deltaX: { type: 'number' },
    deltaY: { type: 'number' },
    durationMs: { type: 'integer', minimum: 0, maximum: 30000 },
    text: { type: 'string' },
    submit: { type: 'boolean' },
    mode: { type: 'string', enum: ['auto', 'unicode', 'clipboard'] },
    key: { type: 'string' },
    keys: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind'],
  additionalProperties: false,
};

export const uuControlTool = {
  schemaVersion: 1,
  name: 'uu_control',
  description:
    'Observe a zero-focus screenshot (with symmetric black-bar trim and optional zoom crop) or inject mouse, keyboard, clipboard, focus, or restore actions into an active UU Remote (uu:<hwnd>) or Proxmox VE QMP (pve:<ssh_host>:<vmid>) session. Honors Human Takeover.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Target session ID (uu:<hwnd> or pve:<ssh_host>:<vmid>). Defaults to the selected or sole active session.',
      },
      action: {
        type: 'string',
        enum: [
          'screenshot',
          'click',
          'double_click',
          'right_click',
          'move',
          'mouse_down',
          'mouse_up',
          'drag',
          'scroll',
          'type',
          'key',
          'hold_key',
          'wait',
          'clipboard_get',
          'clipboard_set',
          'focus',
          'restore',
        ],
        default: 'screenshot',
        description: 'Single action to perform when actions[] batch is not provided.',
      },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: batchActionItemSchema,
        description: 'Optional sequence of input/clipboard actions executed in order.',
      },
      coordinateMode: {
        type: 'string',
        enum: ['normalized_1000', 'normalized_01', 'target_pixels', 'image_pixels'],
        default: 'normalized_1000',
        description: 'Coordinate space for x/y, drag endpoints, scroll anchor, and zoom bounds.',
      },
      x: { type: 'number' },
      y: { type: 'number' },
      startX: { type: 'number' },
      startY: { type: 'number' },
      endX: { type: 'number' },
      endY: { type: 'number' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        default: 'left',
      },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 3,
        default: 1,
      },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
      },
      deltaX: { type: 'number', default: 0 },
      deltaY: { type: 'number' },
      durationMs: {
        type: 'integer',
        minimum: 0,
        maximum: 30000,
      },
      text: {
        type: 'string',
        description: 'Text payload for type or clipboard_set.',
      },
      submit: {
        type: 'boolean',
        default: false,
        description: 'Press Enter after typing text.',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'unicode', 'clipboard'],
        default: 'auto',
      },
      key: {
        type: 'string',
        description: 'Key name or chord such as Enter, Escape, Tab, Ctrl+C, Win+R.',
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key chord array such as ["Ctrl", "Shift", "Esc"]. Avoid Ctrl+Alt+* client hotkeys.',
      },
      zoom: {
        ...zoomRectSchema,
        description: 'Optional crop region in coordinateMode units extracted at native stream resolution before scaling.',
      },
      maxWidth: {
        type: 'integer',
        minimum: 64,
        maximum: 7680,
        default: 1440,
      },
      maxHeight: {
        type: 'integer',
        minimum: 64,
        maximum: 4320,
        default: 1080,
      },
      autoTrimBlackBars: {
        type: 'boolean',
        description: 'Override autoTrimBlackBars setting for this call.',
      },
      remoteAspect: {
        type: 'string',
        description: 'Optional aspect override (e.g. "16:9" or "16:10") for black-bar cropping.',
      },
      observeAfter: {
        type: 'boolean',
        default: true,
        description: 'Capture and attach a fresh screenshot after mutating actions.',
      },
      overrideHumanTakeover: {
        type: 'boolean',
        default: false,
        description: 'Proceed even when Human Takeover is active (use only when explicitly requested by the user).',
      },
      allowClientHotkey: {
        type: 'boolean',
        default: false,
        description: 'Allow Ctrl+Alt+* chords that normally trigger UU Remote local overlay/fullscreen shortcuts.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
  disclosure: 'inline',
};

export const uuLaunchTool = {
  schemaVersion: 1,
  name: 'uu_launch',
  description:
    'Open the NetEase UU Remote desktop client, connect or disconnect a paired uuyc-cli device or Proxmox VE QMP VM target (pve:<ssh_host>:<vmid>), launch an explicit uuremote:// URI, or rescue off-screen GameViewer windows.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'open_client',
          'connect',
          'disconnect',
          'connect_device',
          'disconnect_device',
          'open_uri',
          'recover_offscreen',
        ],
        description: 'Lifecycle or window-recovery operation to execute.',
      },
      deviceId: {
        type: 'string',
        description: 'Target device ID (uuyc-cli paired device ID or pve:<ssh_host>:<vmid>) for connect/disconnect (never omitted on disconnect).',
      },
      pveHost: {
        type: 'string',
        description: 'Optional SSH host alias for a Proxmox VE node (paired with vmid for connect/disconnect).',
      },
      vmid: {
        type: 'integer',
        minimum: 1,
        maximum: 999999999,
        description: 'Optional Proxmox VE QEMU VM ID (paired with pveHost for connect/disconnect).',
      },
      label: {
        type: 'string',
        maxLength: 120,
        description: 'Optional custom display label when registering a Proxmox VE VM target.',
      },
      uri: {
        type: 'string',
        description: 'Explicit uuremote:// or gameviewer:// URI for action="open_uri".',
      },
      sessionId: {
        type: 'string',
        description: 'Optional uu:<hwnd> filter for recover_offscreen, or pve:<ssh_host>:<vmid> target.',
      },
      waitForWindowMs: {
        type: 'integer',
        minimum: 0,
        maximum: 30000,
        default: 4000,
        description: 'Milliseconds to poll for newly opened session windows after open_client, connect_device, or open_uri.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
  disclosure: 'deferred',
};

export const definitions = [uuStatusTool, uuSessionsTool, uuControlTool, uuLaunchTool];
