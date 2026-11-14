import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { UnsafeUrlError } from '@platform/core/url-safety'

import { type HttpsRequester, pinnedHttpsPost, WebhookPostFailed } from './pinned-https-post'

const resolvesTo =
  (...addresses: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(addresses)

// A request that answers with the given status, or fails with the given error, and records how it was made
function fakeRequest(outcome: { status: number } | { error: Error } | 'silence') {
  const calls: Record<string, unknown>[] = []
  const sent: Buffer[] = []
  const request = ((options: Record<string, unknown>) => {
    calls.push(options)
    const req = new EventEmitter() as EventEmitter & {
      end: (body: Buffer) => void
      destroy: jest.Mock
    }
    req.destroy = jest.fn((error?: Error) => {
      if (error !== undefined) req.emit('error', error)
    })
    req.end = (body: Buffer) => {
      sent.push(body)
      if (outcome === 'silence') {
        req.emit('timeout')
        return
      }
      if ('error' in outcome) {
        req.emit('error', outcome.error)
        return
      }
      const response = new PassThrough() as PassThrough & { statusCode: number }
      response.statusCode = outcome.status
      req.emit('response', response)
    }
    return req
  }) as unknown as HttpsRequester
  return { request, calls, sent }
}

const post = (
  url: string,
  outcome: Parameters<typeof fakeRequest>[0],
  addresses: string[] = ['8.8.8.8']
) => {
  const fake = fakeRequest(outcome)
  const result = pinnedHttpsPost(url, {
    body: '{"a":"é"}',
    headers: { 'content-type': 'application/json', 'x-platform-signature': 'sha256=abc' },
    timeoutMs: 1000,
    resolve: resolvesTo(...addresses),
    request: fake.request
  })
  return { ...fake, result }
}

describe('pinnedHttpsPost', () => {
  it('connects to the address that was checked, keeps the name for the certificate, and sends the exact body', async () => {
    const { result, calls, sent } = post('https://hooks.example.com/in?x=1', { status: 200 })

    await expect(result).resolves.toBe(200)

    const options = calls[0] as {
      hostname: string
      path: string
      method: string
      headers: Record<string, string>
      servername: string
      lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void
    }
    expect(options).toMatchObject({
      hostname: 'hooks.example.com',
      path: '/in?x=1',
      method: 'POST',
      servername: 'hooks.example.com'
    })
    expect(options.headers['x-platform-signature']).toBe('sha256=abc')
    // The length is of the bytes, not of the characters
    expect(options.headers['content-length']).toBe(String(Buffer.byteLength('{"a":"é"}')))
    expect(sent[0]?.toString('utf8')).toBe('{"a":"é"}')
    const lookup = jest.fn()
    options.lookup('hooks.example.com', {}, lookup)
    expect(lookup).toHaveBeenCalledWith(null, '8.8.8.8', 4)
  })

  it('treats any 2xx as delivered', async () => {
    for (const status of [200, 201, 202, 204, 299]) {
      await expect(post('https://hooks.example.com/in', { status }).result).resolves.toBe(status)
    }
  })

  it.each([
    [301, false],
    [302, false],
    [400, false],
    [401, false],
    [404, false],
    [410, false],
    [408, true],
    [429, true],
    [500, true],
    [503, true]
  ])('says whether a %i is worth asking again: %s', async (status, retryable) => {
    const failure = await post('https://hooks.example.com/in', { status }).result.catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(WebhookPostFailed)
    expect(failure).toMatchObject({ status, retryable, reason: 'bad_status' })
  })

  it('never follows a redirect: a 302 is a failure and no second request is made', async () => {
    const { result, calls } = post('https://hooks.example.com/in', { status: 302 })

    await expect(result).rejects.toBeInstanceOf(WebhookPostFailed)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['ECONNREFUSED', true],
    ['ECONNRESET', true],
    ['ETIMEDOUT', true],
    ['ERR_TLS_CERT_ALTNAME_INVALID', false],
    ['CERT_HAS_EXPIRED', false],
    ['SELF_SIGNED_CERT_IN_CHAIN', false],
    ['ENOTFOUND', false]
  ])('a connection that fails with %s is retried: %s', async (code, retryable) => {
    const error = Object.assign(new Error('boom'), { code })

    const failure = await post('https://hooks.example.com/in', { error }).result.catch(
      (caught: unknown) => caught
    )

    expect(failure).toMatchObject({ retryable, reason: `no_answer:${code}`, status: null })
    // The text of the error, which names addresses and ports, is not carried
    expect(String((failure as Error).message)).not.toContain('boom')
  })

  it('gives up on a slow endpoint, and asks again later', async () => {
    const failure = await post('https://hooks.example.com/in', 'silence').result.catch(
      (error: unknown) => error
    )

    expect(failure).toMatchObject({ reason: 'too_slow', retryable: true })
  })

  it.each([
    'https://10.0.0.1/in',
    'https://127.0.0.1/in',
    'https://169.254.169.254/latest',
    'https://[::1]/in',
    'https://[::ffff:192.168.0.1]/in',
    'https://localhost/in'
  ])('does not even open a socket to %s', async url => {
    const { result, calls } = post(url, { status: 200 }, ['127.0.0.1'])

    await expect(result).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(calls).toHaveLength(0)
  })

  it('refuses a name that resolves to a private address, or to a mix with one', async () => {
    for (const addresses of [['10.1.2.3'], ['8.8.8.8', '10.1.2.3'], ['fd00::1']]) {
      const { result, calls } = post('https://rebind.example.com/in', { status: 200 }, addresses)

      await expect(result).rejects.toBeInstanceOf(UnsafeUrlError)
      expect(calls).toHaveLength(0)
    }
  })

  it('refuses plain http, credentials and another port', async () => {
    for (const url of [
      'http://hooks.example.com/in',
      'https://user:pw@hooks.example.com/in',
      'https://hooks.example.com:8443/in'
    ]) {
      const { result, calls } = post(url, { status: 200 })

      await expect(result).rejects.toBeInstanceOf(UnsafeUrlError)
      expect(calls).toHaveLength(0)
    }
  })

  it('tells a name that does not exist (final) from a resolver that did not answer (may pass)', async () => {
    const lookupFailure = (code: string) =>
      pinnedHttpsPost('https://gone.example.com/in', {
        body: '{}',
        headers: {},
        timeoutMs: 1000,
        resolve: () => Promise.reject(Object.assign(new Error('dns'), { code })),
        request: fakeRequest({ status: 200 }).request
      }).catch((error: unknown) => error)

    expect(await lookupFailure('ENOTFOUND')).toMatchObject({ retryable: false })
    expect(await lookupFailure('EAI_AGAIN')).toMatchObject({ retryable: true })
  })

  it('bounds the whole exchange, not only the silence between bytes', async () => {
    const calls: Record<string, unknown>[] = []
    const request = ((options: Record<string, unknown>) => {
      calls.push(options)
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: jest.Mock }
      req.destroy = jest.fn((error?: Error) => {
        if (error !== undefined) req.emit('error', error)
      })
      // An endpoint that keeps the socket busy: it never times out as idle and never answers
      req.end = () => undefined
      return req
    }) as unknown as HttpsRequester

    const failure = await pinnedHttpsPost('https://hooks.example.com/in', {
      body: '{}',
      headers: {},
      timeoutMs: 30,
      resolve: resolvesTo('8.8.8.8'),
      request
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ reason: 'too_slow', retryable: true })
  })

  it('closes the connection once it has the status, and settles once', async () => {
    const fake = fakeRequest({ status: 200 })
    const destroyed: jest.Mock[] = []
    const request = ((options: Record<string, unknown>) => {
      const req = (
        fake.request as unknown as (o: Record<string, unknown>) => { destroy: jest.Mock }
      )(options)
      destroyed.push(req.destroy)
      return req
    }) as unknown as HttpsRequester

    await pinnedHttpsPost('https://hooks.example.com/in', {
      body: '{}',
      headers: {},
      timeoutMs: 1000,
      resolve: resolvesTo('8.8.8.8'),
      request
    })

    expect(destroyed[0]).toHaveBeenCalledTimes(1)
  })

  it('does not retry a request that Node refuses to build, such as a header with a line break', async () => {
    const request = (() => {
      throw new TypeError('Invalid character in header content')
    }) as unknown as HttpsRequester

    const failure = await pinnedHttpsPost('https://hooks.example.com/in', {
      body: '{}',
      headers: { 'x-correlation-id': 'a\r\nb' },
      timeoutMs: 1000,
      resolve: resolvesTo('8.8.8.8'),
      request
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ retryable: false })
  })
})
