export interface PhoneExecutionContext {
  signal?: AbortSignal
  settings?: { adbPath?: string }
  dataDir?: string
}

export interface PhoneBusinessResult {
  isError?: boolean
  output: string | PhoneOutputPart[]
}

export type PhoneOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string } }

export interface AndroidScreenState {
  awake: boolean
  wakefulness: string
  locked: boolean
  showing: boolean
  occluded: boolean
  secure: boolean
  width: number
  height: number
  reason?: string
}

export interface HumanBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface HumanGesturePoint {
  x: number
  y: number
  time: number
}

export interface HumanTapKeyframes {
  x: number
  y: number
  holdMs: number
  points: HumanGesturePoint[]
}

export interface HumanSwipeKeyframes {
  x1: number
  y1: number
  x2: number
  y2: number
  durationMs: number
  points: HumanGesturePoint[]
}

export interface HumanTapResult {
  x: number
  y: number
  holdMs: number
}

export interface HumanSwipeResult {
  x1: number
  y1: number
  x2: number
  y2: number
  durationMs: number
  steps: number
}

export interface CleanImeResult {
  changed: boolean
  current?: string
  previous?: string
  restored?: string
  reason?: string
}

export interface PhoneScriptRunner {
  run(args: Record<string, unknown>, context?: PhoneExecutionContext): Promise<PhoneBusinessResult>
  close(): Promise<void>
}

export function sampleGaussian(mean?: number, std?: number, rng?: () => number): number
export function samplePointInBox(
  bounds: Partial<HumanBounds>,
  options?: { insetRatio?: number; sigmaRatio?: number; maxOffsetPx?: number; rng?: () => number },
): { x: number; y: number }
export function buildHumanTapKeyframes(
  point: { x: number; y: number },
  options?: { holdMs?: number; screenWidth?: number; screenHeight?: number; rng?: () => number },
): HumanTapKeyframes
export function buildHumanSwipeKeyframes(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  options?: { durationMs?: number; jitterPx?: number; screenWidth?: number; screenHeight?: number; rng?: () => number },
): HumanSwipeKeyframes
export function resolveDirectionEndpoints(
  direction: 'up' | 'down' | 'left' | 'right',
  options?: {
    width?: number
    height?: number
    startX?: number
    startY?: number
    distance?: number
    distanceRatio?: number
    rng?: () => number
  },
): { x1: number; y1: number; x2: number; y2: number }
export function sampleHumanDelayMs(minMs?: number, maxMs?: number, rng?: () => number): number

export function parseAndroidScreenState(sources?: {
  power?: string
  policy?: string
  wmSize?: string
  fallbackSize?: { width?: number; height?: number }
}): AndroidScreenState
export function attachPhoneConvenienceApis(
  device: Record<string, unknown>,
  screen: Record<string, unknown>,
  options?: {
    platform?: string
    serial?: string
    adbBinary?: string
    signal?: AbortSignal
    rng?: () => number
    env?: Record<string, string | undefined>
  },
): void
export function createPhoneScriptRunner(options?: { dataDir?: string }): PhoneScriptRunner
export function runPhoneScript(args: Record<string, unknown>, context?: PhoneExecutionContext): Promise<PhoneBusinessResult>
