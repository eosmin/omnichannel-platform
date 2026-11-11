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
