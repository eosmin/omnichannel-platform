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
        beforeSendTransaction: scrubEvent,
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
      password: '[redacted]',
      token: '[redacted]',
      RefreshToken: '[redacted]',
      credentials: '[redacted]',
      name: 'ok',
      user: { apiKey: '[redacted]', profile: { accessToken: '[redacted]', city: 'San Salvador' } },
      items: [{ secret: '[redacted]', sku: 'A-1' }]
    })
  })

  it('removes the credentials from the headers', () => {
    const event = {
      request: { headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k', accept: 'json' } }
    } as unknown as Sentry.ErrorEvent
    expect(scrubEvent(event).request?.headers).toEqual({
      Authorization: '[redacted]',
      'X-Api-Key': '[redacted]',
      accept: 'json'
    })
  })

  it('leaves an event with no body, or a body that is not an object, alone', () => {
    const noBody = { message: 'x' } as Sentry.ErrorEvent
    expect(scrubEvent(noBody)).toBe(noBody)
    const text = { request: { data: 'raw' } } as Sentry.ErrorEvent
    expect(scrubEvent(text).request?.data).toBe('raw')
  })

  it('removes the secrets from the url and the query string that Sentry captures by itself', () => {
    const asString = scrubEvent({
      request: {
        url: 'https://api.example.com/api/v1/webhooks/channels/whatsapp?hub.verify_token=s3cret&hub.mode=subscribe',
        query_string: 'hub.verify_token=s3cret&hub.mode=subscribe'
      }
    } as unknown as Sentry.ErrorEvent)
    const asRecord = scrubEvent({
      request: { query_string: { 'hub.verify_token': 's3cret', 'hub.mode': 'subscribe' } }
    } as unknown as Sentry.ErrorEvent)
    const asPairs = scrubEvent({
      request: {
        query_string: [
          ['token', 's3cret'],
          ['page', '2']
        ]
      }
    } as unknown as Sentry.ErrorEvent)

    expect(asString.request?.url).toBe(
      'https://api.example.com/api/v1/webhooks/channels/whatsapp?hub.verify_token=[redacted]&hub.mode=subscribe'
    )
    expect(asString.request?.query_string).toBe('hub.verify_token=[redacted]&hub.mode=subscribe')
    expect(asRecord.request?.query_string).toEqual({
      'hub.verify_token': '[redacted]',
      'hub.mode': 'subscribe'
    })
    expect(asPairs.request?.query_string).toEqual([
      ['token', '[redacted]'],
      ['page', '2']
    ])
  })

  it('does not fail on an event with no request', () => {
    expect(scrubEvent({} as unknown as Sentry.ErrorEvent)).toEqual({})
  })

  it('walks a query string that nests, and one that holds a # or a ?', () => {
    const nested = scrubEvent({
      request: { query_string: { filter: { token: 's3cret' }, page: '2' } }
    } as unknown as Sentry.ErrorEvent)
    const odd = scrubEvent({
      request: { query_string: 'a=1#x&token=s3cret' }
    } as unknown as Sentry.ErrorEvent)

    expect(nested.request?.query_string).toEqual({ filter: { token: '[redacted]' }, page: '2' })
    expect(odd.request?.query_string).toBe('a=1#x&token=[redacted]')
  })

  it('removes them from the breadcrumbs and the spans, and from a transaction', () => {
    const url = 'https://api.example.com/hook?hub.verify_token=s3cret&hub.mode=subscribe'
    const event = {
      request: { url },
      breadcrumbs: [{ data: { url, 'http.query': 'token=s3cret&page=2', status_code: 200 } }],
      spans: [{ data: { 'url.full': url, 'http.query': 'access_token=s3cret' } }]
    } as unknown as Sentry.Event

    const scrubbed = scrubEvent(event)

    expect(JSON.stringify(scrubbed)).not.toContain('s3cret')
    expect(scrubbed.breadcrumbs?.[0]?.data).toEqual({
      url: 'https://api.example.com/hook?hub.verify_token=[redacted]&hub.mode=subscribe',
      'http.query': 'token=[redacted]&page=2',
      status_code: 200
    })
  })

  it('reads the query that starts with a ?, the path with its query, the root span and the description', () => {
    const event = {
      request: { headers: { Referer: 'https://app.example.com/cb?code=s3cret' } },
      contexts: {
        trace: {
          data: {
            'http.target': '/hook?hub.verify_token=s3cret',
            'url.query': '?state=s3cret&page=2'
          }
        }
      },
      spans: [
        {
          op: 'http.client',
          description: 'GET https://graph.facebook.com/v23.0/me?access_token=s3cret',
          data: {}
        }
      ]
    } as unknown as Sentry.Event

    const scrubbed = scrubEvent(event)

    expect(JSON.stringify(scrubbed)).not.toContain('s3cret')
    expect(scrubbed.contexts?.['trace']?.data).toEqual({
      'http.target': '/hook?hub.verify_token=[redacted]',
      'url.query': '?state=[redacted]&page=2'
    })
    expect(scrubbed.spans?.[0]?.description).toBe(
      'GET https://graph.facebook.com/v23.0/me?access_token=[redacted]'
    )
  })

  it('treats a transaction like an error: headers, body and urls', () => {
    const event = {
      request: {
        headers: {
          Authorization: 'Bearer s3cret',
          Referer: 'https://app.example.com/cb?code=s3cret'
        },
        data: { password: 's3cret' }
      },
      spans: [
        {
          op: 'http.server',
          description: 'GET /api/v1/invitations/abc123',
          data: { 'http.query': 'next=/home&token=s3cret' }
        }
      ]
    } as unknown as Sentry.Event

    const scrubbed = scrubEvent(event)

    expect(JSON.stringify(scrubbed)).not.toMatch(/s3cret|abc123/)
    expect(scrubbed.spans?.[0]?.data).toEqual({ 'http.query': 'next=/home&token=[redacted]' })
  })

  it('reads a text body, a body that nests deeper than the limit, and names beyond the old list', () => {
    const text = scrubEvent({
      request: { data: 'password=hunter2&name=ok' }
    })
    const json = scrubEvent({
      request: { data: '{"newPassword":"hunter2","name":"ok"}' }
    })
    const deep = scrubEvent({
      request: {
        data: { a: { a: { a: { a: { a: { a: { a: { a: { a: { password: 'hunter2' } } } } } } } } } }
      }
    })
    const names = scrubEvent({
      request: {
        data: {
          appSecret: 'x',
          verifyToken: 'y',
          client_secret: 'z',
          refresh_token: 'w',
          city: 'ok'
        }
      }
    })

    expect(text.request?.data).toBe('password=[redacted]&name=ok')
    expect(json.request?.data).toBe('{"newPassword":"[redacted]","name":"ok"}')
    expect(JSON.stringify(deep)).not.toContain('hunter2')
    expect(names.request?.data).toEqual({
      appSecret: '[redacted]',
      verifyToken: '[redacted]',
      client_secret: '[redacted]',
      refresh_token: '[redacted]',
      city: 'ok'
    })
  })

  it('redacts the signature and set-cookie headers, and the cookies', () => {
    const scrubbed = scrubEvent({
      request: {
        headers: { 'X-Hub-Signature-256': 'sha256=abc', 'Set-Cookie': 'sid=1', Accept: 'json' },
        cookies: { sid: '1' }
      }
    })

    expect(scrubbed.request?.headers).toEqual({
      'X-Hub-Signature-256': '[redacted]',
      'Set-Cookie': '[redacted]',
      Accept: 'json'
    })
    expect(JSON.stringify(scrubbed.request?.cookies)).not.toContain('sid')
  })

  it('scrubs the message of an error and the user info of a url, and leaves a db span alone', () => {
    const scrubbed = scrubEvent({
      message: 'call to https://svc:p4ss@host/x?access_token=s3cret failed',
      exception: { values: [{ value: 'GET /api/v1/invitations/abc123 failed' }] },
      spans: [
        {
          op: 'db',
          description: 'SELECT * FROM t WHERE token=$1',
          data: { 'db.query.text': 'SELECT token=$1' }
        }
      ]
    } as unknown as Sentry.Event)

    expect(JSON.stringify(scrubbed.message) + JSON.stringify(scrubbed.exception)).not.toMatch(
      /p4ss|s3cret|abc123/
    )
    expect(scrubbed.spans?.[0]).toEqual({
      op: 'db',
      description: 'SELECT * FROM t WHERE token=$1',
      data: { 'db.query.text': 'SELECT token=$1' }
    })
  })

  it('does not throw on null where a shape was expected, and still cleans the rest', () => {
    const event = {
      request: { url: '/x?token=s3cret', query_string: null, headers: null, data: null },
      breadcrumbs: [null, { data: null }],
      spans: [null, { op: 'http', description: null, data: null }],
      contexts: { trace: { data: null } }
    } as unknown as Sentry.Event

    expect(() => scrubEvent(event)).not.toThrow()
    expect(event.request?.url).toBe('/x?token=[redacted]')
  })
})
