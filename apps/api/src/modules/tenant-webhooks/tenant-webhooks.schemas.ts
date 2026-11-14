import { z } from 'zod'

import {
  isPlainHttpsUrl,
  isWebhookEvent,
  WebhookEvents,
  uuidSchema,
  WebhookLimits,
  WebhookStatus
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = uuidSchema

// The address is checked for its shape here (https, no credentials); that it points at the public internet
// needs the resolver and is checked by the service. No fragment: it would never reach the server.
const webhookUrl = z
  .string()
  .trim()
  .max(WebhookLimits.URL_MAX_LENGTH)
  .refine(isPlainHttpsUrl, { message: 'must be an https address without credentials' })
  // Checked only after the shape is: zod runs every refinement, and a text that is not an address has no fragment to read
  .refine(value => !isPlainHttpsUrl(value) || new URL(value).hash === '', {
    message: 'must not carry a fragment'
  })

// Each event once, and only the ones a webhook can be subscribed to
const webhookEvents = z
  .array(z.string().refine(isWebhookEvent, { message: 'is not an event a webhook can follow' }))
  .min(1)
  .max(WebhookEvents.length)
  .transform(events => [...new Set(events)])

export const createWebhookSchema = z.strictObject({
  url: webhookUrl,
  events: webhookEvents
})

// A webhook is paused or resumed by its store; `disabled` is only ever set by the platform, after repeated failures
const settableStatus = z.enum([WebhookStatus.ACTIVE, WebhookStatus.PAUSED])

export const updateWebhookSchema = z
  .strictObject({
    url: webhookUrl.optional(),
    events: webhookEvents.optional(),
    status: settableStatus.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export const listDeliveriesQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(WebhookLimits.DELIVERIES_MAX_PAGE_SIZE)
    .default(WebhookLimits.DELIVERIES_DEFAULT_PAGE_SIZE),
  success: z
    .enum(['true', 'false'])
    .transform(value => value === 'true')
    .optional()
})

export type CreateWebhookBody = z.output<typeof createWebhookSchema>
export type UpdateWebhookBody = z.output<typeof updateWebhookSchema>
export type ListDeliveriesQuery = z.output<typeof listDeliveriesQuerySchema>
