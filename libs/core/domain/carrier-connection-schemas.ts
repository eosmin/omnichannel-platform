import { z } from 'zod'

import { CLOCK_TIME_PATTERN } from './settings-constants'
import { CarrierConnectionLimits, CarrierId, LabelFormat } from './shipping-constants'
import { ShippingPayer } from './status-enums'
import { singleLineText } from './validation'

// What a client sends to connect a carrier and to edit a connection (TDD_17 §6). The plugin checks its own
// credentials; the platform bounds their size and checks everything it stores itself. The body never carries a
// `storeId`: the store is the one TenantGuard resolved.

const MAX_CREDENTIALS_BYTES = 8 * 1024

// A value that fits once written as JSON and holds no NUL: Postgres refuses it, and that would be a 500
const boundedRecord = z.record(z.string(), z.unknown()).refine(
  value => {
    const json = JSON.stringify(value)
    return (
      new TextEncoder().encode(json).length <= MAX_CREDENTIALS_BYTES && !json.includes('\\u0000')
    )
  },
  { message: 'too large, or it holds a NUL character' }
)

const feeCents = z.number().int().min(0).max(CarrierConnectionLimits.MAX_FEE_CENTS)
const clockTime = z.string().regex(CLOCK_TIME_PATTERN)

// The settings both calls take. Every one is optional: a connection made without them keeps the column defaults.
const settings = {
  defaultServiceCode: z
    .string()
    .trim()
    .min(1)
    .max(CarrierConnectionLimits.SERVICE_CODE_MAX_LENGTH)
    .optional(),
  defaultShippingPayer: z.enum(ShippingPayer).optional(),
  labelFormat: z.enum(Object.values(LabelFormat) as [string, ...string[]]).optional(),
  pickupEnabled: z.boolean().optional(),
  pickupDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  pickupCutoffTime: clockTime.nullable().optional(),
  autoPickup: z.boolean().optional(),
  autoPickupTime: clockTime.nullable().optional(),
  pickupReminderMinutes: z
    .number()
    .int()
    .min(0)
    .max(CarrierConnectionLimits.MAX_REMINDER_MINUTES)
    .optional(),
  pollIntervalMinutes: z
    .number()
    .int()
    .min(1)
    .max(CarrierConnectionLimits.MAX_POLL_MINUTES)
    .nullable()
    .optional(),
  maxDeliveryAttempts: z
    .number()
    .int()
    .min(1)
    .max(CarrierConnectionLimits.MAX_DELIVERY_ATTEMPTS)
    .optional(),
  defaultShippingFeeCents: feeCents.nullable().optional(),
  minShippingFeeCents: feeCents.nullable().optional(),
  maxShippingFeeCents: feeCents.nullable().optional(),
  remittanceDeductsFee: z.boolean().optional(),
  // The default connection of the store, the one the create-guide dialog and the order drawer preselect
  isDefault: z.boolean().optional()
}

// min <= default <= max where they are set (the CHECK of the table says the same: a value that fails it must be a
// 400 here and not a 500 there). Returns the message of the first problem, or null.
export function shippingFeeRangeProblem(fees: {
  defaultShippingFeeCents?: number | null
  minShippingFeeCents?: number | null
  maxShippingFeeCents?: number | null
}): string | null {
  const { defaultShippingFeeCents: fee, minShippingFeeCents: min, maxShippingFeeCents: max } = fees
  if (min != null && max != null && min > max) return 'the minimum fee is above the maximum'
  if (min != null && fee != null && min > fee) return 'the default fee is below the minimum'
  if (fee != null && max != null && fee > max) return 'the default fee is above the maximum'
  return null
}

// Pickup rules the table checks (chk_carrier_connections_*), by the same names
export function pickupRulesProblem(rules: {
  pickupEnabled?: boolean
  pickupDays?: readonly number[]
  autoPickup?: boolean
  autoPickupTime?: string | null
}): string | null {
  if (rules.pickupEnabled === true && rules.pickupDays?.length === 0) {
    return 'a connection that takes pickups needs at least one day'
  }
  if (rules.autoPickup === true && rules.pickupEnabled === false) {
    return 'automatic pickups need pickups enabled'
  }
  if (rules.autoPickup === true && rules.autoPickupTime === null) {
    return 'automatic pickups need a time'
  }
  return null
}

function refineSettings(
  value: Partial<{
    defaultShippingFeeCents: number | null
    minShippingFeeCents: number | null
    maxShippingFeeCents: number | null
    pickupDays: number[]
    pickupEnabled: boolean
    autoPickup: boolean
    autoPickupTime: string | null
  }>,
  context: z.RefinementCtx
): void {
  const problem = shippingFeeRangeProblem(value) ?? pickupRulesProblem(value)
  if (problem !== null) context.addIssue({ code: 'custom', message: problem })
  if (
    value.pickupDays !== undefined &&
    new Set(value.pickupDays).size !== value.pickupDays.length
  ) {
    context.addIssue({ code: 'custom', path: ['pickupDays'], message: 'a day is listed twice' })
  }
}

export const connectCarrierSchema = z
  .strictObject({
    carrierId: z.enum(Object.values(CarrierId) as [string, ...string[]]),
    // Whatever the plugin needs: an API key, or the name, phone and prefix of a `local` courier
    credentials: boundedRecord,
    // The name in the list; the one the plugin gives the account when this is absent
    displayName: singleLineText(CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH, 1).optional(),
    ...settings
  })
  .superRefine(refineSettings)
export type ConnectCarrierBody = z.output<typeof connectCarrierSchema>

// One service of the connection: its label may be renamed and it may be switched off. The code is the carrier's own
// and never changes here.
export const carrierServiceEditSchema = z.strictObject({
  code: z.string().trim().min(1).max(CarrierConnectionLimits.SERVICE_CODE_MAX_LENGTH),
  label: singleLineText(CarrierConnectionLimits.SERVICE_LABEL_MAX_LENGTH, 1).optional(),
  active: z.boolean().optional()
})

export const updateCarrierSchema = z
  .strictObject({
    displayName: singleLineText(CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH, 1).optional(),
    // New credentials: checked with the carrier again and sealed. The old ones stay when it refuses.
    credentials: boundedRecord.optional(),
    services: z
      .array(carrierServiceEditSchema)
      .max(CarrierConnectionLimits.MAX_SERVICES)
      .optional(),
    ...settings
  })
  .superRefine(refineSettings)
export type UpdateCarrierBody = z.output<typeof updateCarrierSchema>
