import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { PinnedFetchFailed, pinnedHttpsGet } from './pinned-https-get'
import type { HttpsRequester } from './pinned-request'
import { UnsafeUrlError } from './public-url'

const resolvesTo =
  (...addresses: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(addresses)

// A request that answers with the given status and records how it was made
function fakeRequest(status: number, headers: Record<string, string> = {}) {
  const calls: Record<string, unknown>[] = []
  const request = ((options: Record<string, unknown>) => {
    calls.push(options)
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: jest.Mock }
    req.destroy = jest.fn()
    req.end = () => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number
        headers: Record<string, string>
      }
      response.statusCode = status
      response.headers = headers
      req.emit('response', response)
    }
    return req
  }) as unknown as HttpsRequester
  return { request, calls }
}

describe('pinnedHttpsGet', () => {
  it('connects to the checked address, keeps the name for the certificate and reads the headers', async () => {
    const { request, calls } = fakeRequest(200, {
      'content-type': 'image/png',
      'content-length': '12'
    })
    const response = await pinnedHttpsGet('https://cdn.example.com/a/b.png?x=1', {
      accept: 'image/png',
      timeoutMs: 1000,
      resolve: resolvesTo('8.8.8.8'),
      request
    })
    expect(response.contentType).toBe('image/png')
    expect(response.contentLength).toBe(12)
    expect(calls[0]).toMatchObject({
      hostname: 'cdn.example.com',
      servername: 'cdn.example.com',
      path: '/a/b.png?x=1',
      method: 'GET',
      port: 443
    })
    const lookup = calls[0]?.lookup as (h: string, o: object, cb: jest.Mock) => void
    const callback = jest.fn()
    lookup('cdn.example.com', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
  })

  it('takes an empty content-length as unknown and refuses an encoded body', async () => {
    const empty = fakeRequest(200, { 'content-length': '' })
    const response = await pinnedHttpsGet('https://cdn.example.com/a.png', {
      accept: '*/*',
      timeoutMs: 1000,
      resolve: resolvesTo('8.8.8.8'),
      request: empty.request
    })
    expect(response.contentLength).toBeNull()

    const gzip = fakeRequest(200, { 'content-encoding': 'gzip' })
    await expect(
      pinnedHttpsGet('https://cdn.example.com/a.png', {
        accept: '*/*',
        timeoutMs: 1000,
        resolve: resolvesTo('8.8.8.8'),
        request: gzip.request
      })
    ).rejects.toMatchObject({ retryable: false })
  })

  it('refuses a link whose host has a private address before any request', async () => {
    const { request, calls } = fakeRequest(200)
    await expect(
      pinnedHttpsGet('https://cdn.example.com/a.png', {
        accept: '*/*',
        timeoutMs: 1000,
        resolve: resolvesTo('8.8.8.8', '10.0.0.5'),
        request
      })
    ).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(calls).toHaveLength(0)
  })

  it.each([
    [301, false],
    [404, false],
    [429, true],
    [503, true]
  ])('does not follow or accept status %i (retryable: %s)', async (status, retryable) => {
    const { request } = fakeRequest(status, { location: 'https://127.0.0.1/' })
    await expect(
      pinnedHttpsGet('https://cdn.example.com/a.png', {
        accept: '*/*',
        timeoutMs: 1000,
        resolve: resolvesTo('8.8.8.8'),
        request
      })
    ).rejects.toMatchObject({ name: PinnedFetchFailed.name, retryable })
  })
})

describe('pinnedHttpsGet extra headers', () => {
  it('sends the headers it is given next to its own accept and identity encoding', async () => {
    const { request, calls } = fakeRequest(200, { 'content-type': 'image/png' })
    await pinnedHttpsGet('https://cdn.example.com/a.png', {
      accept: '*/*',
      timeoutMs: 1000,
      resolve: resolvesTo('93.184.216.34'),
      request,
      headers: { 'x-platform-command-signature': 't=1,v1=ab' }
    })
    expect(calls[0]?.['headers']).toEqual({
      'x-platform-command-signature': 't=1,v1=ab',
      accept: '*/*',
      'accept-encoding': 'identity'
    })
  })

  it.each([
    'Host',
    'content-length',
    'Transfer-Encoding',
    'connection',
    'upgrade',
    'TE',
    'accept',
    'Accept-Encoding',
    'Proxy-Authorization',
    'Expect',
    'Cookie',
    'x_bad',
    'x-'
  ])('refuses to set %s, before any lookup or request', async name => {
    const { request, calls } = fakeRequest(200)
    const resolve = jest.fn(resolvesTo('93.184.216.34'))
    await expect(
      pinnedHttpsGet('https://cdn.example.com/a.png', {
        accept: '*/*',
        timeoutMs: 1000,
        resolve,
        request,
        headers: { [name]: 'x' }
      })
    ).rejects.toThrow(TypeError)
    expect(resolve).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe('pinnedHttpsGet header names', () => {
  it('refuses two spellings of one name, as Node would keep only one of them', async () => {
    const { request } = fakeRequest(200)
    await expect(
      pinnedHttpsGet('https://cdn.example.com/a.png', {
        accept: '*/*',
        timeoutMs: 1000,
        resolve: resolvesTo('93.184.216.34'),
        request,
        headers: { 'X-A': '1', 'x-a': '2' }
      })
    ).rejects.toThrow(TypeError)
  })
})

describe('pinnedHttpsGet failures of the connection', () => {
  const failing = (code: string): HttpsRequester =>
    (() => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => {
        req.emit('error', Object.assign(new Error('boom'), { code }))
      }
      return req
    }) as unknown as HttpsRequester
  const get = (request: HttpsRequester, resolve = resolvesTo('8.8.8.8')) =>
    pinnedHttpsGet('https://cdn.example.com/a.png', {
      accept: '*/*',
      timeoutMs: 1000,
      resolve,
      request
    })

  it.each([
    ['ERR_TLS_CERT_ALTNAME_INVALID', false],
    ['CERT_HAS_EXPIRED', false],
    ['ECONNRESET', true],
    ['ECONNREFUSED', true]
  ])('%s is retryable: %s, and the code is kept', async (code, retryable) => {
    await expect(get(failing(code))).rejects.toMatchObject({ retryable })
    await expect(get(failing(code))).rejects.toThrow(code)
  })

  it('a name that does not exist is final, a resolver that did not answer is not', async () => {
    const request = failing('X')
    const refusing = (code: string) => (): Promise<string[]> =>
      Promise.reject(Object.assign(new Error('dns'), { code }))
    await expect(get(request, refusing('ENOTFOUND'))).rejects.toMatchObject({ retryable: false })
    await expect(get(request, refusing('EAI_AGAIN'))).rejects.toMatchObject({ retryable: true })
  })
})
