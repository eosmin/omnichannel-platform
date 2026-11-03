import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import type { ChannelConnectionListState } from '@platform/core/domain'

// Settings → Channels and Plugins: what the api answers to who manages channels. Kept in the page's own
// files and not in `@platform/api-client`, whose barrel the inbox loads whole: nothing here is needed
// there. A value the page does not know yet (a status, a type) is kept as the text it came as.

// A secret never comes back: the credentials are not part of any of these answers

const profileStatusSchema = z.object({
  failedIdentities: z.number().int(),
  errors: z.array(z.object({ code: z.string(), identities: z.number().int() })),
  setupKey: z.string().nullable()
})
export type ConnectionProfileView = z.output<typeof profileStatusSchema>

const connectionSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  displayName: z.string(),
  status: z.string(),
  lastHealthyAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  capabilities: z.array(z.string()),
  profile: profileStatusSchema.nullable()
})
export type ChannelConnectionView = z.output<typeof connectionSchema>

const connectionPageSchema = z.object({
  data: z.array(connectionSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ChannelConnectionPageView = z.output<typeof connectionPageSchema>

const testResultSchema = z.object({
  healthy: z.boolean(),
  checkedAt: z.string(),
  error: z.string().optional()
})
export type ChannelTestView = z.output<typeof testResultSchema>

const connectFieldSchema = z.object({
  key: z.string(),
  labelKey: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  multiple: z.boolean()
})
export type ConnectFieldView = z.output<typeof connectFieldSchema>

const catalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  authorName: z.string(),
  type: z.string(),
  isOfficial: z.boolean(),
  installed: z.boolean(),
  installationId: z.string().nullable(),
  activeConnections: z.number().int(),
  channel: z
    .object({ connectFields: z.array(connectFieldSchema), callbackUrl: z.string().nullable() })
    .nullable()
})
export type PluginCatalogEntryView = z.output<typeof catalogEntrySchema>

const widgetSchema = z.object({
  siteKey: z.string(),
  allowedOrigins: z.array(z.string()),
  preChatEnabled: z.boolean(),
  snippet: z.string(),
  connectSrc: z.array(z.string())
})
export type WidgetEmbedView = z.output<typeof widgetSchema>

// Every call goes through the store in X-Store-Id; the connection or the plugin is named in the path
const enc = encodeURIComponent

// One page of the connections in use or of the disconnected ones, oldest first: a store can hold
// hundreds, and the api never answers them all at once
export function fetchConnections(
  client: ApiClient,
  storeId: string,
  state: ChannelConnectionListState,
  cursor: string | null,
  signal?: AbortSignal
): Promise<ChannelConnectionPageView> {
  const params = new URLSearchParams({ state })
  if (cursor !== null) params.set('cursor', cursor)
  return client.request(`${ApiRoutes.channels.connections}?${params.toString()}`, {
    schema: connectionPageSchema,
    storeId,
    signal
  })
}

export function connectChannel(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  credentials: Record<string, unknown>
): Promise<ChannelConnectionView> {
  return client.request(ApiRoutes.channels.connect(enc(pluginId)), {
    method: 'POST',
    body: { credentials },
    schema: connectionSchema,
    storeId
  })
}

export function testConnection(
  client: ApiClient,
  storeId: string,
  connectionId: string
): Promise<ChannelTestView> {
  return client.request(ApiRoutes.channels.test(enc(connectionId)), {
    method: 'POST',
    schema: testResultSchema,
    storeId
  })
}

export function disconnectConnection(
  client: ApiClient,
  storeId: string,
  connectionId: string
): Promise<ChannelConnectionView> {
  return client.request(ApiRoutes.channels.disconnect(enc(connectionId)), {
    method: 'POST',
    schema: connectionSchema,
    storeId
  })
}

export function fetchWidget(
  client: ApiClient,
  storeId: string,
  connectionId: string,
  signal?: AbortSignal
): Promise<WidgetEmbedView> {
  return client.request(ApiRoutes.channels.widgetEmbed(enc(connectionId)), {
    schema: widgetSchema,
    storeId,
    signal
  })
}

export function saveWidgetOrigins(
  client: ApiClient,
  storeId: string,
  connectionId: string,
  siteOrigins: string[]
): Promise<WidgetEmbedView> {
  return client.request(ApiRoutes.channels.widgetOrigins(enc(connectionId)), {
    method: 'PUT',
    body: { siteOrigins },
    schema: widgetSchema,
    storeId
  })
}

export function saveWidgetPreChat(
  client: ApiClient,
  storeId: string,
  connectionId: string,
  enabled: boolean
): Promise<WidgetEmbedView> {
  return client.request(ApiRoutes.channels.widgetPreChat(enc(connectionId)), {
    method: 'PUT',
    body: { enabled },
    schema: widgetSchema,
    storeId
  })
}

export function fetchPluginCatalog(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<PluginCatalogEntryView[]> {
  return client.request(ApiRoutes.plugins.available, {
    schema: z.array(catalogEntrySchema),
    storeId,
    signal
  })
}

export function installPlugin(
  client: ApiClient,
  storeId: string,
  pluginId: string
): Promise<PluginCatalogEntryView> {
  return client.request(ApiRoutes.plugins.install, {
    method: 'POST',
    body: { pluginId },
    schema: catalogEntrySchema,
    storeId
  })
}

export function uninstallPlugin(
  client: ApiClient,
  storeId: string,
  installationId: string
): Promise<PluginCatalogEntryView> {
  return client.request(ApiRoutes.plugins.revoke(enc(installationId)), {
    method: 'POST',
    schema: catalogEntrySchema,
    storeId
  })
}
