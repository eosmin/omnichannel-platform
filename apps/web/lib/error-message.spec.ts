import { ApiError } from '@platform/api-client'

import { errorCodeOf, knownErrorCode } from './error-message'

describe('errorCodeOf', () => {
  it('keeps the code of an api error the page knows', () => {
    expect(errorCodeOf(new ApiError(401, 'AUTH_TOKEN_INVALID', 'x'))).toBe('AUTH_TOKEN_INVALID')
  })

  it('falls to the generic code for an unknown code and for any other error', () => {
    expect(errorCodeOf(new ApiError(400, 'SOMETHING_NEW', 'x'))).toBe('INTERNAL_ERROR')
    expect(errorCodeOf(new TypeError('boom'))).toBe('INTERNAL_ERROR')
  })
})

describe('knownErrorCode', () => {
  it('keeps a code the page knows and turns any other text into the generic code', () => {
    expect(knownErrorCode('CHANNEL_WINDOW_EXPIRED')).toBe('CHANNEL_WINDOW_EXPIRED')
    expect(knownErrorCode('timeout')).toBe('INTERNAL_ERROR')
  })
})
