import { z } from 'zod'

import {
  lowercasedUuidSchema,
  PaginationLimits,
  PurchaseLimits,
  PurchaseOrderStatus,
  singleLineText,
  queryIntSchema
} from '@platform/core/domain'
import {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  recordPaymentReturnSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentReturnSchema,
  voidPaymentSchema
} from '@platform/core/finance'

import { cursorSchema } from '../customers/list-cursor'

// The bodies are the shared lib's (the web checks its forms against them); the api keeps its names for them
export {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  recordPaymentReturnSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentReturnSchema,
  voidPaymentSchema
}

export const idSchema = lowercasedUuidSchema

const limit = queryIntSchema(1, PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
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
  supplierId: lowercasedUuidSchema.optional()
})

export const payablesQuerySchema = z.strictObject({
  supplierId: lowercasedUuidSchema.optional(),
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
export type RecordPaymentReturnBody = z.infer<typeof recordPaymentReturnSchema>
export type VoidPaymentReturnBody = z.infer<typeof voidPaymentReturnSchema>
export type VoidPaymentBody = z.infer<typeof voidPaymentSchema>
export type PayablesQuery = z.infer<typeof payablesQuerySchema>
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>
