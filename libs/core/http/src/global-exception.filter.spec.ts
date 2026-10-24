import { ErrorCodes } from '@platform/core/errors'

import { checksOf, codeForHttpStatus } from './global-exception.filter'

describe('checksOf', () => {
  it('keeps only the status of each check', () => {
    const body = {
      status: 'error',
      info: {},
      error: { database: { status: 'down', message: 'connect ECONNREFUSED 10.0.0.7:6432' } },
      details: {
        database: { status: 'down', message: 'connect ECONNREFUSED 10.0.0.7:6432' },
        redis: { status: 'up' }
      }
    }
    expect(checksOf(body)).toEqual({ database: 'down', redis: 'up' })
  })

  it('answers an empty object for anything that is not a Terminus body', () => {
    for (const body of [undefined, null, 'text', 42, [], {}, { details: 'x' }, { details: [] }]) {
      expect(checksOf(body)).toEqual({})
    }
  })

  it('marks a check with no status as unknown', () => {
    expect(checksOf({ details: { database: {}, cache: 'x' } })).toEqual({
      database: 'unknown',
      cache: 'unknown'
    })
  })
})

describe('codeForHttpStatus', () => {
  it('maps the statuses Nest raises to the codes of the contract', () => {
    expect(codeForHttpStatus(401)).toBe(ErrorCodes.AUTH_UNAUTHORIZED)
    expect(codeForHttpStatus(403)).toBe(ErrorCodes.PERMISSION_DENIED)
    expect(codeForHttpStatus(404)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    expect(codeForHttpStatus(429)).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
    expect(codeForHttpStatus(400)).toBe(ErrorCodes.VALIDATION_FAILED)
    expect(codeForHttpStatus(409)).toBe(ErrorCodes.VALIDATION_FAILED)
    expect(codeForHttpStatus(503)).toBe(ErrorCodes.INTERNAL_ERROR)
  })
})
