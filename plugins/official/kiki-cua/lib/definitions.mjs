export const COORDINATE_MODES = ['normalized_1000', 'normalized_01', 'target_pixels', 'image_pixels'];

export const CUA_SETTINGS_SCHEMA = {
  schemaVersion: 1,
  schema: {
    type: 'object',
    properties: {
      defaultMaxWidth: {
        type: 'number',
        title: 'Default maximum capture width',
        description: 'Default screenshot width limit in pixels (clamped to integer 640..3840).',
        default: 1280,
        localizations: {
          'zh-CN': {
            title: '默认最大截图宽度',
            description: '默认截图缩放上限像素宽度（整数范围 640..3840）。',
          },
        },
      },
      takeoverThresholdPx: {
        type: 'number',
        title: 'Human takeover mouse threshold (px)',
        description: 'Physical mouse displacement in pixels that automatically engages Human Takeover protection.',
        default: 48,
        localizations: {
          'zh-CN': {
            title: '人工接管鼠标位移阈值 (px)',
            description: '物理鼠标偏离合成坐标超过该像素阈值时，自动锁定人工接管保护并中止剩余动作。',
          },
        },
      },
      groundingEndpoint: {
        type: 'string',
        title: 'External grounding endpoint',
        description: 'Optional OpenAI-compatible VLM grounding URL for coordinate refinement.',
        localizations: {
          'zh-CN': {
            title: '外部视觉定位端点',
            description: '可选的 OpenAI 兼容视觉定位服务 URL，用于坐标精修。',
          },
        },
      },
      groundingModel: {
        type: 'string',
        title: 'External grounding model',
        description: 'Optional model identifier sent to the external grounding endpoint.',
        localizations: {
          'zh-CN': {
            title: '外部视觉定位模型',
            description: '可选的外部视觉定位模型 ID。',
          },
        },
      },
    },
  },
};

export function normalizeCuaSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawMaxW = Number(src.defaultMaxWidth);
  const defaultMaxWidth = Number.isFinite(rawMaxW)
    ? Math.min(3840, Math.max(640, Math.round(rawMaxW)))
    : 1280;
  const rawThreshold = Number(src.takeoverThresholdPx);
  const takeoverThresholdPx = Number.isFinite(rawThreshold)
    ? Math.min(2000, Math.max(0, Math.round(rawThreshold)))
    : 48;
  const groundingEndpoint = typeof src.groundingEndpoint === 'string' && src.groundingEndpoint.trim()
    ? src.groundingEndpoint.trim()
    : '';
  const groundingModel = typeof src.groundingModel === 'string' && src.groundingModel.trim()
    ? src.groundingModel.trim()
    : '';
  return {
    defaultMaxWidth,
    takeoverThresholdPx,
    groundingEndpoint,
    groundingModel,
  };
}

const coordinateModeProperty = {
  type: 'string',
  enum: COORDINATE_MODES,
  default: 'normalized_1000',
  description: 'Coordinate space: normalized_1000 (0..1000, default), normalized_01 (0..1), target_pixels, or image_pixels.',
};

const actionItemSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [
        'click',
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
      ],
      description: 'Deterministic computer-use micro-action kind.',
    },
    x: { type: 'number', description: 'Horizontal coordinate for click, move, mouse_down, mouse_up, or scroll.' },
    y: { type: 'number', description: 'Vertical coordinate for click, move, mouse_down, mouse_up, or scroll.' },
    startX: { type: 'number', description: 'Drag start horizontal coordinate.' },
    startY: { type: 'number', description: 'Drag start vertical coordinate.' },
    endX: { type: 'number', description: 'Drag end horizontal coordinate.' },
    endY: { type: 'number', description: 'Drag end vertical coordinate.' },
    button: {
      type: 'string',
      enum: ['left', 'right', 'middle'],
      description: 'Mouse button (defaults to left).',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 3,
      description: 'Click count: 1 (single), 2 (double), or 3 (triple).',
    },
    modifiers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional modifier keys held during click (e.g. ["ctrl", "shift"]).',
    },
    deltaX: { type: 'number', description: 'Horizontal scroll notches or pixels (positive scrolls right).' },
    deltaY: { type: 'number', description: 'Vertical scroll notches (positive scrolls down, negative scrolls up).' },
    text: { type: 'string', description: 'Text payload for type or clipboard_set.' },
    submit: { type: 'boolean', description: 'Press Enter after typing text.' },
    mode: {
      type: 'string',
      enum: ['auto', 'unicode', 'clipboard'],
      description: 'Text injection mode for type (auto uses Unicode events for short text and Win+V-excluded clipboard paste for multiline/CJK).',
    },
    key: { type: 'string', description: 'Key or chord string such as "Enter", "Ctrl+C", "Ctrl+Shift+Esc", or key to hold for hold_key.' },
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key sequence or chord tokens (e.g. ["Ctrl", "Shift", "P"]).',
    },
    durationMs: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: 'Duration in milliseconds for wait, hold_key, or drag.',
    },
    label: {
      type: 'string',
      description: 'Optional element description for external grounding refinement when groundingEndpoint is configured.',
    },
  },
  required: ['kind'],
  additionalProperties: false,
};

