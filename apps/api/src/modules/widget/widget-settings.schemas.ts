import { z } from 'zod'

import { siteOriginsSchema } from '@platform/channels/web-widget'

// The sites that may load the widget. The error of a bad entry carries its position in `path`.
export const widgetOriginsSchema = z.strictObject({ siteOrigins: siteOriginsSchema })
export type WidgetOriginsBody = z.output<typeof widgetOriginsSchema>
