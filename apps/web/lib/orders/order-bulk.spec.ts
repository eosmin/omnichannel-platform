import type {
  CarrierConnectionSummaryView,
  OrderSummaryView,
  ShipmentSummaryView
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  BulkOrderOutcomes,
  CarrierCapability,
  OrderMessageOutcomeStatus,
  OrderStatus,
  ShipmentKind,
  ShipmentStatus
} from '@platform/core/domain'

import {
  availabilityOf,
  BulkActionKinds,
  type BulkInput,
  BulkOutcomes,
  BulkSkipRules,
  confirmReport,
  jobProgress,
  labelsReport,
  leftOutEntries,
  liveGuidesByOrder,
  pendingConfirmationIds,
  pickupReport,
  pickupTargets,
  printReport,
  printTargets,
  reportCounts,
  summaryReport
} from './order-bulk'

function order(id: string, status: string): OrderSummaryView {
  return { id, status } as OrderSummaryView
}

function guide(
  id: string,
  orderId: string,
  overrides: Partial<ShipmentSummaryView> = {}
): ShipmentSummaryView {
  return {
    id,
    orderId,
    connectionId: 'c1',
    connectionName: 'Carrier',
    kind: ShipmentKind.OUTBOUND,
    status: ShipmentStatus.LABEL_CREATED,
    guideNumber: 'G1',
    trackingUrl: null,
    hasLabel: true,
    pickupId: null,
    createdAt: '2026-11-12T10:00:00.000Z',
    ...overrides
  }
}

function connection(capabilities: string[]): CarrierConnectionSummaryView {
  return {
    id: 'c1',
    carrierId: 'x',
    carrierName: 'X',
    displayName: 'X',
    status: 'active',
    isDefault: true,
    capabilities
  }
}

const everything = (): boolean => true
const nothing = (): boolean => false

function input(overrides: Partial<BulkInput> = {}): BulkInput {
  const guides = liveGuidesByOrder([guide('s1', 'o1'), guide('s2', 'o2', { hasLabel: false })])
  return {
    selectedIds: ['o2', 'o1', 'o3'],
    rows: [
      order('o1', OrderStatus.CONFIRMED),
      order('o2', OrderStatus.PENDING_CONFIRMATION),
      order('o3', OrderStatus.PENDING_CONFIRMATION)
    ],
    guides,
    connections: [connection([CarrierCapability.PICKUP_REQUEST])],
    can: everything,
    ...overrides
  }
}

describe('liveGuidesByOrder', () => {
  it('keeps only outbound guides that still hold their order', () => {
    const map = liveGuidesByOrder([
      guide('a', 'o1'),
      guide('b', 'o1', { status: ShipmentStatus.CANCELLED }),
      guide('c', 'o2', { status: ShipmentStatus.FAILED }),
      guide('d', 'o3', { status: ShipmentStatus.RETURNED }),
      guide('e', 'o4', { kind: ShipmentKind.RETURN }),
      guide('f', 'o5', { status: ShipmentStatus.CANCEL_PENDING })
    ])
    expect([...map.keys()]).toEqual(['o1', 'o5'])
    expect(map.get('o1')?.map(g => g.id)).toEqual(['a'])
  })
})

describe('availabilityOf', () => {
  it('offers each action to who may and has something to act on', () => {
    expect(availabilityOf(input())).toEqual({
      tooMany: false,
      confirm: true,
      summary: true,
      labels: true,
      print: true,
      pickup: true
    })
  })

  it('offers nothing without a permission, whatever the rows are', () => {
    expect(availabilityOf(input({ can: nothing }))).toEqual({
      tooMany: false,
      confirm: false,
      summary: false,
      labels: false,
      print: false,
      pickup: false
    })
  })

  it('asks each action for its own permission', () => {
    const only = (permission: string) => (asked: string) => asked === permission
    expect(availabilityOf(input({ can: only(ClientPermissions.ORDERS_CONFIRM) })).confirm).toBe(
      true
    )
    expect(availabilityOf(input({ can: only(ClientPermissions.ORDERS_CONFIRM) })).labels).toBe(
      false
    )
    expect(availabilityOf(input({ can: only(ClientPermissions.SHIPPING_MANAGE) })).pickup).toBe(
      false
    )
    expect(
      availabilityOf(input({ can: only(ClientPermissions.SHIPPING_MANAGE_PICKUPS) })).pickup
    ).toBe(true)
    expect(
      availabilityOf(input({ can: only(ClientPermissions.ORDERS_SEND_MESSAGES) })).summary
    ).toBe(true)
  })

  it('offers nothing with no selection', () => {
    expect(availabilityOf(input({ selectedIds: [] }))).toEqual({
      tooMany: false,
      confirm: false,
      summary: false,
      labels: false,
      print: false,
      pickup: false
    })
  })

  it('offers no confirmation when no selected order waits for it', () => {
    expect(availabilityOf(input({ selectedIds: ['o1'] })).confirm).toBe(false)
  })

  it('offers no print when no selected order has a label', () => {
    expect(availabilityOf(input({ selectedIds: ['o2', 'o3'] })).print).toBe(false)
  })

  it('does not offer a pickup of a carrier that cannot be asked for one', () => {
    expect(availabilityOf(input({ connections: [connection([])] })).pickup).toBe(false)
    expect(
      availabilityOf(
        input({
          connections: [
            connection([CarrierCapability.PICKUP_REQUEST, CarrierCapability.PICKUP_BOUND_GUIDES])
          ]
        })
      ).pickup
    ).toBe(false)
  })

  it('offers no pickup for a guide that already holds one or is past its label', () => {
    const guides = liveGuidesByOrder([
      guide('s1', 'o1', { pickupId: 'p1' }),
      guide('s2', 'o2', { status: ShipmentStatus.IN_TRANSIT })
    ])
    expect(availabilityOf(input({ guides })).pickup).toBe(false)
  })

  it('refuses a selection longer than a run takes', () => {
    const ids = Array.from({ length: 101 }, (_, index) => `o${index}`)
    const result = availabilityOf(input({ selectedIds: ids }))
    expect(result.tooMany).toBe(true)
    expect(result.labels).toBe(false)
    expect(result.confirm).toBe(false)
  })
})

