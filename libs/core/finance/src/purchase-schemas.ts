// The bodies of the purchase routes are in the domain lib (a screen checks its forms against them); this file keeps the old path.
export {
  closePurchaseOrderSchema,
  completeReceiptDocumentSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  purchaseFiscalDocumentSchema,
  purchaseIdempotencyKey,
  receivePurchaseOrderSchema,
  recordPaymentReturnSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentReturnSchema,
  voidPaymentSchema
} from '@platform/core/domain'
