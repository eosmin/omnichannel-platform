import { CarrierFeeLimits } from '@platform/core/domain'

import { messageKey } from './connect-manifest'
import { contractViolation, printable } from './contract-rules'

// What a carrier declared about the commission and the rates per service, copied and checked once when it registers (TDD_17 §4.15):
// the web app draws its fields from this copy, never from the live plugin
export interface FeeSettingsSnapshot {
  commission: boolean
  rateServices: readonly { code: string; labelKey: string }[]
}

export const NO_FEE_SETTINGS: FeeSettingsSnapshot = Object.freeze({
  commission: false,
  rateServices: Object.freeze([])
})

export function snapshotFeeSettings(declared: unknown, id: string): FeeSettingsSnapshot {
  if (typeof declared !== 'object' || declared === null) {
    throw contractViolation(`Plugin ${printable(id)} declares invalid fee settings`)
  }
  const { commission, rateServices, rateServiceOf } = declared as Record<string, unknown>
  if (
    typeof commission !== 'boolean' ||
    !Array.isArray(rateServices) ||
    rateServices.length > CarrierFeeLimits.MAX_RATE_SERVICES ||
    typeof rateServiceOf !== 'function'
  ) {
    throw contractViolation(`Plugin ${printable(id)} declares invalid fee settings`)
  }
  const seen = new Set<string>()
  const services = (rateServices as unknown[]).map(raw => {
    const service = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const { code, labelKey } = service
    if (
      typeof code !== 'string' ||
      !CarrierFeeLimits.RATE_CODE_PATTERN.test(code) ||
      !messageKey(labelKey) ||
      seen.has(code)
    ) {
      throw contractViolation(`Plugin ${printable(id)} declares an invalid rate service`)
    }
    seen.add(code)
    return Object.freeze({ code, labelKey })
  })
  return Object.freeze({ commission, rateServices: Object.freeze(services) })
}
