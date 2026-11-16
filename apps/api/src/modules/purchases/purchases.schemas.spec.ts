import * as shared from '@platform/core/finance'

import {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentSchema
} from './purchases.schemas'

// The bodies moved to the shared lib (the web checks its forms against them); the api keeps validating with those very schemas, under its old names
describe('the purchase schemas of the api', () => {
  it('are the shared ones, so the api and the web cannot drift', () => {
    expect(createSupplierSchema).toBe(shared.createSupplierSchema)
    expect(updateSupplierSchema).toBe(shared.updateSupplierSchema)
    expect(createPurchaseOrderSchema).toBe(shared.createPurchaseOrderSchema)
    expect(updatePurchaseOrderSchema).toBe(shared.updatePurchaseOrderSchema)
    expect(receivePurchaseOrderSchema).toBe(shared.receivePurchaseOrderSchema)
    expect(closePurchaseOrderSchema).toBe(shared.closePurchaseOrderSchema)
    expect(recordPaymentSchema).toBe(shared.recordPaymentSchema)
    expect(voidPaymentSchema).toBe(shared.voidPaymentSchema)
  })

  it('still refuse what the api refused before the move', () => {
    expect(createSupplierSchema.safeParse({ name: 'A', extra: 1 }).success).toBe(false)
    expect(createSupplierSchema.safeParse({ name: 'A' }).success).toBe(true)
    expect(updatePurchaseOrderSchema.safeParse({}).success).toBe(false)
  })
})
