import { ApiError } from '@platform/api-client'

import { accountHolderOf, firstIssueOf, missingPermissionsOf } from './error-message'

describe('missingPermissionsOf', () => {
  it('reads the permissions a refusal says are missing', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'Missing permission', null, {
      required: ['conversations:resolve', 'conversations:assign']
    })
    expect(missingPermissionsOf(error)).toEqual(['conversations:resolve', 'conversations:assign'])
  })

  it('reads the same list when the api sends it as `permissions` (a change of conversation status)', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'x', null, {
      permissions: ['conversations:resolve']
    })
    expect(missingPermissionsOf(error)).toEqual(['conversations:resolve'])
  })

  it('prefers `required` when both come', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'x', null, {
      required: ['a:b'],
      permissions: ['c:d']
    })
    expect(missingPermissionsOf(error)).toEqual(['a:b'])
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

describe('accountHolderOf', () => {
  const inUse = (metadata: Record<string, unknown>): ApiError =>
    new ApiError(409, 'CHANNEL_ACCOUNT_IN_USE', 'x', null, metadata)

  it('reads the store the api named', () => {
    expect(accountHolderOf(inUse({ storeName: 'Tienda Sur' }))).toBe('Tienda Sur')
  })

  it('names nothing when the api did not, or the value is not text', () => {
    expect(accountHolderOf(inUse({}))).toBeNull()
    expect(accountHolderOf(inUse({ storeName: 7 }))).toBeNull()
    expect(accountHolderOf(inUse({ storeName: '  ' }))).toBeNull()
  })

  it('reads it only from this refusal, never from another code or a plain error', () => {
    expect(
      accountHolderOf(new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, { storeName: 'Sur' }))
    ).toBeNull()
    expect(accountHolderOf(new TypeError('boom'))).toBeNull()
  })

  it('cuts a very long name', () => {
    const name = accountHolderOf(inUse({ storeName: 'a'.repeat(500) }))
    expect(Array.from(name ?? '').length).toBeLessThanOrEqual(80)
  })
})
