import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

import { canUnmerge, fieldChoicesOf, handleOwnerOf, knownConflicts } from './merge-form'

describe('knownConflicts', () => {
  it('keeps the fields the page can draw, in the order of the contact data', () => {
    expect(knownConflicts(['phone', 'shoeSize', 'name'])).toEqual(['name', 'phone'])
  })
})

describe('fieldChoicesOf', () => {
  it('keeps the survivor for a conflict nobody picked', () => {
    expect(fieldChoicesOf(['name', 'email'], { email: 'absorbed' })).toEqual({
      name: 'survivor',
      email: 'absorbed'
    })
  })

  it('sends nothing when there is no conflict', () => {
    expect(fieldChoicesOf([], {})).toEqual({})
  })
})

describe('handleOwnerOf', () => {
  const conflict = (metadata: Record<string, unknown>) =>
    new ApiError(409, ErrorCodes.RESOURCE_CONFLICT, 'taken', null, metadata)

  it('reads the owner of the handle from the conflict', () => {
    expect(handleOwnerOf(conflict({ customerId: 'c2' }))).toBe('c2')
  })

  it('is null when the conflict names nobody, or is not a conflict', () => {
    expect(handleOwnerOf(conflict({ customerId: null }))).toBeNull()
    expect(handleOwnerOf(conflict({}))).toBeNull()
    expect(
      handleOwnerOf(
        new ApiError(400, ErrorCodes.VALIDATION_FAILED, 'x', null, { customerId: 'c2' })
      )
    ).toBeNull()
    expect(handleOwnerOf(new Error('boom'))).toBeNull()
  })
})

describe('canUnmerge', () => {
  const now = new Date('2026-10-31T12:00:00.000Z')

  it('allows a merge inside its window that is still done', () => {
    expect(canUnmerge({ unmergeUntil: '2026-11-15T00:00:00.000Z', unmergedAt: null }, now)).toBe(
      true
    )
  })

  it('refuses one past its window, one undone, and a date that does not read', () => {
    expect(canUnmerge({ unmergeUntil: '2026-10-01T00:00:00.000Z', unmergedAt: null }, now)).toBe(
      false
    )
    expect(
      canUnmerge(
        { unmergeUntil: '2026-11-15T00:00:00.000Z', unmergedAt: '2026-10-30T00:00:00.000Z' },
        now
      )
    ).toBe(false)
    expect(canUnmerge({ unmergeUntil: 'soon', unmergedAt: null }, now)).toBe(false)
  })
})
