import * as Sentry from '@sentry/nestjs'

import { initSentry, scrubEvent, SENTRY_IGNORED_ERRORS } from './sentry'

jest.mock('@sentry/nestjs', () => ({ init: jest.fn() }))

const DSN = 'https://key@o1.ingest.sentry.io/1'

describe('initSentry', () => {
  beforeEach(() => jest.mocked(Sentry.init).mockClear())

  it('stays off without a DSN, and anywhere that is not a deployed environment', () => {
    expect(initSentry({ dsn: undefined, environment: 'production', release: undefined })).toBe(
      false
    )
    for (const environment of ['development', 'test']) {
      expect(initSentry({ dsn: DSN, environment, release: undefined })).toBe(false)
    }
    expect(Sentry.init).not.toHaveBeenCalled()
  })

  it('starts with a DSN outside development, scrubbing events and ignoring business errors', () => {
    expect(initSentry({ dsn: DSN, environment: 'production', release: 'abc123' })).toBe(true)
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: DSN,
        environment: 'production',
        release: 'abc123',
        beforeSend: scrubEvent,
        ignoreErrors: [...SENTRY_IGNORED_ERRORS]
      })
    )
  })

  it('leaves the release out when there is none', () => {
    initSentry({ dsn: DSN, environment: 'staging', release: undefined })
    expect(jest.mocked(Sentry.init).mock.calls[0]?.[0]).not.toHaveProperty('release')
  })

  it('does not report the business errors that are already logged', () => {
    expect(SENTRY_IGNORED_ERRORS).toContain('PlatformException')
  })
})

describe('scrubEvent', () => {
  it('removes secrets from the request body at any depth, whatever the case, and keeps the rest', () => {
    const event = {
      request: {
        data: {
          password: 'p',
          token: 't',
          RefreshToken: 'r',
          credentials: { oauth: 'o' },
          name: 'ok',
          user: { apiKey: 'k', profile: { accessToken: 'a', city: 'San Salvador' } },
          items: [{ secret: 's', sku: 'A-1' }]
        }
      }
    } as unknown as Sentry.ErrorEvent
    expect((scrubEvent(event).request as { data: object }).data).toEqual({
      password: '[removed]',
      token: '[removed]',
      RefreshToken: '[removed]',
      credentials: '[removed]',
      name: 'ok',
      user: { apiKey: '[removed]', profile: { accessToken: '[removed]', city: 'San Salvador' } },
      items: [{ secret: '[removed]', sku: 'A-1' }]
    })
  })

  it('removes the credentials from the headers', () => {
    const event = {
      request: { headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k', accept: 'json' } }
    } as unknown as Sentry.ErrorEvent
    expect(scrubEvent(event).request?.headers).toEqual({
      Authorization: '[removed]',
      'X-Api-Key': '[removed]',
      accept: 'json'
    })
  })

  it('leaves an event with no body, or a body that is not an object, alone', () => {
    const noBody = { message: 'x' } as Sentry.ErrorEvent
    expect(scrubEvent(noBody)).toBe(noBody)
    const text = { request: { data: 'raw' } } as Sentry.ErrorEvent
    expect(scrubEvent(text).request?.data).toBe('raw')
  })
})
