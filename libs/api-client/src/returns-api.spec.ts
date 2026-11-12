import { ApiRoutes } from '@platform/core/api'
import { OrderReturnCondition, OrderReturnStatus, OrderReturnType } from '@platform/core/domain'

import { createApiClient } from './api-client'
import { ApiError } from './api-error'
import {
  approveReturn,
  cancelReturn,
  completeReturn,
  createReturn,
  fetchReturn,
  fetchReturns,
  markReturnInTransit,
  receiveReturn,
  rejectReturn
} from './returns-api'

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

const view = {
  id: 'r1',
  orderId: 'o1',
  orderNumber: '00001',
  type: OrderReturnType.REFUND,
  reason: 'DEFECTIVE',
  status: OrderReturnStatus.REQUESTED,
  shippingPayer: 'sender',
  replacementOrderId: null,
  returnShipmentId: null,
  refundAmountCents: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '2026-11-12T10:00:00.000Z',
  receivedAt: null,
  lines: [
    {
      id: 'l1',
      orderItemId: 'i1',
      productName: 'Shoe',
      variantName: null,
      quantity: 1,
      condition: null,
      restockWarehouseId: null
    }
  ]
}

describe('returns api', () => {
  it('lists the returns of the store with the filters', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [view], nextCursor: null, hasMore: false })
    )

    const page = await fetchReturns(client, 's1', {
      status: OrderReturnStatus.REQUESTED,
      orderId: 'o1',
      limit: 10
    })

    expect(page.data[0]?.orderNumber).toBe('00001')
    const [url] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(
      `https://api.example.com/api/v1${ApiRoutes.returns.list}?limit=10&status=requested&orderId=o1`
    )
  })

  it('reads one return, and an answer of another shape is an error', async () => {
    const { client } = setup(json(200, view))
    expect((await fetchReturn(client, 's1', 'r1')).lines).toHaveLength(1)

    const bad = setup(json(200, { ...view, status: 'nonsense' }))
    await expect(fetchReturn(bad.client, 's1', 'r1')).rejects.toBeInstanceOf(Error)
  })

  it('creates, moves and receives a return through its own routes', async () => {
    const { client, fetchImpl } = setup(json(200, view))
    await createReturn(client, 's1', {
      orderId: 'o1',
      type: OrderReturnType.REFUND,
      reason: 'DEFECTIVE',
      lines: [{ orderItemId: 'i1', quantity: 1 }]
    })
    await approveReturn(client, 's1', 'r1')
    await markReturnInTransit(client, 's1', 'r1')
    await rejectReturn(client, 's1', 'r1', { notes: 'no' })
    await cancelReturn(client, 's1', 'r1', {})
    await receiveReturn(client, 's1', 'r1', {
      lines: [{ orderItemId: 'i1', condition: OrderReturnCondition.RESELLABLE }]
    })
    await completeReturn(client, 's1', 'r1', { refundAmountCents: 1000 })

    const calls = fetchImpl.mock.calls.map(([url, init]) => [
      String(url).replace('https://api.example.com/api/v1', ''),
      init.method
    ])
    expect(calls).toEqual([
      [ApiRoutes.returns.create, 'POST'],
      [ApiRoutes.returns.approve('r1'), 'POST'],
      [ApiRoutes.returns.inTransit('r1'), 'POST'],
      [ApiRoutes.returns.reject('r1'), 'POST'],
      [ApiRoutes.returns.cancel('r1'), 'POST'],
      [ApiRoutes.returns.receive('r1'), 'POST'],
      [ApiRoutes.returns.complete('r1'), 'POST']
    ])
  })

  it('raises the error of the api', async () => {
    const { client } = setup(
      json(409, { error: { code: 'RETURN_QUANTITY_EXCEEDS_DELIVERED', message: 'x' } })
    )
    await expect(
      createReturn(client, 's1', {
        orderId: 'o1',
        type: OrderReturnType.REFUND,
        reason: 'DEFECTIVE',
        lines: [{ orderItemId: 'i1', quantity: 9 }]
      })
    ).rejects.toBeInstanceOf(ApiError)
  })
})
