import { z } from 'zod'

import { CLOCK_TIME_PATTERN } from './settings-constants'
import { BulkLabelLimits, ManualShipmentStatuses, ShipmentLimits } from './shipping-constants'
import { type ShipmentStatus, ShippingPayer } from './status-enums'
import { singleLineText, uuidSchema } from './validation'

// What a client sends to make a guide and to set a status by hand (TDD_17 §4.2, §4.5, §6). Every shape is strict, and none
// carries a store, an amount to collect or a cost: the store is the one the guard resolved, the amount comes from the order
// (TDD_17 §4.4) and the cost is what the carrier says.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// A day that exists: '2026-02-31' rolls over to March in a Date, and '2026-13-01' is not a date at all
function isCalendarDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

// A day of the calendar as 'YYYY-MM-DD'
export const isoDaySchema = z
  .string()
  .regex(ISO_DATE)
  .refine(isCalendarDay, { message: 'not a day of the calendar' })

// A clock that runs a little fast is not a lie about the future
const CLOCK_ALLOWANCE_MS = 5 * 60 * 1000
const clock = z.string().regex(CLOCK_TIME_PATTERN)

// The carrier's own ids for the places of the address, for a carrier that asks for them (REQUIRES_LOCATION_IDS)
const locationIdText = singleLineText(60, 1)
export const shipmentLocationIdsSchema = z.strictObject({
  departmentId: locationIdText,
  municipalityId: locationIdText,
  settlementId: locationIdText.optional()
})

// The day and hours a pickup-bound carrier comes for the guides. Without it the next valid day of the connection is used
export const shipmentPickupSchema = z
  .strictObject({
    date: isoDaySchema,
    from: clock,
    to: clock
  })
  .refine(value => value.from < value.to, { message: 'the window ends before it starts' })

// What the courier reads on the label: one line of free text, never the packing notes
const notes = z
  .string()
  .trim()
  .max(ShipmentLimits.NOTES_MAX_LENGTH)
  .refine(value => !value.includes('\u0000'), { message: 'a NUL character' })

export const createShipmentSchema = z.strictObject({
  connectionId: uuidSchema.optional(),
  serviceCode: singleLineText(40, 1).optional(),
  shippingPayer: z.enum(ShippingPayer).optional(),
  originWarehouseId: uuidSchema.optional(),
  locationIds: shipmentLocationIdsSchema.optional(),
  pickup: shipmentPickupSchema.optional(),
  notes: notes.optional()
})
export type CreateShipmentBody = z.output<typeof createShipmentSchema>

// A status set by hand: the table of transitions decides from where. A guide number goes with `label_created` for a guide
// that was found at the carrier after an unknown outcome (TDD_17 §4.5).
export const setShipmentStatusSchema = z.strictObject({
  status: z.enum(ManualShipmentStatuses as readonly [ShipmentStatus, ...ShipmentStatus[]]),
  guideNumber: singleLineText(ShipmentLimits.GUIDE_NUMBER_MAX_LENGTH, 1).optional(),
  description: singleLineText(ShipmentLimits.DESCRIPTION_MAX_LENGTH, 1).optional(),
  occurredAt: z.iso
    .datetime()
    .refine(value => new Date(value).getTime() <= Date.now() + CLOCK_ALLOWANCE_MS, {
      message: 'in the future'
    })
    .optional()
})
export type SetShipmentStatusBody = z.output<typeof setShipmentStatusSchema>

// Ids that name each thing once: a repeated order would ask for two guides, a repeated shipment would print its label twice
const uniqueIds = z
  .array(uuidSchema)
  .min(1)
  .max(BulkLabelLimits.MAX_ORDERS)
  .refine(ids => new Set(ids).size === ids.length, { message: 'an id appears twice' })

// Bulk generation (TDD_17 §4.6): the orders in the order the agent selected them, which is the order of the pages. The carrier
// and the pickup are optional and apply to every order of the run; without them each order follows its planned carrier.
// The places of a carrier that asks for them (REQUIRES_LOCATION_IDS) are chosen once for the whole run, so they only make sense
// with the carrier the run is made for: without `connectionId` each order follows its own planned carrier and no single pair of
// places could be right for all. Two levels, the ones a plugin lists (no settlement).
export const bulkLocationIdsSchema = z.strictObject({
  departmentId: locationIdText,
  municipalityId: locationIdText
})
// A run that follows each order's planned carrier gives the places of each carrier that asks for them, by the id of its connection:
// the run applies a pair to the orders that carrier makes the guide of, and to no other. The way a run pinned to one carrier gives its
// pair (`connectionId` + `locationIds`) and this one are never used together.
export const bulkLocationsByConnectionSchema = z
  .record(uuidSchema, bulkLocationIdsSchema)
  .refine(value => Object.keys(value).length <= BulkLabelLimits.MAX_PLACE_CARRIERS, {
    message: 'too many carriers'
  })
export const bulkLabelsSchema = z
  .strictObject({
    orderIds: uniqueIds,
    connectionId: uuidSchema.optional(),
    locationIds: bulkLocationIdsSchema.optional(),
    locationsByConnection: bulkLocationsByConnectionSchema.optional(),
    pickup: shipmentPickupSchema.optional()
  })
  .refine(value => value.locationIds === undefined || value.connectionId !== undefined, {
    message: 'places need the carrier they belong to',
    path: ['connectionId']
  })
  .refine(value => value.locationsByConnection === undefined || value.connectionId === undefined, {
    message: 'a run pinned to a carrier gives its places with `locationIds`',
    path: ['locationsByConnection']
  })
export type BulkLabelsBody = z.output<typeof bulkLabelsSchema>

// "Print labels" of guides that already exist: the shipments in the order of the pages
export const mergeLabelsSchema = z.strictObject({ shipmentIds: uniqueIds })
export type MergeLabelsBody = z.output<typeof mergeLabelsSchema>
