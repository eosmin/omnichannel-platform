import {
  type BulkLabelLeftOutReason,
  BulkLabelJobStatus,
  type BulkOrderOutcome,
  BulkOrderOutcomes
} from '@platform/core/domain'
import { type ErrorCode, ErrorCodes } from '@platform/core/errors'

import type { ShipmentOutcome } from './shipping.service'

// What a bulk run says of one order (the `results` of the BulkLabelJob, TDD_17 §4.6). `errorCode` is a code the platform
// answers with, `reason` one of the closed list of why a label that exists is not in the file; the screen draws both from its
// own texts.
export interface BulkResultEntry {
  orderId: string
  outcome: BulkOrderOutcome
  shipmentId?: string
  // Only on an order that is split between warehouses: every guide of the order whose label is a page of the file, in the order of
  // its parts. `shipmentId` is the first of them, or, when a part did not get its guide, the guide of that part (the one the
  // `errorCode` is about)
  shipmentIds?: string[]
  errorCode?: ErrorCode
  reason?: BulkLabelLeftOutReason
}

// What came of asking the engine for one guide. A refusal before anything was written (the order did not qualify) is a skip; one
// after the row was written (the carrier refused, or nobody knows what it did) names the shipment and is a failure.
export function entryOfOutcome(outcome: ShipmentOutcome): BulkResultEntry {
  if (outcome.ok) {
    return {
      orderId: outcome.orderId,
      outcome: BulkOrderOutcomes.CREATED,
      shipmentId: outcome.shipmentId
    }
  }
  const code = outcome.error.code
  return outcome.shipmentId === undefined
    ? { orderId: outcome.orderId, outcome: BulkOrderOutcomes.SKIPPED, errorCode: code }
    : {
        orderId: outcome.orderId,
        outcome: BulkOrderOutcomes.FAILED,
        shipmentId: outcome.shipmentId,
        errorCode: code
      }
}

// An order whose label is, or will be, a page of the file
export function hasLabel(entry: BulkResultEntry): boolean {
  return entry.outcome === BulkOrderOutcomes.CREATED || entry.outcome === BulkOrderOutcomes.REUSED
}

// The guides of an order whose label is, or will be, a page of the file. A split order that lost a part still prints the labels of
// the parts that have one.
export function labelIdsOf(entry: BulkResultEntry): string[] {
  if (entry.shipmentIds !== undefined) return entry.shipmentIds
  return hasLabel(entry) && entry.shipmentId !== undefined ? [entry.shipmentId] : []
}

// A guide that is still alive, as far as a bulk run cares
export interface LiveGuide {
  id: string
  status: string
  originWarehouseId: string | null
}

// One piece of what an order ships: the warehouse it leaves from and the guide it already has there, if any. An order that is not
// split is one part.
export interface OrderPart {
  originWarehouseId: string | null
  guide: LiveGuide | undefined
}

// The parts of an order: one per warehouse its lines leave from (`origins`, in the order the guides are to be made) and one for
// every live guide whose warehouse is not among them (the allocation changed after the guide was made: it is still the order's).
// The index of one live guide per order and warehouse means a warehouse has at most one guide; if the data ever held more, the
// newest printable one speaks for it. An order that names no warehouse and has no guide is one part with no origin: the engine
// picks the warehouse of the store.
export function partsOfOrder(
  origins: readonly string[],
  live: readonly LiveGuide[],
  isPrintable: (status: string) => boolean
): OrderPart[] {
  const named = [...new Set(origins)]
  const guideAt = (origin: string | null): LiveGuide | undefined => {
    const here = live.filter(guide => guide.originWarehouseId === origin)
    return here.find(guide => isPrintable(guide.status)) ?? here[0]
  }
  const parts: OrderPart[] = named.map(origin => ({
    originWarehouseId: origin,
    guide: guideAt(origin)
  }))
  // A live guide whose warehouse the allocation does not name (none at all, or the lines moved after the guide was made) is still the
  // order's. It stands for a warehouse that has no guide of its own, one by one, so the run never pays for a second guide of what
  // the order already shipped; the rest are parts of their own.
  const orphans: OrderPart[] = []
  const seen = new Set<string | null>(named)
  for (const guide of live) {
    if (seen.has(guide.originWarehouseId)) continue
    seen.add(guide.originWarehouseId)
    orphans.push({
      originWarehouseId: guide.originWarehouseId,
      guide: guideAt(guide.originWarehouseId)
    })
  }
  for (const orphan of orphans) {
    const open = parts.find(
      part =>
        part.guide === undefined &&
        part.originWarehouseId !== null &&
        named.includes(part.originWarehouseId)
    )
    if (open === undefined) {
      parts.push(orphan)
    } else {
      open.guide = orphan.guide
    }
  }
  return parts.length === 0 ? [{ originWarehouseId: null, guide: undefined }] : parts
}

