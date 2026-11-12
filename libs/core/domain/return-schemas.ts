import { z } from 'zod'

import { CustomerLimits } from './customer-constants'
import { ORDER_MAX_AMOUNT_CENTS, OrderLimits } from './order-constants'
import { createOrderSchema } from './order-schemas'
import { OrderReturnReasons } from './shipping-constants'
import { OrderReturnCondition, OrderReturnType, ShippingPayer } from './status-enums'
import { singleLineText, uuidSchema } from './validation'

// What a client sends about a return (TDD_17 §4.11, §6). Every shape is strict and none carries a store, a status or an amount
// of stock: the store is the one the guard resolved and the status is moved by the endpoint that is called.

export const ReturnLimits = {
  MAX_LINES: 100,
  NOTES_MAX_LENGTH: 2000,
  // A return is quantities of an order that has at most this many units on a line (the orders' own limit)
  MAX_LINE_QUANTITY: 10_000
} as const

// A reason is stored by its key (`DEFECTIVE`); the interface translates it through the i18n key that the key names
export type OrderReturnReasonKey = keyof typeof OrderReturnReasons
export const OrderReturnReasonKeys = Object.keys(OrderReturnReasons) as OrderReturnReasonKey[]
const reasonSchema = z.enum(
  OrderReturnReasonKeys as [OrderReturnReasonKey, ...OrderReturnReasonKey[]]
)

const notesSchema = z
  .string()
  .trim()
  .min(1)
  .max(ReturnLimits.NOTES_MAX_LENGTH)
  .refine(value => !value.includes('\u0000'), { message: 'a NUL character' })

export const returnLineSchema = z.strictObject({
  orderItemId: uuidSchema,
  quantity: z.number().int().min(1).max(ReturnLimits.MAX_LINE_QUANTITY)
})

export const createReturnSchema = z.strictObject({
  orderId: uuidSchema,
  type: z.enum(OrderReturnType),
  reason: reasonSchema,
  lines: z.array(returnLineSchema).min(1).max(ReturnLimits.MAX_LINES),
  // Omitted, the default of the store (`StoreSettings.returnShippingPayer`) is used
  shippingPayer: z.enum(ShippingPayer).optional(),
  notes: notesSchema.optional()
})
export type CreateReturnBody = z.output<typeof createReturnSchema>

// The replacement order of an exchange (TDD_17 §4.11): what the agent picks and how it is paid and sent. The customer is the one of the
// returned order, the order is born CONFIRMED and its discount is the credit of the return, never a number the client sends
// A line of the replacement names a product, a variant and a quantity, and nothing else: its price is the catalog's, and the
// warehouses are the allocator's choice. A price of the agent's own is an override that the replacement does not take (the credit
// is the system's, and the price control of the store stays with the orders).
const replacementItemSchema = z.strictObject({
  productId: uuidSchema,
  variantId: uuidSchema.optional(),
  quantity: z.number().int().min(1).max(OrderLimits.MAX_QUANTITY_PER_LINE)
})

export const replacementOrderSchema = createOrderSchema
  .pick({
    shippingCents: true,
    carrierConnectionId: true,
    paymentMethod: true,
    shippingAddress: true,
    recipientPhones: true,
    customerNotes: true,
    internalNotes: true,
    packingNotes: true,
    scheduledDeliveryDate: true
  })
  .extend({
    items: z
      .array(replacementItemSchema)
      .min(1)
      .max(OrderLimits.MAX_LINES)
      .refine(
        items =>
          new Set(items.map(item => `${item.productId}:${item.variantId ?? ''}`.toLowerCase()))
            .size === items.length,
        { message: 'a product and variant appear twice' }
      )
  })
export type ReplacementOrderBody = z.output<typeof replacementOrderSchema>

// Approving an exchange names its replacement; approving a refund names nothing
export const approveReturnSchema = z.strictObject({
  replacement: replacementOrderSchema.optional()
})
export type ApproveReturnBody = z.output<typeof approveReturnSchema>

