import { type OrderCopyDraft, PaymentMethod } from '@platform/core/domain'

import {
  type OrderDetailView,
  pluginCopyView,
  pluginCreatedView,
  pluginDetailView,
  pluginPageView
} from './orders.views'

const NOW = new Date('2026-11-15T12:00:00.000Z')

function detail(): OrderDetailView {
  return {
    id: 'order-1',
    orderNumber: 'T-1',
    customerId: 'customer-1',
    status: 'PENDING_CONFIRMATION',
    subtotalCents: 1999,
    shippingCents: 0,
    discountCents: 0,
    totalCents: 1999,
    taxCents: null,
    pricesIncludeTax: null,
    shippingTaxRateBps: null,
    currency: 'USD',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    priceApprovalStatus: 'not_required',
    freeShipping: false,
    scheduledDeliveryDate: null,
    createdAt: NOW,
    updatedAt: NOW,
    customer: {
      id: 'customer-1',
      name: 'Ana',
      email: null,
      phone: null,
      nationalPhone: null,
      isCaution: false
    },
    conversationId: null,
    paymentReference: null,
    paymentProofMediaId: null,
    shippingAddress: null,
    customerNotes: 'leave it at the door',
    internalNotes: 'the internal note',
    packingNotes: 'the packing note',
    recipientPhones: [],
    trackingNumber: null,
    cancellationReason: null,
    cancelledBy: null,
    cancelledByPluginId: null,
    cancelledAt: null,
    proofOfDeliveryMediaId: null,
    confirmedAt: null,
    confirmedBy: null,
    confirmedByPluginId: null,
    confirmedVia: null,
    copiedFromOrderId: null,
    discountReason: null,
    priceApprovalRequestedBy: null,
    priceApprovalRequestedByPluginId: null,
    priceApprovedBy: null,
    priceApprovedByPluginId: null,
    priceApprovedAt: null,
    priceApprovedDiscountCents: null,
    priceApprovedShippingCents: null,
    createdBy: 'user-1',
    createdByPluginId: null,
    shippedAt: null,
    deliveredAt: null,
    items: [],
    priceModified: false
  }
}

const ALLOWED_DETAIL = [
  'cancelledAt',
  'confirmedAt',
  'createdAt',
  'currency',
  'discountCents',
  'freeShipping',
  'id',
  'items',
  'orderNumber',
  'paymentMethod',
  'paymentStatus',
  'priceApprovalStatus',
  'scheduledDeliveryDate',
  'shippingCents',
  'status',
  'subtotalCents',
  'totalCents',
  'updatedAt'
]

describe('the order as a plugin reads it', () => {
  it('answers the fields of the allowlist and no other', () => {
    const view = pluginDetailView(detail())

    expect(Object.keys(view).sort()).toEqual(ALLOWED_DETAIL)
    expect(view.totalCents).toBe(1999)
  })

  it('holds back a column the detail gains later, until a scope opens it', () => {
    const grown = { ...detail(), riskScore: 9, items: [] }

    expect(pluginDetailView(grown)).not.toHaveProperty('riskScore')
  })

  it('leaves out the notes, the customer, the people of the team and the ids of products', () => {
    const text = JSON.stringify(
      pluginDetailView({
        ...detail(),
        confirmedBy: 'user-2',
        createdBy: null,
        createdByPluginId: 'plugin-9',
        confirmedByPluginId: 'plugin-8',
        items: [
          {
            id: 'item-1',
            productId: 'product-1',
            variantId: 'variant-1',
            productName: 'Shirt',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            originalUnitPriceCents: 1500,
            priceOverrideReason: 'a favour',
            priceOverriddenBy: 'user-3',
            freeShipping: false,
            taxTreatment: null,
            taxRateBps: null,
            taxCents: null,
            allocations: [{ warehouseId: 'warehouse-1', quantity: 2 }]
          }
        ]
      })
    )

    for (const secret of [
      'the internal note',
      'the packing note',
      'leave it at the door',
      'Ana',
      'customer-1',
      'user-1',
      'user-2',
      'user-3',
      'plugin-9',
      'plugin-8',
      'product-1',
      'variant-1',
      'a favour',
      'warehouse-1'
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('Shirt')
  })

  it('answers a page of orders as summaries without the customer or the carrier', () => {
    const page = pluginPageView({
      data: [
        {
          ...pluginDetailView(detail()),
          customerId: 'customer-1',
          carrierConnectionId: 'carrier-1',
          priceApprovalStatus: 'not_required',
          priceModified: false,
          customer: { id: 'customer-1', name: 'Ana', isCaution: true }
        }
      ],
      nextCursor: null,
      hasMore: false
    })

    const text = JSON.stringify(page)
    expect(text).not.toContain('Ana')
    expect(text).not.toContain('carrier-1')
    expect(text).not.toContain('customer-1')
    expect(page.data[0]?.orderNumber).toBe('T-1')
  })
})

describe('the answer of a creation and the draft of a copy for a plugin', () => {
  it('answers the allowlisted order and the notices, nothing of the person or the plugin that made it', () => {
    const created = pluginCreatedView({
      order: { ...detail(), createdBy: null, createdByPluginId: 'plugin-9' },
      notices: ['confirmation_skipped_price_approval']
    })

    expect(Object.keys(created.order).sort()).toEqual(ALLOWED_DETAIL)
    expect(created.notices).toEqual(['confirmation_skipped_price_approval'])
    expect(JSON.stringify(created)).not.toContain('plugin-9')
  })

  it('leaves out the internal and packing notes and the note of the customer from the draft', () => {
    const draft: OrderCopyDraft = {
      draft: {
        customerId: 'customer-1',
        items: [{ productId: 'product-1', quantity: 1 }],
        shippingCents: 0,
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        recipientPhones: ['71234567'],
        customerNotes: 'leave it at the door',
        internalNotes: 'the internal note',
        packingNotes: 'the packing note',
        copiedFromOrderId: 'order-1'
      },
      lines: [],
      warnings: []
    }

    const view = pluginCopyView(draft)

    expect(Object.keys(view.draft).sort()).toEqual([
      'customerId',
      'items',
      'paymentMethod',
      'recipientPhones',
      'shippingAddress',
      'shippingCents'
    ])
    const text = JSON.stringify(view)
    for (const secret of ['the internal note', 'the packing note', 'leave it at the door']) {
      expect(text).not.toContain(secret)
    }
  })
})
