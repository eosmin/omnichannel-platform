import { UnsafeUrlError } from '@platform/core/url-safety'
import { CarrierRejectedError } from '@platform/plugins/sdk'

import { carrierEndpointFetch } from './carrier-endpoint-fetch'

const policy = { timeoutMs: 1_000, maxResponseBytes: 1_024, allowCustomPort: true } as const
const resolvesTo =
  (...addresses: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(addresses)

describe('carrierEndpointFetch', () => {
  it.each([
    ['a name that resolves to loopback', 'https://gw.carrier.com/', ['127.0.0.1']],
    [
      'a name that resolves to the metadata address',
      'https://gw.carrier.com/',
      ['169.254.169.254']
    ],
    [
      'a name that resolves to an IPv4-mapped loopback',
      'https://gw.carrier.com/',
      ['::ffff:127.0.0.1']
    ],
    ['a name that resolves to a unique local address', 'https://gw.carrier.com/', ['fc00::1']],
    ['a decimal loopback literal', 'https://2130706433/', ['8.8.8.8']],
    ['an octal loopback literal', 'https://017700000001/', ['8.8.8.8']],
    ['a hex loopback literal', 'https://0x7f.0.0.1/', ['8.8.8.8']]
  ])(
    'turns %s into a refusal of the connection data, with no request',
    async (_label, url, addresses) => {
      const request = jest.fn()
      const fetcher = carrierEndpointFetch({
        ...policy,
        resolve: resolvesTo(...addresses),
        request: request as never
      })

      await expect(fetcher(url)).rejects.toBeInstanceOf(CarrierRejectedError)
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('lets any other failure through as it is', async () => {
    const fetcher = carrierEndpointFetch({
      ...policy,
      resolve: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))
    })

    const error = await fetcher('https://gw.carrier.com/').catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(CarrierRejectedError)
    expect(error).not.toBeInstanceOf(UnsafeUrlError)
  })
})
