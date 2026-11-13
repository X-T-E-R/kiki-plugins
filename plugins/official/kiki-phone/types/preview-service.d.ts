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
}): {
  listState(options?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  captureFrame(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspectHierarchy(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  performAction(input?: Record<string, unknown>, options?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  handlePanelRequest(action: string, args?: unknown, context?: { settings?: Record<string, unknown>; kikiHome?: string }): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
};
