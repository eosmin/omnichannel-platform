import { ApiError, createApiClient } from '@platform/api-client'
import { ShippingPayer } from '@platform/core/domain'

import { fetchReturnSettings, saveReturnSettings } from './return-settings-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, call: () => fetchImpl.mock.calls[0] as [string, RequestInit] }
}

describe('the return settings requests', () => {
  it('reads who pays the way back, through the store of the request', async () => {
    const { client, call } = setup({ returnShippingPayer: 'sender' })
    await expect(fetchReturnSettings(client, 's-1')).resolves.toEqual({
      returnShippingPayer: ShippingPayer.SENDER
    })
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/returns')
    expect(new Headers(call()[1].headers).get('X-Store-Id')).toBe('s-1')
  })

  it('patches only the key given', async () => {
    const { client, call } = setup({ returnShippingPayer: 'recipient' })
    await saveReturnSettings(client, 's-1', { returnShippingPayer: ShippingPayer.RECIPIENT })
    expect(call()[1].method).toBe('PATCH')
    expect(JSON.parse(call()[1].body as string)).toEqual({ returnShippingPayer: 'recipient' })
  })

  it('refuses a payer this page does not know instead of drawing a wrong choice', async () => {
    const { client } = setup({ returnShippingPayer: 'third_party' })
    await expect(fetchReturnSettings(client, 's-1')).rejects.toBeDefined()
  })

  it('raises the error of a refusal', async () => {
    const { client } = setup({ error: { code: 'FORBIDDEN', message: 'no' } }, 403)
    await expect(saveReturnSettings(client, 's-1', {})).rejects.toBeInstanceOf(ApiError)
  })
})
