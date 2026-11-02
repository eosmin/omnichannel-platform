import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { assertMediaServable } from './media-guard'

function refusal(status: string): PlatformException {
  try {
    assertMediaServable(status)
  } catch (error) {
    if (error instanceof PlatformException) return error
    throw error
  }
  throw new Error(`"${status}" was not refused`)
}

describe('assertMediaServable', () => {
  it('lets a clean file through', () => {
    expect(() => assertMediaServable('clean')).not.toThrow()
  })

  it.each([
    ['infected', ErrorCodes.FILE_INFECTED, HttpStatusCodes.FORBIDDEN],
    ['unscannable', ErrorCodes.FILE_UNSCANNABLE, HttpStatusCodes.GONE],
    ['pending', ErrorCodes.FILE_NOT_READY, HttpStatusCodes.CONFLICT],
    ['a status nobody knows', ErrorCodes.FILE_NOT_READY, HttpStatusCodes.CONFLICT]
  ])('refuses %s with its own code and status', (status, code, httpStatus) => {
    const error = refusal(status)
    expect(error.code).toBe(code)
    expect(error.statusCode).toBe(httpStatus)
  })
})
