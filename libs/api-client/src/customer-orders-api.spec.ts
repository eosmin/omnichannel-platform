import { createApiClient } from './api-client'
import { fetchCustomerOrders } from './customer-orders-api'

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

const order = {
  id: 'o1',
  orderNumber: '00012',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  totalCents: 1999,
  currency: 'USD',
  itemCount: 2,
  createdAt: '2026-10-30T10:00:00.000Z'
}
const figures = {
  orders: 1,
  totalSpentCents: 1999,
  averageOrderCents: 1999,
  firstOrderAt: '2026-10-30T10:00:00.000Z',
  lastOrderAt: '2026-10-30T10:00:00.000Z'
}

describe('fetchCustomerOrders', () => {
  it('asks for the state and the cursor, and for nothing that is not named', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [order], nextCursor: null, hasMore: false, figures: null })
    )

    const page = await fetchCustomerOrders(client, 's1', 'c1', 'DELIVERED', 'cur')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/orders?status=DELIVERED&cursor=cur'
    )
    expect(page.data).toEqual([order])
    expect(page.figures).toBeNull()
  })

  it('has no query string when nothing narrows it, and reads the figures of the first page', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [order], nextCursor: null, hasMore: false, figures })
    )

    const page = await fetchCustomerOrders(client, 's1', 'c1', undefined, null)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/customers/c1/orders')
    expect(page.figures?.totalSpentCents).toBe(1999)
  })

  it('refuses a page whose order has no total', async () => {
    const { client } = setup(
      json(200, {
        data: [{ ...order, totalCents: undefined }],
        nextCursor: null,
        hasMore: false,
        figures: null
      })
    )

    await expect(fetchCustomerOrders(client, 's1', 'c1', undefined, null)).rejects.toThrow()
  })
})
