// The bodies of the purchase routes are in the domain lib (a screen checks its forms against them); this file keeps the old path.
export {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  purchaseIdempotencyKey,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentSchema
} from '@platform/core/domain'
