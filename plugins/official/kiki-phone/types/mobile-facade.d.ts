export interface PhoneFacadeResult {
  isError?: boolean
  content: Array<Record<string, unknown>>
  structuredContent?: unknown
}

export interface PhoneFacade {
  execute(name: 'phone_help' | 'phone_call', args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<PhoneFacadeResult>
  close(): Promise<void>
}

export const facadeTools: Array<Record<string, unknown>>
