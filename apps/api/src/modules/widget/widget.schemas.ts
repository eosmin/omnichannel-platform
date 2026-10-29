import { z } from 'zod'

import { VISITOR_ID_PATTERN } from '@platform/core/domain'

// The site key is checked by WidgetSites, which answers "not found" for anything that is not one
export const widgetBootstrapSchema = z.strictObject({
  siteKey: z.string().min(1).max(64),
  visitorId: z.string().regex(VISITOR_ID_PATTERN)
})
export type WidgetBootstrapBody = z.output<typeof widgetBootstrapSchema>
