import { ApiRoutes } from '@platform/core/api'
import {
  OrderReturnCondition,
  ReceptionBatchStatus,
  ReceptionScanResults,
  ShipmentKind,
  ShipmentStatus
} from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  completeReceptionBatch,
  createReceptionBatch,
  fetchReceptionBatch,
  fetchReceptionBatches,
  removeReceptionItem,
  scanReceptionCode,
  updateReceptionItem
} from './reception-api'

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

const item = {
  id: 'i1',
  shipmentId: 's1',
  guideNumber: 'G-1',
  shipmentStatus: ShipmentStatus.RETURNING,
  orderId: 'o1',
  orderNumber: '00001',
  orderItems: [{ id: 'oi1', productName: 'Shoe', variantName: null, quantity: 2 }],
  customerIsCaution: false,
  reason: 'DELIVERY_FAILED',
  condition: OrderReturnCondition.RESELLABLE,
  note: null,
  lines: [],
  flagCustomer: false,
  flagReason: null,
  confirmDelivered: false,
  outcome: null,
  errorCode: null,
  returnId: null,
  flagApplied: false,
  scannedAt: '2026-11-12T10:00:00.000Z'
}

const batch = {
  id: 'b1',
  status: ReceptionBatchStatus.DRAFT,
  createdBy: 'u1',
  createdAt: '2026-11-12T10:00:00.000Z',
  completedAt: null,
  cautionPreselected: true,
  counts: { total: 1, received: 0, failed: 0, pending: 1 },
  items: [item]
}

const path = (url: unknown) => String(url).replace('https://api.example.com/api/v1', '')

describe('reception api', () => {
  it('lists the batches with an optional status and reads one with its packages', async () => {
    const { client, fetchImpl } = setup(json(200, [{ ...batch, items: undefined }]))
    const list = await fetchReceptionBatches(client, 's', ReceptionBatchStatus.DRAFT)
    expect(list[0]?.counts.pending).toBe(1)
    expect(path(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${ApiRoutes.returns.reception.batches}?status=draft`
    )

    const one = setup(json(200, batch))
    expect((await fetchReceptionBatch(one.client, 's', 'b1')).items[0]?.guideNumber).toBe('G-1')
    const plain = setup(json(200, []))
    await fetchReceptionBatches(plain.client, 's')
    expect(path(plain.fetchImpl.mock.calls[0]?.[0])).toBe(ApiRoutes.returns.reception.batches)
  })

  it('refuses an answer of another shape', async () => {
    const bad = setup(json(200, { ...batch, status: 'nonsense' }))
    await expect(fetchReceptionBatch(bad.client, 's', 'b1')).rejects.toBeInstanceOf(Error)
  })

  it('creates, scans, edits, removes and completes through its own routes', async () => {
    const { client, fetchImpl } = setup(json(200, batch))
    await createReceptionBatch(client, 's')
    await completeReceptionBatch(client, 's', 'b1')
    expect(fetchImpl.mock.calls.map(([url, init]) => [path(url), init.method])).toEqual([
      [ApiRoutes.returns.reception.batches, 'POST'],
      [ApiRoutes.returns.reception.complete('b1'), 'POST']
    ])

    const edit = setup(json(200, item))
    await updateReceptionItem(edit.client, 's', 'b1', 'i1', { flagCustomer: false })
    expect(path(edit.fetchImpl.mock.calls[0]?.[0])).toBe(
      ApiRoutes.returns.reception.itemById('b1', 'i1')
    )
    expect(edit.fetchImpl.mock.calls[0]?.[1].method).toBe('PATCH')

    const gone = setup(new Response(null, { status: 204 }))
    await removeReceptionItem(gone.client, 's', 'b1', 'i1')
    expect(gone.fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })

  it('reads the four answers of a scan', async () => {
    const added = setup(json(200, { result: ReceptionScanResults.ADDED, item }))
    const found = await scanReceptionCode(added.client, 's', 'b1', { code: 'G-1' })
    expect(found.result).toBe(ReceptionScanResults.ADDED)
    expect(JSON.parse(added.fetchImpl.mock.calls[0]?.[1].body as string)).toEqual({ code: 'G-1' })

    const none = setup(json(200, { result: ReceptionScanResults.NOT_FOUND }))
    expect((await scanReceptionCode(none.client, 's', 'b1', { code: 'x' })).result).toBe(
      ReceptionScanResults.NOT_FOUND
    )

    const many = setup(
      json(200, {
        result: ReceptionScanResults.AMBIGUOUS,
        candidates: [
          {
            shipmentId: 's1',
            guideNumber: 'G-1',
            orderNumber: '00001',
            status: ShipmentStatus.RETURNING,
            kind: ShipmentKind.OUTBOUND
          }
        ]
      })
    )
    const answer = await scanReceptionCode(many.client, 's', 'b1', { code: 'G-1' })
    expect(answer.result === ReceptionScanResults.AMBIGUOUS && answer.candidates).toHaveLength(1)

    const delivered = setup(
      json(200, {
        result: ReceptionScanResults.NEEDS_CONFIRMATION,
        candidate: {
          shipmentId: 's1',
          guideNumber: 'G-1',
          orderNumber: '00001',
          status: ShipmentStatus.DELIVERED,
          kind: ShipmentKind.OUTBOUND
        }
      })
    )
    const asked = await scanReceptionCode(delivered.client, 's', 'b1', {
      code: 'G-1',
      confirmDelivered: true
    })
    expect(asked.result === ReceptionScanResults.NEEDS_CONFIRMATION && asked.candidate.status).toBe(
      ShipmentStatus.DELIVERED
    )
    expect(JSON.parse(delivered.fetchImpl.mock.calls[0]?.[1].body as string)).toEqual({
      code: 'G-1',
      confirmDelivered: true
    })
  })
})
