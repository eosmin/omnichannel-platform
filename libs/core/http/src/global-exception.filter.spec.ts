import { type ArgumentsHost, BadRequestException, HttpException } from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import type { Counter } from '@prometheus-io/client'
import * as Sentry from '@sentry/nestjs'
import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes, HttpHeaders, PlatformException } from '@platform/core/errors'

import {
  bodyParserRefusal,
  checksOf,
  codeForHttpStatus,
  GlobalExceptionFilter
} from './global-exception.filter'

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
    expect(codeForHttpStatus(413)).toBe(ErrorCodes.PAYLOAD_TOO_LARGE)
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

function parserError(over: Record<string, unknown>): Error {
  return Object.assign(new Error('parser'), { expose: true, ...over })
}

describe('bodyParserRefusal', () => {
  it('recognises the refusals of the body parser by their shape', () => {
    expect(bodyParserRefusal(parserError({ status: 413, type: 'entity.too.large' }))).toEqual({
      status: 413,
      type: 'entity.too.large'
    })
    expect(bodyParserRefusal(parserError({ status: 415, type: 'encoding.unsupported' }))).toEqual({
      status: 415,
      type: 'encoding.unsupported'
    })
    expect(bodyParserRefusal(parserError({ status: 400, type: 'request.aborted' }))).toBeDefined()
  })

  it('leaves alone anything that is not a client refusal of the parser', () => {
    expect(
      bodyParserRefusal({ status: 413, type: 'entity.too.large', expose: true })
    ).toBeUndefined()
    expect(
      bodyParserRefusal(parserError({ status: 500, type: 'entity.too.large' }))
    ).toBeUndefined()
    expect(bodyParserRefusal(parserError({ status: 413 }))).toBeUndefined()
    expect(
      bodyParserRefusal(parserError({ type: 'x', status: 413, expose: false }))
    ).toBeUndefined()
    expect(bodyParserRefusal(new Error('boom'))).toBeUndefined()
    // An http-errors object of another library is not a parser refusal
    expect(bodyParserRefusal(parserError({ status: 403, type: 'csrf.invalid' }))).toBeUndefined()
  })
})

describe('GlobalExceptionFilter, a body the parser refused', () => {
  beforeEach(() => jest.mocked(Sentry.captureException).mockClear())

  function run(exception: unknown) {
    const response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn<void, [unknown]>()
    }
    const request = {
      url: '/api/v1/invitations/tok3n/accept',
      path: '/api/v1/invitations/tok3n/accept',
      method: 'POST',
      correlationId: 'c-1'
    }
    const warn = jest.fn()
    const logger = { error: jest.fn(), warn } as unknown as PinoLogger
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost
    new GlobalExceptionFilter(logger, { inc: jest.fn() } as unknown as Counter<string>).catch(
      exception,
      host
    )
    return { response, warn }
  }

  it('answers with the status of the parser, logs only the kind and never reports it', () => {
    const secret = 'the-body-of-the-request'
    const { response, warn } = run(
      parserError({ status: 415, type: 'encoding.unsupported', body: secret })
    )
    expect(response.status).toHaveBeenCalledWith(415)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok3n')
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(secret)
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  it('answers 413 with its own code', () => {
    const { response } = run(parserError({ status: 413, type: 'entity.too.large' }))
    expect(response.status).toHaveBeenCalledWith(413)
    const body = response.json.mock.calls[0]?.[0] as { error: { code: string } }
    expect(body.error.code).toBe(ErrorCodes.PAYLOAD_TOO_LARGE)
  })
})

// SEC-429: Nest names the class in the message of its throttler error ("ThrottlerException: Too Many
// Requests"). The answer carries the code of the contract and a message of ours, never a class name.
describe('GlobalExceptionFilter, the message of a Nest error', () => {
  function answer(exception: unknown) {
    const response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn<void, [unknown]>()
    }
    const request = { url: '/api/v1/x', path: '/api/v1/x', method: 'POST', correlationId: 'c-1' }
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as PinoLogger
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost
    new GlobalExceptionFilter(logger, { inc: jest.fn() } as unknown as Counter<string>).catch(
      exception,
      host
    )
    const [body] = response.json.mock.calls[0] as [{ error: { code: string; message: string } }]
    const [status] = response.status.mock.calls[0] as [number]
    return {
      status,
      body: JSON.stringify(body),
      error: body.error
    }
  }

  it('answers a rate limit with its code and a message that names no class', () => {
    const { status, body, error } = answer(new ThrottlerException())
    expect(status).toBe(429)
    expect(error.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
    expect(body).not.toMatch(/Throttler|Exception/)
    expect(body).not.toContain('stack')
    expect(error.message).toBe('Too many requests')
  })

  it('takes the name of a class off the message of any other Nest error', () => {
    const { error } = answer(new HttpException('SomethingException: it broke', 400))
    expect(error.message).toBe('it broke')
    expect(answer(new BadRequestException('plain words')).error.message).toBe('plain words')
  })
})

describe('GlobalExceptionFilter, a database lock that was waited for too long', () => {
  beforeEach(() => jest.mocked(Sentry.captureException).mockClear())

  function run(exception: unknown) {
    const response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      json: jest.fn<void, [unknown]>()
    }
    const request = {
      url: '/api/v1/customers?search=secret',
      path: '/api/v1/customers',
      method: 'GET',
      correlationId: 'c-9'
    }
    const warn = jest.fn()
    const logger = { error: jest.fn(), warn } as unknown as PinoLogger
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost
    new GlobalExceptionFilter(logger, { inc: jest.fn() } as unknown as Counter<string>).catch(
      exception,
      host
    )
    return { response, warn }
  }

  const lockTimeout = {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
    message: 'Raw query failed. Code: `55P03`. select * from customers where email = ...'
  }

  it('answers 503 DATABASE_BUSY with the time to wait, and says nothing of the query', () => {
    const { response } = run(lockTimeout)

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: ErrorCodes.DATABASE_BUSY,
        message: 'The service is busy, try again in a moment',
        metadata: { retryAfterSeconds: 5 }
      },
      correlationId: 'c-9'
    })
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('customers')
    expect(response.setHeader).toHaveBeenCalledWith(HttpHeaders.RETRY_AFTER, '5')
  })

  it('logs a warning with the route only, and does not report it as an incident', () => {
    const { warn } = run(lockTimeout)

    expect(warn).toHaveBeenCalledWith(
      { route: 'unknown' },
      'a request gave up waiting for a database lock'
    )
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  it('leaves any other database error as the 500 it is', () => {
    const { response } = run({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23505' } } }
    })

    expect(response.status).toHaveBeenCalledWith(500)
    expect(Sentry.captureException).toHaveBeenCalled()
  })
})

