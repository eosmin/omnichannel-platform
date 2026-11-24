import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutesSettings } from '@platform/core/api'
import type { WebhookStatus } from '@platform/core/domain'

// Settings → Webhooks: what the api answers about the webhooks of a store and their delivery log. Kept with the page and
// not in `@platform/api-client`, whose barrel the inbox loads whole. A status or an event this page does not know (a newer
// server) stays as the text it came as and is drawn as it is.

const webhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  status: z.string(),
  consecutiveFailures: z.number().int(),
  lastFailureAt: z.string().nullable(),
  createdAt: z.string()
})
export type WebhookView = z.output<typeof webhookSchema>

// The two calls that make a secret answer it once with the webhook; it is never read again
const webhookWithSecretSchema = webhookSchema.extend({ secret: z.string() })
export type WebhookWithSecretView = z.output<typeof webhookWithSecretSchema>

const deliverySchema = z.object({
  id: z.string(),
  event: z.string(),
  statusCode: z.number().int().nullable(),
  durationMs: z.number(),
  success: z.boolean(),
  // A code of WebhookDeliveryErrors, maybe followed by a colon and the code of the network error; never a sentence
  error: z.string().nullable(),
  attempt: z.number().int(),
  createdAt: z.string()
})
export type WebhookDeliveryView = z.output<typeof deliverySchema>

const deliveryPageSchema = z.object({
  items: z.array(deliverySchema),
  nextCursor: z.string().nullable()
})
export type WebhookDeliveryPage = z.output<typeof deliveryPageSchema>

export interface CreateWebhookInput {
  url: string
  events: string[]
}

// Only what changed is sent; `status` is paused or active (the platform alone sets disabled)
export interface UpdateWebhookInput {
  url?: string
  events?: string[]
  status?: WebhookStatus.ACTIVE | WebhookStatus.PAUSED
}

export type DeliveryOutcome = 'all' | 'failed' | 'succeeded'

const enc = encodeURIComponent

export function fetchWebhooks(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<WebhookView[]> {
  return client.request(ApiRoutesSettings.webhooks, {
    schema: z.array(webhookSchema),
    storeId,
    signal
  })
}

export function createWebhook(
  client: ApiClient,
  storeId: string,
  input: CreateWebhookInput
): Promise<WebhookWithSecretView> {
  return client.request(ApiRoutesSettings.webhooks, {
    method: 'POST',
    body: input,
    schema: webhookWithSecretSchema,
    storeId
  })
}

export function updateWebhook(
  client: ApiClient,
  storeId: string,
  webhookId: string,
  input: UpdateWebhookInput
): Promise<WebhookView> {
  return client.request(ApiRoutesSettings.webhookById(enc(webhookId)), {
    method: 'PATCH',
    body: input,
    schema: webhookSchema,
    storeId
  })
}

export function deleteWebhook(
  client: ApiClient,
  storeId: string,
  webhookId: string
): Promise<undefined> {
  return client.request(ApiRoutesSettings.webhookById(enc(webhookId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// The old secret stops working at once
export function rotateWebhookSecret(
  client: ApiClient,
  storeId: string,
  webhookId: string
): Promise<WebhookWithSecretView> {
  return client.request(ApiRoutesSettings.webhookSecret(enc(webhookId)), {
    method: 'POST',
    schema: webhookWithSecretSchema,
    storeId
  })
}

export function fetchWebhookDeliveries(
  client: ApiClient,
  storeId: string,
  webhookId: string,
  options: { cursor: string | null; outcome: DeliveryOutcome },
  signal?: AbortSignal
): Promise<WebhookDeliveryPage> {
  const query = new URLSearchParams()
  if (options.cursor !== null) query.set('cursor', options.cursor)
  if (options.outcome !== 'all') query.set('success', String(options.outcome === 'succeeded'))
  const text = query.toString()
  const suffix = text === '' ? '' : `?${text}`
  return client.request(`${ApiRoutesSettings.webhookDeliveries(enc(webhookId))}${suffix}`, {
    schema: deliveryPageSchema,
    storeId,
    signal
  })
}
