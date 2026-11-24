import { z } from 'zod'

import { ApiRoutesPluginWidgets } from '@platform/core/api'
import {
  PluginBridgeMessages,
  type PluginBridgeRequest,
  type PluginBridgeResponse
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The widgets of the plugins in the agent sidebar (TDD_10 §7). Listing and opening a session need
// conversations:view; Settings reads with settings:view and shows or hides with settings:manage_plugins. The API key
// of a plugin is nowhere in these answers: the page hands the frame a session token over its port, never a key.

const widgetSchema = z.object({
  installationId: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  widgetId: z.string(),
  name: z.string(),
  // The manifest's url with no query: the page adds the conversation and the widget
  url: z.string(),
  origin: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  refreshInterval: z.number().nullable()
})
export type PluginWidgetView = z.output<typeof widgetSchema>

const widgetSettingsSchema = widgetSchema.extend({ visible: z.boolean() })
export type PluginWidgetSettingsView = z.output<typeof widgetSettingsSchema>

const sessionSchema = z.object({
  token: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  origin: z.string()
})
export type PluginWidgetSessionView = z.output<typeof sessionSchema>

// What the bridge answers with the frame's request. A failure the api words as an error (4xx) is turned into
// `{ ok: false }` by the page, never forwarded as text.
// Each view is parsed, and a parse drops every key it does not name: a field the api adds later does not reach a
// frame until this file says so.
const conversationDataSchema = z.object({
  id: z.string(),
  status: z.string(),
  channelType: z.string(),
  createdAt: z.string(),
  lastInboundAt: z.string().nullable(),
  tags: z.array(z.string())
})
const customerDataSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locale: z.string().nullable()
})
const bridgeDataSchema = z.object({
  type: z.literal(PluginBridgeMessages.RESPONSE),
  id: z.string(),
  ok: z.literal(true),
  data: z.union([conversationDataSchema, customerDataSchema])
})

const enc = encodeURIComponent

export function fetchPluginWidgets(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<PluginWidgetView[]> {
  return client.request(ApiRoutesPluginWidgets.list, {
    schema: z.array(widgetSchema),
    storeId,
    signal
  })
}

export function fetchPluginWidgetSettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<PluginWidgetSettingsView[]> {
  return client.request(ApiRoutesPluginWidgets.settings, {
    schema: z.array(widgetSettingsSchema),
    storeId,
    signal
  })
}

export function setPluginWidgetVisible(
  client: ApiClient,
  storeId: string,
  installationId: string,
  widgetId: string,
  visible: boolean
): Promise<PluginWidgetSettingsView> {
  return client.request(ApiRoutesPluginWidgets.visibility(enc(installationId), enc(widgetId)), {
    method: 'PUT',
    body: { visible },
    schema: widgetSettingsSchema,
    storeId
  })
}

export function openPluginWidgetSession(
  client: ApiClient,
  storeId: string,
  installationId: string,
  conversationId: string,
  widgetId: string
): Promise<PluginWidgetSessionView> {
  return client.request(ApiRoutesPluginWidgets.sessions, {
    method: 'POST',
    body: { installationId, conversationId, widgetId },
    schema: sessionSchema,
    storeId
  })
}

// One request of a frame, forwarded with the session token it was handed. The answer is built here from the api's,
// so a frame only ever gets the shape of `PluginBridgeResponse`, whatever else the api said.
export async function callPluginWidgetBridge(
  client: ApiClient,
  storeId: string,
  token: string,
  request: PluginBridgeRequest
): Promise<PluginBridgeResponse> {
  const answer = await client.request(ApiRoutesPluginWidgets.bridge, {
    method: 'POST',
    body: { token, request },
    schema: bridgeDataSchema,
    storeId
  })
  return { type: PluginBridgeMessages.RESPONSE, id: answer.id, ok: true, data: answer.data }
}
