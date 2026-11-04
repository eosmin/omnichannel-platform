import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

import { assignableOnly, isAssigneeRefusal } from './assignees'

describe('assignableOnly', () => {
  it('keeps who can be given a conversation, in order, and drops the rest', () => {
    const members = [
      { id: 'a', canBeAssigned: true },
      { id: 'b', canBeAssigned: false },
      { id: 'c', canBeAssigned: true }
    ]

    expect(assignableOnly(members).map(member => member.id)).toEqual(['a', 'c'])
  })

  it('is empty when nobody can', () => {
    expect(assignableOnly([{ canBeAssigned: false }])).toEqual([])
  })
})

describe('isAssigneeRefusal', () => {
  it('is the not-found answer of the api, and nothing else', () => {
    expect(
      isAssigneeRefusal(new ApiError(404, ErrorCodes.RESOURCE_NOT_FOUND, 'assignee not found'))
    ).toBe(true)
    expect(isAssigneeRefusal(new ApiError(403, ErrorCodes.PERMISSION_DENIED, 'x'))).toBe(false)
    expect(isAssigneeRefusal(new TypeError('boom'))).toBe(false)
  })
})
