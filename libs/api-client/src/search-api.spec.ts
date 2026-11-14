import { SearchEntities } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  searchCatalog,
  searchCustomers,
  searchGlobal,
  searchMessages,
  searchOrders
} from './search-api'

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

function setup(body: unknown) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(json(body)))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const customer = { id: 'c1', name: 'José', email: null, phone: null }

describe('search api', () => {
  it('asks the global search for the text, in the store of the header', async () => {
    const { client, fetchImpl } = setup({
      query: 'jose & más',
      groups: [{ entity: SearchEntities.CUSTOMERS, hits: [customer] }]
    })
    const result = await searchGlobal(client, 'store-1', 'jose & más')
    expect(result.groups[0]?.entity).toBe(SearchEntities.CUSTOMERS)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/search?q=jose+%26+m%C3%A1s')
    expect(new Headers(init?.headers).get('X-Store-Id')).toBe('store-1')
  })

  it('leaves out the parameters it was not given', async () => {
    const { client, fetchImpl } = setup({ query: 'a1', hits: [], hasMore: false })
    await searchMessages(client, 's', { q: 'a1', conversationId: 'conv' })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/search/messages?q=a1&conversationId=conv'
    )
  })

  it('reads a page of customers and a page of orders with their limit', async () => {
    const customers = setup({ query: 'jo', hits: [customer], hasMore: true })
    expect((await searchCustomers(customers.client, 's', { q: 'jo', limit: 25 })).hasMore).toBe(
      true
    )
    expect(customers.fetchImpl.mock.calls[0]?.[0]).toContain('/search/customers?q=jo&limit=25')
    const orders = setup({ query: '1001', hits: [], hasMore: false })
    expect((await searchOrders(orders.client, 's', { q: '1001' })).hits).toEqual([])
  })

  it('reads the products as the autocomplete answers them', async () => {
    const { client } = setup({
      data: [
        {
          id: 'p',
          name: 'Camisa',
          sku: null,
          priceCents: 1500,
          imageMediaId: null,
          active: true,
          matchedVariant: null
        }
      ]
    })
    expect((await searchCatalog(client, 's', { q: 'cam' })).data[0]?.name).toBe('Camisa')
  })

  it('refuses an answer that is not the shape of the contract', async () => {
    const { client } = setup({ query: 'x', groups: [{ entity: 'nothing', hits: [] }] })
    await expect(searchGlobal(client, 's', 'xx')).rejects.toBeDefined()
  })
})
