import { z } from 'zod'

import { siteOriginsSchema } from '@platform/channels/web-widget'

// The sites that may load the widget. The error of a bad entry carries its position in `path`.
export const widgetOriginsSchema = z.strictObject({ siteOrigins: siteOriginsSchema })
export type WidgetOriginsBody = z.output<typeof widgetOriginsSchema>

// Whether the widget asks the visitor for a name, an email and a phone before the first message
export const widgetPreChatSchema = z.strictObject({ enabled: z.boolean() })
export type WidgetPreChatBody = z.output<typeof widgetPreChatSchema>
