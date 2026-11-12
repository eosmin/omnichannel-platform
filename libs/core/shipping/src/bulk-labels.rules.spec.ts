import {
  BulkLabelJobStatus,
  BulkLabelLeftOutReasons,
  BulkOrderOutcomes
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import {
  type BulkResultEntry,
  entryOfOutcome,
  entryOfParts,
  finalStatusOf,
  hasLabel,
  chunksOf,
  inSelectionOrder,
  labelIdsOf,
  partsOfOrder,
  PartsLedger,
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

const printable = (status: string): boolean => status === 'label_created'

describe('the parts of an order', () => {
  it('is one part with no origin when the order names no warehouse and has no guide', () => {
    expect(partsOfOrder([], [], printable)).toEqual([{ originWarehouseId: null, guide: undefined }])
  })

  it('is one part per warehouse its lines leave from, in the order given, each with the guide it has there', () => {
    const live = [{ id: 'g-b', status: 'label_created', originWarehouseId: 'b' }]
    expect(partsOfOrder(['a', 'b'], live, printable)).toEqual([
      { originWarehouseId: 'a', guide: undefined },
      { originWarehouseId: 'b', guide: live[0] }
    ])
  })

  it('keeps a guide whose warehouse the allocation no longer names as a part of its own when every warehouse has a guide', () => {
    const live = [
      { id: 'g-a', status: 'label_created', originWarehouseId: 'a' },
      { id: 'g-old', status: 'label_created', originWarehouseId: 'gone' },
      { id: 'g-none', status: 'label_created', originWarehouseId: null }
    ]
    expect(partsOfOrder(['a', 'a'], live, printable).map(part => part.originWarehouseId)).toEqual([
      'a',
      'gone',
      null
    ])
  })

  it('lets a guide with no warehouse, or one the allocation left, stand for a warehouse that has none: no second guide is paid', () => {
    const none = { id: 'g-none', status: 'label_created', originWarehouseId: null }
    expect(partsOfOrder(['w1'], [none], printable)).toEqual([
      { originWarehouseId: 'w1', guide: none }
    ])
    const moved = { id: 'g-w2', status: 'label_created', originWarehouseId: 'w2' }
    expect(partsOfOrder(['w1'], [moved], printable)).toEqual([
      { originWarehouseId: 'w1', guide: moved }
    ])
    // Two warehouses, one stale guide: it covers the first that has none, the other still needs its own
    const parts = partsOfOrder(['w1', 'w3'], [moved], printable)
    expect(parts).toEqual([
      { originWarehouseId: 'w1', guide: moved },
      { originWarehouseId: 'w3', guide: undefined }
    ])
  })

  it('lets the newest printable guide of a warehouse speak for it', () => {
    const live = [
      { id: 'busy', status: 'cancel_pending', originWarehouseId: 'a' },
      { id: 'ready', status: 'label_created', originWarehouseId: 'a' }
    ]
    expect(partsOfOrder(['a'], live, printable)[0]?.guide?.id).toBe('ready')
    expect(partsOfOrder(['a'], [live[0] as (typeof live)[number]], printable)[0]?.guide?.id).toBe(
      'busy'
    )
  })
})

describe('the entry of a split order', () => {
  const created = (shipmentId: string): BulkResultEntry => ({
    orderId: 'o',
    outcome: BulkOrderOutcomes.CREATED,
    shipmentId
  })
  const reused = (shipmentId: string): BulkResultEntry => ({
    orderId: 'o',
    outcome: BulkOrderOutcomes.REUSED,
    shipmentId
  })

  it('says what its only part says, without a list', () => {
    expect(entryOfParts('o', [reused('s1')])).toEqual(reused('s1'))
  })

  it('is created, and lists every label in the order of the parts, when each part has its label', () => {
    expect(entryOfParts('o', [reused('s1'), created('s2')])).toEqual({
      orderId: 'o',
      outcome: BulkOrderOutcomes.CREATED,
      shipmentId: 's1',
      shipmentIds: ['s1', 's2']
    })
  })

  it('is reused when no part was made by the run', () => {
    expect(entryOfParts('o', [reused('s1'), reused('s2')]).outcome).toBe(BulkOrderOutcomes.REUSED)
  })

  it('fails with what the first part without a label says, and still lists the labels the others have', () => {
    const entry = entryOfParts('o', [
      created('s1'),
      {
        orderId: 'o',
        outcome: BulkOrderOutcomes.FAILED,
        shipmentId: 's2',
        errorCode: ErrorCodes.SHIPPING_OUTCOME_UNKNOWN
      },
      {
        orderId: 'o',
        outcome: BulkOrderOutcomes.SKIPPED,
        errorCode: ErrorCodes.SHIPPING_ORIGIN_MISSING
      }
    ])
    expect(entry).toEqual({
      orderId: 'o',
      outcome: BulkOrderOutcomes.FAILED,
      shipmentId: 's2',
      errorCode: ErrorCodes.SHIPPING_OUTCOME_UNKNOWN,
      shipmentIds: ['s1']
    })
    expect(hasLabel(entry)).toBe(false)
    expect(labelIdsOf(entry)).toEqual(['s1'])
  })

  it('lists no label when no part has one', () => {
    const entry = entryOfParts('o', [
      {
        orderId: 'o',
        outcome: BulkOrderOutcomes.SKIPPED,
        errorCode: ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED
      },
      {
        orderId: 'o',
        outcome: BulkOrderOutcomes.SKIPPED,
        errorCode: ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED
      }
    ])
    expect(entry.shipmentIds).toBeUndefined()
    expect(labelIdsOf(entry)).toEqual([])
  })

  it('carries the reason a label was left out of the file when a part has one', () => {
    const entry = entryOfParts('o', [
      reused('s1'),
      { orderId: 'o', outcome: BulkOrderOutcomes.FAILED, reason: BulkLabelLeftOutReasons.NOT_READY }
    ])
    expect(entry.reason).toBe(BulkLabelLeftOutReasons.NOT_READY)
  })

  it('reads the labels of an entry that is not split from its shipment', () => {
    expect(labelIdsOf(created('s1'))).toEqual(['s1'])
    expect(
      labelIdsOf({ orderId: 'o', outcome: BulkOrderOutcomes.FAILED, shipmentId: 's9' })
    ).toEqual([])
    expect(labelIdsOf({ orderId: 'o', outcome: BulkOrderOutcomes.CREATED })).toEqual([])
  })
})

describe('the ledger of the parts', () => {
  it('gives the order only when the last part has settled, in the order of the parts', () => {
    const ledger = new PartsLedger()
    ledger.open('o', 2)
    const second = { orderId: 'o', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's2' }
    const first = { orderId: 'o', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's1' }
    expect(ledger.fill('o', 1, second)).toBeNull()
    expect(ledger.fill('o', 0, first)?.shipmentIds).toEqual(['s1', 's2'])
  })

  it('gives an order of one part at once, and forgets an order it gave', () => {
    const ledger = new PartsLedger()
    ledger.open('o', 1)
    const entry = { orderId: 'o', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's1' }
    expect(ledger.fill('o', 0, entry)).toEqual(entry)
    expect(ledger.fill('o', 0, entry)).toBeNull()
  })

  it('ignores a part of an order it does not know or a slot that does not exist', () => {
    const ledger = new PartsLedger()
    ledger.open('o', 1)
    const entry = { orderId: 'o', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's1' }
    expect(ledger.fill('other', 0, entry)).toBeNull()
    expect(ledger.fill('o', 3, entry)).toBeNull()
    expect(ledger.fill('o', -1, entry)).toBeNull()
  })
})

describe('what a fault leaves of the split orders under way', () => {
  it('keeps the guides the finished parts made and says the order did not end', () => {
    const ledger = new PartsLedger()
    ledger.open('o', 3)
    ledger.open('none', 2)
    ledger.fill('o', 0, { orderId: 'o', outcome: BulkOrderOutcomes.CREATED, shipmentId: 's1' })
    ledger.fill('o', 2, { orderId: 'o', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's3' })
    ledger.fill('none', 0, {
      orderId: 'none',
      outcome: BulkOrderOutcomes.SKIPPED,
      errorCode: ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED
    })
    expect(ledger.unfinished()).toEqual([
      {
        orderId: 'o',
        outcome: BulkOrderOutcomes.FAILED,
        errorCode: ErrorCodes.INTERNAL_ERROR,
        shipmentIds: ['s1', 's3']
      }
    ])
  })
})

describe('what a fault leaves of an order whose part may have a guide', () => {
  it('names the shipment of a part that was refused after its row was written, and the labels of the others', () => {
    const ledger = new PartsLedger()
    ledger.open('o', 3)
    ledger.fill('o', 0, {
      orderId: 'o',
      outcome: BulkOrderOutcomes.FAILED,
      shipmentId: 's1',
      errorCode: ErrorCodes.SHIPPING_OUTCOME_UNKNOWN
    })
    expect(ledger.unfinished()).toEqual([
      {
        orderId: 'o',
        outcome: BulkOrderOutcomes.FAILED,
        errorCode: ErrorCodes.SHIPPING_OUTCOME_UNKNOWN,
        shipmentId: 's1'
      }
    ])
    ledger.fill('o', 1, { orderId: 'o', outcome: BulkOrderOutcomes.CREATED, shipmentId: 's2' })
    expect(ledger.unfinished()[0]).toMatchObject({ shipmentId: 's1', shipmentIds: ['s2'] })
  })
})

describe('chunksOf', () => {
  it('cuts a list in runs of at most the size, in order, and a size below one is one', () => {
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunksOf([1, 2], 0)).toEqual([[1], [2]])
    expect(chunksOf([], 3)).toEqual([])
  })
})
