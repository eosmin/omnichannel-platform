import { ApiError } from '@platform/api-client'

import { firstIssueOf, missingPermissionsOf } from './error-message'

describe('missingPermissionsOf', () => {
  it('reads the permissions a refusal says are missing', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'Missing permission', null, {
      required: ['conversations:resolve', 'conversations:assign']
    })
    expect(missingPermissionsOf(error)).toEqual(['conversations:resolve', 'conversations:assign'])
  })

  it('is empty for any other error, or a refusal that names nothing', () => {
    expect(missingPermissionsOf(new ApiError(403, 'PERMISSION_DENIED', 'x'))).toEqual([])
    expect(
      missingPermissionsOf(new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, { required: ['a:b'] }))
    ).toEqual([])
    expect(missingPermissionsOf(new TypeError('boom'))).toEqual([])
  })

  it('ignores entries that are not text', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'x', null, { required: ['a:b', 7, null] })
    expect(missingPermissionsOf(error)).toEqual(['a:b'])
  })
})

describe('firstIssueOf', () => {
  const refusal = (issues: unknown): ApiError =>
    new ApiError(400, 'VALIDATION_FAILED', 'x', null, { issues })

  it('names the field of the first issue', () => {
    expect(firstIssueOf(refusal([{ path: 'phone', code: 'custom', message: 'm' }]))).toEqual({
      field: 'phone',
      index: null
    })
  })

  it('gives the position inside a list field', () => {
    expect(
      firstIssueOf(refusal([{ path: 'siteOrigins.1', code: 'custom', message: 'm' }]))
    ).toEqual({ field: 'siteOrigins', index: 1 })
  })

  it('skips an issue with no path and is null when none names a field', () => {
    expect(firstIssueOf(refusal([{ path: '' }, { path: 'name' }]))).toEqual({
      field: 'name',
      index: null
    })
    expect(firstIssueOf(refusal([{ path: '' }]))).toBeNull()
    expect(firstIssueOf(refusal('nope'))).toBeNull()
    expect(firstIssueOf(new ApiError(409, 'RESOURCE_CONFLICT', 'x'))).toBeNull()
  })
})
