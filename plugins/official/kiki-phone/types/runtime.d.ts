import type { PhoneFacade } from './mobile-facade.d.ts'

export function createCompactPhoneFacade(options?: {
  dataDir?: string
  prepare?: boolean
  signal?: AbortSignal
}): Promise<PhoneFacade>