describe('GlobalExceptionFilter, the Retry-After header', () => {
  function run(exception: unknown) {
    const response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      json: jest.fn<void, [unknown]>()
    }
    const request = { url: '/api/v1/x', path: '/api/v1/x', method: 'POST', correlationId: 'c-3' }
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as PinoLogger
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost
    new GlobalExceptionFilter(logger, { inc: jest.fn() } as unknown as Counter<string>).catch(
      exception,
      host
    )
    return response
  }
  const refusal = (metadata?: Record<string, unknown>) =>
    new PlatformException(ErrorCodes.RATE_LIMIT_EXCEEDED, 'too many', 429, metadata)

  it('says it in the header too when the body says how long to wait', () => {
    const response = run(refusal({ retryAfterSeconds: 42 }))

    expect(response.setHeader).toHaveBeenCalledWith(HttpHeaders.RETRY_AFTER, '42')
    // The contract of the body is the same as ever
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
        message: 'too many',
        metadata: { retryAfterSeconds: 42 }
      },
      correlationId: 'c-3'
    })
  })

  it('rounds a fraction up to whole seconds', () => {
    const response = run(refusal({ retryAfterSeconds: 2.2 }))

    expect(response.setHeader).toHaveBeenCalledWith(HttpHeaders.RETRY_AFTER, '3')
  })

  it.each([
    ['no metadata', undefined],
    ['metadata with no wait', { other: 1 }],
    ['a wait that is zero', { retryAfterSeconds: 0 }],
    ['a negative wait', { retryAfterSeconds: -5 }],
    ['a wait that is not a number', { retryAfterSeconds: '30' }],
    ['a wait that is not finite', { retryAfterSeconds: Infinity }],
    ['a wait too large to write as whole seconds', { retryAfterSeconds: 1e21 }]
  ])('does not set it for %s', (_name, metadata) => {
    const response = run(refusal(metadata))

    expect(response.setHeader).not.toHaveBeenCalled()
  })

  it.each([
    ['a 400', 400],
    ['a 403', 403],
    ['a 409', 409]
  ])('does not set it on %s, where the header means something else', (_name, status) => {
    const response = run(
      new PlatformException(ErrorCodes.VALIDATION_FAILED, 'no', status, { retryAfterSeconds: 30 })
    )

    expect(response.setHeader).not.toHaveBeenCalled()
  })

  it('sets it on a 503 as well as on a 429', () => {
    const response = run(
      new PlatformException(ErrorCodes.DATABASE_BUSY, 'busy', 503, { retryAfterSeconds: 7 })
    )

    expect(response.setHeader).toHaveBeenCalledWith(HttpHeaders.RETRY_AFTER, '7')
  })

  it('leaves the 429 of the rate limiter alone: its guard writes the header, not the filter', () => {
    const response = run(new ThrottlerException())

    expect(response.status).toHaveBeenCalledWith(429)
    expect(response.setHeader).not.toHaveBeenCalled()
  })
})
