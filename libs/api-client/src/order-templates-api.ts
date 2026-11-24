import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type { OrderMessageKindType, OrderMessageVariable } from '@platform/core/domain'
import type { Locale } from '@platform/core/i18n'

import type { ApiClient } from './api-client'

// The templates of the messages a store sends about an order (TDD_17 §4.7). Reading them asks for orders:view; writing,
// deleting and previewing for settings:manage_order_templates. Only the templates a store wrote exist: a kind and language
// with none is a 404 on GET and is absent from the list, and the sender then falls back to its own text.

// The link to a template the channel approved: its name and language as the owner copied them, and which variable of ours
// fills each numbered placeholder, in order
const channelTemplateLinkSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  language: z.string(),
  variables: z.array(z.string())
})
export type OrderTemplateChannelLink = z.output<typeof channelTemplateLinkSchema>

// A kind, language, variable or warning this page does not know is kept as the text it came as
const orderTemplateSchema = z.object({
  id: z.string(),
  kind: z.string(),
  locale: z.string(),
  body: z.string(),
  autoSend: z.boolean(),
  attachSummary: z.boolean(),
  channelTemplate: channelTemplateLinkSchema.nullable(),
  // The variables the body needs a value for
  variables: z.array(z.string()),
  warnings: z.array(z.string()),
  updatedAt: z.string()
})
export type OrderTemplateView = z.output<typeof orderTemplateSchema>
const orderTemplateListSchema = z.array(orderTemplateSchema)

const orderTemplatePreviewSchema = z.object({ text: z.string(), variables: z.array(z.string()) })
export type OrderTemplatePreviewView = z.output<typeof orderTemplatePreviewSchema>

export interface OrderTemplateChannelLinkInput {
  pluginId: string
  name: string
  language: string
  variables: OrderMessageVariable[]
}

// `autoSend` left out takes the default of the kind; a kind that follows a store preference refuses it when it is on
export interface PutOrderTemplateInput {
  body: string
  autoSend?: boolean
  attachSummary: boolean
  channelTemplate: OrderTemplateChannelLinkInput | null
}

const enc = encodeURIComponent

export function fetchOrderTemplates(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<OrderTemplateView[]> {
  return client.request(ApiRoutes.orderTemplates.list, {
    schema: orderTemplateListSchema,
    storeId,
    signal
  })
}

export function putOrderTemplate(
  client: ApiClient,
  storeId: string,
  kind: OrderMessageKindType,
  locale: Locale,
  input: PutOrderTemplateInput
): Promise<OrderTemplateView> {
  return client.request(ApiRoutes.orderTemplates.byKindAndLocale(enc(kind), enc(locale)), {
    method: 'PUT',
    body: input,
    schema: orderTemplateSchema,
    storeId
  })
}

export function deleteOrderTemplate(
  client: ApiClient,
  storeId: string,
  kind: OrderMessageKindType,
  locale: Locale
): Promise<undefined> {
  return client.request(ApiRoutes.orderTemplates.byKindAndLocale(enc(kind), enc(locale)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// The text being edited, rendered with a sample order; nothing is saved
export function previewOrderTemplate(
  client: ApiClient,
  storeId: string,
  body: string,
  locale: Locale,
  signal?: AbortSignal
): Promise<OrderTemplatePreviewView> {
  return client.request(ApiRoutes.orderTemplates.preview, {
    method: 'POST',
    body: { body, locale },
    schema: orderTemplatePreviewSchema,
    storeId,
    signal
  })
}