describe('targets', () => {
  it('keeps the order of the selection', () => {
    expect(pendingConfirmationIds(input())).toEqual(['o2', 'o3'])
    expect(printTargets(input()).map(g => g.id)).toEqual(['s1'])
    expect(pickupTargets(input()).map(g => g.id)).toEqual(['s2', 's1'])
  })
})

describe('confirmReport', () => {
  it('reports the ones that changed, the refused with their code and the ones not sent', () => {
    const report = confirmReport(['o1', 'o2', 'o3'], ['o1'], {
      succeeded: ['o2'],
      failed: [{ id: 'o3', code: 'ORDER_INVALID_TRANSITION' }]
    })
    expect(report.entries).toEqual([
      { orderId: 'o1', outcome: 'skipped', rule: BulkSkipRules.NOT_PENDING_CONFIRMATION },
      { orderId: 'o2', outcome: 'done' },
      { orderId: 'o3', outcome: 'skipped', code: 'ORDER_INVALID_TRANSITION' }
    ])
    expect(reportCounts(report)).toEqual({ done: 1, reused: 0, skipped: 2, failed: 0 })
    expect(leftOutEntries(report).map(entry => entry.orderId)).toEqual(['o1', 'o3'])
  })
})

describe('what the server did not say', () => {
  it('reports an id missing from both answers as failed, not as left out for a reason', () => {
    const report = confirmReport(['o1'], [], { succeeded: [], failed: [] })
    expect(report.entries).toEqual([{ orderId: 'o1', outcome: 'failed' }])
  })

  it('does not call a run that is still going a failure of its orders', () => {
    const report = labelsReport(
      {
        id: 'j',
        status: 'running',
        total: 1,
        succeeded: 0,
        failed: 0,
        results: null,
        download: null,
        createdAt: '2026-11-12T10:00:00.000Z',
        finishedAt: null
      },
      ['o1']
    )
    expect(report.entries).toEqual([{ orderId: 'o1', outcome: 'failed', reason: 'still_running' }])
  })
})

describe('labelsReport', () => {
  it('maps every outcome of a run, in the order of the selection', () => {
    const report = labelsReport(
      {
        id: 'j',
        status: 'completed_with_errors',
        total: 4,
        succeeded: 2,
        failed: 2,
        results: [
          { orderId: 'o1', outcome: BulkOrderOutcomes.CREATED, shipmentId: 's1' },
          { orderId: 'o2', outcome: BulkOrderOutcomes.REUSED, shipmentId: 's2' },
          {
            orderId: 'o3',
            outcome: BulkOrderOutcomes.SKIPPED,
            errorCode: 'SHIPPING_ORDER_NOT_CONFIRMED'
          },
          {
            orderId: 'o4',
            outcome: BulkOrderOutcomes.FAILED,
            shipmentId: 's4',
            reason: 'not_ready'
          }
        ],
        download: { url: 'https://files/x.pdf', filename: 'labels.pdf' },
        createdAt: '2026-11-12T10:00:00.000Z',
        finishedAt: '2026-11-12T10:01:00.000Z'
      },
      ['o4', 'o3', 'o2', 'o1', 'o5']
    )
    expect(report.download).toEqual({ url: 'https://files/x.pdf', filename: 'labels.pdf' })
    expect(report.entries.map(entry => [entry.orderId, entry.outcome])).toEqual([
      ['o4', BulkOutcomes.FAILED],
      ['o3', BulkOutcomes.SKIPPED],
      ['o2', BulkOutcomes.REUSED],
      ['o1', BulkOutcomes.DONE],
      // an order the run said nothing about is never reported as a success
      ['o5', BulkOutcomes.FAILED]
    ])
    expect(report.entries[1]?.code).toBe('SHIPPING_ORDER_NOT_CONFIRMED')
    expect(report.entries[0]?.reason).toBe('not_ready')
  })
})

