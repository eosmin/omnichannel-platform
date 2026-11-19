import { PurchaseOrderStatus } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  fetchAllSuppliers,
  fetchPayables,
  fetchPurchaseOrderPage,
  fetchSupplierPaymentReturns,
  receivePurchaseOrder,
  recordPurchaseOrderPayment,
  recordSupplierPaymentReturn,
  voidSupplierPayment,
  voidSupplierPaymentReturn
} from './purchases-api'

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

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

const supplier = (id: string) => ({
  id,
  name: `Supplier ${id}`,
  taxId: null,
  contactName: null,
  email: null,
  phone: null,
  paymentTermsDays: 30,
  defaultPayableAccountId: null,
  active: true,
  createdAt: '2026-11-01T10:00:00.000Z'
})

const orderBody = {
  id: 'o1',
  number: 'PO-000001',
  supplierId: 's1',
  warehouseId: 'w1',
  status: 'ordered',
  orderedOn: '2026-11-10',
  expectedOn: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '2026-11-10T10:00:00.000Z',
  lines: [],
  receipts: []
}

const payment = {
  id: 'p1',
  supplierId: 's1',
  purchaseReceiptId: 'r1',
  paidFromAccountId: 'a1',
  amountCents: 12_345,
  paidOn: '2026-11-16',
  reference: null,
  entryId: 'e1',
  voidedByEntryId: null,
  createdBy: 'u1',
  createdAt: '2026-11-16T10:00:00.000Z'
}

describe('purchases-api', () => {
  it('follows the pages of the suppliers, with the store of the request, until the api says there are no more', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [supplier('s1')], nextCursor: 'c1', hasMore: true }),
      json(200, { data: [supplier('s2')], nextCursor: null, hasMore: false })
    )

    const all = await fetchAllSuppliers(client, 'store-1')

    expect(all.map(item => item.id)).toEqual(['s1', 's2'])
    const second = callOf(fetchImpl, 1)
    expect(second.url).toContain('/suppliers?')
    expect(second.url).toContain('cursor=c1')
    expect(second.headers.get('x-store-id')).toBe('store-1')
  })

  it('asks for the orders of a status and a supplier, and leaves out what is empty', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [orderBody], nextCursor: null, hasMore: false })
    )

    const page = await fetchPurchaseOrderPage(client, 'store-1', {
      status: PurchaseOrderStatus.ORDERED,
      supplierId: ''
    })

    expect(page.data[0]?.number).toBe('PO-000001')
    const { url } = callOf(fetchImpl)
    expect(url).toContain('status=ordered')
    expect(url).not.toContain('supplierId')
  })

  it('asks for the payables of a supplier, only the overdue ones when told', async () => {
    const { client, fetchImpl } = setup(json(200, { bills: [], suppliers: [] }))

    await fetchPayables(client, 'store-1', { supplierId: 's1', overdueOnly: true })

    const { url } = callOf(fetchImpl)
    expect(url).toContain('supplierId=s1')
    expect(url).toContain('overdueOnly=true')
  })

  it('posts a receipt with its body and answers the order', async () => {
    const { client, fetchImpl } = setup(json(201, orderBody))

    const order = await receivePurchaseOrder(client, 'store-1', 'o1', {
      idempotencyKey: 'a-key-of-the-form-0001',
      receivedOn: '2026-11-16',
      lines: [{ orderLineId: 'l1', quantity: 2 }]
    })

    expect(order.status).toBe(PurchaseOrderStatus.ORDERED)
    const { url, init } = callOf(fetchImpl)
    expect(url).toBe('https://api.example.com/api/v1/purchase-orders/o1/receive')
    expect(init.method).toBe('POST')
    expect((JSON.parse(init.body as string) as { lines: unknown }).lines).toEqual([
      { orderLineId: 'l1', quantity: 2 }
    ])
  })

  it('pays a bill through its order and voids a payment with its reason', async () => {
    const { client, fetchImpl } = setup(json(201, payment))

    await recordPurchaseOrderPayment(client, 'store-1', 'o1', {
      idempotencyKey: 'a-key-of-the-form-0002',
      paidFromAccountId: '00000000-0000-4000-8000-000000000001',
      amountCents: 12_345,
      paidOn: '2026-11-16'
    })
    await voidSupplierPayment(client, 'store-1', 'p1', { reason: 'Paid twice' })

    expect(callOf(fetchImpl, 0).url).toBe(
      'https://api.example.com/api/v1/purchase-orders/o1/payments'
    )
    expect(callOf(fetchImpl, 1).url).toBe(
      'https://api.example.com/api/v1/supplier-payments/p1/void'
    )
    expect(JSON.parse(callOf(fetchImpl, 1).init.body as string)).toEqual({ reason: 'Paid twice' })
  })

  it('lists, records and voids the returns of a payment', async () => {
    const row = {
      id: 'r1',
      supplierId: 's1',
      supplierPaymentId: 'p1',
      receivedIntoAccountId: 'a1',
      amountCents: 500,
      returnedOn: '2026-11-18',
      reference: null,
      entryId: 'e1',
      voidedByEntryId: null,
      createdBy: 'u1',
      createdAt: '2026-11-18T10:00:00.000Z'
    }
    const { client, fetchImpl } = setup(
      json(200, { data: [row], nextCursor: null, hasMore: false }),
      json(201, row),
      json(200, { ...row, voidedByEntryId: 'e2' })
    )

    const page = await fetchSupplierPaymentReturns(client, 'store-1', 'p1', null)
    await recordSupplierPaymentReturn(client, 'store-1', 'p1', {
      idempotencyKey: 'k',
      receivedIntoAccountId: 'a1',
      amountCents: 500,
      returnedOn: '2026-11-18'
    })
    const voided = await voidSupplierPaymentReturn(client, 'store-1', 'r1', { reason: 'Bounced' })

    expect(page.data[0]?.amountCents).toBe(500)
    expect(callOf(fetchImpl, 0).url).toContain('/api/v1/supplier-payments/p1/returns?limit=')
    expect(callOf(fetchImpl, 1).url).toBe(
      'https://api.example.com/api/v1/supplier-payments/p1/returns'
    )
    expect(callOf(fetchImpl, 2).url).toBe(
      'https://api.example.com/api/v1/supplier-payment-returns/r1/void'
    )
    expect(voided.voidedByEntryId).toBe('e2')
  })
})
