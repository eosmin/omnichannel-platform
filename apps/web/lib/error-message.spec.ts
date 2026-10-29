import { ApiError } from '@platform/api-client'

import { errorCodeOf } from './error-message'

describe('errorCodeOf', () => {
  it('keeps the code of an api error the page knows', () => {
    expect(errorCodeOf(new ApiError(401, 'AUTH_TOKEN_INVALID', 'x'))).toBe('AUTH_TOKEN_INVALID')
  })

  it('falls to the generic code for an unknown code and for any other error', () => {
    expect(errorCodeOf(new ApiError(400, 'SOMETHING_NEW', 'x'))).toBe('INTERNAL_ERROR')
    expect(errorCodeOf(new TypeError('boom'))).toBe('INTERNAL_ERROR')
  })
})
