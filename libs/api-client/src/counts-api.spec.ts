import { CountStatus } from '@platform/core/domain'

import { createApiClient } from './api-client'
import { ApiError } from './api-error'
import {
  applyCount,
  cancelCount,
  createCount,
  fetchAllCountLines,
  fetchCount,
  fetchCounts,
  fetchCountWarehouses,
  reopenCount,
  startCount,
  submitCount,
  updateCountLines
} from './counts-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(...responses: Response[]) {
  // The last response is repeated once the others are used
  let calls = 0
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() => {
    const next = responses[Math.min(calls, responses.length - 1)]
    calls += 1
    if (next === undefined) throw new Error('no response queued')
    return Promise.resolve(next.clone())
  })
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const header = {
  id: 'c1',
  number: 'CT-0001',
  status: CountStatus.COUNTING,
  warehouse: { id: 'w1', name: 'Main', code: 'MAIN' },
  storeId: null,
  storeName: null,
  note: null,
  createdBy: 'u1',
  startedAt: '2026-11-11T10:00:00.000Z',
  submittedAt: null,
  appliedBy: null,
  appliedAt: null,
  createdAt: '2026-11-11T09:00:00.000Z',
  updatedAt: '2026-11-11T10:00:00.000Z'
}
const line = (id: string, counted: number | null = null) => ({
  id,
  storeId: 's1',
  productId: 'p1',
  productName: 'Shoe',
  sku: 'SH-1',
  variantId: null,
  variantName: null,
  expectedQuantity: 10,
  countedQuantity: counted,
  variance: counted === null ? null : counted - 10
})
const detail = (lines: ReturnType<typeof line>[], next: string | null) => ({
  ...header,
  totals: { lines: 3, counted: 1, withVariance: 1 },
  lines,
  nextCursor: next,
  hasMore: next !== null
})

describe('counts api', () => {
  it('lists the counts of the organization through a store, with the filters', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [header], nextCursor: null, hasMore: false })
    )
    const page = await fetchCounts(client, 's1', {
      status: CountStatus.REVIEW,
      warehouseId: 'w1',
      limit: 10
    })
    expect(page.data[0]?.number).toBe('CT-0001')
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/counts?limit=10&status=review&warehouseId=w1')
    expect(init?.headers).toMatchObject({ 'x-store-id': 's1' })
  })

  it('reads one page of a count with its totals and the line filter', async () => {
    const { client, fetchImpl } = setup(json(200, detail([line('l1', 7)], 'l1')))
    const count = await fetchCount(client, 's1', 'c1', { filter: 'variance', cursor: 'x' })
    expect(count.totals).toEqual({ lines: 3, counted: 1, withVariance: 1 })
    expect(count.lines[0]?.variance).toBe(-3)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/counts/c1?cursor=x&filter=variance'
    )
  })

  it('reads every page of a count, with the header and totals of the first', async () => {
    const { client, fetchImpl } = setup(
      json(200, detail([line('l1')], 'l1')),
      json(200, detail([line('l2', 4)], 'l2')),
      json(200, detail([line('l3')], null))
    )
    const count = await fetchAllCountLines(client, 's1', 'c1')
    expect(count.lines.map(item => item.id)).toEqual(['l1', 'l2', 'l3'])
    expect(count.hasMore).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('cursor=l1')
    expect(fetchImpl.mock.calls[2]?.[0]).toContain('cursor=l2')
  })

  it('stops following the cursor after as many pages as a count can hold', async () => {
    const { client, fetchImpl } = setup(json(200, detail([line('l1')], 'l1')))
    const count = await fetchAllCountLines(client, 's1', 'c1')
    // 2 000 lines at 100 a page, plus one page of margin
    expect(fetchImpl).toHaveBeenCalledTimes(21)
    expect(count.lines).toHaveLength(21)
  })

  it('reads all 2 000 lines of a full count on 20 pages and stops there', async () => {
    const pages = Array.from({ length: 20 }, (_, page) =>
      json(
        200,
        detail(
          Array.from({ length: 100 }, (_, index) => line(`l${page * 100 + index}`)),
          page === 19 ? null : `c${page}`
        )
      )
    )
    const { client, fetchImpl } = setup(...pages)
    const count = await fetchAllCountLines(client, 's1', 'c1')
    expect(count.lines).toHaveLength(2000)
    expect(new Set(count.lines.map(item => item.id)).size).toBe(2000)
    expect(fetchImpl).toHaveBeenCalledTimes(20)
  })

  it('creates a count in a warehouse, limited to a store', async () => {
    const { client, fetchImpl } = setup(json(201, { ...header, status: CountStatus.DRAFT }))
    const created = await createCount(client, 's1', {
      warehouseId: 'w1',
      storeId: 's2',
      note: 'q4'
    })
    expect(created.status).toBe(CountStatus.DRAFT)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/counts')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      warehouseId: 'w1',
      storeId: 's2',
      note: 'q4'
    })
  })

  it.each([
    ['start', startCount, '/counts/c1/start'],
    ['submit', submitCount, '/counts/c1/submit'],
    ['reopen', reopenCount, '/counts/c1/reopen'],
    ['apply', applyCount, '/counts/c1/apply'],
    ['cancel', cancelCount, '/counts/c1/cancel']
  ] as const)('%s posts to its own route and answers the header', async (_name, call, path) => {
    const { client, fetchImpl } = setup(json(200, header))
    const answer = await call(client, 's1', 'c1')
    expect(answer.id).toBe('c1')
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(`https://api.example.com/api/v1${path}`)
    expect(init?.method).toBe('POST')
  })

  it('sends the quantities of a few lines, null taking one back', async () => {
    const { client, fetchImpl } = setup(json(200, header))
    await updateCountLines(client, 's1', 'c1', [
      { lineId: 'l1', countedQuantity: 0 },
      { lineId: 'l2', countedQuantity: null }
    ])
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/counts/c1/lines')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({
      lines: [
        { lineId: 'l1', countedQuantity: 0 },
        { lineId: 'l2', countedQuantity: null }
      ]
    })
  })

  it('keeps the metadata of a refused apply for the screen to name the lines', async () => {
    const { client } = setup(
      json(409, {
        error: {
          code: 'INSUFFICIENT_INVENTORY',
          message: 'short',
          metadata: { conflict: 'short_stock', lines: [{ lineId: 'l1', requested: 4, onHand: 1 }] }
        },
        correlationId: 'req-1'
      })
    )
    const error = await applyCount(client, 's1', 'c1').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).metadata).toEqual({
      conflict: 'short_stock',
      lines: [{ lineId: 'l1', requested: 4, onHand: 1 }]
    })
  })

  it('reads every page of the active warehouses of the organization', async () => {
    const warehouse = (id: string) => ({ id, name: id, code: id, active: true, stores: [] })
    const { client, fetchImpl } = setup(
      json(200, { data: [warehouse('a')], nextCursor: 'a', hasMore: true }),
      json(200, { data: [warehouse('b')], nextCursor: null, hasMore: false })
    )
    const found = await fetchCountWarehouses(client, 's1')
    expect(found.map(item => item.id)).toEqual(['a', 'b'])
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('active=true')
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('cursor=a')
  })
})