describe('printReport', () => {
  it('leaves out an order with no guide and one whose label did not go in the file', () => {
    const targets = [guide('s1', 'o1'), guide('s2', 'o2')]
    const report = printReport(['o1', 'o2', 'o3'], targets, {
      download: { url: 'u', filename: 'f.pdf' },
      merged: ['s1'],
      leftOut: [{ shipmentId: 's2', reason: 'not_ready' }],
      pageCount: 1,
      mixedSizes: true
    })
    expect(report.mixedSizes).toBe(true)
    expect(report.entries).toEqual([
      { orderId: 'o1', outcome: 'done' },
      { orderId: 'o2', outcome: 'skipped', reason: 'not_ready' },
      { orderId: 'o3', outcome: 'skipped', rule: BulkSkipRules.NO_GUIDE }
    ])
  })
})

describe('pickupReport', () => {
  it('reports the guides that wait with the reason and the connection the api refused', () => {
    const targets = [
      guide('s1', 'o1'),
      guide('s2', 'o2'),
      guide('s3', 'o3', { connectionId: 'c2' })
    ]
    const pickup = {
      id: 'p',
      connectionId: 'c1',
      connectionName: 'X',
      pickupDate: '2026-11-13',
      status: 'pending',
      packageCount: 1
    }
    const report = pickupReport(['o1', 'o2', 'o3', 'o4'], targets, [
      {
        connectionId: 'c1',
        shipmentIds: ['s1', 's2'],
        result: {
          pickup,
          created: true,
          joined: [],
          waiting: [{ shipmentId: 's2', reason: 'cutoff_passed' }]
        }
      },
      { connectionId: 'c2', shipmentIds: ['s3'], result: { code: 'PICKUP_NOT_ENABLED' } }
    ])
    expect(report.entries).toEqual([
      { orderId: 'o1', outcome: 'done' },
      { orderId: 'o2', outcome: 'skipped', reason: 'cutoff_passed' },
      { orderId: 'o3', outcome: 'failed', code: 'PICKUP_NOT_ENABLED' },
      { orderId: 'o4', outcome: 'skipped', rule: BulkSkipRules.NOT_WAITING_FOR_PICKUP }
    ])
  })

  it('never hides a refusal behind the success of another guide of the order', () => {
    const targets = [guide('s1', 'o1'), guide('s2', 'o1', { connectionId: 'c2' })]
    const report = pickupReport(['o1'], targets, [
      {
        connectionId: 'c1',
        shipmentIds: ['s1'],
        result: {
          pickup: {
            id: 'p',
            connectionId: 'c1',
            connectionName: 'X',
            pickupDate: '2026-11-13',
            status: 'pending',
            packageCount: 1
          },
          created: true,
          joined: [],
          waiting: []
        }
      },
      { connectionId: 'c2', shipmentIds: ['s2'], result: { code: 'PICKUP_NOT_ENABLED' } }
    ])
    expect(report.entries).toEqual([
      { orderId: 'o1', outcome: 'failed', code: 'PICKUP_NOT_ENABLED' }
    ])
  })
})

describe('summaryReport', () => {
  it('counts a sent and a repeated press as done and names why a message did not go', () => {
    const report = summaryReport([
      { orderId: 'o1', outcome: { status: OrderMessageOutcomeStatus.SENT } },
      { orderId: 'o2', outcome: { status: OrderMessageOutcomeStatus.DUPLICATE } },
      {
        orderId: 'o3',
        outcome: { status: OrderMessageOutcomeStatus.NOT_SENT, reason: 'window_closed' }
      },
      { orderId: 'o4', outcome: { status: OrderMessageOutcomeStatus.SKIPPED } },
      { orderId: 'o5', code: 'FORBIDDEN' }
    ])
    expect(report.entries).toEqual([
      { orderId: 'o1', outcome: 'done' },
      { orderId: 'o2', outcome: 'done' },
      { orderId: 'o3', outcome: 'skipped', reason: 'window_closed' },
      { orderId: 'o4', outcome: 'skipped', reason: undefined },
      { orderId: 'o5', outcome: 'failed', code: 'FORBIDDEN' }
    ])
    expect(report.action).toBe(BulkActionKinds.SUMMARY)
  })
})

describe('jobProgress', () => {
  it('is the share of settled orders and never passes 1', () => {
    expect(jobProgress({ total: 4, succeeded: 1, failed: 1 })).toBe(0.5)
    expect(jobProgress({ total: 0, succeeded: 0, failed: 0 })).toBe(0)
    expect(jobProgress({ total: 2, succeeded: 3, failed: 0 })).toBe(1)
  })
})
