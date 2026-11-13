import { type ShipmentStatus } from '@platform/core/domain'
import type { CarrierEvent } from '@platform/plugins/sdk'

import {
  C807_RETURN_REASON,
  C807_STATUS_CATALOG,
  C807StatusCodes,
  C807Time
} from './c807-constants'

const BY_CODE: ReadonlyMap<string, ShipmentStatus | null> = new Map(
  C807_STATUS_CATALOG.map(entry => [entry.code, entry.defaultStatus])
)

// What a status of C807 means by default: the code with its reason when the catalog knows that pair, otherwise the code alone.
// An unknown code is `null` (the owner maps it from the unmapped list), never a guess.
export function c807StatusOf(code: string, reason?: string): ShipmentStatus | null {
  if (reason !== undefined && reason !== '') {
    const composite = BY_CODE.get(`${code}:${reason}`)
    if (composite !== undefined) return composite
  }
  return BY_CODE.get(code) ?? null
}

// "2022-02-17 12:16:35" has no zone; the zone of C807 is added so that the instant is the right one. A text that is not a
// date is `null`: an event with no moment is dropped, never given the moment of the call.
export function c807Instant(text: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text.trim())
  if (!match) return null
  const instant = `${match[1]}T${match[2]}${C807Time.OFFSET}`
  return Number.isNaN(Date.parse(instant)) ? null : instant
}

export interface C807RawEvent {
  guide?: string
  code: string
  label?: string
  observations?: string | null
  date: string
  // A package that went back to the sender
  returned?: boolean
  // The reason of a code `16`, and its words
  reason?: string
  reasonText?: string | null
}

// One status of C807 as the event the core reads. The reason is part of the code only when it changes what it means: a
// code `16` with the number of its reason, a code `15` of a package that went back to the sender.
export function toCarrierEvent(raw: C807RawEvent): CarrierEvent | null {
  const occurredAt = c807Instant(raw.date)
  if (occurredAt === null) return null
  const reason =
    raw.code === C807StatusCodes.ARRIVED && raw.returned === true
      ? C807_RETURN_REASON
      : raw.code === C807StatusCodes.PROBLEM
        ? raw.reason
        : undefined
  const description = [raw.label, raw.reasonText, raw.observations]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(': ')
  return {
    status: c807StatusOf(raw.code, reason),
    rawStatus: raw.code,
    ...(reason === undefined || reason === '' ? {} : { rawReason: reason }),
    ...(description === '' ? {} : { description }),
    occurredAt,
    ...(raw.guide === undefined ? {} : { guideNumber: raw.guide })
  }
}
