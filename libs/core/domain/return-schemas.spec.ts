import { approveReturnSchema, replacementOrderSchema } from './return-schemas'
import { PaymentMethod } from './status-enums'

const replacement = {
  items: [{ productId: '4f8c8a54-3b0f-4a52-9a44-0a2b6f9d6a11', quantity: 2 }],
  paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
  recipientPhones: ['71234567']
}

describe('replacementOrderSchema', () => {
  it('takes what the agent picks and fills in the fee and the date', () => {
    const parsed = replacementOrderSchema.parse(replacement)
    expect(parsed.shippingCents).toBe(0)
    expect(parsed.scheduledDeliveryDate).toBeNull()
  })

  it("has no key for a discount, a customer, a status or a store: the credit is the system's", () => {
    for (const extra of [
      { discountCents: 100 },
      { discountReason: 'friend' },
      { customerId: '4f8c8a54-3b0f-4a52-9a44-0a2b6f9d6a11' },
      { confirmOnCreate: true },
      { storeId: 'x' }
    ]) {
      expect(replacementOrderSchema.safeParse({ ...replacement, ...extra }).success).toBe(false)
    }
  })
})

describe('a line of the replacement', () => {
  const line = replacement.items[0]

  it('has no price, no reason for a price and no warehouses', () => {
    for (const extra of [
      { unitPriceCents: 1 },
      { priceReason: 'friend' },
      { allocations: [{ warehouseId: 'w', quantity: 2 }] }
    ]) {
      expect(
        replacementOrderSchema.safeParse({ ...replacement, items: [{ ...line, ...extra }] }).success
      ).toBe(false)
    }
  })

  it('names a product once, with a variant or without', () => {
    expect(replacementOrderSchema.safeParse({ ...replacement, items: [line, line] }).success).toBe(
      false
    )
    expect(replacementOrderSchema.safeParse({ ...replacement, items: [] }).success).toBe(false)
    const variant = { ...line, variantId: '5a8c8a54-3b0f-4a52-9a44-0a2b6f9d6a22' }
    expect(
      replacementOrderSchema.safeParse({ ...replacement, items: [line, variant] }).success
    ).toBe(true)
  })
})

describe('approveReturnSchema', () => {
  it('takes no replacement for a refund and one for an exchange', () => {
    expect(approveReturnSchema.parse({})).toEqual({})
    expect(approveReturnSchema.parse({ replacement }).replacement?.items).toHaveLength(1)
  })

  it('refuses any other key', () => {
    expect(approveReturnSchema.safeParse({ status: 'approved' }).success).toBe(false)
  })
})