export const definitions = [
  {
    schemaVersion: 1,
    name: 'cua_targets',
    description: 'List, select, or toggle Human Takeover protection across local desktop displays (local:primary, local:monitor-*), pinned local windows (local:window:<hwnd>), and active remote display/input target providers discovered via kiki.cua.provider.v1. Selected targetId persists across calls.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'select', 'takeover'],
          default: 'list',
          description: 'list returns all local and remote targets; select persists targetId; takeover sets or releases Human Takeover lock.',
        },
        targetId: {
          type: 'string',
          description: 'Target identifier such as local:primary, local:monitor-0, local:window:0x1042A, or a remote provider target id.',
        },
        takeoverActive: {
          type: 'boolean',
          description: 'For action="takeover": true locks target under human control; false hands control back to the agent.',
        },
        reason: {
          type: 'string',
          description: 'Optional short note recorded when toggling Human Takeover.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    accesses: [{ kind: 'all' }],
    concurrencySafe: true,
    disclosure: 'inline',
  },
  {
    schemaVersion: 1,
    name: 'cua_observe',
    description: 'Capture a crisp PNG screenshot, cursor position, active window metadata, and optional bounded accessibility controls from the selected local or remote target. Supports full-resolution native zoom cropping before bicubic downscaling plus optional 0..1000 grid or Set-of-Mark ([1], [2]) overlays.',
    parameters: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'Optional target identifier; defaults to the currently selected target (or local:primary).',
        },
        maxWidth: {
          type: 'integer',
          minimum: 240,
          maximum: 3840,
          default: 1280,
          description: 'Maximum output image width in pixels after optional zoom crop.',
        },
        maxHeight: {
          type: 'integer',
          minimum: 240,
          maximum: 3840,
          default: 900,
          description: 'Maximum output image height in pixels after optional zoom crop.',
        },
        zoom: {
          type: 'object',
          description: 'High-resolution region cropped from the native full-resolution buffer before downscaling, expressed in coordinateMode.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        coordinateMode: coordinateModeProperty,
        overlay: {
          type: 'string',
          enum: ['none', 'grid', 'som'],
          default: 'none',
          description: 'Visual overlay drawn on the returned PNG: none, grid (0..1000 ruler ticks every 100 units), or som ([1], [2] badges on interactive UIA controls).',
        },
        includeAccessibility: {
          type: 'boolean',
          default: false,
          description: 'Include bounded interactive accessibility controls (capped at <=120 items with 750ms timeout).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    accesses: [{ kind: 'all' }],
    concurrencySafe: true,
    disclosure: 'inline',
  },
  {
    schemaVersion: 1,
    name: 'cua_act',
    description: 'Execute 1..16 deterministic mouse, keyboard, wait, or clipboard actions on the selected local or remote target. Enforces Human Takeover protection (manual lock or physical mouse displacement > takeoverThresholdPx aborts immediately with human_takeover_active) and captures a settled post-action screenshot by default.',
    parameters: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'Optional target identifier; defaults to the currently selected target.',
        },
        coordinateMode: coordinateModeProperty,
        zoomRelative: {
          type: 'boolean',
          default: false,
          description: 'When true, map action coordinates inside the cropBounds of the most recent zoomed cua_observe on this target.',
        },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: actionItemSchema,
          description: 'Ordered batch of 1..16 deterministic actions.',
        },
        observeAfter: {
          type: 'boolean',
          default: true,
          description: 'Capture and return a post-action screenshot after settleMs so one call completes act + verify.',
        },
        settleMs: {
          type: 'integer',
          minimum: 0,
          maximum: 5000,
          default: 180,
          description: 'Delay in milliseconds before post-action observation when observeAfter is true.',
        },
        overrideHumanTakeover: {
          type: 'boolean',
          default: false,
          description: 'Set true only when explicitly instructed by the user to resume control while Human Takeover is active.',
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
    accesses: [{ kind: 'all' }],
    disclosure: 'inline',
  },
  {
    schemaVersion: 1,
    name: 'cua_windows',
    description: 'List visible top-level local desktop windows with bounds, process name, DPI, UIPI elevation, and HWND/windowId, or focus/restore a specific window (optionally pinning local:window:<hwnd> as a selectable target).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'focus', 'restore'],
          default: 'list',
          description: 'Window operation: list visible windows, focus a window to foreground, or restore a minimized window.',
        },
        hwnd: {
          type: 'string',
          description: 'Target window handle (e.g. "0x1042A" or decimal string) for focus/restore.',
        },
        windowId: {
          type: 'string',
          description: 'Alias for hwnd / cross-platform window identifier.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on window title or process name.',
        },
        pinTarget: {
          type: 'boolean',
          default: false,
          description: 'When true during focus/restore, pin local:window:<hwnd> into cua_targets for window-scoped capture.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    accesses: [{ kind: 'all' }],
    disclosure: 'deferred',
  },
];
