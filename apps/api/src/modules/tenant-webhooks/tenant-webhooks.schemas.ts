import { z } from 'zod'

import {
  isPlainHttpsUrl,
  isWebhookEvent,
  lowercasedUuidSchema,
  WebhookEvents,
  WebhookLimits,
  WebhookStatus,
  queryIntSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = lowercasedUuidSchema

// The address as the URL standard writes it, and without the dot that ends a fully qualified host name: `example.com.` is the
// host `example.com`, so the two spellings are one address for the rule that a store holds one webhook per address and events
export function canonicalWebhookUrl(value: string): string {
  const url = new URL(value)
  url.hostname = url.hostname.replace(/\.+$/, '')
  return url.href
}

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
  // A host made only of dots names nothing: the final dots cannot be taken off it (`https://./` stays as it is)
  .refine(value => !isPlainHttpsUrl(value) || new URL(value).hostname.replace(/\.+$/, '') !== '', {
    message: 'must name a host'
  })
  // The address as the URL standard writes it (host in lower case, no default port, a path): two spellings of one address
  // (and the host with no final dot) are one, for the rule that a store holds one webhook per address and set of events
  .transform(value => (isPlainHttpsUrl(value) ? canonicalWebhookUrl(value) : value))

// Each event once, in a fixed order (the same set is then the same array: a store cannot hold two webhooks with the
// same address and events), and only the ones a webhook can be subscribed to
const webhookEvents = z
  .array(z.string().refine(isWebhookEvent, { message: 'is not an event a webhook can follow' }))
  .min(1)
  .max(WebhookEvents.length)
  .transform(events => [...new Set(events)].sort())

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
  limit: queryIntSchema(1, WebhookLimits.DELIVERIES_MAX_PAGE_SIZE).default(
    WebhookLimits.DELIVERIES_DEFAULT_PAGE_SIZE
  ),
  success: z
    .enum(['true', 'false'])
    .transform(value => value === 'true')
    .optional()
})

export type CreateWebhookBody = z.output<typeof createWebhookSchema>
export type UpdateWebhookBody = z.output<typeof updateWebhookSchema>
export type ListDeliveriesQuery = z.output<typeof listDeliveriesQuerySchema>
