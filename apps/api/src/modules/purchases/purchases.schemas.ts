import { z } from 'zod'

import {
  PaginationLimits,
  PurchaseLimits,
  PurchaseOrderStatus,
  singleLineText
} from '@platform/core/domain'
import {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentSchema
} from '@platform/core/finance'

import { cursorSchema } from '../customers/list-cursor'

// The bodies are the shared lib's (the web checks its forms against them); the api keeps its names for them
export {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentSchema
}

export const idSchema = z.uuid()

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(PaginationLimits.MAX)
  .default(PaginationLimits.DEFAULT)
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

export const listSuppliersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit,
  // A part of the name
  q: singleLineText(PurchaseLimits.SUPPLIER_NAME_MAX_LENGTH, 1).optional(),
  // The switched-off ones are listed only when asked
  includeInactive: flag.default(false)
})

export const listPurchaseOrdersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit,
  status: z.enum(PurchaseOrderStatus).optional(),
  supplierId: z.uuid().optional()
})

export const payablesQuerySchema = z.strictObject({
  supplierId: z.uuid().optional(),
  // Only the bills past their due day
  overdueOnly: flag.default(false)
})

export const listPaymentsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit
})

export type CreateSupplierBody = z.infer<typeof createSupplierSchema>
export type UpdateSupplierBody = z.infer<typeof updateSupplierSchema>
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>
export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderSchema>
export type UpdatePurchaseOrderBody = z.infer<typeof updatePurchaseOrderSchema>
export type ListPurchaseOrdersQuery = z.infer<typeof listPurchaseOrdersQuerySchema>
export type ReceivePurchaseOrderBody = z.infer<typeof receivePurchaseOrderSchema>
export type ClosePurchaseOrderBody = z.infer<typeof closePurchaseOrderSchema>
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>
export type VoidPaymentBody = z.infer<typeof voidPaymentSchema>
export type PayablesQuery = z.infer<typeof payablesQuerySchema>
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>
