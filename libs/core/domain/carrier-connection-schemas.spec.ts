import {
  connectCarrierSchema,
  shippingFeeRangeProblem,
  updateCarrierSchema
} from './carrier-connection-schemas'

const base = { carrierId: 'local', credentials: { name: 'a' } }

describe('connectCarrierSchema', () => {
  it('accepts the text of an escape that is not a NUL, and refuses a real NUL in a text or a key', () => {
    expect(
      connectCarrierSchema.safeParse({ ...base, credentials: { pattern: String.raw`\u0000` } })
        .success
    ).toBe(true)
    expect(
      connectCarrierSchema.safeParse({ ...base, credentials: { a: 'x\u0000y' } }).success
    ).toBe(false)
    expect(connectCarrierSchema.safeParse({ ...base, credentials: { 'k\u0000': 1 } }).success).toBe(
      false
    )
    expect(
      connectCarrierSchema.safeParse({ ...base, credentials: { a: [{ b: 'z\u0000' }] } }).success
    ).toBe(false)
  })

  it('bounds the size of the credentials', () => {
    expect(
      connectCarrierSchema.safeParse({ ...base, credentials: { a: 'x'.repeat(9000) } }).success
    ).toBe(false)
  })

  it('refuses a store, an unknown carrier, a bad fee range, repeated days and a pickup rule that breaks the table', () => {
    for (const over of [
      { storeId: 'x' },
      { carrierId: 'ups' },
      { minShippingFeeCents: 5, maxShippingFeeCents: 1 },
      { pickupDays: [1, 1] },
      { pickupEnabled: true, pickupDays: [] }
    ]) {
      expect(connectCarrierSchema.safeParse({ ...base, ...over }).success).toBe(false)
    }
  })
})

describe('updateCarrierSchema and the fee rule', () => {
  it('takes services to edit and refuses a status', () => {
    expect(
      updateCarrierSchema.safeParse({ services: [{ code: 'a', active: false }] }).success
    ).toBe(true)
    expect(updateCarrierSchema.safeParse({ status: 'active' }).success).toBe(false)
  })

  it('names the first problem of a fee range, and none when it holds', () => {
    expect(shippingFeeRangeProblem({})).toBeNull()
    expect(shippingFeeRangeProblem({ minShippingFeeCents: 3, maxShippingFeeCents: 2 })).toMatch(
      /minimum/
    )
    expect(shippingFeeRangeProblem({ defaultShippingFeeCents: 9, maxShippingFeeCents: 2 })).toMatch(
      /maximum/
    )
  })
})
