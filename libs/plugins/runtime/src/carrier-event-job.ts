import { z } from 'zod'

import {
  CarrierReportableStatuses,
  CarrierStatusLimits,
  isStorableProviderCode,
  providerStatusCodeOf,
  ShipmentStatus
} from '@platform/core/domain'
import type { CarrierEvent } from '@platform/plugins/sdk'

const text = (max: number) => z.string().min(1).max(max)
// A field the carrier may leave out: an empty one is the same as none (a status update is not lost for a blank reason)
const blankIsNone = (value: unknown): unknown => (value === '' ? undefined : value)
// An auxiliary field too long to keep is left out and the event stays: a delivery is not lost for an echoed reference
const optionalText = (max: number) =>
  z.preprocess(
    value =>
      value === '' || (typeof value === 'string' && value.length > max) ? undefined : value,
    z.string().max(max).optional()
  )

// One event of a carrier as the plugin normalized it (`CarrierEvent`), checked again where it crosses a boundary: the
// signature proves who sent the request, not that the plugin read it well, and a job crossed Redis. The strings are bounded
// so that one event cannot carry a body. Only status fields: no name, phone or address of the recipient is part of it, which
// is why the carrier's free-text `description` is not kept in the job (it can carry them, and a job stays in Redis).
const REPORTABLE: ReadonlySet<ShipmentStatus> = new Set(CarrierReportableStatuses)

// A code as the carrier sends it, before it is normalized: bounded, and not blank
const providerCodeText = text(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH)

export const carrierEventSchema = z
  .object({
    providerEventId: optionalText(200),
    // Only what a carrier can report (the same rule as a mapping and a seed): a status our own actions drive is refused
    status: z
      .enum(ShipmentStatus)
      .refine(status => REPORTABLE.has(status), { message: 'not a status a carrier can report' })
      .nullable(),
    // Looked up by a mapping, so never cut: what is not a code that can be stored is left out whole
    rawStatus: providerCodeText,
    rawReason: z.preprocess(blankIsNone, providerCodeText.optional()),
    occurredAt: z.iso.datetime({ offset: true }),
    guideNumber: optionalText(200),
    providerShipmentId: optionalText(200),
    reference: optionalText(200)
  })
  // What is looked up and stored is the normalized composite, not the two parts: it is the one that must fit
  .refine(event => isStorableProviderCode(providerStatusCodeOf(event.rawStatus, event.rawReason)), {
    message: 'not a status code'
  })
export type ValidCarrierEvent = z.output<typeof carrierEventSchema>

// What the plugin gives must be what the schema keeps: a field of the SDK type that the schema does not name would be
// dropped without an error
export const asCarrierEvent = (event: ValidCarrierEvent): CarrierEvent => event

// The payload of a job `PROCESS_CARRIER_EVENT` of the WEBHOOKS queue (TDD_17 §4.9). It lives here and not with the other
// job types because it carries the event of a plugin, and the core does not depend on the plugin SDK. The worker holds the
// schema of the whole job (`exactly<ProcessCarrierEventJob>()`, which this library may not import). The store comes from
// the connection the signature authenticated, never from the body.
export interface ProcessCarrierEventJob {
  correlationId?: string
  storeId: string
  connectionId: string
  event: ValidCarrierEvent
  receivedAt: string
}
