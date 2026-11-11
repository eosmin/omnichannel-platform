import { z } from 'zod'

import { OrderMessageKind, ValidationMessages } from '@platform/core/domain'

import { kindSchema } from './order-templates.schemas'

// The kinds a person can send by hand. The return and the exchange are about a shipment that is not the outbound one of the
// order, so they wait for the returns step (4.12), which gives the send the shipment it is about
const KINDS_OF_ANOTHER_SHIPMENT: readonly string[] = [
  OrderMessageKind.RETURN_APPROVED,
  OrderMessageKind.EXCHANGE_SHIPPED
]
const manualKindSchema = kindSchema.refine(kind => !KINDS_OF_ANOTHER_SHIPMENT.includes(kind), {
  message: ValidationMessages.ORDER_MESSAGE_KIND_NOT_MANUAL
})

// A person sends a message of a kind about an order. The key is the one their client made for this press: the same key sends
// once (a retry, a double click), a new press sends again. It is not a secret and not a user's text.
export const sendOrderMessageSchema = z.strictObject({
  kind: manualKindSchema,
  // Required to send, not to preview (the controller asks for it): a preview claims nothing
  idempotencyKey: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
})
export type SendOrderMessageBody = z.output<typeof sendOrderMessageSchema>

// `?preview=true` renders the message from the real order and sends nothing
export const sendOrderMessageQuerySchema = z.strictObject({
  preview: z
    .enum(['true', 'false'])
    .optional()
    .transform(value => value === 'true')
})
export type SendOrderMessageQuery = z.output<typeof sendOrderMessageQuerySchema>
