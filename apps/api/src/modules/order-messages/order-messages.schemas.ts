import { z } from 'zod'

import { uuidSchema } from '@platform/core/domain'

import { kindSchema } from './order-templates.schemas'

// A person sends a message of a kind about an order. The key is the one their client made for this press: the same key sends
// once (a retry, a double click), a new press sends again. It is not a secret and not a user's text.
export const sendOrderMessageSchema = z.strictObject({
  kind: kindSchema,
  // The package the message is about, for the kinds whose package is not the outbound one of the order (`return_approved`: the guide of
  // the way back). Left out, the message takes the live one of its kind. It must be a shipment of the order: another order's is not found.
  shipmentId: uuidSchema.optional(),
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
