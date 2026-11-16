import {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  purchaseIdempotencyKey,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentSchema
} from './purchase-schemas'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('the bodies of the purchase routes', () => {
  it('take a key of 8 to 100 safe characters and nothing else', () => {
    expect(purchaseIdempotencyKey.safeParse('a-key-0001').success).toBe(true)
    expect(purchaseIdempotencyKey.safeParse('short').success).toBe(false)
    expect(purchaseIdempotencyKey.safeParse('has a space in it').success).toBe(false)
    expect(purchaseIdempotencyKey.safeParse('x'.repeat(101)).success).toBe(false)
  })

  it('refuse a key they do not know (a typo is never silently dropped)', () => {
    expect(createSupplierSchema.safeParse({ name: 'A', nonsense: 1 }).success).toBe(false)
    expect(updateSupplierSchema.safeParse({ name: 'A', nonsense: 1 }).success).toBe(false)
    expect(voidPaymentSchema.safeParse({ reason: 'x', nonsense: 1 }).success).toBe(false)
    expect(closePurchaseOrderSchema.safeParse({ nonsense: 1 }).success).toBe(false)
  })

  it('refuse a change that changes nothing', () => {
    expect(updateSupplierSchema.safeParse({}).success).toBe(false)
    expect(updatePurchaseOrderSchema.safeParse({}).success).toBe(false)
  })

  it('take a day only if it exists, a whole number of units and cents, and one line of a receipt once', () => {
    const base = { idempotencyKey: 'a-key-0001', supplierId: id(1), warehouseId: id(2) }
    expect(createPurchaseOrderSchema.safeParse({ ...base, expectedOn: '2026-02-30' }).success).toBe(
      false
    )
    expect(createPurchaseOrderSchema.safeParse({ ...base, expectedOn: '2026-02-28' }).success).toBe(
      true
    )
    const line = { productId: id(3), quantity: 1, unitCostCents: 100 }
    expect(
      createPurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, quantity: 1.5 }] }).success
    ).toBe(false)
    expect(
      createPurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, unitCostCents: 1.5 }] })
        .success
    ).toBe(false)
    const received = { idempotencyKey: 'a-key-0001', receivedOn: '2026-11-16' }
    const once = { orderLineId: id(4), quantity: 1 }
    expect(receivePurchaseOrderSchema.safeParse({ ...received, lines: [once] }).success).toBe(true)
    expect(receivePurchaseOrderSchema.safeParse({ ...received, lines: [once, once] }).success).toBe(
      false
    )
    expect(receivePurchaseOrderSchema.safeParse({ ...received, lines: [] }).success).toBe(false)
  })

  it('take a payment of at least one cent', () => {
    const payment = {
      idempotencyKey: 'a-key-0001',
      paidFromAccountId: id(5),
      amountCents: 1,
      paidOn: '2026-11-16'
    }
    expect(recordPaymentSchema.safeParse(payment).success).toBe(true)
    expect(recordPaymentSchema.safeParse({ ...payment, amountCents: 0 }).success).toBe(false)
  })
})
