import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  type HttpsRequester,
  PinnedExchangeFailed,
  PinnedExchangeReasons
} from './pinned-https-exchange'
import { createPinnedFetch } from './pinned-https-fetch'
import { UnsafeUrlError } from './public-url'

type Outcome = { status: number; chunks?: string[]; headers?: Record<string, string> }

function fakeRequest(outcome: Outcome | 'silence') {
  const calls: Record<string, unknown>[] = []
  const sent: Buffer[] = []
  const request = ((options: Record<string, unknown>) => {
    calls.push(options)
    const req = new EventEmitter() as EventEmitter & {
      end: (body?: Buffer) => void
      destroy: jest.Mock
    }
    req.destroy = jest.fn()
    req.end = (body?: Buffer) => {
      if (body !== undefined) sent.push(body)
      if (outcome === 'silence') {
        req.emit('timeout')
        return
      }
      const response = new PassThrough() as PassThrough & {
        statusCode: number
        headers: Record<string, string>
      }
      response.statusCode = outcome.status
      response.headers = outcome.headers ?? {}
      req.emit('response', response)
      for (const chunk of outcome.chunks ?? []) response.write(chunk)
      response.end()
    }
    return req
  }) as unknown as HttpsRequester
  return { request, calls, sent }
}

const resolvesTo =
  (...addresses: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(addresses)

function run(
  url: string,
  outcome: Outcome | 'silence' = { status: 200, chunks: ['{}'] },
  {
    addresses = ['8.8.8.8'],
    maxResponseBytes = 64,
    init
  }: { addresses?: string[]; maxResponseBytes?: number; init?: RequestInit } = {}
) {
  const fake = fakeRequest(outcome)
  const fetcher = createPinnedFetch({
    timeoutMs: 1_000,
    maxResponseBytes,
    resolve: resolvesTo(...addresses),
    request: fake.request
  })
  return { ...fake, result: fetcher(url, init) }
}

describe('createPinnedFetch', () => {
  it('connects to the checked address, with the name only for the certificate, and returns the answer', async () => {
    const { result, calls, sent } = run(
      'https://api.carrier.com/v1/x?y=1',
      { status: 200, chunks: ['{"a"', ':1}'], headers: { 'content-type': 'application/json' } },
      {
        init: {
          method: 'POST',
          body: '{"q":1}',
          headers: { 'Content-Type': 'application/json', LauValue: 's' }
        }
      }
    )

    const response = await result
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"a":1}')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      hostname: 'api.carrier.com',
      port: 443,
      path: '/v1/x?y=1',
      method: 'POST',
      servername: 'api.carrier.com'
    })
    expect((calls[0]?.headers as Record<string, string>).lauvalue).toBe('s')
    expect(sent[0]?.toString()).toBe('{"q":1}')
    // The socket goes to the address that was checked, whatever the name says
    const lookup = calls[0]?.lookup as (h: string, o: object, cb: (...a: unknown[]) => void) => void
    const cb = jest.fn()
    lookup('api.carrier.com', {}, cb)
    expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4)
  })

  it('connects to the port the address names only when the caller allows it, and never below 1024', async () => {
    const fake = fakeRequest({ status: 200, chunks: ['ok'] })
    const base = {
      timeoutMs: 1_000,
      maxResponseBytes: 64,
      resolve: resolvesTo('8.8.8.8'),
      request: fake.request
    }

    await createPinnedFetch({ ...base, allowCustomPort: true })('https://api.carrier.com:40467/x')
    expect(fake.calls[0]).toMatchObject({ port: 40467, path: '/x' })

    await expect(
      createPinnedFetch({ ...base, allowCustomPort: true })('https://api.carrier.com:22/x')
    ).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(createPinnedFetch(base)('https://api.carrier.com:40467/x')).rejects.toBeInstanceOf(
      UnsafeUrlError
    )
    expect(fake.calls).toHaveLength(1)

    // A custom port does not open a private address
    await expect(
      createPinnedFetch({ ...base, allowCustomPort: true, resolve: resolvesTo('127.0.0.1') })(
        'https://api.carrier.com:40467/x'
      )
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('does not resolve a second time: a name that answers something else later is not followed (rebinding)', async () => {
    let asked = 0
    const fake = fakeRequest({ status: 200, chunks: ['ok'] })
    const fetcher = createPinnedFetch({
      timeoutMs: 1_000,
      maxResponseBytes: 64,
      resolve: () => {
        asked += 1
        return Promise.resolve(asked === 1 ? ['8.8.8.8'] : ['169.254.169.254'])
      },
      request: fake.request
    })

    await fetcher('https://rebind.example.com/')

    expect(asked).toBe(1)
    const lookup = fake.calls[0]?.lookup as (
      h: string,
      o: object,
      cb: (...a: unknown[]) => void
    ) => void
    const cb = jest.fn()
    lookup('rebind.example.com', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
  })

  it.each([
    ['loopback', ['127.0.0.1']],
    ['metadata', ['169.254.169.254']],
    ['private', ['10.0.0.5']],
    ['ipv6 loopback', ['::1']],
    ['ipv4 mapped loopback', ['::ffff:127.0.0.1']],
    ['unique local', ['fc00::1']],
    ['one private among public ones', ['8.8.8.8', '192.168.1.1']],
    ['nothing', []]
  ])('refuses a name that resolves to %s and makes no request', async (_label, addresses) => {
    const { result, calls } = run('https://evil.example.com/', undefined, { addresses })

    await expect(result).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(calls).toHaveLength(0)
  })

  it.each([
    'https://127.0.0.1/',
    'https://2130706433/', // decimal
    'https://0x7f.0.0.1/', // hex
    'https://017700000001/', // octal
    'https://0177.0.0.1/',
    'https://127.1/', // short form
    'https://0/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[fc00::1]/',
    'https://[fd00::1]/',
    'https://[fe80::1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::ffff:169.254.169.254]/',
    'http://8.8.8.8/',
    'https://8.8.8.8:8443/',
    'https://user:pass@8.8.8.8/'
  ])('refuses the address literal %s without resolving or connecting', async url => {
    const resolve = jest.fn(resolvesTo('8.8.8.8'))
    const fake = fakeRequest({ status: 200 })
    const fetcher = createPinnedFetch({
      timeoutMs: 1_000,
      maxResponseBytes: 64,
      resolve,
      request: fake.request
    })

    await expect(fetcher(url)).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fake.calls).toHaveLength(0)
  })

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %s: it fails and nothing else is requested',
    async status => {
      const { result, calls } = run('https://api.carrier.com/', {
        status,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' }
      })

      await expect(result).rejects.toMatchObject({
        reason: PinnedExchangeReasons.BAD_STATUS,
        status
      })
      expect(calls).toHaveLength(1)
    }
  )

  it.each([100, 199, 600, 700, 999])(
    'fails, and does not throw out of the handler, for a status a Response cannot hold (%s)',
    async status => {
      const { result } = run('https://api.carrier.com/', { status, chunks: ['x'] })
      await expect(result).rejects.toMatchObject({
        reason: PinnedExchangeReasons.BAD_STATUS,
        status
      })
    }
  )

  it('rejects before resolving anything when the signal is already aborted, and leaves no listener behind', async () => {
    const resolve = jest.fn(resolvesTo('8.8.8.8'))
    const controller = new AbortController()
    const add = jest.spyOn(controller.signal, 'addEventListener')
    const remove = jest.spyOn(controller.signal, 'removeEventListener')
    const fake = fakeRequest({ status: 200, chunks: ['ok'] })
    const fetcher = createPinnedFetch({
      timeoutMs: 1_000,
      maxResponseBytes: 64,
      resolve,
      request: fake.request
    })

    await fetcher('https://api.carrier.com/', { signal: controller.signal })
    // Every listener that was added is taken off when the call ends
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length)

    controller.abort()
    await expect(
      fetcher('https://api.carrier.com/', { signal: controller.signal })
    ).rejects.toMatchObject({
      reason: PinnedExchangeReasons.TOO_SLOW
    })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('returns an answer of any other status for the caller to decide', async () => {
    const { result } = run('https://api.carrier.com/', { status: 401, chunks: ['no'] })
    const response = await result
    expect(response.status).toBe(401)
    expect(response.ok).toBe(false)
  })

  it('fails when the answer is longer than the ceiling', async () => {
    const { result } = run('https://api.carrier.com/', { status: 200, chunks: ['x'.repeat(65)] })
    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.TOO_LARGE })
  })

  it('fails when the answer is encoded (it would unpack past the ceiling)', async () => {
    const { result } = run('https://api.carrier.com/', {
      status: 200,
      headers: { 'content-encoding': 'gzip' }
    })
    await expect(result).rejects.toBeInstanceOf(PinnedExchangeFailed)
  })

  it('fails with too_slow when the server does not answer', async () => {
    const { result } = run('https://api.carrier.com/', 'silence')
    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.TOO_SLOW })
  })

  it('fails with too_slow when the signal is already aborted, before any request', async () => {
    const { result, calls } = run('https://api.carrier.com/', undefined, {
      init: { signal: AbortSignal.abort() }
    })
    await expect(result).rejects.toMatchObject({ reason: PinnedExchangeReasons.TOO_SLOW })
    expect(calls).toHaveLength(0)
  })

  it.each([
    'Host',
    'Content-Length',
    'Connection',
    'Cookie',
    'Proxy-Authorization',
    'Transfer-Encoding'
  ])('refuses a caller header that routes or frames the request: %s', async name => {
    const { result, calls } = run('https://api.carrier.com/', undefined, {
      init: { headers: { [name]: 'x' } }
    })
    await expect(result).rejects.toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('refuses a body that is not text and a body on a GET', async () => {
    await expect(
      run('https://api.carrier.com/', undefined, {
        init: { method: 'POST', body: new Uint8Array(1) }
      }).result
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      run('https://api.carrier.com/', undefined, { init: { method: 'GET', body: 'x' } }).result
    ).rejects.toBeInstanceOf(TypeError)
  })
})
