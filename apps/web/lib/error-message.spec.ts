import { ApiError } from '@platform/api-client'

import { errorCodeOf, rateLimitWaitOf } from './error-message'

describe('errorCodeOf', () => {
  it('keeps the code of an api error', () => {
    expect(errorCodeOf(new ApiError(401, 'AUTH_TOKEN_INVALID', 'x'))).toBe('AUTH_TOKEN_INVALID')
  })

  // The page holds no table of the codes: a code of a newer server is kept, and the message shows the generic text
  it('keeps a code the page may not know, and is the generic code for any other error', () => {
    expect(errorCodeOf(new ApiError(400, 'SOMETHING_NEW', 'x'))).toBe('SOMETHING_NEW')
    expect(errorCodeOf(new TypeError('boom'))).toBe('INTERNAL_ERROR')
  })
})

// H-11: a refusal by rate limit says how long to wait, and the page shows it in the unit a person reads
describe('rateLimitWaitOf', () => {
  const limited = (seconds: unknown): ApiError =>
    new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, { retryAfterSeconds: seconds })

  it.each([
    [1, { unit: 'seconds', value: 1 }],
    [45, { unit: 'seconds', value: 45 }],
    [59.2, { unit: 'minutes', value: 1 }],
    [60, { unit: 'minutes', value: 1 }],
    [421, { unit: 'minutes', value: 8 }],
    [3599, { unit: 'minutes', value: 60 }],
    [3600, { unit: 'hours', value: 1 }],
    [86_400, { unit: 'hours', value: 24 }]
  ])('reads %s seconds as %j', (seconds, wait) => {
    expect(rateLimitWaitOf(limited(seconds))).toEqual(wait)
  })

  it('has no wait for an error that does not say one, or is not a rate limit', () => {
    expect(rateLimitWaitOf(limited(undefined))).toBeNull()
    expect(rateLimitWaitOf(limited(0))).toBeNull()
    expect(rateLimitWaitOf(limited('soon'))).toBeNull()
    expect(
      rateLimitWaitOf(new ApiError(400, 'VALIDATION_FAILED', 'x', null, { retryAfterSeconds: 5 }))
    ).toBeNull()
    expect(rateLimitWaitOf(new TypeError('boom'))).toBeNull()
  })
})
