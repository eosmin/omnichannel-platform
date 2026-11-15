import { z } from 'zod'

import {
  CHANNEL_ID_PATTERN,
  CodePluginAuthor,
  OfficialPluginAuthor,
  PluginRevokeLimits
} from '@platform/core/domain'
import { pluginManifestSchema } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { isPluginScope, isSetupCode } from './plugin-install-rules'

// Only the shape of the id: the service looks for the plugin in the catalog. `scopes` is what the owner authorized on the consent
// screen: an integration plugin needs it (the service compares it with what the manifest asks for), a channel or the shipping
// plugin takes none.
// A plugin id in a path
export const pluginIdSchema = z.string().regex(CHANNEL_ID_PATTERN)

export const installPluginSchema = z.strictObject({
  pluginId: z.string().regex(CHANNEL_ID_PATTERN),
  scopes: z
    .array(z.string().refine(isPluginScope))
    .max(Object.values(PluginScopes).length)
    .refine(list => new Set(list).size === list.length, { message: 'repeated scope' })
    .optional()
})
export type InstallPluginBody = z.output<typeof installPluginSchema>

// What a manifest may not say about its author: the addresses that mark a catalog row as the platform's own or as one that
// its code wrote (CodePluginAuthor, OfficialPluginAuthor), which the boot sync trusts
const RESERVED_AUTHOR_EMAILS: ReadonlySet<string> = new Set(
  [OfficialPluginAuthor.EMAIL, CodePluginAuthor.EMAIL].map(email => email.toLowerCase())
)

// The body of `POST /plugins/register` is the manifest itself, pasted as it is
export const registerPluginSchema = pluginManifestSchema.refine(
  manifest => !RESERVED_AUTHOR_EMAILS.has(manifest.author.email.toLowerCase()),
  { path: ['author', 'email'], message: 'that address is reserved' }
)
export type RegisterPluginBody = z.output<typeof registerPluginSchema>

// The one-time code of an install, in the body (never in a query string, which is logged)
export const exchangeSetupSchema = z.strictObject({ code: z.string().refine(isSetupCode) })
export type ExchangeSetupBody = z.output<typeof exchangeSetupSchema>

// What the owner typed to revoke an integration plugin (TDD_10 §6.6). Optional here because the revocation of a channel plugin takes
// no body; the service refuses an integration plugin whose word is not exactly `PLUGIN_REVOKE_CONFIRMATION`.
export const revokePluginSchema = z
  // Not strict: the route took no body before, and a client that sends more than the word is not refused for it
  .object({
    confirmation: z.string().max(PluginRevokeLimits.CONFIRMATION_MAX_LENGTH).optional()
  })
  .optional()
export type RevokePluginBody = z.output<typeof revokePluginSchema>
