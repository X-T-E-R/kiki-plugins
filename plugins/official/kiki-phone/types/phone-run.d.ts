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

export interface PhoneScriptRunner {
  run(args: Record<string, unknown>, context?: PhoneExecutionContext): Promise<PhoneBusinessResult>
  close(): Promise<void>
}

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
  },
): void
export function createPhoneScriptRunner(options?: { dataDir?: string }): PhoneScriptRunner
export function runPhoneScript(args: Record<string, unknown>, context?: PhoneExecutionContext): Promise<PhoneBusinessResult>
