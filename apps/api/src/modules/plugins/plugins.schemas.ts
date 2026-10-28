import { z } from 'zod'

import { CHANNEL_ID_PATTERN } from '@platform/core/domain'

// Only the shape of the id: the service looks for the plugin in the catalog
export const installPluginSchema = z.strictObject({
  pluginId: z.string().regex(CHANNEL_ID_PATTERN)
})
export type InstallPluginBody = z.output<typeof installPluginSchema>
