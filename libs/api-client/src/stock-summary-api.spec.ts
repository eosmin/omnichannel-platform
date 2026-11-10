import { createApiClient } from './api-client'
import { fetchStockSummary } from './stock-summary-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(response: Response) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(response.clone()))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

describe('fetchStockSummary', () => {
  it('asks for the ids as one list and answers the rows', async () => {
    const row = {
      productId: 'p1',
      trackInventory: true,
      onHand: 3,
      reserved: 1,
      available: 2,
      lowStockThreshold: 5,
      isLow: true
    }
    const { client, fetchImpl } = setup(json(200, { data: [row] }))

    const rows = await fetchStockSummary(client, 's1', ['p1', 'p2'])

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/inventory/summary?productIds=p1%2Cp2'
    )
    expect(new Headers(fetchImpl.mock.calls[0]?.[1].headers).get('x-store-id')).toBe('s1')
    expect(rows).toEqual([row])
  })

  it('refuses an answer that is not the contract', async () => {
    const { client } = setup(json(200, { data: [{ productId: 'p1' }] }))

    await expect(fetchStockSummary(client, 's1', ['p1'])).rejects.toBeDefined()
  })
})
