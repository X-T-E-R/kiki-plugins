export const SCRCPY_SERVER_VERSION: string;
export const SCRCPY_SERVER_URL: string;
export const SCRCPY_SERVER_SHA256: string;
export const SCRCPY_DEVICE_JAR_PATH: string;
export const SCRCPY_STREAM_PROTOCOL: 'h264-scrcpy-v1';

export const FRAME_PACKET_MAGIC: number;
export const CLIENT_TOUCH_MAGIC: number;
export const CLIENT_SCROLL_MAGIC: number;

export function sha256Hex(bytes: Uint8Array): string;
export function extractAvcCodecFromAnnexB(buf: Uint8Array): string;
export function hasSpsNalu(buf: Uint8Array): boolean;

export function packVideoFrame(options: {
  keyFrame: boolean;
  width: number;
  height: number;
  seq?: number;
  ptsUs?: number;
  data: Uint8Array;
}): Buffer;

export class ScrcpyVideoStreamParser {
  width: number;
  height: number;
  deviceName: string;
  codecId: string;
  codecProfile: string;
  constructor(options?: { expectDummyByte?: boolean });
  push(chunk: Uint8Array): Array<Record<string, unknown>>;
}

export function encodeTouchEvent(options: {
  action: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  pointerSlot?: number;
  buttons?: number;
}): Buffer;

export function encodeScrollEvent(options: {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  hScroll?: number;
  vScroll?: number;
  buttons?: number;
}): Buffer;

export function parseClientBinaryControl(
  buf: Uint8Array,
  screenWidth: number,
  screenHeight: number,
): Buffer | null;

export function ensureScrcpyServer(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  allowDownload?: boolean;
  signal?: AbortSignal;
}): Promise<{ jarPath: string; version: string; source: 'cache' | 'local' | 'downloaded' }>;

export interface PanelStreamSession {
  sendBinary(chunk: Uint8Array | ArrayBuffer): boolean;
  sendText?(text: string): boolean;
  close?(reason?: string): void;
  onBinary?(handler: (buf: Buffer) => void): () => void;
  onText?(handler: (text: string) => void): () => void;
  onClose?(handler: (reason?: string) => void): () => void;
  bufferedAmount?(): number;
}

export function createScrcpyManager(options?: {
  resolveDataDir: () => string;
  executeFile?: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;
  spawnProcess?: (...args: unknown[]) => unknown;
  createSocket?: (opts: { host: string; port: number }) => unknown;
  allocatePort?: () => Promise<number>;
  ensureServer?: typeof ensureScrcpyServer;
  fetchImpl?: typeof fetch;
  allowDownload?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): {
  acquireControl(options: {
    adbBinary?: string;
    serial: string;
    fallbackSize?: { width: number; height: number };
  }): Promise<Record<string, (...args: unknown[]) => unknown> | null>;
  warmControl(options: {
    adbBinary?: string;
    serial: string;
    fallbackSize?: { width: number; height: number };
  }): void;
  openVideoStream(
    options: {
      adbBinary?: string;
      serial: string;
      maxFps?: number;
      maxWidth?: number;
      bitRate?: number;
      fallbackSize?: { width: number; height: number };
      clientReadyFallbackMs?: number;
    },
    session: PanelStreamSession,
    context?: { signal?: AbortSignal },
  ): Promise<{
    protocol: 'h264-scrcpy-v1';
    width: number;
    height: number;
    codec: 'h264';
    codecProfile: string;
    deviceName?: string;
  }>;
  dispose(): Promise<void>;
};