// One line of a receipt: what came back, in which condition and where it goes (resellable units only)
export const receiveReturnLineSchema = z.strictObject({
  orderItemId: uuidSchema,
  condition: z.enum(OrderReturnCondition),
  restockWarehouseId: uuidSchema.optional()
})

// The receipt names the condition of every line of the return: nothing is assumed resellable
export const receiveReturnSchema = z.strictObject({
  lines: z.array(receiveReturnLineSchema).min(1).max(ReturnLimits.MAX_LINES)
})
export type ReceiveReturnBody = z.output<typeof receiveReturnSchema>

// Completing a refund return records the money given back (by hand: the platform processes no payment); an exchange has none
export const completeReturnSchema = z.strictObject({
  refundAmountCents: z.number().int().min(0).max(ORDER_MAX_AMOUNT_CENTS).optional(),
  notes: notesSchema.optional()
})
export type CompleteReturnBody = z.output<typeof completeReturnSchema>

// A reason to refuse or cancel is optional text for the team, never shown to the customer
export const returnDecisionSchema = z.strictObject({
  notes: notesSchema.optional()
})
export type ReturnDecisionBody = z.output<typeof returnDecisionSchema>

// ---------------------------------------------------------------------------------------------------- reception (TDD_17 §4.16)

export const ReceptionLimits = {
  // A batch is one table of packages on a desk: more than this is a second batch
  MAX_ITEMS: 200,
  // What a barcode reader types: a guide number is far shorter
  CODE_MAX_LENGTH: 100,
  // A completion that has been running longer than this died with its process: another may take the batch
  PROCESSING_STALE_MS: 10 * 60 * 1000,
  LIST_LIMIT: 50,
  // The shipments a code that more than one matches offers to choose from
  MAX_CANDIDATES: 10
} as const

// The reason a scanned package starts with, and the one that preselects the flag of its customer (TDD_17 §4.16)
export const ReceptionReasons = {
  DEFAULT: 'DELIVERY_FAILED',
  REFUSED: 'REFUSED_BY_CUSTOMER'
} as const satisfies Record<string, OrderReturnReasonKey>

// What scanning a code answers: the package joined the batch, no shipment answers to the code, or more than one does
export const ReceptionScanResults = {
  ADDED: 'added',
  NOT_FOUND: 'not_found',
  AMBIGUOUS: 'ambiguous'
} as const

// The code a reader typed, as it came: the lookup ignores the case and the blanks, the field only refuses what a query cannot hold
export const scanCodeSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1)
    .max(ReceptionLimits.CODE_MAX_LENGTH)
    .refine(value => !value.includes('\u0000'), { message: 'a NUL character' }),
  // The shipment the agent picked when the code matched more than one
  shipmentId: uuidSchema.optional()
})
export type ScanCodeBody = z.output<typeof scanCodeSchema>

// One line of a package that did not come back whole: what came back, in which condition and where it goes (resellable only)
export const receptionLineSchema = z.strictObject({
  orderItemId: uuidSchema,
  quantity: z.number().int().min(1).max(ReturnLimits.MAX_LINE_QUANTITY),
  condition: z.enum(OrderReturnCondition),
  restockWarehouseId: uuidSchema.optional()
})
export type ReceptionLine = z.output<typeof receptionLineSchema>

export const receptionLinesSchema = z.array(receptionLineSchema).max(ReturnLimits.MAX_LINES)

// What the agent decides about a package before the batch is completed. `lines: []` is every unit of the order that is not in a
// return yet, in `condition`. The flag reason is a line about a person: it never reaches the audit entry nor a log.
export const updateReceptionItemSchema = z
  .strictObject({
    reason: reasonSchema.optional(),
    condition: z.enum(OrderReturnCondition).optional(),
    note: notesSchema.nullable().optional(),
    lines: receptionLinesSchema.optional(),
    flagCustomer: z.boolean().optional(),
    flagReason: singleLineText(CustomerLimits.CAUTION_REASON_MAX_LENGTH, 1).nullable().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })
export type UpdateReceptionItemBody = z.output<typeof updateReceptionItemSchema>
