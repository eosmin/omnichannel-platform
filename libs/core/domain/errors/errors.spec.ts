import { STATUS_CODES } from 'node:http'

import { ErrorCodes } from './error-codes'
import { resourceConflict, resourceNotFound, unauthorized } from './error-factories'
import { HttpStatusCodes } from './http-status-codes'
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

describe('HttpStatusCodes', () => {
  // Each name must be the standard reason phrase of its number (Node knows them): a mistyped number,
  // GONE: 401 for instance, fails here, and adding a status needs no edit to this test. A name that
  // is not the phrase (URI_TOO_LONG) needs a line in phraseOf.
  const phraseOf = (name: string): string =>
    name === 'OK'
      ? 'OK'
      : name
          .split('_')
          .map(word => word.charAt(0) + word.slice(1).toLowerCase())
          .join(' ')

  it.each(Object.entries(HttpStatusCodes))('%s is the status %i of that name', (name, code) => {
    expect(STATUS_CODES[code]).toBe(phraseOf(name))
  })

  it('gives each status one name', () => {
    const values = Object.values(HttpStatusCodes)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('the answer factories', () => {
  it('resourceNotFound builds a 404 that names what was not found', () => {
    const error = resourceNotFound('customer')

    expect(error).toBeInstanceOf(PlatformException)
    expect(error.code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    expect(error.statusCode).toBe(404)
    expect(error.message).toBe('customer not found')
    expect(error.metadata).toBeUndefined()
  })

  it('resourceConflict builds a 409 with the metadata that tells the client what to do', () => {
    const error = resourceConflict('the handle belongs to another customer', { customerId: 'c1' })

    expect(error.code).toBe(ErrorCodes.RESOURCE_CONFLICT)
    expect(error.statusCode).toBe(409)
    expect(error.message).toBe('the handle belongs to another customer')
    expect(error.metadata).toEqual({ customerId: 'c1' })
    expect(resourceConflict('no metadata').metadata).toBeUndefined()
  })

  it('unauthorized builds a 401', () => {
    const error = unauthorized('no access token', { header: 'authorization' })

    expect(error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED)
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe('no access token')
    expect(error.metadata).toEqual({ header: 'authorization' })
    expect(unauthorized('x').metadata).toBeUndefined()
  })
})
