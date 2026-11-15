import { z } from 'zod'

import { pluginBridgeRequestSchema, PluginWidgetLimits, uuidSchema } from '@platform/core/domain'

export const openWidgetSessionSchema = z.strictObject({
  installationId: uuidSchema,
  conversationId: uuidSchema
})
export type OpenWidgetSessionBody = z.infer<typeof openWidgetSessionSchema>

// The token is the one the session answered with; the request is what the frame asked, already parsed
// by the page and parsed again here because the page is not trusted either
export const widgetBridgeSchema = z.strictObject({
  token: z.string().min(1).max(PluginWidgetLimits.TOKEN_MAX_LENGTH),
  request: pluginBridgeRequestSchema
})
export type WidgetBridgeBody = z.infer<typeof widgetBridgeSchema>
