import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

import { currentNoteOf } from './stale-note'

const conflict = (metadata: Record<string, unknown>): ApiError =>
  new ApiError(409, ErrorCodes.RESOURCE_CONFLICT, 'the note changed', null, metadata)

describe('currentNoteOf', () => {
  it('reads the text and the version the api says the note has now', () => {
    const error = conflict({ current: { content: 'new text', version: 4 } })
    expect(currentNoteOf(error)).toEqual({ content: 'new text', version: 4 })
  })

  it('is null for a conflict that carries no current note', () => {
    expect(currentNoteOf(conflict({}))).toBeNull()
    expect(currentNoteOf(conflict({ current: { content: 'x', version: 'four' } }))).toBeNull()
  })

  it('is null for any other error', () => {
    const other = new ApiError(403, ErrorCodes.PERMISSION_DENIED, 'no', null, {
      current: { content: 'x', version: 1 }
    })
    expect(currentNoteOf(other)).toBeNull()
    expect(currentNoteOf(new Error('boom'))).toBeNull()
  })
})