// What a bulk run says of an order from what became of each of its parts, in the order of the parts. An order of one part says what
// that part says. A split order is a success only when every part has its label; otherwise it says what the first part without one
// says, and still names the labels the other parts have, which are printed.
export function entryOfParts(orderId: string, parts: readonly BulkResultEntry[]): BulkResultEntry {
  const [only] = parts
  if (parts.length === 1 && only !== undefined) return only
  const ids = parts
    .filter(hasLabel)
    .flatMap(part => (part.shipmentId === undefined ? [] : [part.shipmentId]))
  const missing = parts.find(part => !hasLabel(part))
  if (missing === undefined) {
    return {
      orderId,
      outcome: parts.some(part => part.outcome === BulkOrderOutcomes.CREATED)
        ? BulkOrderOutcomes.CREATED
        : BulkOrderOutcomes.REUSED,
      ...(ids[0] === undefined ? {} : { shipmentId: ids[0] }),
      shipmentIds: ids
    }
  }
  return {
    orderId,
    outcome: missing.outcome,
    ...(missing.shipmentId === undefined ? {} : { shipmentId: missing.shipmentId }),
    ...(missing.errorCode === undefined ? {} : { errorCode: missing.errorCode }),
    ...(missing.reason === undefined ? {} : { reason: missing.reason }),
    ...(ids.length === 0 ? {} : { shipmentIds: ids })
  }
}

// Keeps what each part of a split order came to until the last one has, so that an order is announced once and whole
export class PartsLedger {
  private readonly slots = new Map<string, (BulkResultEntry | undefined)[]>()

  open(orderId: string, count: number): void {
    this.slots.set(orderId, new Array<BulkResultEntry | undefined>(count).fill(undefined))
  }

  // The entry of the order once every one of its parts has settled, else null
  fill(orderId: string, index: number, entry: BulkResultEntry): BulkResultEntry | null {
    const slots = this.slots.get(orderId)
    if (slots === undefined || index < 0 || index >= slots.length) return null
    slots[index] = entry
    const done = slots.filter((part): part is BulkResultEntry => part !== undefined)
    if (done.length !== slots.length) return null
    this.slots.delete(orderId)
    return entryOfParts(orderId, done)
  }

  // What the orders that did not finish have to show when the run stops on a fault: a guide a part made is a guide the run paid for,
  // so it stays on the account (and in the file) even though the order did not end whole
  unfinished(): BulkResultEntry[] {
    const entries: BulkResultEntry[] = []
    for (const [orderId, slots] of this.slots) {
      const done = slots.filter((part): part is BulkResultEntry => part !== undefined)
      const ids = done.flatMap(part => labelIdsOf(part))
      // A part that wrote a row and was refused, or whose outcome nobody knows, may have a guide at the carrier: it is named too
      const doubtful = done.find(part => !hasLabel(part) && part.shipmentId !== undefined)
      if (ids.length === 0 && doubtful === undefined) continue
      entries.push({
        orderId,
        outcome: BulkOrderOutcomes.FAILED,
        errorCode: doubtful?.errorCode ?? ErrorCodes.INTERNAL_ERROR,
        ...(doubtful?.shipmentId === undefined ? {} : { shipmentId: doubtful.shipmentId }),
        ...(ids.length === 0 ? {} : { shipmentIds: ids })
      })
    }
    return entries
  }
}

// The requests cut in runs the engine takes at once (`size` at most), in the same order
export function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size))
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += width)
    chunks.push(items.slice(start, start + width))
  return chunks
}

// The entries in the order the agent selected the orders in, one per order; an order with none is not silently dropped
export function inSelectionOrder(
  orderIds: readonly string[],
  settled: ReadonlyMap<string, BulkResultEntry>
): BulkResultEntry[] {
  return orderIds.map(
    orderId =>
      settled.get(orderId) ?? {
        orderId,
        outcome: BulkOrderOutcomes.FAILED,
        errorCode: ErrorCodes.INTERNAL_ERROR
      }
  )
}

// `succeeded` are the orders whose label is in the file, `failed` every other one (skipped, refused, or left out of the file):
// together they are the orders of the run once it ends, which the table checks
export function tallyOf(entries: readonly BulkResultEntry[]): {
  succeeded: number
  failed: number
} {
  const succeeded = entries.filter(hasLabel).length
  return { succeeded, failed: entries.length - succeeded }
}

// The status of a run that ended by itself: "with errors" when any order is not in the file, even all of them. `FAILED` is for
// a run that stopped on a fault, never for orders that did not qualify.
export function finalStatusOf(failed: number): BulkLabelJobStatus {
  return failed === 0 ? BulkLabelJobStatus.COMPLETED : BulkLabelJobStatus.COMPLETED_WITH_ERRORS
}

// Runs `work` over the items with at most `limit` at the same time, and gives the results in the order of the items. A pool, not a
// batch: a slow call does not hold back the next one. `work` answers for its own failures; if it throws anyway nothing new is
// started, what is under way finishes, and the first fault is thrown.
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let fault: { error: unknown } | undefined
  const lane = async (): Promise<void> => {
    while (fault === undefined) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await work(items[index] as T, index)
      } catch (error) {
        fault ??= { error }
      }
    }
  }
  // A limit that is not a number is one at a time, never no lane at all
  const lanes = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 1, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  if (fault !== undefined) throw fault.error
  return results
}
