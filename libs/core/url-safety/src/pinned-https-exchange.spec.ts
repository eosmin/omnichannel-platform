import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  type HttpsRequester,
  PinnedExchangeFailed,
  PinnedExchangeReasons,
  pinnedHttpsExchange
} from './pinned-https-exchange'
import { UnsafeUrlError } from './public-url'

const resolvesTo =
  (...addresses: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(addresses)

type Outcome = { status: number; chunks?: string[] } | { error: Error } | 'silence' | 'refuse'

// A request that answers with the given status and body, or fails, and records how it was made
function fakeRequest(outcome: Outcome) {
  const calls: Record<string, unknown>[] = []
  const sent: Buffer[] = []
  const request = ((options: Record<string, unknown>) => {
    if (outcome === 'refuse') throw new TypeError('Invalid character in header content')
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
      for (const chunk of outcome.chunks ?? []) response.write(chunk)
      response.end()
    }
    return req
  }) as unknown as HttpsRequester
  return { request, calls, sent }
}

const exchange = (
  url: string,
  outcome: Outcome,
  { addresses = ['8.8.8.8'], maxResponseBytes = 64, anyStatus = false } = {}
) => {
  const fake = fakeRequest(outcome)
  const result = pinnedHttpsExchange(url, {
    body: '{"a":"é"}',
    headers: { 'content-type': 'application/json' },
    timeoutMs: 1000,
    maxResponseBytes,
    ...(anyStatus ? { anyStatus } : {}),
    resolve: resolvesTo(...addresses),
    request: fake.request
  })
  return { ...fake, result }
}

describe('pinnedHttpsExchange', () => {
  it('posts to the address it checked and reads the answer', async () => {
    const { result, calls, sent } = exchange('https://hooks.example.com/in?x=1', {
      status: 200,
      chunks: ['{"chall', 'enge":"abc"}']
    })

    await expect(result).resolves.toEqual({ status: 200, body: '{"challenge":"abc"}' })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      hostname: 'hooks.example.com',
      port: 443,
      path: '/in?x=1',
      servername: 'hooks.example.com'
    })
    expect(sent[0]?.toString('utf8')).toBe('{"a":"é"}')
    expect((calls[0]?.['headers'] as Record<string, string>)['content-length']).toBe('10')
  })

  it('connects to the checked address, not to a new answer of the resolver', async () => {
    const { result, calls } = exchange('https://hooks.example.com/in', { status: 204 })
    await result
    const lookup = calls[0]?.['lookup'] as (
      host: string,
      options: object,
      callback: (error: unknown, address: string, family: number) => void
    ) => void
    const answered = await new Promise<string>(resolve => {
      lookup('hooks.example.com', {}, (_error, address) => {
        resolve(address)
      })
    })

    expect(answered).toBe('8.8.8.8')
  })

  it.each([
    ['not https', 'http://hooks.example.com/in', ['8.8.8.8']],
    ['a private address', 'https://hooks.example.com/in', ['10.0.0.5']],
    ['one private among the answers', 'https://hooks.example.com/in', ['8.8.8.8', '127.0.0.1']],
    ['a literal loopback', 'https://127.0.0.1/in', ['127.0.0.1']]
  ])('refuses %s before it connects', async (_name, url, addresses) => {
    const { result, calls } = exchange(url, { status: 200 }, { addresses })

    await expect(result).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(calls).toHaveLength(0)
  })

  it('does not follow a redirect and fails with its status', async () => {
    const { result } = exchange('https://hooks.example.com/in', { status: 302 })

    await expect(result).rejects.toMatchObject({
      reason: PinnedExchangeReasons.BAD_STATUS,
      status: 302
    })
  })

  it('fails on a 5xx', async () => {
    const { result } = exchange('https://hooks.example.com/in', { status: 503 })

    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.BAD_STATUS })
  })

  it('with `anyStatus` returns the status and the body of a refusal and of a redirect, for the caller to map', async () => {
    const refusal = exchange(
      'https://hooks.example.com/in',
      { status: 422, chunks: ['{"error":{"code":"rejected"}}'] },
      { anyStatus: true, maxResponseBytes: 128 }
    )
    await expect(refusal.result).resolves.toEqual({
      status: 422,
      body: '{"error":{"code":"rejected"}}'
    })
    const redirect = exchange('https://hooks.example.com/in', { status: 302 }, { anyStatus: true })
    await expect(redirect.result).resolves.toEqual({ status: 302, body: '' })
  })

  it('with `anyStatus` still reads no more than the ceiling', async () => {
    const { result } = exchange(
      'https://hooks.example.com/in',
      { status: 500, chunks: ['x'.repeat(65)] },
      { anyStatus: true }
    )

    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.TOO_LARGE })
  })

  it('stops reading an answer that is longer than the ceiling', async () => {
    const { result } = exchange(
      'https://hooks.example.com/in',
      { status: 200, chunks: ['x'.repeat(40), 'y'.repeat(40)] },
      { maxResponseBytes: 64 }
    )

    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.TOO_LARGE })
  })

  it('names the code of a network error and never what the other side sent', async () => {
    const reset = Object.assign(new Error('socket hang up secret=abc'), { code: 'ECONNRESET' })
    const { result } = exchange('https://hooks.example.com/in', { error: reset })

    const failure = await result.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PinnedExchangeFailed)
    expect((failure as PinnedExchangeFailed).reason).toBe(
      `${PinnedExchangeReasons.NO_ANSWER}:ECONNRESET`
    )
    expect((failure as Error).message).not.toContain('secret')
  })

  it('fails when the address says nothing within the budget', async () => {
    const { result } = exchange('https://hooks.example.com/in', 'silence')

    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.TOO_SLOW })
  })

  it('refuses a request that Node itself refuses', async () => {
    const { result } = exchange('https://hooks.example.com/in', 'refuse')

    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.REQUEST_REFUSED })
  })

  it('fails when the name does not resolve', async () => {
    const fake = fakeRequest({ status: 200 })
    const result = pinnedHttpsExchange('https://gone.example.com/in', {
      body: '{}',
      headers: {},
      timeoutMs: 1000,
      maxResponseBytes: 64,
      resolve: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })),
      request: fake.request
    })

    await expect(result).rejects.toMatchObject({
      reason: `${PinnedExchangeReasons.NOT_RESOLVED}:ENOTFOUND`
    })
  })

  it('fails when the resolver is slower than the budget', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeRequest({ status: 200 })
      const result = pinnedHttpsExchange('https://slow.example.com/in', {
        body: '{}',
        headers: {},
        timeoutMs: 50,
        maxResponseBytes: 64,
        resolve: () => new Promise<string[]>(() => undefined),
        request: fake.request
      })
      const settled = result.catch((error: unknown) => error)
      await jest.advanceTimersByTimeAsync(60)

      expect(await settled).toMatchObject({ reason: PinnedExchangeReasons.TOO_SLOW })
    } finally {
      jest.useRealTimers()
    }
  })
})
