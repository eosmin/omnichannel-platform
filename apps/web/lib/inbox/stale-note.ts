import { z } from 'zod'

import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

const staleNoteSchema = z.object({
  current: z.object({ content: z.string().nullable(), version: z.number().int() })
})

// A note edited with a version that is no longer the current one is refused with 409 and the text and
// version it has now. Null for any other error, and for an answer that does not carry them.
export function currentNoteOf(error: unknown): { content: string; version: number } | null {
  if (!(error instanceof ApiError) || !error.is(ErrorCodes.RESOURCE_CONFLICT)) return null
  const parsed = staleNoteSchema.safeParse(error.metadata)
  if (!parsed.success) return null
  return { content: parsed.data.current.content ?? '', version: parsed.data.current.version }
}
