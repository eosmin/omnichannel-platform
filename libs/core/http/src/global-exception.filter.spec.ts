import type { ArgumentsHost } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import * as Sentry from '@sentry/nestjs'
import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes } from '@platform/core/errors'

import { checksOf, codeForHttpStatus, GlobalExceptionFilter } from './global-exception.filter'

jest.mock('@sentry/nestjs', () => ({ withScope: jest.fn(), captureException: jest.fn() }))

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

describe('GlobalExceptionFilter, report of an unexpected error', () => {
  it('sends the url to Sentry without the secrets of the path or the query', () => {
    const setContext = jest.fn()
    const scope = { setContext, setUser: jest.fn(), setTag: jest.fn() }
    jest
      .mocked(Sentry.withScope)
      .mockImplementation(((callback: (value: typeof scope) => unknown) =>
        callback(scope)) as never)
    const response = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() }
    const request = {
      url: '/api/v1/invitations/abc123?hub.verify_token=s3cret&page=2',
      method: 'GET',
      correlationId: 'c-1'
    }
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost
    const logger = {
      error: jest.fn(),
      warn: jest.fn(),
      setContext: jest.fn()
    } as unknown as PinoLogger
    const filter = new GlobalExceptionFilter(logger, {
      inc: jest.fn()
    } as unknown as Counter<string>)

    filter.catch(new Error('boom'), host)

    expect(setContext).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        url: '/api/v1/invitations/[redacted]?hub.verify_token=[redacted]&page=2'
      })
    )
  })
})
