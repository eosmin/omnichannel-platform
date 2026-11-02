import { z } from 'zod'

import {
  InboundLimits,
  type MediaUnavailableCode,
  MediaUnavailableCodes,
  PROVIDER_MEDIA_REF,
  RefetchableUnavailableCodes,
  UNAVAILABLE_FILES_KEY
} from '@platform/core/domain'

// Where a customer file that could not be kept came from, so that an agent can ask for it again. Only
// the id of the provider's media is kept, never a link: a link is a bearer credential that expires, and
// fetching it again would be a request to an address the customer chose. The worker checks the id on
// the way back as it does for the first fetch. Written by the worker when it gives up, read by the api.
export const LostFileLimits = { TEXT_MAX_LENGTH: 255 } as const

export const lostFileSourceSchema = z.object({
  pluginId: z.string().min(1).max(LostFileLimits.TEXT_MAX_LENGTH),
  connectionId: z.string().min(1).max(LostFileLimits.TEXT_MAX_LENGTH),
  ref: z.string().max(InboundLimits.MEDIA_REF_MAX_LENGTH).regex(PROVIDER_MEDIA_REF),
  contentType: z.string().max(LostFileLimits.TEXT_MAX_LENGTH),
  filename: z.string().max(LostFileLimits.TEXT_MAX_LENGTH).nullable()
})
export type LostFileSource = z.infer<typeof lostFileSourceSchema>

// One entry of `unavailableFiles`, as it is stored. An entry this version does not know how to read
// is kept untouched by whoever rewrites the list (see `UnavailableFileMarker`).
export const lostFileEntrySchema = z.object({
  index: z.int().min(0),
  // As stored: a code of a newer worker is drawn as the generic one (`displayCodeOf`) but never retried
  code: z.string(),
  // A source that does not parse is no source: the file just cannot be asked for again
  source: lostFileSourceSchema.optional().catch(undefined),
  // When an agent last asked for the file again (ISO text)
  requestedAt: z.string().optional()
})
export type LostFileEntry = z.infer<typeof lostFileEntrySchema>

export const lostFilesSchema = z.object({
  [UNAVAILABLE_FILES_KEY]: z.array(lostFileEntrySchema)
})

// Whether an agent may ask for this file again: the failure may pass and the source was kept
export const canRetryLostFile = (entry: LostFileEntry): boolean =>
  entry.source !== undefined && RefetchableUnavailableCodes.some(code => code === entry.code)

// What the thread draws for a code: one of a newer worker reads as the generic failure
export const displayCodeOf = (code: string): MediaUnavailableCode =>
  Object.values(MediaUnavailableCodes).find(known => known === code) ??
  MediaUnavailableCodes.FETCH_FAILED
