import { z } from 'zod'

import { CHANNEL_ID_PATTERN, CodePluginAuthor, OfficialPluginAuthor } from '@platform/core/domain'
import { pluginManifestSchema } from '@platform/plugins/runtime'

// Only the shape of the id: the service looks for the plugin in the catalog
export const installPluginSchema = z.strictObject({
  pluginId: z.string().regex(CHANNEL_ID_PATTERN)
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
