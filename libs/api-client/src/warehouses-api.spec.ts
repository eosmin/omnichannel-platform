import { createApiClient } from './api-client'
import {
  createWarehouse,
  fetchAllWarehouses,
  fetchWarehousePage,
  replaceWarehouseStores,
  updateWarehouse
} from './warehouses-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(...responses: Response[]) {
  const queue = [...responses]
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return Promise.resolve((next as Response).clone())
  })
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const warehouse = {
  id: 'w1',
  name: 'Main',
  code: 'MAIN',
  address: { line1: '1 Main St', city: 'Leon' },
  active: true,
  stores: [
    { storeId: 's1', storeName: 'Shop', priority: 1 },
    { storeId: 's2', storeName: 'Outlet', priority: 2 }
  ],
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z'
}

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

describe('warehouses api', () => {
  it('reads a page with its filters, through the store of the request', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [warehouse], nextCursor: null, hasMore: false })
    )

    const page = await fetchWarehousePage(client, 's1', { active: true, cursor: 'c1', limit: 50 })

    const call = callOf(fetchImpl)
    expect(call.url).toBe(
      'https://api.example.com/api/v1/warehouses?active=true&cursor=c1&limit=50'
    )
    expect(call.headers.get('x-store-id')).toBe('s1')
    expect(page.data[0]?.stores.map(link => link.priority)).toEqual([1, 2])
  })

  it('follows the cursor to the last page', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [warehouse], nextCursor: 'next', hasMore: true }),
      json(200, { data: [{ ...warehouse, id: 'w2' }], nextCursor: null, hasMore: false })
    )

    const all = await fetchAllWarehouses(client, 's1')

    expect(all.map(item => item.id)).toEqual(['w1', 'w2'])
    expect(callOf(fetchImpl, 1).url).toContain('cursor=next')
  })

  it('stops at a bound when the cursor never ends', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [warehouse], nextCursor: 'again', hasMore: true })
    )

    const all = await fetchAllWarehouses(client, 's1')

    // One page a call, up to the bound of 20 pages, and what was read is still answered
    expect(fetchImpl.mock.calls.length).toBe(20)
    expect(all).toHaveLength(20)
  })

  it('creates with a POST of the body', async () => {
    const { client, fetchImpl } = setup(json(201, warehouse))

    await createWarehouse(client, 's1', { name: 'Main', code: 'MAIN' })

    const call = callOf(fetchImpl)
    expect(call.init.method).toBe('POST')
    expect(call.url).toBe('https://api.example.com/api/v1/warehouses')
    expect(JSON.parse(call.init.body as string)).toEqual({ name: 'Main', code: 'MAIN' })
  })

  it('changes with a PATCH of only the keys given, and clears the address with null', async () => {
    const { client, fetchImpl } = setup(json(200, warehouse))

    await updateWarehouse(client, 's1', 'w1', { address: null, active: false })

    const call = callOf(fetchImpl)
    expect(call.init.method).toBe('PATCH')
    expect(call.url).toBe('https://api.example.com/api/v1/warehouses/w1')
    expect(JSON.parse(call.init.body as string)).toEqual({ address: null, active: false })
  })

  it('replaces the links with a PUT of the complete list', async () => {
    const { client, fetchImpl } = setup(json(200, warehouse))

    await replaceWarehouseStores(client, 's1', 'w1', [
      { storeId: 's2', priority: 1 },
      { storeId: 's1', priority: 2 }
    ])

    const call = callOf(fetchImpl)
    expect(call.init.method).toBe('PUT')
    expect(call.url).toBe('https://api.example.com/api/v1/warehouses/w1/stores')
    expect(JSON.parse(call.init.body as string)).toEqual({
      stores: [
        { storeId: 's2', priority: 1 },
        { storeId: 's1', priority: 2 }
      ]
    })
  })

  it('refuses an answer that is not the contract', async () => {
    const { client } = setup(json(200, { data: [{ id: 'w1' }], nextCursor: null, hasMore: false }))

    await expect(fetchWarehousePage(client, 's1')).rejects.toBeDefined()
  })
})
