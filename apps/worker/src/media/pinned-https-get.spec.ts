import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  PinnedFetchFailed,
  pinnedHttpsGet,
  pinnedLookup,
  type HttpsRequester
} from './pinned-https-get'
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

describe('pinnedLookup', () => {
  it('answers with the vetted address whatever the name, in both forms node asks', () => {
    const lookup = pinnedLookup(['8.8.8.8', '2001:4860:4860::8888']) as unknown as (
      host: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void
    ) => void
    const single = jest.fn()
    lookup('anything.example', {}, single)
    expect(single).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    const all = jest.fn()
    lookup('anything.example', { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 }
    ])
  })
})

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
