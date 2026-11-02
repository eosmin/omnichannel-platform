import { ApiError } from '@platform/api-client'

import { retryAfterSecondsOf } from './team-errors'

describe('retryAfterSecondsOf', () => {
  it('reads the wait of a rate limit', () => {
    const error = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, { retryAfterSeconds: 59.2 })
    expect(retryAfterSecondsOf(error)).toBe(60)
  })

  it('is null for another code, a missing or a bad number, and a non api error', () => {
    expect(retryAfterSecondsOf(new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, {}))).toBeNull()
    expect(retryAfterSecondsOf(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, {}))).toBeNull()
    const bad = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, { retryAfterSeconds: '60' })
    expect(retryAfterSecondsOf(bad)).toBeNull()
    expect(retryAfterSecondsOf(new Error('x'))).toBeNull()
  })
})
