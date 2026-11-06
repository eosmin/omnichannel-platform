import { ApiError } from '@platform/api-client'

import { errorCodeOf } from './error-message'

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
