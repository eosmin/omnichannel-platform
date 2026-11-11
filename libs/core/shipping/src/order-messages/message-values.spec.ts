import { OrderMessageVariables } from '@platform/core/domain'
import { Locales } from '@platform/core/i18n'

import { renderOrderMessage } from './message-template'
import {
  buildOrderMessageValues,
  formatAddress,
  formatItemsList,
  formatLongDate,
  formatMoney,
  type OrderMessageSource
} from './message-values'

const SOURCE: OrderMessageSource = {
  customerName: 'Ana',
  orderNumber: 'A-1',
  items: [
    { name: 'Shoe', variantLabel: 'Size 40', quantity: 2, unitPriceCents: 1000 },
    { name: 'Sock', variantLabel: null, quantity: 1, unitPriceCents: 250 }
  ],
  totalCents: 2250,
  currency: 'USD',
  shippingAddress: { line1: 'Calle 5', city: 'Santa Tecla', state: 'La Libertad', country: 'SV' },
  carrierName: 'Courier',
  trackingNumber: 'GU-1',
  trackingUrl: 'https://example.com/t/GU-1',
  storeName: 'Shop',
  codAmountCents: 2250,
  failedAttempts: 2,
  maxAttempts: 3,
  scheduledDeliveryDate: new Date(Date.UTC(2026, 9, 28))
}

describe('formatting', () => {
  it('writes money in the currency of the order and the language of the customer', () => {
    expect(formatMoney(1050, 'USD', Locales.EN)).toBe('$10.50')
    expect(formatMoney(1050, 'USD', Locales.ES)).toMatch(/10[.,]50/u)
  })

  it('writes the day long, without a comma after the weekday and without shifting it by a timezone', () => {
    expect(formatLongDate(new Date(Date.UTC(2026, 9, 28)), Locales.ES)).toBe(
      'miércoles 28 de octubre'
    )
    // English keeps the comma of its own way of writing the date
    expect(formatLongDate(new Date(Date.UTC(2026, 9, 28)), Locales.EN)).toBe(
      'Wednesday, October 28'
    )
  })

  it('writes one line per item with the price of the line', () => {
    expect(formatItemsList(SOURCE.items, 'USD', Locales.EN)).toBe(
      '2 × Shoe (Size 40) — $20.00\n1 × Sock — $2.50'
    )
  })

  it('joins the parts of an address that exist', () => {
    expect(
      formatAddress({ line1: 'A', line2: 'B', city: 'C', postalCode: '1', country: 'SV' })
    ).toBe('A, B, C, 1, SV')
    expect(formatAddress({ line1: 'A', city: 'C', country: 'SV' })).toBe('A, C, SV')
  })
})

describe('buildOrderMessageValues', () => {
  it('gives every variable a value for a complete order', () => {
    const values = buildOrderMessageValues(SOURCE, Locales.EN)
    expect(Object.keys(values).sort()).toEqual(Object.values(OrderMessageVariables).sort())
    expect(values.attemptNumber).toBe('2')
  })

  it('leaves out what the order does not have, so an order without a date cannot render a template that uses it', () => {
    const values = buildOrderMessageValues(
      { ...SOURCE, scheduledDeliveryDate: null, trackingNumber: ' ', codAmountCents: null },
      Locales.EN
    )
    expect(values.scheduledDeliveryDate).toBeUndefined()
    expect(values.trackingNumber).toBeUndefined()
    expect(values.codAmount).toBeUndefined()
    expect(renderOrderMessage('Arrives {{scheduledDeliveryDate}}', values)).toEqual({
      ok: false,
      reason: 'missing_variable',
      missing: ['scheduledDeliveryDate']
    })
    expect(renderOrderMessage('Order {{orderNumber}}', values)).toEqual({
      ok: true,
      text: 'Order A-1'
    })
  })
})
