import type { OrderCopyView } from '@platform/api-client'
import { OrderCopyWarnings, PaymentMethod } from '@platform/core/domain'

import { copySeedOf, copyWarningRows } from './order-copy'

function copy(overrides: Partial<OrderCopyView> = {}): OrderCopyView {
  return {
    draft: {
      customerId: 'c1',
      items: [{ productId: 'p1', quantity: 2 }],
      shippingCents: 500,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      recipientPhones: ['71234567'],
      customerNotes: 'Ring twice',
      internalNotes: 'Careful',
      packingNotes: 'Wrap it',
      shippingAddress: { line1: 'Main 1', city: 'Town', country: 'SV' },
      copiedFromOrderId: 'o1'
    },
    lines: [
      {
        productId: 'p1',
        variantId: null,
        productName: 'Shirt',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1200,
        previousUnitPriceCents: 1000
      }
    ],
    warnings: [],
    ...overrides
  }
}

describe('copySeedOf', () => {
  it('starts the form from the draft at the catalog price, with no typed price', () => {
    const seed = copySeedOf(copy())
    expect(seed.customerId).toBe('c1')
    expect(seed.copiedFromOrderId).toBe('o1')
    expect(seed.shippingText).toBe('5.00')
    expect(seed.phones).toEqual(['71234567'])
    expect(seed.customerNotes).toBe('Ring twice')
    expect(seed.internalNotes).toBe('Careful')
    expect(seed.packingNotes).toBe('Wrap it')
    expect(seed.shippingAddress).toEqual({ line1: 'Main 1', city: 'Town', country: 'SV' })
    expect(seed.paymentMethod).toBe(PaymentMethod.CASH_ON_DELIVERY)
    expect(seed.lines).toEqual([
      expect.objectContaining({
        productId: 'p1',
        quantity: '2',
        catalogPriceCents: 1200,
        priceText: null,
        allocations: null
      })
    ])
  })

  it('leaves the fee empty when it was free and offers one phone field when there were none', () => {
    const seed = copySeedOf(
      copy({ draft: { ...copy().draft, shippingCents: 0, recipientPhones: [] } })
    )
    expect(seed.shippingText).toBe('')
    expect(seed.phones).toEqual([''])
  })

  it('draws a line the catalog cannot price with the price it was sold at', () => {
    const seed = copySeedOf(
      copy({ lines: copy().lines.map(line => ({ ...line, unitPriceCents: null })) })
    )
    expect(seed.lines[0]?.catalogPriceCents).toBe(1000)
  })
})

describe('copyWarningRows', () => {
  it('names the line of each warning and the two prices of a change', () => {
    const rows = copyWarningRows(
      copy({
        warnings: [
          { code: OrderCopyWarnings.PRICE_CHANGED, itemIndex: 0, productId: 'p1', variantId: null }
        ]
      })
    )
    expect(rows).toEqual([
      {
        code: OrderCopyWarnings.PRICE_CHANGED,
        productName: 'Shirt',
        variantName: null,
        previousCents: 1000,
        currentCents: 1200
      }
    ])
  })

  it('lists the warnings in the order of the lines', () => {
    const rows = copyWarningRows(
      copy({
        lines: copy().lines.flatMap(row => [row, { ...row, productName: 'Hat' }]),
        warnings: [
          { code: OrderCopyWarnings.OUT_OF_STOCK, itemIndex: 1, productId: 'p1', variantId: null },
          {
            code: OrderCopyWarnings.PRODUCT_INACTIVE,
            itemIndex: 0,
            productId: 'p1',
            variantId: null
          }
        ]
      })
    )
    expect(rows.map(row => row.productName)).toEqual(['Shirt', 'Hat'])
  })

  it('keeps a code it does not know, with no prices, and drops a warning of a line that is not there', () => {
    const rows = copyWarningRows(
      copy({
        warnings: [
          { code: 'from_the_future', itemIndex: 0, productId: 'p1', variantId: null },
          { code: OrderCopyWarnings.OUT_OF_STOCK, itemIndex: 9, productId: 'x', variantId: null }
        ]
      })
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: null, previousCents: null, currentCents: null })
  })
})
