export type PhonePrepareStatus = 'checking' | 'runtime_ready' | 'transport_ready' | 'authorization_required' | 'device_offline' | 'no_device' | 'download_consent_required' | 'error'

export interface PhonePrepareResult {
  status: PhonePrepareStatus
  node: string
  dataDir: string
  runtimeInstalled?: boolean
  message?: string
  devices?: Array<{ serial: string; state: string; details: string }>
  [key: string]: unknown
}

export function preparePhone(
  options?: { download?: boolean; adbPath?: string; warmup?: boolean; platform?: 'android' | 'ios' },
  support?: { dataDir?: string; signal?: AbortSignal },
): Promise<PhonePrepareResult>

export function runtimeInstalled(dataDir: string): Promise<boolean>
export function facadeRuntimeInstalled(dataDir: string): Promise<boolean>
