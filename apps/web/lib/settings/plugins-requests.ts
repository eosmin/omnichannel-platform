import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

import { catalogEntrySchema } from './channels-requests'

// Settings → Plugins (Step 5.6 PR W1): registering a plugin by its manifest, what installing one grants, the one-time setup
// code and the detail of one plugin. Kept apart from the channel requests: only this page loads them. The texts of the manifest
// (name, description, author) are the author's and are drawn as text, never as markup. No secret comes back from any of these
// except the setup code and the command secret, which the api shows once and marks as not to be stored.

const enc = encodeURIComponent

// Links the author wrote: only an https address is ever drawn as a link, whatever the api sent
const httpsOnly = z
  .string()
  .nullable()
  .transform(value => (value !== null && /^https:\/\//i.test(value) ? value : null))

const consentSchema = z.object({
  plugin: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    authorUrl: httpsOnly
  }),
  // What the manifest asks for now, what the installation holds, and the difference (a new version asks for more)
  scopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  newScopes: z.array(z.string()),
  rateLimitPerMinute: z.number().int(),
  webhooks: z.object({ endpoint: z.string(), events: z.array(z.string()) }).nullable(),
  legal: z.object({
    privacyPolicy: httpsOnly,
    termsOfService: httpsOnly
  }),
  settingsUrl: httpsOnly,
  installation: z.object({ id: z.string(), status: z.string() }).nullable()
})
export type PluginConsentView = z.output<typeof consentSchema>

const setupOfferSchema = z.object({
  installationId: z.string(),
  code: z.string(),
  expiresAt: z.string(),
  settingsUrl: httpsOnly
})
export type PluginSetupOfferView = z.output<typeof setupOfferSchema>

const installedSchema = catalogEntrySchema.extend({ setup: setupOfferSchema.nullable() })
export type PluginInstallResultView = z.output<typeof installedSchema>

const registeredSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.string(),
  outcome: z.string()
})
export type RegisteredPluginView = z.output<typeof registeredSchema>

const detailSchema = catalogEntrySchema.extend({
  version: z.string().nullable(),
  description: z.string().nullable(),
  requestedScopes: z.array(z.string()),
  webhookEvents: z.array(z.string()),
  installation: z
    .object({
      id: z.string(),
      status: z.string(),
      scopes: z.array(z.string()),
      apiKeyPrefix: z.string().nullable(),
      rateLimitPerMinute: z.number().int(),
      webhookEndpoint: z.string().nullable(),
      webhookConsecutiveFailures: z.number().int(),
      webhookLastFailureAt: z.string().nullable(),
      webhookDisabledAt: z.string().nullable(),
      installedAt: z.string(),
      revokedAt: z.string().nullable()
    })
    .nullable()
})
export type PluginDetailView = z.output<typeof detailSchema>

const commandSecretSchema = z.object({
  commandSecret: z.string(),
  rotatedAt: z.string(),
  previousValidUntil: z.string()
})
export type RotatedCommandSecretView = z.output<typeof commandSecretSchema>

export function fetchPluginConsent(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  signal?: AbortSignal
): Promise<PluginConsentView> {
  return client.request(ApiRoutes.plugins.consent(enc(pluginId)), {
    schema: consentSchema,
    storeId,
    signal
  })
}

export function fetchPluginDetail(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  signal?: AbortSignal
): Promise<PluginDetailView> {
  return client.request(ApiRoutes.plugins.byId(enc(pluginId)), {
    schema: detailSchema,
    storeId,
    signal
  })
}

// The manifest is sent as the owner pasted it: the api is the one that validates it, and says why when it refuses
export function registerPlugin(
  client: ApiClient,
  storeId: string,
  manifest: unknown
): Promise<RegisteredPluginView> {
  return client.request(ApiRoutes.plugins.register, {
    method: 'POST',
    body: manifest,
    schema: registeredSchema,
    storeId
  })
}

// Deletes a plugin the organization registered. The name is the one the owner typed; the api checks it again (and that no store of the
// organization still holds the plugin).
export function deletePlugin(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  confirmation: string
): Promise<undefined> {
  return client.request(ApiRoutes.plugins.byId(encodeURIComponent(pluginId)), {
    method: 'DELETE',
    body: { confirmation },
    schema: z.undefined(),
    storeId
  })
}

// `scopes` are exactly the ones the consent screen showed: the api refuses the install when the manifest asks for others now
export function installIntegrationPlugin(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  scopes: readonly string[]
): Promise<PluginInstallResultView> {
  return client.request(ApiRoutes.plugins.install, {
    method: 'POST',
    body: { pluginId, scopes },
    schema: installedSchema,
    storeId
  })
}

export function reissueSetupCode(
  client: ApiClient,
  storeId: string,
  installationId: string
): Promise<PluginSetupOfferView> {
  return client.request(ApiRoutes.plugins.setupCode(enc(installationId)), {
    method: 'POST',
    schema: setupOfferSchema,
    storeId
  })
}

export function rotateCommandSecret(
  client: ApiClient,
  storeId: string,
  installationId: string
): Promise<RotatedCommandSecretView> {
  return client.request(ApiRoutes.plugins.commandSecret(enc(installationId)), {
    method: 'POST',
    schema: commandSecretSchema,
    storeId
  })
}
