import { ApiError } from '@platform/api-client'

import { errorCodeOf, errorDetailOf } from './error-message'

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

describe('errorDetailOf', () => {
  it('names the limit of a file that is too large, in megabytes', () => {
    const error = new ApiError(400, 'FILE_TOO_LARGE', 'x', null, { maxSizeBytes: 10 * 1024 * 1024 })
    expect(errorDetailOf(error)).toEqual({
      key: 'fileTooLarge',
      values: { megabytes: 10 }
    })
  })

  it('rounds a limit that is not a whole number of megabytes up to one decimal', () => {
    const error = new ApiError(400, 'FILE_TOO_LARGE', 'x', null, {
      maxSizeBytes: 1.5 * 1024 * 1024
    })
    expect(errorDetailOf(error)).toEqual({
      key: 'fileTooLarge',
      values: { megabytes: 1.5 }
    })
  })

  it.each([undefined, 0, -1, '10', Number.NaN])('has no detail for a limit of %j', limit => {
    const error = new ApiError(400, 'FILE_TOO_LARGE', 'x', null, { maxSizeBytes: limit })
    expect(errorDetailOf(error)).toBeNull()
  })

  it('names the wait of a refusal for too many requests, in seconds up to a minute and in minutes after', () => {
    const wait = (seconds: number): unknown =>
      errorDetailOf(
        new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, { retryAfterSeconds: seconds })
      )
    expect(wait(30)).toEqual({ key: 'rateLimit', values: { value: 30, unit: 'seconds' } })
    expect(wait(60)).toEqual({ key: 'rateLimit', values: { value: 60, unit: 'seconds' } })
    expect(wait(61)).toEqual({ key: 'rateLimit', values: { value: 2, unit: 'minutes' } })
    expect(wait(900)).toEqual({ key: 'rateLimit', values: { value: 15, unit: 'minutes' } })
  })

  it.each([undefined, 0, -5, '30'])('has no detail for a wait of %j', seconds => {
    const error = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, {
      retryAfterSeconds: seconds
    })
    expect(errorDetailOf(error)).toBeNull()
  })

  it('names the kind of a conflict, so a check that is running is not told to reload', () => {
    const error = new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, {
      conflict: 'chain_check_running'
    })
    expect(errorDetailOf(error)).toEqual({ key: 'conflicts.chain_check_running' })
  })

  it.each([undefined, '', 7, 'has space'])('has no detail for a conflict of %j', conflict => {
    const error = new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, { conflict })
    expect(errorDetailOf(error)).toBeNull()
  })

  it('has none for other codes or other errors', () => {
    expect(
      errorDetailOf(new ApiError(400, 'VALIDATION_FAILED', 'x', null, { maxSizeBytes: 5 }))
    ).toBeNull()
    expect(errorDetailOf(new TypeError('boom'))).toBeNull()
  })
})
