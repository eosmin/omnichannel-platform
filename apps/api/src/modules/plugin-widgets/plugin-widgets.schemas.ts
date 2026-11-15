import { z } from 'zod'

import {
  pluginBridgeRequestSchema,
  pluginWidgetDeclarationSchema,
  pluginWidgetVisibilitySchema,
  PluginWidgetLimits,
  uuidSchema
} from '@platform/core/domain'

// The id of a widget, the one the manifest declares
export const widgetIdSchema = pluginWidgetDeclarationSchema.shape.id

export const openWidgetSessionSchema = z.strictObject({
  installationId: uuidSchema,
  conversationId: uuidSchema,
  // Which widget of the installation the session is for: hiding a widget ends its sessions and no other's
  widgetId: widgetIdSchema.optional()
})
export type OpenWidgetSessionBody = z.infer<typeof openWidgetSessionSchema>

// The token is the one the session answered with; the request is what the frame asked, already parsed
// by the page and parsed again here because the page is not trusted either
export const widgetBridgeSchema = z.strictObject({
  token: z.string().min(1).max(PluginWidgetLimits.TOKEN_MAX_LENGTH),
  request: pluginBridgeRequestSchema
})
export type WidgetBridgeBody = z.infer<typeof widgetBridgeSchema>

export const widgetVisibilitySchema = pluginWidgetVisibilitySchema
export type WidgetVisibilityBody = z.infer<typeof widgetVisibilitySchema>
