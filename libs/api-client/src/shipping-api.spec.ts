import { createApiClient } from './api-client'
import {
  fetchBulkLabelJob,
  fetchOrderMessages,
  fetchShipmentsForOrders,
  mergeLabels,
  previewOrderMessage,
  requestPickup,
  sendOrderMessage,
  startBulkLabels
} from './shipping-api'

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

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>) => {
  const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

const job = {
  id: 'j1',
  status: 'running',
  total: 2,
  succeeded: 1,
  failed: 0,
  results: null,
  download: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  finishedAt: null
}

describe('shipping api', () => {
  it('asks for the shipments of the orders on the page in one request, through the store', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchShipmentsForOrders(client, 's1', ['o1', 'o2'])
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/shipments?orderIds=o1%2Co2')
    expect(headers.get('x-store-id')).toBe('s1')
  })

  it('asks in requests of at most a run of orders and follows the cursor to the end', async () => {
    const shipment = (id: string) => ({
      id,
      orderId: 'o1',
      connectionId: 'c1',
      connectionName: 'X',
      kind: 'outbound',
      status: 'label_created',
      guideNumber: 'G',
      trackingUrl: null,
      hasLabel: true,
      pickupId: null,
      createdAt: '2026-11-12T10:00:00.000Z'
    })
    const answers = [
      json(200, { data: [shipment('a')], nextCursor: 'next', hasMore: true }),
      json(200, { data: [shipment('b')], nextCursor: null, hasMore: false }),
      json(200, { data: [shipment('c')], nextCursor: null, hasMore: false })
    ]
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockImplementation(() => Promise.resolve((answers.shift() as Response).clone()))
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      getAccessToken: () => 'token',
      refreshAccessToken: () => Promise.resolve('token'),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    const page = await fetchShipmentsForOrders(
      client,
      's1',
      Array.from({ length: 150 }, (_, index) => `o${index}`)
    )
    expect(page.data.map(row => row.id)).toEqual(['a', 'b', 'c'])
    const urls = fetchImpl.mock.calls.map(call => new URL(call[0]).searchParams)
    expect(urls[0]?.get('orderIds')?.split(',')).toHaveLength(100)
    expect(urls[1]?.get('cursor')).toBe('next')
    expect(urls[2]?.get('orderIds')?.split(',')).toHaveLength(50)
    expect(urls[2]?.get('cursor')).toBeNull()
  })

  it('starts a run with the orders in the order of the selection and the carrier when one is chosen', async () => {
    const { client, fetchImpl } = setup(json(202, job))
    await startBulkLabels(client, 's1', { orderIds: ['o2', 'o1'], connectionId: 'c1' })
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/shipments/bulk')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ orderIds: ['o2', 'o1'], connectionId: 'c1' })
  })

  it('sends the places of the batch with the carrier they belong to', async () => {
    const { client, fetchImpl } = setup(json(202, job))
    const locationIds = { departmentId: '2', municipalityId: '21' }
    await startBulkLabels(client, 's1', { orderIds: ['o1'], connectionId: 'c1', locationIds })
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({
      orderIds: ['o1'],
      connectionId: 'c1',
      locationIds
    })
  })

  it('reads a run by its id', async () => {
    const { client, fetchImpl } = setup(json(200, job))
    expect((await fetchBulkLabelJob(client, 's1', 'j1')).status).toBe('running')
    expect(callOf(fetchImpl).url).toContain('/shipments/bulk/j1')
  })

  it('merges the labels of the shipments named', async () => {
    const { client, fetchImpl } = setup(
      json(200, { download: null, merged: ['s1'], leftOut: [], pageCount: 1, mixedSizes: false })
    )
    await mergeLabels(client, 's1', ['sh1'])
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/shipments/labels/merge')
    expect(JSON.parse(init.body as string)).toEqual({ shipmentIds: ['sh1'] })
  })

  it('requests a pickup of the guides named for one connection', async () => {
    const { client, fetchImpl } = setup(
      json(201, {
        pickup: {
          id: 'p1',
          connectionId: 'c1',
          connectionName: 'X',
          pickupDate: '2026-11-13',
          status: 'pending',
          packageCount: 1
        },
        created: true,
        joined: [],
        waiting: [{ shipmentId: 'sh1', reason: 'cutoff_passed' }]
      })
    )
    const result = await requestPickup(client, 's1', { connectionId: 'c1', shipmentIds: ['sh1'] })
    expect(result.waiting[0]?.reason).toBe('cutoff_passed')
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({
      connectionId: 'c1',
      shipmentIds: ['sh1']
    })
  })

  it('sends the summary of an order with the key of the press', async () => {
    const { client, fetchImpl } = setup(
      json(200, { status: 'sent', route: 'email', messageId: null })
    )
    const outcome = await sendOrderMessage(client, 's1', 'o1', {
      kind: 'order_summary',
      idempotencyKey: 'press-0001'
    })
    expect(outcome.status).toBe('sent')
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/orders/o1/messages')
    expect(JSON.parse(init.body as string)).toEqual({
      kind: 'order_summary',
      idempotencyKey: 'press-0001'
    })
  })

  it('reads a page of the history of an order and follows its cursor', async () => {
    const item = {
      id: 'd1',
      kind: 'order_shipped',
      trigger: 'manual',
      route: 'not_sent',
      status: 'not_sent',
      reason: 'missing_variable',
      locale: null,
      shipmentId: null,
      deliveryStatus: null,
      deliveryError: null,
      requestedBy: { id: 'u1', name: 'Ana' },
      createdAt: '2026-11-12T10:00:00.000Z'
    }
    const { client, fetchImpl } = setup(
      json(200, { data: [item], nextCursor: 'c2', hasMore: true })
    )
    const page = await fetchOrderMessages(client, 's1', 'o1', 'c1')
    expect(page.data[0]?.reason).toBe('missing_variable')
    expect(page.nextCursor).toBe('c2')
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/orders/o1/messages?cursor=c1')
    expect(headers.get('x-store-id')).toBe('s1')
  })

  it('previews a message with the preview flag and no key, and reads a refusal', async () => {
    const { client, fetchImpl } = setup(
      json(200, { preview: true, ok: false, reason: 'missing_variable', missing: ['trackingUrl'] })
    )
    const preview = await previewOrderMessage(client, 's1', 'o1', 'order_shipped')
    expect(preview).toEqual({ ok: false, reason: 'missing_variable', missing: ['trackingUrl'] })
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/orders/o1/messages?preview=true')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'order_shipped' })
  })
})
