import { TransferShortageAction, TransferStatus } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  cancelTransfer,
  closeTransfer,
  createTransfer,
  dispatchTransfer,
  fetchTransfer,
  fetchTransferPage,
  receiveTransfer,
  updateTransfer
} from './transfers-api'

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

const header = {
  id: 't1',
  number: 'TR-0001',
  status: TransferStatus.IN_TRANSIT,
  fromWarehouse: { id: 'w1', name: 'Main', code: 'MAIN' },
  toWarehouse: { id: 'w2', name: 'Outlet', code: 'OUT' },
  note: null,
  createdBy: 'u1',
  dispatchedBy: 'u1',
  dispatchedAt: '2026-11-11T10:00:00.000Z',
  closedAt: null,
  createdAt: '2026-11-11T09:00:00.000Z',
  updatedAt: '2026-11-11T10:00:00.000Z'
}

const transfer = {
  ...header,
  lines: [
    {
      id: 'l1',
      storeId: 's1',
      productId: 'p1',
      productName: 'Shoe',
      variantId: null,
      variantName: null,
      sku: 'SHOE-1',
      quantity: 5,
      receivedQuantity: 2,
      pendingQuantity: 3,
      shortageAction: null
    }
  ]
}

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>) => {
  const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

describe('transfers api', () => {
  it('reads a page with its filters, through the store of the request', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [{ ...header, lineCount: 1 }], nextCursor: null, hasMore: false })
    )

    const page = await fetchTransferPage(client, 's1', {
      status: TransferStatus.IN_TRANSIT,
      warehouseId: 'w1',
      cursor: 'c1',
      limit: 20
    })

    const call = callOf(fetchImpl)
    expect(call.url).toBe(
      'https://api.example.com/api/v1/transfers?status=in_transit&warehouseId=w1&cursor=c1&limit=20'
    )
    expect(call.headers.get('x-store-id')).toBe('s1')
    expect(page.data[0]?.lineCount).toBe(1)
  })

  it('sends only the limit when no filter is given', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchTransferPage(client, 's1')
    expect(callOf(fetchImpl).url).toMatch(/\/transfers\?limit=\d+$/)
  })

  it('encodes the id of every transfer it names', async () => {
    const { client, fetchImpl } = setup(json(200, transfer))
    await fetchTransfer(client, 's1', 'a/b')
    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/transfers/a%2Fb')
  })

  it('refuses an answer with a status the app does not know', async () => {
    const { client } = setup(json(200, { ...transfer, status: 'lost' }))
    await expect(fetchTransfer(client, 's1', 't1')).rejects.toThrow()
  })

  it('reads one transfer with the pending units of each line', async () => {
    const { client, fetchImpl } = setup(json(200, transfer))
    const view = await fetchTransfer(client, 's1', 't1')
    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/transfers/t1')
    expect(view.lines[0]?.pendingQuantity).toBe(3)
  })

  it('makes a draft with POST and the lines as given', async () => {
    const { client, fetchImpl } = setup(json(201, { ...transfer, status: TransferStatus.DRAFT }))
    await createTransfer(client, 's1', {
      fromWarehouseId: 'w1',
      toWarehouseId: 'w2',
      lines: [{ productId: 'p1', quantity: 5 }]
    })
    const call = callOf(fetchImpl)
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(call.init.body as string)).toEqual({
      fromWarehouseId: 'w1',
      toWarehouseId: 'w2',
      lines: [{ productId: 'p1', quantity: 5 }]
    })
  })

  it('edits a draft with PATCH, a null note clears it', async () => {
    const { client, fetchImpl } = setup(json(200, transfer))
    await updateTransfer(client, 's1', 't 1', { note: null })
    const call = callOf(fetchImpl)
    expect(call.url).toBe('https://api.example.com/api/v1/transfers/t%201')
    expect(call.init.method).toBe('PATCH')
    expect(JSON.parse(call.init.body as string)).toEqual({ note: null })
  })

  it('dispatches and cancels with POST and no body', async () => {
    const dispatched = setup(json(200, transfer))
    await dispatchTransfer(dispatched.client, 's1', 't1')
    expect(callOf(dispatched.fetchImpl).url).toBe(
      'https://api.example.com/api/v1/transfers/t1/dispatch'
    )
    expect(callOf(dispatched.fetchImpl).init.method).toBe('POST')
    expect(callOf(dispatched.fetchImpl).init.body).toBeUndefined()

    const cancelled = setup(json(200, { ...transfer, status: TransferStatus.CANCELLED }))
    const view = await cancelTransfer(cancelled.client, 's1', 't1')
    expect(callOf(cancelled.fetchImpl).url).toBe(
      'https://api.example.com/api/v1/transfers/t1/cancel'
    )
    expect(view.status).toBe(TransferStatus.CANCELLED)
  })

  it('receives with the receipt key and the units of each line', async () => {
    const { client, fetchImpl } = setup(json(200, transfer))
    await receiveTransfer(client, 's1', 't1', {
      receiptKey: '0b6f6f1e-6b43-4f5b-9a55-3f0f0f0f0f0f',
      lines: [{ lineId: 'l1', quantity: 2 }]
    })
    const call = callOf(fetchImpl)
    expect(call.url).toBe('https://api.example.com/api/v1/transfers/t1/receive')
    expect(JSON.parse(call.init.body as string)).toEqual({
      receiptKey: '0b6f6f1e-6b43-4f5b-9a55-3f0f0f0f0f0f',
      lines: [{ lineId: 'l1', quantity: 2 }]
    })
  })

  it('closes with the action chosen for each short line', async () => {
    const { client, fetchImpl } = setup(json(200, { ...transfer, status: TransferStatus.RECEIVED }))
    await closeTransfer(client, 's1', 't1', {
      lines: [{ lineId: 'l1', action: TransferShortageAction.WRITE_OFF }]
    })
    const call = callOf(fetchImpl)
    expect(call.url).toBe('https://api.example.com/api/v1/transfers/t1/close')
    expect(JSON.parse(call.init.body as string)).toEqual({
      lines: [{ lineId: 'l1', action: 'write_off' }]
    })
  })
})
