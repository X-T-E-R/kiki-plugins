import type { PhoneBusinessResult, PhoneExecutionContext } from './phone-run.d.ts'

export function execAdb(
  file: string,
  args?: string[],
  options?: {
    encoding?: BufferEncoding | 'buffer' | null
    env?: NodeJS.ProcessEnv
    cwd?: string
    timeout?: number
    maxBuffer?: number
    signal?: AbortSignal
    drainGraceMs?: number
    platform?: NodeJS.Platform
    skipStartServer?: boolean
  },
): Promise<{ stdout: string; stderr: string }>

export function runAdb(
  name: 'android_connection' | 'android_shell',
  args: Record<string, unknown>,
  context?: PhoneExecutionContext,
): Promise<PhoneBusinessResult>
