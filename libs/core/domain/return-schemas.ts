import { z } from 'zod'

import { ORDER_MAX_AMOUNT_CENTS } from './order-constants'
import { createOrderSchema } from './order-schemas'
import { OrderReturnReasons } from './shipping-constants'
import { OrderReturnCondition, OrderReturnType, ShippingPayer } from './status-enums'
import { uuidSchema } from './validation'

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
export const replacementOrderSchema = createOrderSchema.pick({
  items: true,
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
