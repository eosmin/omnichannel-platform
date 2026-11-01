import { z } from 'zod'

import { VISITOR_ID_PATTERN } from '@platform/core/domain'

// The site key is checked by WidgetSites, which answers "not found" for anything that is not one
export const widgetBootstrapSchema = z.strictObject({
  siteKey: z.string().min(1).max(64),
  visitorId: z.string().regex(VISITOR_ID_PATTERN)
})
export type WidgetBootstrapBody = z.output<typeof widgetBootstrapSchema>

// A file the visitor wants to send. Whether the type is allowed and the size fits is answered with the
// error codes of any upload (FILE_TYPE_NOT_ALLOWED, FILE_TOO_LARGE), not as a malformed body.
export const widgetUploadSchema = z.strictObject({
  visitorToken: z.string().min(1).max(512),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(127),
  fileSizeBytes: z.number().int().positive()
})
export type WidgetUploadBody = z.output<typeof widgetUploadSchema>

// The file of a message of the visitor's own conversation, by its id (the one the history carries)
export const widgetDownloadSchema = z.strictObject({
  visitorToken: z.string().min(1).max(512),
  mediaId: z.uuid()
})
export type WidgetDownloadBody = z.output<typeof widgetDownloadSchema>
