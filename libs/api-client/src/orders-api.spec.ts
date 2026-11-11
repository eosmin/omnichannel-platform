import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import {
  cancelOrder,
  changeOrderStatus,
  confirmOrder,
  confirmOrdersBulk,
  decideOrderPrice,
  fetchOrder,
  fetchOrders,
  getOrderCopy,
  recordOrderPayment,
  requestOrdersExport
} from './orders-api'

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

const summary = {
  id: 'o1',
  orderNumber: '00001',
  customerId: 'c1',
  customer: { id: 'c1', name: 'Ana' },
  status: 'CONFIRMED',
  subtotalCents: 1000,
  shippingCents: 200,
  discountCents: 0,
  totalCents: 1200,
  currency: 'USD',
  paymentMethod: 'CASH',
  paymentStatus: 'PENDING',
  priceApprovalStatus: 'not_required',
  freeShipping: false,
  scheduledDeliveryDate: '2026-11-12',
  priceModified: false,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z'
}

const detail = {
  ...summary,
  conversationId: null,
  paymentReference: null,
  paymentProofMediaId: null,
  shippingAddress: null,
  customerNotes: null,
  recipientPhones: [],
  trackingNumber: null,
  cancellationReason: null,
  cancelledBy: null,
  cancelledAt: null,
  proofOfDeliveryMediaId: null,
  confirmedAt: null,
  confirmedBy: null,
  confirmedVia: null,
  discountReason: null,
  priceApprovalRequestedBy: null,
  priceApprovedBy: null,
  priceApprovedAt: null,
  priceApprovedDiscountCents: null,
  priceApprovedShippingCents: null,
  createdBy: 'u1',
  shippedAt: null,
  deliveredAt: null,
  customer: { id: 'c1', name: 'Ana', email: null, phone: null, nationalPhone: null },
  items: [],
  priceModified: false
}

describe('orders api', () => {
  it('asks the list with the filters, the sort and the cursor, in the store of the request', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [summary], nextCursor: 'n', hasMore: true })
    )
    const page = await fetchOrders(client, 's1', {
      q: ' ana ',
      status: 'CONFIRMED',
      scheduledDeliveryOn: 'today',
      sort: 'scheduled_delivery',
      cursor: 'c2',
      createdFrom: undefined
    })
    expect(page.data[0]?.customer.name).toBe('Ana')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const query = new URL(url).searchParams
    expect(new URL(url).pathname).toBe('/api/v1/orders')
    expect(Object.fromEntries(query)).toEqual({
      q: 'ana',
      status: 'CONFIRMED',
      scheduledDeliveryOn: 'today',
      sort: 'scheduled_delivery',
      cursor: 'c2'
    })
    expect((init.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBe('s1')
  })

  it('sends no query for an empty filter', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchOrders(client, 's1', { q: '  ', cursor: null })
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/orders$/)
  })

  it('refuses an answer that does not fit the page', async () => {
    const { client } = setup(json(200, { data: [{ id: 'o1' }], nextCursor: null, hasMore: false }))
    await expect(fetchOrders(client, 's1', {})).rejects.toThrow()
  })

  it('reads an order whose internal notes the api left out', async () => {
    const { client } = setup(json(200, detail))
    const order = await fetchOrder(client, 's1', 'o1')
    expect(order.internalNotes).toBeUndefined()
    expect(order.customer.nationalPhone).toBeNull()
  })

  it('queues the export on the route before the id, with the filters', async () => {
    const { client, fetchImpl } = setup(
      json(202, {
        id: 'e1',
        type: 'orders',
        format: 'csv',
        status: 'pending',
        filename: null,
        rowCount: null,
        progress: null,
        error: null,
        createdAt: '2026-11-10T10:00:00.000Z',
        completedAt: null,
        expiresAt: '2026-11-17T10:00:00.000Z'
      })
    )
    await requestOrdersExport(client, 's1', { status: 'SHIPPED', q: 'ana' })
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.pathname).toBe('/api/v1/orders/export')
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'SHIPPED', q: 'ana' })
  })

  it('posts each mutation to its own route with its own body', async () => {
    const { client, fetchImpl } = setup(json(200, detail))
    await changeOrderStatus(client, 's1', 'o1', { status: 'SHIPPED' } as never)
    await confirmOrder(client, 's1', 'o1', 'call')
    await cancelOrder(client, 's1', 'o1', 'duplicate')
    await recordOrderPayment(client, 's1', 'o1', { method: 'CASH', status: 'COMPLETED' } as never)
    await decideOrderPrice(client, 's1', 'o1', 'approve')
    await decideOrderPrice(client, 's1', 'o1', 'reject', 'too low')
    const calls = fetchImpl.mock.calls.map(([url, init]) => [
      new URL(url).pathname.replace('/api/v1', ''),
      init.method,
      init.body
    ])
    expect(calls).toEqual([
      ['/orders/o1/status', 'POST', JSON.stringify({ status: 'SHIPPED' })],
      ['/orders/o1/confirm', 'POST', JSON.stringify({ via: 'call' })],
      ['/orders/o1/cancel', 'POST', JSON.stringify({ cancellationReason: 'duplicate' })],
      ['/orders/o1/payment', 'POST', JSON.stringify({ method: 'CASH', status: 'COMPLETED' })],
      ['/orders/o1/price-approval/approve', 'POST', JSON.stringify({})],
      ['/orders/o1/price-approval/reject', 'POST', JSON.stringify({ reason: 'too low' })]
    ])
  })

  it('confirms a selection in one call and reads what changed and what did not', async () => {
    const answer = { succeeded: ['o1'], failed: [{ id: 'o2', code: 'ORDER_ALREADY_CONFIRMED' }] }
    const { client, fetchImpl } = setup(json(200, answer))

    expect(await confirmOrdersBulk(client, 's1', ['o1', 'o2'], 'call')).toEqual(answer)

    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; body: string }]
    expect(new URL(url).pathname).toBe('/api/v1/orders/confirm-bulk')
    expect([init.method, init.body]).toEqual([
      'POST',
      JSON.stringify({ ids: ['o1', 'o2'], via: 'call' })
    ])
  })

  it('reads the draft of a copy from the order it names', async () => {
    const copy = {
      draft: {
        customerId: 'c1',
        items: [{ productId: 'p1', quantity: 2 }],
        shippingCents: 0,
        paymentMethod: 'CASH',
        recipientPhones: ['71234567'],
        copiedFromOrderId: 'o1'
      },
      lines: [
        {
          productId: 'p1',
          variantId: null,
          productName: 'Mug',
          variantName: null,
          quantity: 2,
          unitPriceCents: 1200,
          previousUnitPriceCents: 1000
        }
      ],
      warnings: [{ code: 'price_changed', itemIndex: 0, productId: 'p1', variantId: null }]
    }
    const { client, fetchImpl } = setup(json(200, copy))

    expect(await getOrderCopy(client, 's1', 'o1')).toEqual(copy)

    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).pathname).toBe('/api/v1/orders/o1/copy')
  })
})
