import { guideAffectingChanges, type GuideSource } from './shipment-cancel-rules'
import { GuideAffectingFields } from './shipping-constants'
import { PaymentMethod } from './status-enums'

const base: GuideSource = {
  address: { line1: 'Calle 1', city: 'San Salvador', country: 'SV' },
  recipientPhones: ['70001111'],
  paymentMethod: PaymentMethod.TRANSFER,
  items: [
    { productId: 'p1', variantId: null, quantity: 2 },
    { productId: 'p2', variantId: 'v1', quantity: 1 }
  ],
  totalCents: 5000
}

describe('guideAffectingChanges (TDD_17 §4.8)', () => {
  it('finds nothing in an order that is the same', () => {
    expect(guideAffectingChanges(base, { ...base })).toEqual([])
  })

  it('reads the address the same whatever the order of its keys, and a missing key as no key', () => {
    const reordered = { line1: 'Calle 1', country: 'SV', city: 'San Salvador', note: undefined }
    expect(guideAffectingChanges(base, { ...base, address: reordered })).toEqual([])
  })

  it('finds an address that changed, one that was added and one that was removed', () => {
    const moved = { ...base, address: { ...(base.address as object), line1: 'Calle 2' } }
    expect(guideAffectingChanges(base, moved)).toEqual([GuideAffectingFields.ADDRESS])
    expect(guideAffectingChanges({ ...base, address: null }, base)).toEqual([
      GuideAffectingFields.ADDRESS
    ])
    expect(guideAffectingChanges(base, { ...base, address: null })).toEqual([
      GuideAffectingFields.ADDRESS
    ])
  })

  it('finds the phones that changed, and takes no phones and an empty list as the same', () => {
    expect(guideAffectingChanges(base, { ...base, recipientPhones: ['70002222'] })).toEqual([
      GuideAffectingFields.RECIPIENT_PHONES
    ])
    expect(
      guideAffectingChanges({ ...base, recipientPhones: null }, { ...base, recipientPhones: [] })
    ).toEqual([])
  })

  it('finds the payment method that changed', () => {
    expect(guideAffectingChanges(base, { ...base, paymentMethod: PaymentMethod.CARD })).toEqual([
      GuideAffectingFields.PAYMENT_METHOD
    ])
  })

  it('reads the lines as a set: a new order of the same lines is nothing, a new quantity or variant is a change', () => {
    const [first, second] = base.items
    if (first === undefined || second === undefined) throw new Error('fixture')
    expect(guideAffectingChanges(base, { ...base, items: [second, first] })).toEqual([])
    expect(
      guideAffectingChanges(base, { ...base, items: [{ ...first, quantity: 3 }, second] })
    ).toEqual([GuideAffectingFields.ITEMS])
    expect(
      guideAffectingChanges(base, { ...base, items: [first, { ...second, variantId: 'v2' }] })
    ).toEqual([GuideAffectingFields.ITEMS])
    expect(guideAffectingChanges(base, { ...base, items: [first] })).toEqual([
      GuideAffectingFields.ITEMS
    ])
  })

  it('counts a new total only where the carrier collects it', () => {
    expect(guideAffectingChanges(base, { ...base, totalCents: 6000 })).toEqual([])
    const cod = { ...base, paymentMethod: PaymentMethod.CASH_ON_DELIVERY }
    expect(guideAffectingChanges(cod, { ...cod, totalCents: 6000 })).toEqual([
      GuideAffectingFields.COD_TOTAL
    ])
    // Turning an order into cash on delivery changes the method and what is collected
    expect(guideAffectingChanges(base, { ...cod, totalCents: 6000 })).toEqual([
      GuideAffectingFields.PAYMENT_METHOD,
      GuideAffectingFields.COD_TOTAL
    ])
  })
})
