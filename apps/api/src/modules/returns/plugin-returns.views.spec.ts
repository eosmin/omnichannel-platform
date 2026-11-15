import type {
  OrderReturnCondition,
  OrderReturnStatus,
  OrderReturnType
} from '@platform/core/domain'

import {
  pluginReceptionBatchSummaryView,
  pluginReceptionBatchView,
  pluginReturnPage,
  pluginReturnView
} from './plugin-returns.views'
import type { ReceptionBatchView, ReceptionItemView } from './return-reception.views'
import type { ReturnView } from './returns.views'

const view = (over: Partial<ReturnView> = {}): ReturnView => ({
  id: 'r-1',
  orderId: 'o-1',
  orderNumber: '00041',
  type: 'refund' as OrderReturnType,
  reason: 'DEFECTIVE',
  status: 'requested' as OrderReturnStatus,
  shippingPayer: 'sender',
  replacementOrderId: null,
  returnShipmentId: null,
  refundAmountCents: 1500,
  notes: null,
  createdBy: 'user-staff-1',
  createdAt: '2026-11-15T00:00:00.000Z',
  receivedAt: null,
  lines: [
    {
      id: 'l-1',
      orderItemId: 'i-1',
      productName: 'Shirt',
      variantName: null,
      quantity: 1,
      condition: 'new' as OrderReturnCondition,
      restockWarehouseId: null
    }
  ],
  ...over
})

const item = (over: Partial<ReceptionItemView> = {}): ReceptionItemView =>
  ({
    id: 'it-1',
    shipmentId: 's-1',
    guideNumber: 'G-1',
    shipmentStatus: 'returning',
    orderId: 'o-1',
    orderNumber: '00041',
    orderItems: [],
    customerIsCaution: true,
    reason: 'DELIVERY_FAILED',
    condition: 'new',
    note: null,
    lines: [],
    flagCustomer: true,
    flagReason: 'rude to the courier',
    confirmDelivered: false,
    outcome: null,
    errorCode: null,
    returnId: null,
    flagApplied: true,
    scannedAt: '2026-11-15T00:00:00.000Z',
    ...over
  }) as ReceptionItemView

const batch = (): ReceptionBatchView => ({
  id: 'b-1',
  status: 'draft',
  createdBy: 'user-staff-2',
  createdAt: '2026-11-15T00:00:00.000Z',
  completedAt: null,
  cautionPreselected: true,
  counts: { total: 1, received: 0, failed: 0, pending: 1 },
  items: [item()]
})

describe('the returns a plugin reads', () => {
  it('drops the id of the person who made the return', () => {
    const out = pluginReturnView(view())

    expect('createdBy' in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain('user-staff')
    expect(out.refundAmountCents).toBe(1500)
    expect(out.lines).toHaveLength(1)
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...view(), internalCost: 99 }

    expect(Object.keys(pluginReturnView(extra)).sort()).toEqual(
      Object.keys(pluginReturnView(view())).sort()
    )
  })

  it('keeps the paging of a page and cleans each row', () => {
    const page = pluginReturnPage({
      data: [view(), view({ id: 'r-2' })],
      nextCursor: 'c',
      hasMore: true
    })

    expect(page.nextCursor).toBe('c')
    expect(page.hasMore).toBe(true)
    expect(JSON.stringify(page)).not.toContain('createdBy')
  })
})

describe('the reception batches a plugin reads', () => {
  it('drops who opened the batch and what only steers the editor of the scanner', () => {
    const out = pluginReceptionBatchView(batch())

    expect('createdBy' in out).toBe(false)
    expect('cautionPreselected' in out).toBe(false)
    expect(out.counts.total).toBe(1)
  })

  it('drops every flag on the customer from the packages', () => {
    const out = pluginReceptionBatchView(batch())
    const text = JSON.stringify(out)

    expect(text).not.toMatch(/flagCustomer|flagReason|flagApplied|customerIsCaution|rude/)
    expect(out.items[0]?.guideNumber).toBe('G-1')
  })

  it('drops who opened a batch from the list too', () => {
    const full = batch()
    const summary = { ...full, items: undefined, cautionPreselected: undefined } as never
    const out = pluginReceptionBatchSummaryView(summary)

    expect('createdBy' in out).toBe(false)
    expect(out.id).toBe('b-1')
  })

  it('names the fields of a package, a batch and a line one by one, so a new column does not reach a plugin', () => {
    const extraItem = {
      ...item({
        orderItems: [
          { id: 'i-1', productName: 'Shirt', variantName: null, quantity: 1, cost: 9 } as never
        ],
        lines: [{ orderItemId: 'i-1', quantity: 1, condition: 'new', secret: 'x' } as never]
      }),
      internal: 'x'
    }
    const out = pluginReceptionBatchView({ ...batch(), items: [extraItem], extra: 'x' } as never)

    expect(Object.keys(out).sort()).toEqual(Object.keys(pluginReceptionBatchView(batch())).sort())
    expect(JSON.stringify(out)).not.toMatch(/internal|secret|"cost"|"extra"/)
    const line = pluginReturnView(view({ lines: [{ ...view().lines[0], cost: 9 } as never] }))
      .lines[0]
    expect(Object.keys(line ?? {})).not.toContain('cost')
  })
})
