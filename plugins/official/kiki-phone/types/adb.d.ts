import type { PhoneBusinessResult, PhoneExecutionContext } from './phone-run.d.ts'

export function runAdb(
  name: 'android_connection' | 'android_shell',
  args: Record<string, unknown>,
  context?: PhoneExecutionContext,
): Promise<PhoneBusinessResult>
