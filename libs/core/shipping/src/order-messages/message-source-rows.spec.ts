import { orderMessageSourceOf, type OrderMessageRows } from './message-source-rows'

const rows = (over: Partial<OrderMessageRows> = {}): OrderMessageRows => ({
  orderNumber: 'ORD-1',
  totalCents: 2500,
  currency: 'USD',
  shippingAddress: { line1: '1 Main St', city: 'San Salvador', country: 'SV' },
  scheduledDeliveryDate: null,
  trackingNumber: null,
  storeName: 'Casa Luz',
  customerName: 'Ana',
  items: [{ productName: 'Candle', variantName: 'Large', quantity: 2, unitPriceCents: 1000 }],
  shipment: null,
  ...over
})

describe('orderMessageSourceOf', () => {
  it('takes the figures of the order and the name of the store and the customer', () => {
    const source = orderMessageSourceOf(rows())
    expect(source).toMatchObject({
      orderNumber: 'ORD-1',
      totalCents: 2500,
      currency: 'USD',
      storeName: 'Casa Luz',
      customerName: 'Ana',
      carrierName: null,
      trackingUrl: null,
      codAmountCents: null,
      failedAttempts: null,
      maxAttempts: null,
      scheduledDeliveryDate: null
    })
    expect(source.items).toEqual([
      { name: 'Candle', variantLabel: 'Large', quantity: 2, unitPriceCents: 1000 }
    ])
    expect(source.shippingAddress).toEqual({
      line1: '1 Main St',
      city: 'San Salvador',
      country: 'SV'
    })
  })

  it('takes the carrier, the guide and the attempts from the package', () => {
    const source = orderMessageSourceOf(
      rows({
        shipment: {
          carrierName: 'Forza',
          guideNumber: 'G-77',
          trackingUrl: 'https://track.example/G-77',
          failedAttempts: 2,
          maxDeliveryAttempts: 3,
          codAmountCents: 2500
        }
      })
    )
    expect(source).toMatchObject({
      carrierName: 'Forza',
      trackingNumber: 'G-77',
      trackingUrl: 'https://track.example/G-77',
      failedAttempts: 2,
      maxAttempts: 3,
      codAmountCents: 2500
    })
  })

  it('falls back to the tracking number the order holds when the package has no guide', () => {
    const source = orderMessageSourceOf(
      rows({
        trackingNumber: 'T-1',
        shipment: {
          carrierName: 'Local',
          guideNumber: null,
          trackingUrl: null,
          failedAttempts: 0,
          maxDeliveryAttempts: 3,
          codAmountCents: null
        }
      })
    )
    expect(source.trackingNumber).toBe('T-1')
  })

  it('takes a blank guide for no guide, so the variable is missing and never empty', () => {
    const shipment = {
      carrierName: 'Forza',
      guideNumber: '  ',
      trackingUrl: null,
      failedAttempts: 0,
      maxDeliveryAttempts: 3,
      codAmountCents: null
    }
    expect(orderMessageSourceOf(rows({ shipment })).trackingNumber).toBeNull()
    expect(orderMessageSourceOf(rows({ shipment, trackingNumber: 'T-9' })).trackingNumber).toBe(
      'T-9'
    )
  })

  it('has no items and no tracking number when the order has none', () => {
    const source = orderMessageSourceOf(rows({ items: [] }))
    expect(source.items).toEqual([])
    expect(source.trackingNumber).toBeNull()
  })

  it('leaves an address that no longer has the shape of the schema out, so its variable is missing', () => {
    const source = orderMessageSourceOf(rows({ shippingAddress: { street: 'old shape' } }))
    expect(source.shippingAddress).toBeNull()
  })

  it('leaves the address out for an order that has none', () => {
    expect(orderMessageSourceOf(rows({ shippingAddress: null })).shippingAddress).toBeNull()
  })

  it('keeps the day of a scheduled delivery as it is', () => {
    const day = new Date('2026-11-12T00:00:00.000Z')
    expect(
      orderMessageSourceOf(rows({ scheduledDeliveryDate: day })).scheduledDeliveryDate
    ).toEqual(day)
  })
})
