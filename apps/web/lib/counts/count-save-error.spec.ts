import { ApiError } from '@platform/api-client'

import { isRetryableSaveError } from './count-save-error'

const error = (status: number) => new ApiError(status, 'X', 'x')

describe('isRetryableSaveError', () => {
  it.each([0, 408, 429, 500, 502, 503])('keeps the quantities to send later after a %p', status => {
    expect(isRetryableSaveError(error(status))).toBe(true)
  })

  it.each([400, 401, 403, 404, 409])(
    'stops after a %p: the same request gets the same answer',
    status => {
      expect(isRetryableSaveError(error(status))).toBe(false)
    }
  )

  it("treats an error that is not the api's as a lost connection", () => {
    expect(isRetryableSaveError(new TypeError('Failed to fetch'))).toBe(true)
  })
})
