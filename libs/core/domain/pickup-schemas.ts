import { z } from 'zod'

import { isoDaySchema } from './shipment-schemas'
import { PickupLimits } from './shipping-constants'
import { uuidSchema } from './validation'

// What a client sends to a pickup (TDD_17 §4.10, §6). Every shape is strict and none carries a store: it is the one the guard
// resolved.

const shipmentIds = z
  .array(uuidSchema)
  .min(1)
  .max(PickupLimits.MAX_SHIPMENTS)
  .refine(ids => new Set(ids).size === ids.length, { message: 'a shipment appears twice' })

// Request a pickup now: of the guides named, or of every guide of the connection that is waiting. Without a date the next day
// the connection takes pickups is used. `confirmAfterCutoff` is the answer to the confirmation dialog of a change after the
// cutoff of the day (`DestructiveActionTiers.REQUEST_PICKUP_AFTER_CUTOFF`): without it the api refuses with `PICKUP_CUTOFF_PASSED`.
export const requestPickupSchema = z.strictObject({
  connectionId: uuidSchema,
  shipmentIds: shipmentIds.optional(),
  date: isoDaySchema.optional(),
  confirmAfterCutoff: z.boolean().optional()
})
export type RequestPickupBody = z.output<typeof requestPickupSchema>

export const addPickupShipmentsSchema = z.strictObject({
  shipmentIds,
  confirmAfterCutoff: z.boolean().optional()
})
export type AddPickupShipmentsBody = z.output<typeof addPickupShipmentsSchema>
