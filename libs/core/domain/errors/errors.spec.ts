import { ErrorCodes } from './error-codes'
import { PlatformException } from './platform-exception'

describe('ErrorCodes', () => {
  it('uses each key as its own value', () => {
    for (const [key, value] of Object.entries(ErrorCodes)) {
      expect(value).toBe(key)
    }
  })

  it('has no billing, quota, AI or staff codes in the single-owner MVP', () => {
    const forbidden = /^(QUOTA_|SUBSCRIPTION_|FEATURE_NOT_IN_PLAN|AI_|IMPERSONATION_|STAFF_)/
    expect(Object.keys(ErrorCodes).filter(key => forbidden.test(key))).toEqual([])
  })
})

describe('PlatformException', () => {
  it('carries the code, status and metadata and defaults to 500', () => {
    const error = new PlatformException(ErrorCodes.INTERNAL_ERROR, 'boom')
    expect(error.code).toBe(ErrorCodes.INTERNAL_ERROR)
    expect(error.statusCode).toBe(500)
    expect(error.name).toBe('PlatformException')

    const withMetadata = new PlatformException(ErrorCodes.INSUFFICIENT_INVENTORY, 'short', 409, {
      available: 2
    })
    expect(withMetadata.statusCode).toBe(409)
    expect(withMetadata.metadata).toEqual({ available: 2 })
    expect(withMetadata).toBeInstanceOf(Error)
  })
})
