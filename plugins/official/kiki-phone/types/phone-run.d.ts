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

export interface PhoneScriptRunner {
  run(args: Record<string, unknown>, context?: PhoneExecutionContext): Promise<PhoneBusinessResult>
  close(): Promise<void>
}

export function createPhoneScriptRunner(options?: { dataDir?: string }): PhoneScriptRunner
export function runPhoneScript(args: Record<string, unknown>, context?: PhoneExecutionContext): Promise<PhoneBusinessResult>
