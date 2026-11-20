import type { PanelStreamSession } from './scrcpy-stream.js';

export interface DeviceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlattenedViewNode {
  id: string;
  depth: number;
  role?: string;
  text?: string;
  label?: string;
  identifier?: string;
  value?: string;
  clickable: boolean;
  focused: boolean;
  bounds: DeviceBounds;
  normBounds: DeviceBounds;
  locator: string;
}

export function fitDeviceFrame(
  aspect: number,
  width: number,
  height: number,
  rightInset?: number,
): { width: number; height: number };

export function normalizePointerToDevice(
  normX: number,
  normY: number,
  screenWidth: number,
  screenHeight: number,
): { x: number; y: number };

export function computeContainedRect(
  containerWidth: number,
  containerHeight: number,
  contentWidth?: number,
  contentHeight?: number,
): { x: number; y: number; width: number; height: number; scale: number };

export function mapContainedPointToDevice(
  offsetX: number,
  offsetY: number,
  containerWidth: number,
  containerHeight: number,
  screenWidth?: number,
  screenHeight?: number,
): {
  inside: boolean;
  normX: number;
  normY: number;
  x: number;
  y: number;
  rect: { x: number; y: number; width: number; height: number; scale: number };
};

export function buildMobilewrightLocatorHint(node: Partial<FlattenedViewNode>): string;

export function flattenViewHierarchy(
  tree: unknown,
  screenSize?: { width: number; height: number },
  maxNodes?: number,
): FlattenedViewNode[];

export function createPhonePreviewService(options?: {
  dataDir?: string;
  hostPlatform?: NodeJS.Platform;
  executeFile?: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;
  loadDriverModule?: (ctx: { dataDir: string; adbBinary?: string }) => Promise<unknown>;
  scrcpyManager?: Record<string, (...args: unknown[]) => unknown>;
  metadataTtlMs?: number;
  fastStateTtlMs?: number;
  fastProbeTimeoutMs?: number;
}): {
  activate(context?: Record<string, unknown>): Promise<void>;
  peekState(options?: { settings?: Record<string, unknown>; maxAgeMs?: number; waitBudgetMs?: number }): Promise<Record<string, unknown>>;
  listState(options?: { settings?: Record<string, unknown>; fast?: boolean }): Promise<Record<string, unknown>>;
  captureFrame(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspectHierarchy(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  performAction(input?: Record<string, unknown>, options?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  openPanelStream(
    stream: string,
    args: Record<string, unknown> | undefined,
    session: PanelStreamSession,
    context?: {
      panelId?: string;
      sessionId?: string;
      workspaceId?: string;
      settings?: Record<string, unknown>;
      kikiHome?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    protocol: 'h264-scrcpy-v1';
    width: number;
    height: number;
    codec: 'h264';
    codecProfile?: string;
    deviceName?: string;
  }>;
  handlePanelRequest(action: string, args?: unknown, context?: { settings?: Record<string, unknown>; kikiHome?: string }): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
};
