import { z } from 'zod'

import { ShippingPayer } from '@platform/core/domain'
import {
  type CarrierEvent,
  type CarrierLocation,
  type CreateShipmentParams
} from '@platform/plugins/sdk'

import { safeCarrierText } from './forza-client'
import type { ForzaConfig } from './forza-connection'
import {
  FORZA_GUIDE_PATTERN,
  FORZA_STATUS_CATALOG,
  ForzaCurrencies,
  ForzaDelivery,
  ForzaLimits,
  ForzaPickupResults
} from './forza-constants'

const CENTS_PER_UNIT = 100
const PAD = 2

// Money as the API wants it: a decimal text with two places, from whole cents
export function centsToAmount(cents: number): string {
  const whole = Math.floor(cents / CENTS_PER_UNIT)
  const rest = String(cents % CENTS_PER_UNIT).padStart(PAD, '0')
  return `${whole}.${rest}`
}

// `YYYY-MM-DD hh:mm:ss` in the zone below, the format of `DateOfSale`
// In the zone of the three countries (UTC-6, no daylight saving), which the documentation does not state (Step 4.15)
const SALE_ZONE_OFFSET_MS = -6 * 60 * 60 * 1000
export function formatSaleDate(now: Date): string {
  return new Date(now.getTime() + SALE_ZONE_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

const clip = (value: string, max: number): string => value.trim().slice(0, max)

// "FD10931478" to its series and number; null for anything else
export function splitGuide(guide: string): { serie: string; number: number } | null {
  const match = FORZA_GUIDE_PATTERN.exec(guide.trim())
  if (match === null) return null
  return { serie: (match[1] ?? '').toUpperCase(), number: Number(match[2]) }
}

// The ticket is the customer's own control value: letters and digits of the order number, the last seven
function ticketOf(reference: string): string {
  return reference.replace(/[^A-Za-z0-9]/g, '').slice(-ForzaLimits.TICKET_MAX)
}

function poundsOf(weightGrams: number | undefined, fallback: number): number {
  if (weightGrams === undefined || weightGrams <= 0) return fallback
  return Math.max(0.01, Math.round((weightGrams / ForzaLimits.GRAMS_PER_POUND) * 100) / 100)
}

// The body of `GetServiceByHeaderCodeRequest` (documentation, method 5). Cash on delivery needs the bank data of the
// connection; without it the guide is refused here, before anything is sent. Returns the refusal as text.
export function buildCreateServiceParams(
  config: ForzaConfig,
  params: CreateShipmentParams,
  now: Date
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const { recipient, sender } = params
  const township = recipient.locationIds?.municipalityId
  if (township === undefined || township.trim() === '') {
    return { ok: false, message: 'The delivery municipality is required' }
  }
  const phone = recipient.phones[0]
  if (phone === undefined) return { ok: false, message: 'A recipient phone is required' }
  if (params.cod !== null) {
    if (!Number.isInteger(params.cod.amountCents) || params.cod.amountCents <= 0) {
      return { ok: false, message: 'The amount to collect is not valid' }
    }
    // Nothing is converted: the amount is collected in the currency of the country
    if (params.cod.currency.toUpperCase() !== ForzaCurrencies[config.country]) {
      return { ok: false, message: 'The amount to collect is not in the currency of the country' }
    }
  }
  if (params.cod !== null && config.bank === null) {
    return { ok: false, message: 'The bank account for cash on delivery is not set up' }
  }

  const currency = ForzaCurrencies[config.country]
  const count = Math.max(1, params.packageCount)
  const codCents = params.cod?.amountCents ?? 0
  // The value of each package is not known to the core: it carries the amount to collect (split in cents) or 0
  const base = Math.floor(codCents / count)
  const extra = codCents - base * count
  const parcels = Array.from({ length: count }, (_, index) => {
    const parcel = params.parcels[index]
    return {
      length: parcel?.lengthCm ?? 0,
      width: parcel?.widthCm ?? 0,
      height: parcel?.heightCm ?? 0,
      weight: poundsOf(parcel?.weightGrams, config.defaultWeightLbs),
      amount: centsToAmount(base + (index === 0 ? extra : 0)),
      currency,
      description: clip(params.reference, ForzaLimits.NAME_MAX),
      fragil: 'false'
    }
  })
  const totalWeight = parcels.reduce((sum, parcel) => sum + parcel.weight, 0)

  const ticket = ticketOf(params.reference)
  const note = params.notes === undefined ? '' : clip(params.notes, ForzaLimits.NOTE_MAX)
  const bank = config.bank

  return {
    ok: true,
    value: {
      DateOfSale: formatSaleDate(now),
      to_address: {
        name: clip(recipient.name, ForzaLimits.NAME_MAX),
        phone: clip(phone, ForzaLimits.PHONE_MAX),
        HeaderCodeTownship: township,
        address1: clip(recipient.address.line1, ForzaLimits.ADDRESS_MAX),
        address2: clip(recipient.address.line2 ?? '', ForzaLimits.ADDRESS_MAX),
        city: clip(recipient.address.city, ForzaLimits.ADDRESS_MAX)
      },
      from_address: {
        name: clip(sender.name, ForzaLimits.NAME_MAX),
        phone: clip(sender.phone, ForzaLimits.PHONE_MAX),
        HeaderCodeTownship: config.originHeaderCodeTownship,
        address1: clip(sender.address.line1, ForzaLimits.ADDRESS_MAX),
        address2: clip(sender.address.line2 ?? '', ForzaLimits.ADDRESS_MAX),
        city: clip(sender.address.city, ForzaLimits.ADDRESS_MAX)
      },
      parcels,
      ...(ticket === '' ? {} : { Ticket_Number: ticket }),
      IdCountry: config.country,
      idDeliveryOption: ForzaDelivery.OPTION_ID,
      descriptionDelivery: ForzaDelivery.DESCRIPTION,
      CodeOfReference: String(config.codeOfReference),
      CountPieces: count,
      TotalWeight: totalWeight.toFixed(2),
      TotalValue: centsToAmount(codCents),
      Currency: currency,
      ProductInsuranceAmount: 0,
      InsuranceCurrency: currency,
      // "true": the service is charged to the recipient at the destination (the payer of the shipping)
      Collected: params.shippingPayer === ShippingPayer.RECIPIENT,
      COD: {
        CashOnDelivery: params.cod !== null,
        AmmountCashOnDelivery: centsToAmount(codCents),
        CashOnDeliveryCurrency: currency,
        BankAccountName: params.cod === null ? '' : (bank?.bankAccountName ?? ''),
        BankId: params.cod === null ? '' : (bank?.bankId ?? ''),
        BankAccountType: params.cod === null ? '' : (bank?.bankAccountType ?? ''),
        BankAccountId: params.cod === null ? '' : (bank?.bankAccountId ?? '')
      },
      BillAccountNumber: '',
      PaymentMethod: '',
      Note: note
    }
  }
}

const createAnswerSchema = z
  .array(
    z.object({
      TrackingNumber: z.string().min(1).max(40),
      PDF: z.array(z.string()).optional()
    })
  )
  .min(1)

export function readCreatedGuide(objectValue: unknown): { guideNumber: string } | null {
  const parsed = createAnswerSchema.safeParse(objectValue)
  // One guide per request: more than one entry is an answer this plugin does not know how to store
  const first = parsed.success && parsed.data.length === 1 ? parsed.data[0] : undefined
  if (first === undefined || splitGuide(first.TrackingNumber) === null) return null
  return { guideNumber: first.TrackingNumber.trim().toUpperCase() }
}

const reprintAnswerSchema = z.array(z.object({ PDF: z.array(z.string()).min(1) })).min(1)

export function readLabelLink(objectValue: unknown): string | null {
  const parsed = reprintAnswerSchema.safeParse(objectValue)
  return parsed.success ? (parsed.data[0]?.PDF[0] ?? null) : null
}

// Cancel: Forza answers the text of the result per call; the one it gives for a done cancellation is the only
// thing taken as done, anything else is a refusal that keeps its text (a guide that is not "Solicitado" is one)
// The one sentence of the documentation for a done cancellation, and nothing else
const CANCEL_DONE = /^la anulaci.n de gu.as fue realizada exitosamente\.?$/i
const cancelAnswerSchema = z
  .array(
    z.object({ Result: z.array(z.object({ DescriptionResult: z.string().nullish() })).min(1) })
  )
  .min(1)

export function readCancelResult(objectValue: unknown): { done: boolean; message: string } {
  const parsed = cancelAnswerSchema.safeParse(objectValue)
  const text = parsed.success ? (parsed.data[0]?.Result[0]?.DescriptionResult ?? '') : ''
  return {
    done: CANCEL_DONE.test(text.trim()),
    message: safeCarrierText(text, 'Forza did not cancel the guide')
  }
}

const trackSchema = z.object({
  GuideSerie: z.string().optional(),
  GuideNumber: z.union([z.number(), z.string()]).optional(),
  OrderDetail: z
    .object({
      milestones: z
        .array(
          z.object({
            eventId: z.union([z.number(), z.string()]).optional(),
            stageId: z.union([z.number(), z.string()]),
            date: z.string(),
            title: z.string().nullish(),
            description: z.string().nullish()
          })
        )
        .default([])
    })
    .optional()
})

const KNOWN_STATUS = new Map(FORZA_STATUS_CATALOG.map(entry => [entry.code, entry.defaultStatus]))

// "2024-03-11 09:13:41Z" to ISO 8601; null when it is not a date
function isoOf(raw: string): string | null {
  // A date with no zone is read as UTC, as the ones the documentation shows end in `Z`
  const text = raw.trim().replace(' ', 'T')
  const time = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

// Every milestone of the guide as an event. The id of the event is the guide and the milestone, so the same line
// read twice (a poll) is one event. A status the catalog does not explain keeps `status: null`.
export function readTrackEvents(guideNumber: string, trackOrder: unknown): CarrierEvent[] {
  const parsed = trackSchema.safeParse(trackOrder)
  if (!parsed.success) return []
  const events: CarrierEvent[] = []
  for (const milestone of parsed.data.OrderDetail?.milestones ?? []) {
    const occurredAt = isoOf(milestone.date)
    if (occurredAt === null) continue
    const rawStatus = String(milestone.stageId)
    const title = safeCarrierText(milestone.title, '')
    events.push({
      providerEventId: `${guideNumber}:${String(milestone.eventId ?? '')}:${rawStatus}:${occurredAt}`,
      status: KNOWN_STATUS.get(rawStatus) ?? null,
      rawStatus,
      ...(title === '' ? {} : { description: title }),
      occurredAt,
      guideNumber
    })
  }
  return events
}

const provinceSchema = z.object({
  provinceLists: z.array(z.object({ HeaderCode: z.string(), ProvinceName: z.string() }))
})
const townshipSchema = z.object({
  TownshipByHeaderCodes: z.array(
    z.object({ HeaderCode: z.string(), HeaderCodeTownship: z.string(), TownshipName: z.string() })
  )
})

export function readProvinces(objectValue: unknown): CarrierLocation[] {
  const parsed = provinceSchema.safeParse(objectValue)
  if (!parsed.success) return []
  return parsed.data.provinceLists.map(item => ({ id: item.HeaderCode, name: item.ProvinceName }))
}

export function readTownships(objectValue: unknown, parentId: string): CarrierLocation[] {
  const parsed = townshipSchema.safeParse(objectValue)
  if (!parsed.success) return []
  return parsed.data.TownshipByHeaderCodes.filter(item => item.HeaderCode === parentId).map(
    item => ({ id: item.HeaderCodeTownship, name: item.TownshipName, parentId })
  )
}

const pickupSchema = z.object({
  IdResult: z.number(),
  Message: z.string().nullish(),
  ServiceId: z.number().optional()
})

export function readPickup(
  objectValue: unknown
): { ok: true; serviceId: number } | { ok: false; message: string } {
  const parsed = pickupSchema.safeParse(objectValue)
  if (!parsed.success) return { ok: false, message: 'Forza answered something unreadable' }
  if (
    parsed.data.IdResult === ForzaPickupResults.OK &&
    parsed.data.ServiceId !== undefined &&
    parsed.data.ServiceId > 0
  ) {
    return { ok: true, serviceId: parsed.data.ServiceId }
  }
  return { ok: false, message: safeCarrierText(parsed.data.Message, 'Forza refused the pickup') }
}
