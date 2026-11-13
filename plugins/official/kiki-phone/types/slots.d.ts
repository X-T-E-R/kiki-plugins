export const KIKI_PHONE_PLUGIN_ID = 'kiki-phone';

export function buildPhoneGuiSlots(
  pluginId?: string,
  liveSummary?: Record<string, unknown> | null,
): Array<Record<string, unknown>>;

export const PHONE_HTTP_ROUTES: ReadonlyArray<{
  readonly method: 'GET' | 'POST';
  readonly subpath: string;
}>;

export function createPhoneSlotHandlers(
  previewService: {
    listState(opts?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
    captureFrame(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    inspectHierarchy(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    performAction(input?: Record<string, unknown>, opts?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  },
  options?: { pluginId?: string },
): {
  'E5:prompt-context'(payload?: Record<string, unknown>, context?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  'E8:tool-pipeline'(payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  'E12:server-gui-slots'(payload?: Record<string, unknown>, context?: { settings?: Record<string, unknown> }): Promise<Record<string, unknown>>;
};
