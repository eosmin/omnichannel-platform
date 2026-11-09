import { z } from 'zod'

import {
  type ApiClient,
  channelDescriptorSchema,
  channelOAuthDescriptorSchema,
  localizedTextSchema
} from '@platform/api-client'
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

// What the provider says about the token of a connection (the daily job and every connect read it). `unknown`
// is also what a server that does not send it is taken for: nothing is said then, and never "expired".
const tokenExpirySchema = z.object({
  state: z.string(),
  expiresAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  kind: z.string()
})
export type TokenExpiryView = z.output<typeof tokenExpirySchema>
const UNKNOWN_TOKEN_EXPIRY: TokenExpiryView = {
  state: 'unknown',
  expiresAt: null,
  checkedAt: null,
  kind: 'unknown'
}

const connectionSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  // What is shown as the name: the label the owner gave, or the name of the account while there is none
  displayName: z.string(),
  label: z.string().nullable(),
  accountName: z.string(),
  status: z.string(),
  lastHealthyAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  capabilities: z.array(z.string()),
  profile: profileStatusSchema.nullable(),
  tokenExpiry: tokenExpirySchema.catch(UNKNOWN_TOKEN_EXPIRY)
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
  // A message key (the official plugins) or null for a plugin that names the field with a text of its own, which
  // the form draws once the settings read it (Step 7.9 B1b); until then such a field shows its key
  labelKey: z.string().nullable(),
  // The text of the plugin itself in each language, and a line of help: null/absent from the official plugins
  label: localizedTextSchema.nullable().catch(null),
  helpKey: z.string().nullable().catch(null),
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
    .object({
      connectFields: z.array(connectFieldSchema),
      callbackUrl: z.string().nullable(),
      // "Connect with Facebook" is offered for this channel; false from a server older than the page
      facebookLogin: z.boolean().catch(false),
      // How the channel is named and drawn, and its login: none when the server does not say or the descriptor
      // is not valid (the browser checks it again), never a failure of the page. Until B1b draws the login from
      // `oauth`, the button still follows `facebookLogin` and the Facebook address.
      descriptor: channelDescriptorSchema.nullable().catch(null),
      oauth: channelOAuthDescriptorSchema.nullable().catch(null)
    })
    .nullable()
})
export type PluginCatalogEntryView = z.output<typeof catalogEntrySchema>

const widgetSchema = z.object({
  siteKey: z.string(),
  allowedOrigins: z.array(z.string()),
  preChatEnabled: z.boolean(),
  snippet: z.string(),
  connectSrc: z.array(z.string()),
  // A server older than the page says nothing of the script: the card then lists what it has
  scriptSrc: z.array(z.string()).catch([])
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

// The token of a connection that exists: the api checks that it is of the same account
export function updateConnectionToken(
  client: ApiClient,
  storeId: string,
  connectionId: string,
  credentials: Record<string, unknown>
): Promise<ChannelConnectionView> {
  return client.request(ApiRoutes.channels.updateToken(enc(connectionId)), {
    method: 'POST',
    body: { credentials },
    schema: connectionSchema,
    storeId
  })
}

// The name the owner gives to a connection; null goes back to the name of the account
export function renameConnection(
  client: ApiClient,
  storeId: string,
  connectionId: string,
  label: string | null
): Promise<ChannelConnectionView> {
  return client.request(ApiRoutes.channels.label(enc(connectionId)), {
    method: 'PUT',
    body: { label },
    schema: connectionSchema,
    storeId
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

// "Connect with Facebook" (Step 7.8). The api makes the state and answers the address of the dialog; the
// browser goes there, and comes back with the id of a session that holds the person's token on the server:
// the page only ever holds that id, and only in memory.
const startSchema = z.object({ authorizeUrl: z.string() })

const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  linkedAccount: z.object({ id: z.string(), username: z.string().nullable() }).nullable()
})
export type OAuthAssetView = z.output<typeof assetSchema>

const assetsSchema = z.object({
  pluginId: z.string(),
  // The connection this login repairs, when it was started from one
  connectionId: z.string().nullable().catch(null),
  // The account that connection is (the id of its Page, or of its Instagram account), to show which Page it is
  repairAccountId: z.string().nullable().catch(null),
  assets: z.array(assetSchema)
})
export type OAuthAssetsView = z.output<typeof assetsSchema>

export function startFacebookLogin(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  // The connection to repair, when the login is started from its card: the api keeps it with the state
  connectionId?: string
): Promise<{ authorizeUrl: string }> {
  return client.request(ApiRoutes.channels.oauthStart(enc(pluginId)), {
    method: 'POST',
    body: connectionId === undefined ? undefined : { connectionId },
    schema: startSchema,
    storeId
  })
}

export function fetchOAuthAssets(
  client: ApiClient,
  storeId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<OAuthAssetsView> {
  return client.request(ApiRoutes.channels.oauthAssets(enc(sessionId)), {
    schema: assetsSchema,
    storeId,
    signal
  })
}

export function completeOAuth(
  client: ApiClient,
  storeId: string,
  sessionId: string,
  assetId: string
): Promise<ChannelConnectionView> {
  return client.request(ApiRoutes.channels.oauthComplete(enc(sessionId)), {
    method: 'POST',
    body: { assetId },
    schema: connectionSchema,
    storeId
  })
}

export function cancelOAuth(
  client: ApiClient,
  storeId: string,
  sessionId: string
): Promise<undefined> {
  return client.request(ApiRoutes.channels.oauthSession(enc(sessionId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}
