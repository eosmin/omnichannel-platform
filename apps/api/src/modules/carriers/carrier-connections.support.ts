import { z } from 'zod'

import {
  CarrierConnectionLimits,
  CarrierHealthReasons,
  type CarrierHealthReason,
  CarrierReportableStatuses,
  CarrierStatusMappingSource,
  normalizeProviderStatusCode,
  pickupRulesProblem,
  shippingFeeRangeProblem,
  type ShipmentStatus
} from '@platform/core/domain'
import { CarrierCredentialsUnreadableError } from '@platform/core/shipping'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError,
  type CarrierPlugin
} from '@platform/plugins/sdk'

// Pure rules of the carrier connections, apart from the service so they are tested without a database.

// What a plugin answers to connect(): checked before any of it is stored or shown. The credentials it returns may differ
// from the input (an exchanged token) and are what is kept; the metadata is not secret.
export const connectAnswerSchema = z.object({
  displayName: z.string().trim().min(1).max(CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH),
  credentials: z.record(z.string(), z.unknown()),
  // Not secret, and small: what a plugin keeps of an account is a few settings
  metadata: z.record(z.string(), z.json()).refine(value => JSON.stringify(value).length <= 2048, {
    message: 'too large'
  })
})
export type ConnectAnswer = z.output<typeof connectAnswerSchema>

// The one thing a courier with `CarrierCapability.INTERNAL_GUIDE` needs besides its name: the prefix of its guides, which the sequence holds
export const localMetadataSchema = z.object({
  phone: z.string().max(CarrierConnectionLimits.CONTACT_PHONE_MAX_LENGTH),
  notes: z.string().max(CarrierConnectionLimits.CONTACT_NOTES_MAX_LENGTH).optional(),
  prefix: z.string()
})

// What `withTimeout` rejects with when a carrier takes longer than the time it was given
const PROVIDER_TIMEOUT_NAME = 'ProviderTimeoutError'

// Which name of the closed list a failure of the plugin is, without ever reading what it says
export function healthReasonOf(error: unknown): CarrierHealthReason {
  if (error instanceof CarrierAuthError) return CarrierHealthReasons.AUTH
  if (error instanceof CarrierRejectedError) return CarrierHealthReasons.REJECTED
  if (error instanceof CarrierUnavailableError) return CarrierHealthReasons.UNAVAILABLE
  // A call that took longer than the time it was given is the carrier being slow, not a bad credential
  // By name: the class lives in the channels library, whose barrel reads the environment, and a spec of these rules must not
  if (error instanceof Error && error.name === PROVIDER_TIMEOUT_NAME)
    return CarrierHealthReasons.UNAVAILABLE
  if (error instanceof CarrierCredentialsUnreadableError) {
    return CarrierHealthReasons.CREDENTIALS_UNREADABLE
  }
  return CarrierHealthReasons.INVALID_ANSWER
}

export interface ServiceSeed {
  code: string
  label: string
}

// The services of the plugin's catalog, as rows to write: each with its label in the language of the store, and no code
// twice (the first one wins) or longer than the table of services allows
export function seedServices(
  plugin: Pick<CarrierPlugin, 'serviceCatalog'>,
  labelOf: (service: { code: string; label: string }) => string
): ServiceSeed[] {
  const seen = new Set<string>()
  const rows: ServiceSeed[] = []
  for (const service of plugin.serviceCatalog()) {
    const code = service.code.trim()
    const label = labelOf(service).trim()
    if (code === '' || label === '' || seen.has(code)) continue
    if (code.length > CarrierConnectionLimits.SERVICE_CODE_MAX_LENGTH) continue
    if (rows.length >= CarrierConnectionLimits.MAX_SERVICES) break
    seen.add(code)
    rows.push({ code, label: label.slice(0, CarrierConnectionLimits.SERVICE_LABEL_MAX_LENGTH) })
  }
  return rows
}

// The service a new connection starts with: the one the owner asked for, else the carrier's next-day one, else the first
export function defaultServiceCodeOf(
  plugin: Pick<CarrierPlugin, 'serviceCatalog'>,
  seeded: readonly ServiceSeed[],
  requested: string | undefined
): string | null {
  if (requested !== undefined) return requested
  const nextDay = plugin.serviceCatalog().find(service => service.defaultForNextDay === true)
  if (nextDay !== undefined && seeded.some(row => row.code === nextDay.code.trim())) {
    return nextDay.code.trim()
  }
  return seeded[0]?.code ?? null
}

export interface MappingSeed {
  providerCode: string
  label: string
  status: ShipmentStatus
  source: CarrierStatusMappingSource
}

const REPORTABLE: ReadonlySet<ShipmentStatus> = new Set(CarrierReportableStatuses)

// The mappings a connection starts with (TDD_17 §4.17): what the plugin's status catalog assumes for each code, under the
// normalized code the webhook will look up. A code the plugin cannot safely map (null) is not seeded: it stays unmapped, so
// the owner decides when it first arrives. A default that is not a status a carrier can report is the plugin's bug.
export function seedStatusMappings(plugin: Pick<CarrierPlugin, 'statusCatalog'>): MappingSeed[] {
  const byCode = new Map<string, MappingSeed>()
  for (const entry of plugin.statusCatalog()) {
    if (entry.defaultStatus === null) continue
    if (!REPORTABLE.has(entry.defaultStatus)) {
      throw new RangeError(
        'the status catalog of a carrier maps a code to a status it cannot report'
      )
    }
    const providerCode = normalizeProviderStatusCode(entry.code)
    if (providerCode === '' || byCode.has(providerCode)) continue
    byCode.set(providerCode, {
      providerCode,
      label: entry.label,
      status: entry.defaultStatus,
      source: CarrierStatusMappingSource.DEFAULT
    })
  }
  return [...byCode.values()]
}

export interface RulesSnapshot {
  defaultShippingFeeCents: number | null
  minShippingFeeCents: number | null
  maxShippingFeeCents: number | null
  pickupEnabled: boolean
  pickupDays: readonly number[]
  autoPickup: boolean
  autoPickupTime: string | null
}

// The rules of the table (chk_carrier_connections_*) over the values a write would leave: the ones it sets over the ones the
// row has. A value that fails is a 400 here and not a 500 there. Returns the first problem, or null.
export function settingsProblem(
  current: RulesSnapshot,
  change: Partial<RulesSnapshot>
): string | null {
  const merged = { ...current, ...change }
  return shippingFeeRangeProblem(merged) ?? pickupRulesProblem(merged)
}
