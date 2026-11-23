import { ApiError, createApiClient } from '@platform/api-client'
import { DSR_REQUEST_VIEW_KEYS, DsrNoticeStatuses, DsrStatus, DsrType } from '@platform/core/domain'

import {
  approveDsrRequest,
  cancelDsrErasure,
  fetchDsrExportLink,
  fetchDsrRequest,
  fetchDsrRequests,
  rejectDsrRequest
} from './dsr-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  const call = () => {
    const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
    return { url, init, headers: new Headers(init.headers) }
  }
  return { client, call }
}

const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined

const request = {
  id: 'r1',
  type: DsrType.ERASURE,
  status: DsrStatus.MANUAL_REVIEW,
  requestedAt: '2026-11-01T10:00:00.000Z',
  deadlineAt: '2026-12-01T10:00:00.000Z',
  verifiedAt: '2026-11-01T11:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  requestedBy: null,
  erasureDueAt: null,
  erasureFailureCode: null,
  completedAt: null,
  rejectionReason: null,
  noticeStatus: DsrNoticeStatuses.NONE,
  exportReady: false,
  exportExpiresAt: null,
  exportFailureCode: null,
  retainedRecordsSummary: null,
  subjectCustomerIds: ['c1'],
  approvals: [],
  notes: null
}

describe('the data requests api calls', () => {
  it('reads exactly the fields the api pins as its answer (DSR_REQUEST_VIEW_KEYS)', async () => {
    expect(Object.keys(request).sort()).toEqual([...DSR_REQUEST_VIEW_KEYS].sort())
    const { client } = setup({ data: [request], nextCursor: null, hasMore: false })
    const page = await fetchDsrRequests(client, 'store-1', null)
    expect(Object.keys(page.data[0] ?? {}).sort()).toEqual([...DSR_REQUEST_VIEW_KEYS].sort())
  })

  it('reads the queue by the store of the header, a hundred at a time, from a cursor', async () => {
    const { client, call } = setup({ data: [request], nextCursor: 'r1', hasMore: true })
    const page = await fetchDsrRequests(client, 'store-1', 'r0')
    expect(page.data).toHaveLength(1)
    expect(call().url).toBe('https://api.example.com/api/v1/compliance/dsr?limit=100&cursor=r0')
    expect(call().headers.get('x-store-id')).toBe('store-1')
  })

  it('reads the first page with no cursor', async () => {
    const { client, call } = setup({ data: [], nextCursor: null, hasMore: false })
    await fetchDsrRequests(client, 'store-1', null)
    expect(call().url).toBe('https://api.example.com/api/v1/compliance/dsr?limit=100')
  })

  it('reads one request with what an erasure would wait for', async () => {
    const openWork = { orders: 1, shipments: 0, returns: 0, remittances: 0, receivables: 2 }
    const { client, call } = setup({ ...request, openWork })
    const detail = await fetchDsrRequest(client, 'store-1', 'r1')
    expect(detail.openWork).toEqual(openWork)
    expect(call().url).toBe('https://api.example.com/api/v1/compliance/dsr/r1')
  })

  it('sends the confirmation and the reason of an approval, and only the reason of a refusal or a cancellation', async () => {
    const approve = setup(request)
    await approveDsrRequest(approve.client, 'store-1', 'r1', 'verified by phone')
    expect(approve.call().url).toBe('https://api.example.com/api/v1/compliance/dsr/r1/approve')
    expect(approve.call().init.method).toBe('POST')
    expect(bodyOf(approve.call().init)).toEqual({ confirm: true, reason: 'verified by phone' })

    const reject = setup(request)
    await rejectDsrRequest(reject.client, 'store-1', 'r1', 'not the owner')
    expect(reject.call().url).toBe('https://api.example.com/api/v1/compliance/dsr/r1/reject')
    expect(bodyOf(reject.call().init)).toEqual({ reason: 'not the owner' })

    const cancel = setup(request)
    await cancelDsrErasure(cancel.client, 'store-1', 'r1', 'asked to stop')
    expect(cancel.call().url).toBe('https://api.example.com/api/v1/compliance/dsr/r1/cancel')
    expect(bodyOf(cancel.call().init)).toEqual({ reason: 'asked to stop' })
  })

  it('keeps a type, a status, a notice state and a code it does not know as the text they came as', async () => {
    const { client } = setup({
      data: [
        {
          ...request,
          type: 'new_kind',
          status: 'new_status',
          noticeStatus: 'new_state',
          erasureFailureCode: 'new_code'
        }
      ],
      nextCursor: null,
      hasMore: false
    })
    const page = await fetchDsrRequests(client, 'store-1', null)
    expect(page.data[0]).toMatchObject({
      type: 'new_kind',
      status: 'new_status',
      noticeStatus: 'new_state',
      erasureFailureCode: 'new_code'
    })
  })

  it('reads the closing summary as a basis and whole counts, and drops what is not a count', async () => {
    const { client } = setup({
      ...request,
      openWork: null,
      retainedRecordsSummary: {
        legalBasis: 'legal_obligation',
        orders: 3,
        conversations: 0,
        note: 'free text',
        messages: -1,
        files: 1.5
      }
    })
    const detail = await fetchDsrRequest(client, 'store-1', 'r1')
    expect(detail.retainedRecordsSummary).toEqual({
      legalBasis: 'legal_obligation',
      counts: { orders: 3, conversations: 0 }
    })
  })

  it('reads a summary that is not an object as no summary, and never fails the whole request for it', async () => {
    const { client } = setup({ ...request, openWork: null, retainedRecordsSummary: 'oops' })
    const detail = await fetchDsrRequest(client, 'store-1', 'r1')
    expect(detail.retainedRecordsSummary).toBeNull()
  })

  it('refuses an answer that has no state of the closing notice, so a failure is never hidden by a missing field', async () => {
    const incomplete: Record<string, unknown> = { ...request }
    delete incomplete['noticeStatus']
    const { client } = setup({ data: [incomplete], nextCursor: null, hasMore: false })
    await expect(fetchDsrRequests(client, 'store-1', null)).rejects.toBeDefined()
  })

  it('asks the signed link of the file by the id of the request', async () => {
    const link = {
      url: 'https://files.example.com/x?sig=1',
      filename: 'data-export.zip',
      expiresInSeconds: 300,
      fileExpiresAt: '2026-12-01T00:00:00.000Z'
    }
    const { client, call } = setup(link)
    expect((await fetchDsrExportLink(client, 'store-1', 'r1')).filename).toBe('data-export.zip')
    expect(call().url).toBe('https://api.example.com/api/v1/compliance/dsr/r1/export')
  })

  it('refuses a link that is not a web address, so the page never goes to javascript: or data:', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://files.example.com/x']) {
      const { client } = setup({
        url,
        filename: 'data-export.zip',
        expiresInSeconds: 300,
        fileExpiresAt: '2026-12-01T00:00:00.000Z'
      })
      await expect(fetchDsrExportLink(client, 'store-1', 'r1')).rejects.toBeDefined()
    }
  })

  it('passes a refusal of the api through with its code and its counts', async () => {
    const { client } = setup(
      {
        error: {
          code: 'DSR_BLOCKED_BY_OPEN_WORK',
          message: 'x',
          metadata: { orders: 2 }
        },
        correlationId: 'c-1'
      },
      409
    )
    const failure = await approveDsrRequest(client, 'store-1', 'r1', 'ok').catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('DSR_BLOCKED_BY_OPEN_WORK')
    expect((failure as ApiError).metadata['orders']).toBe(2)
  })
})
