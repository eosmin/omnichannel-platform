import { createApiClient } from './api-client'
import { fetchCustomer, fetchCustomerConversations, fetchCustomerTimeline } from './customers-api'

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

const note = {
  type: 'note',
  id: 'n1',
  at: '2026-10-30T10:00:00.000Z',
  authorId: 'u1',
  authorName: 'María',
  content: 'VIP'
}

describe('fetchCustomerTimeline', () => {
  it('asks for the kind and the cursor, and for nothing that is not named', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [note], nextCursor: null, hasMore: false })
    )

    const page = await fetchCustomerTimeline(client, 's1', 'c1', 'note', 'cur')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/timeline?type=note&cursor=cur'
    )
    expect(page.data).toEqual([note])
  })

  it('has no query string when nothing narrows it', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchCustomerTimeline(client, 's1', 'c1', undefined, null)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/timeline'
    )
  })

  it('leaves out an entry of a kind it does not know, and keeps the rest', async () => {
    const future = { type: 'order', id: 'o1', at: '2026-10-30T10:00:00.000Z' }
    const { client } = setup(json(200, { data: [future, note], nextCursor: null, hasMore: false }))

    const page = await fetchCustomerTimeline(client, 's1', 'c1', undefined, null)

    expect(page.data).toEqual([note])
  })

  it('sends the store of the request in X-Store-Id', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchCustomerTimeline(client, 's1', 'c1', undefined, null)

    expect(new Headers(fetchImpl.mock.calls[0]?.[1].headers).get('X-Store-Id')).toBe('s1')
  })
})

describe('fetchCustomerConversations', () => {
  it('names the page size', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchCustomerConversations(client, 's1', 'c1', 100)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/conversations?limit=100'
    )
  })
})

describe('fetchCustomer', () => {
  it('refuses an answer that is not a customer', async () => {
    const { client } = setup(json(200, { id: 'c1' }))

    await expect(fetchCustomer(client, 's1', 'c1')).rejects.toThrow()
  })
})
