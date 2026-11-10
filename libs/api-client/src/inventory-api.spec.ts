import { InventoryMovementType } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  createStockAdjustment,
  fetchKardex,
  fetchProductInventory,
  fetchWarehousesOfStore
} from './inventory-api'

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

const level = {
  id: 'l1',
  productId: 'p1',
  productName: 'Shoe',
  productSku: null,
  variantId: null,
  variantName: null,
  variantSku: null,
  warehouseId: 'w1',
  warehouseCode: 'MAIN',
  warehouseName: 'Main',
  onHand: 10,
  reserved: 2,
  available: 8,
  lowStockThreshold: 3,
  updatedAt: '2026-11-10T10:00:00.000Z'
}
const movement = {
  id: 'm1',
  productId: 'p1',
  variantId: null,
  warehouseId: 'w1',
  type: 'receipt',
  quantity: 5,
  reason: 'opening_stock',
  note: null,
  referenceType: 'manual',
  referenceId: null,
  onHandAfter: 5,
  reservedAfter: 0,
  createdBy: 'u1',
  createdAt: '2026-11-10T10:00:00.000Z'
}

describe('fetchProductInventory', () => {
  it('reads the cost keys when they are there, and leaves them out when they are not', async () => {
    const body = {
      productId: 'p1',
      trackInventory: true,
      lowStockThreshold: 3,
      onHand: 10,
      reserved: 2,
      available: 8,
      levels: [{ ...level, valueCents: 2000, averageCostCents: 200 }, level]
    }
    const { client, fetchImpl } = setup(json(200, body))

    const inventory = await fetchProductInventory(client, 's1', 'p1')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/products/p1/inventory'
    )
    expect(inventory.levels[0]).toMatchObject({ valueCents: 2000, averageCostCents: 200 })
    // Absent stays absent: it is not "no cost"
    expect(inventory.levels[1]).not.toHaveProperty('valueCents')
  })
})

describe('fetchKardex', () => {
  it('names the item, the warehouse and the page, and nothing else', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [movement], nextCursor: 'next', hasMore: true })
    )

    const page = await fetchKardex(client, 's1', {
      productId: 'p1',
      variantId: 'v1',
      warehouseId: 'w1',
      cursor: 'cur',
      limit: 20
    })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/inventory/kardex?productId=p1&variantId=v1&warehouseId=w1&cursor=cur&limit=20'
    )
    expect(page.nextCursor).toBe('next')
    expect(page.data[0]).not.toHaveProperty('unitCostCents')
  })

  it('sends no variant for the bare row of a product', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchKardex(client, 's1', { productId: 'p1', variantId: null, warehouseId: 'w1' })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/inventory/kardex?productId=p1&warehouseId=w1'
    )
  })
})

describe('createStockAdjustment', () => {
  it('sends the adjustment with its key as it was written and answers whether it was a retry', async () => {
    const { client, fetchImpl } = setup(json(201, { movement, replayed: false }))

    const result = await createStockAdjustment(client, 's1', {
      warehouseId: 'w1',
      productId: 'p1',
      type: InventoryMovementType.ADJUSTMENT_IN,
      quantity: 5,
      reason: 'found',
      idempotencyKey: 'key-1'
    })

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://api.example.com/api/v1/inventory/adjustments')
    expect(call?.[1].method).toBe('POST')
    expect(JSON.parse(call?.[1].body as string)).toEqual({
      warehouseId: 'w1',
      productId: 'p1',
      type: 'adjustment_in',
      quantity: 5,
      reason: 'found',
      idempotencyKey: 'key-1'
    })
    expect(result.replayed).toBe(false)
  })
})

describe('fetchWarehousesOfStore', () => {
  it('follows the pages of the organization to find the warehouses of the store', async () => {
    const link = (storeId: string) => [{ storeId, storeName: storeId, priority: 1 }]
    const pages = [
      {
        data: [{ id: 'w1', name: 'One', code: 'ONE', active: true, stores: link('s2') }],
        nextCursor: 'c2',
        hasMore: true
      },
      {
        data: [{ id: 'w2', name: 'Two', code: 'TWO', active: true, stores: link('s1') }],
        nextCursor: null,
        hasMore: false
      }
    ]
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockImplementation(url =>
        Promise.resolve(json(200, url.includes('cursor=c2') ? pages[1] : pages[0]))
      )
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      getAccessToken: () => 'token',
      refreshAccessToken: () => Promise.resolve('token'),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const warehouses = await fetchWarehousesOfStore(client, 's1')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(warehouses.map(warehouse => warehouse.id)).toEqual(['w2'])
  })

  it('keeps the warehouses the store sells from, asked active', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        data: [
          {
            id: 'w1',
            name: 'Main',
            code: 'MAIN',
            active: true,
            stores: [{ storeId: 's1', storeName: 'A', priority: 1 }]
          },
          {
            id: 'w2',
            name: 'Other',
            code: 'OTHER',
            active: true,
            stores: [{ storeId: 's2', storeName: 'B', priority: 1 }]
          }
        ],
        nextCursor: null,
        hasMore: false
      })
    )

    const warehouses = await fetchWarehousesOfStore(client, 's1')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/warehouses?limit=100&active=true'
    )
    expect(warehouses.map(warehouse => warehouse.id)).toEqual(['w1'])
  })
})
