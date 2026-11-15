import { ShipmentStatus } from '@platform/core/domain'

import {
  pluginShipmentDetail,
  pluginShipmentPage,
  pluginShipmentView
} from './plugin-shipments.views'
import type { ShipmentDetailView, ShipmentView } from './shipments.views'

const shipment = (over: Partial<ShipmentView> = {}): ShipmentView => ({
  id: 's-1',
  orderId: 'o-1',
  orderNumber: 'ORD-1',
  connectionId: 'c-1',
  connectionName: 'Courier',
  carrierId: 'carrier-x',
  kind: 'OUTBOUND',
  returnId: null,
  originWarehouseId: null,
  status: ShipmentStatus.LABEL_CREATED,
  serviceCode: 'local',
  shippingPayer: 'SENDER',
  codAmountCents: 5000,
  codStatus: 'NOT_DELIVERED',
  codExpectedCents: 4100,
  codRemittedCents: 4000,
  codRemittanceId: 'rem-1',
  deliveredAt: null,
  currency: 'USD',
  packageCount: 1,
  failedAttempts: 0,
  guideNumber: 'G-1',
  trackingUrl: null,
  hasLabel: true,
  carrierCostCents: 900,
  refundStatus: 'NONE',
  pickupId: null,
  lastError: null,
  cancelRequestedAt: null,
  cancelledAt: null,
  createdBy: 'user-staff-1',
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
  ...over
})

const MONEY_AND_PEOPLE = [
  'carrierCostCents',
  'codExpectedCents',
  'codRemittedCents',
  'codRemittanceId',
  'createdBy'
]

describe('the shipments a plugin reads', () => {
  it('drops the money of the carrier and the id of the person who made the guide', () => {
    const view = pluginShipmentView(shipment())

    for (const key of MONEY_AND_PEOPLE) expect(key in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('user-staff')
  })

  it('keeps what a plugin follows: status, guide, tracking, cash to collect', () => {
    expect(
      pluginShipmentView(shipment({ guideNumber: 'G-9', codAmountCents: 1200 }))
    ).toMatchObject({
      id: 's-1',
      status: ShipmentStatus.LABEL_CREATED,
      guideNumber: 'G-9',
      codAmountCents: 1200,
      hasLabel: true
    })
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...shipment(), storeId: 'store-1', idempotencyKey: 'k-secret' }

    expect(Object.keys(pluginShipmentView(extra)).sort()).toEqual(
      Object.keys(pluginShipmentView(shipment())).sort()
    )
    expect(JSON.stringify(pluginShipmentView(extra))).not.toContain('k-secret')
  })

  it('answers a detail with its history and a page with its cursor, both without the money', () => {
    const detail: ShipmentDetailView = {
      ...shipment(),
      events: [
        {
          id: 'e-1',
          status: ShipmentStatus.LABEL_CREATED,
          rawStatus: null,
          description: null,
          occurredAt: '2026-11-14T00:00:00.000Z',
          source: 'SYSTEM'
        }
      ]
    }

    const view = pluginShipmentDetail(detail)
    const page = pluginShipmentPage({ data: [shipment()], nextCursor: 'c', hasMore: true })

    expect(view.events).toHaveLength(1)
    expect(Object.keys(view.events[0] ?? {}).sort()).toEqual([
      'description',
      'id',
      'occurredAt',
      'rawStatus',
      'source',
      'status'
    ])
    expect(page.nextCursor).toBe('c')
    expect(page.hasMore).toBe(true)
    for (const text of [JSON.stringify(view), JSON.stringify(page)]) {
      for (const key of MONEY_AND_PEOPLE) expect(text).not.toContain(key)
    }
  })
})
