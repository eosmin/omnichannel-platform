import { ApiError, createApiClient } from '@platform/api-client'

import { fetchInventorySettings, saveInventorySettings } from './inventory-requests'

const view = {
  allowNegativeStock: true,
  allowSplitFulfillment: false,
  defaultLowStockThreshold: 3
}

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
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
  const call = () => fetchImpl.mock.calls[0] ?? []
  return { client, call }
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

describe('inventory settings requests', () => {
  it('reads the switches of the store from its route', async () => {
    const { client, call } = setup(view)

    await expect(fetchInventorySettings(client, 'store-1')).resolves.toEqual(view)

    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/inventory')
    expect(call()[1]?.method ?? 'GET').toBe('GET')
  })

  it('saves with a PATCH that carries only the keys it was given, a null threshold included', async () => {
    const { client, call } = setup({ ...view, defaultLowStockThreshold: null })

    await saveInventorySettings(client, 'store-1', { defaultLowStockThreshold: null })

    expect(call()[1]?.method).toBe('PATCH')
    expect(bodyOf(call()[1])).toEqual({ defaultLowStockThreshold: null })
  })

  it('refuses an answer that is not the shape of the settings', async () => {
    const { client } = setup({ allowNegativeStock: 'yes' })
    await expect(fetchInventorySettings(client, 'store-1')).rejects.toBeDefined()
  })

  it('raises the error of the api for a refused change', async () => {
    const { client } = setup({ error: { code: 'VALIDATION_FAILED', message: 'no' } }, 400)
    await expect(
      saveInventorySettings(client, 'store-1', { allowNegativeStock: true })
    ).rejects.toBeInstanceOf(ApiError)
  })
})
