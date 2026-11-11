import { BulkLabelJobStatus, BulkOrderOutcomes } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import {
  type BulkResultEntry,
  entryOfOutcome,
  finalStatusOf,
  hasLabel,
  inSelectionOrder,
  runLimited,
  tallyOf
} from './bulk-labels.rules'
import type { ShipmentOutcome } from './shipping.service'

const refusal = (code: (typeof ErrorCodes)[keyof typeof ErrorCodes]) =>
  new PlatformException(code, 'no', HttpStatusCodes.CONFLICT)

describe('entryOfOutcome', () => {
  it('names the shipment of a guide that was made', () => {
    const outcome: ShipmentOutcome = {
      ok: true,
      orderId: 'o1',
      shipmentId: 's1',
      status: 'label_created' as never
    }
    expect(entryOfOutcome(outcome)).toEqual({
      orderId: 'o1',
      outcome: BulkOrderOutcomes.CREATED,
      shipmentId: 's1'
    })
  })

  it('skips an order that was refused before a row was written, with the code', () => {
    expect(
      entryOfOutcome({
        ok: false,
        orderId: 'o1',
        error: refusal(ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED)
      })
    ).toEqual({
      orderId: 'o1',
      outcome: BulkOrderOutcomes.SKIPPED,
      errorCode: ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED
    })
  })

  it('fails an order whose row was written and then refused, and names the shipment', () => {
    expect(
      entryOfOutcome({
        ok: false,
        orderId: 'o1',
        shipmentId: 's1',
        error: refusal(ErrorCodes.SHIPPING_CARRIER_REJECTED)
      })
    ).toEqual({
      orderId: 'o1',
      outcome: BulkOrderOutcomes.FAILED,
      shipmentId: 's1',
      errorCode: ErrorCodes.SHIPPING_CARRIER_REJECTED
    })
  })
})

describe('the account of a run', () => {
  const entries: BulkResultEntry[] = [
    { orderId: 'a', outcome: BulkOrderOutcomes.CREATED, shipmentId: 's1' },
    { orderId: 'b', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's2' },
    {
      orderId: 'c',
      outcome: BulkOrderOutcomes.SKIPPED,
      errorCode: ErrorCodes.SHIPPING_CARRIER_REQUIRED
    },
    { orderId: 'd', outcome: BulkOrderOutcomes.FAILED, shipmentId: 's3' }
  ]

  it('counts as succeeded only the orders whose label is a page of the file', () => {
    expect(entries.map(hasLabel)).toEqual([true, true, false, false])
    expect(tallyOf(entries)).toEqual({ succeeded: 2, failed: 2 })
    expect(tallyOf([])).toEqual({ succeeded: 0, failed: 0 })
  })

  it('says "with errors" whenever an order is not in the file, even when none is', () => {
    expect(finalStatusOf(0)).toBe(BulkLabelJobStatus.COMPLETED)
    expect(finalStatusOf(1)).toBe(BulkLabelJobStatus.COMPLETED_WITH_ERRORS)
    expect(finalStatusOf(5)).toBe(BulkLabelJobStatus.COMPLETED_WITH_ERRORS)
  })

  it('lists the orders as they were selected, and never drops one that was not settled', () => {
    const settled = new Map<string, BulkResultEntry>(
      entries.map(entry => [entry.orderId, entry] as const)
    )
    const ordered = inSelectionOrder(['d', 'z', 'a'], settled)
    expect(ordered.map(entry => entry.orderId)).toEqual(['d', 'z', 'a'])
    expect(ordered[1]).toMatchObject({
      outcome: BulkOrderOutcomes.FAILED,
      errorCode: ErrorCodes.INTERNAL_ERROR
    })
  })
})

describe('runLimited', () => {
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  it('never runs more than the limit at once, and gives the results in the order of the items', async () => {
    let running = 0
    let peak = 0
    const results = await runLimited([30, 5, 20, 1, 10, 2], 3, async (ms, index) => {
      running += 1
      peak = Math.max(peak, running)
      await pause(ms)
      running -= 1
      return index
    })
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(3)
  })

  it('does not hold back the next item for the slowest of a batch', async () => {
    const finished: number[] = []
    await runLimited([400, 1, 1, 1], 2, async (ms, index) => {
      await pause(ms)
      finished.push(index)
    })
    // The second lane took items 1, 2 and 3 while the first was still on item 0
    expect(finished).toEqual([1, 2, 3, 0])
  })

  it('takes a limit below one as one, and a limit above the items as the items', async () => {
    let peak = 0
    let running = 0
    const work = async () => {
      running += 1
      peak = Math.max(peak, running)
      await pause(2)
      running -= 1
    }
    await runLimited([1, 2, 3], 0, work)
    expect(peak).toBe(1)
    await expect(runLimited([], 5, work)).resolves.toEqual([])
  })

  it('takes a limit that is not a number as one at a time', async () => {
    await expect(
      runLimited([1, 2], Number.NaN, (item: number) => Promise.resolve(item))
    ).resolves.toEqual([1, 2])
  })

  it('stops starting items after a fault, lets the ones under way finish, and throws the first', async () => {
    const started: number[] = []
    const finished: number[] = []
    await expect(
      runLimited([1, 2, 3, 4, 5, 6], 2, async (_item, index) => {
        started.push(index)
        await pause(5)
        if (index === 1) throw new Error('boom')
        finished.push(index)
      })
    ).rejects.toThrow('boom')
    expect(started).not.toContain(5)
    expect(finished).toContain(0)
  })
})
