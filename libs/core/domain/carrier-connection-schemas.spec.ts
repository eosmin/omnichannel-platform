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

  it('refuses a body nested so deep that walking it would overflow the stack, as a validation error', () => {
    let deep: unknown = 'x'
    for (let level = 0; level < 50_000; level += 1) deep = [deep]
    expect(connectCarrierSchema.safeParse({ ...base, credentials: { a: deep } }).success).toBe(
      false
    )
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

describe('commission and rates of a connection', () => {
  it('takes the commission as whole basis points and the rates as whole cents per service code', () => {
    const ok = connectCarrierSchema.safeParse({
      ...base,
      commissionBps: 450,
      serviceRatesCents: { CCE: 300, SEC: 0 }
    })
    expect(ok.success).toBe(true)
    expect(
      updateCarrierSchema.safeParse({ commissionBps: null, serviceRatesCents: null }).success
    ).toBe(true)
  })
  it('refuses a fraction, a negative, an amount over the limit and a code that is not one', () => {
    const bad = (body: Record<string, unknown>) => updateCarrierSchema.safeParse(body).success
    expect(bad({ commissionBps: 4.5 })).toBe(false)
    expect(bad({ commissionBps: -1 })).toBe(false)
    expect(bad({ commissionBps: 5001 })).toBe(false)
    expect(bad({ serviceRatesCents: { CCE: 1.5 } })).toBe(false)
    expect(bad({ serviceRatesCents: { CCE: -1 } })).toBe(false)
    expect(bad({ serviceRatesCents: { CCE: 100_000_001 } })).toBe(false)
    expect(bad({ serviceRatesCents: { 'not a code': 1 } })).toBe(false)
    expect(bad({ serviceRatesCents: { '': 1 } })).toBe(false)
  })
  it('bounds how many rates a body can carry', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`S${i}`, 1]))
    expect(updateCarrierSchema.safeParse({ serviceRatesCents: many }).success).toBe(false)
  })
})
