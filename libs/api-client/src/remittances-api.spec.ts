import { RemittanceLineOutcome, RemittanceStatus } from '@platform/core/domain'

import { createApiClient } from './api-client'
import { ApiError } from './api-error'
import {
  confirmRemittance,
  discardRemittance,
  fetchRemittance,
  fetchRemittancePending,
  fetchRemittances,
  importRemittanceFile,
  previewRemittanceImport,
  updateRemittanceLine,
  voidRemittance
} from './remittances-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(...responses: Response[]) {
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

const view = {
  id: 'r1',
  connectionId: 'c1',
  connectionName: 'Carrier',
  carrierId: 'x',
  status: RemittanceStatus.DRAFT,
  reference: null,
  receivedOn: null,
  importProfileId: null,
  sourceMediaId: null,
  totals: { expectedCents: 1500, reportedCents: 1400, feeCents: 0, differenceCents: -100 },
  lineCount: 1,
  note: null,
  createdBy: 'u1',
  createdAt: '2026-11-12T10:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null
}
const line = {
  id: 'l1',
  position: 1,
  guideNumber: 'G-1',
  shipmentId: 's1',
  orderNumber: '1001',
  reportedCents: 1400,
  reportedFeeCents: null,
  expectedCents: 1500,
  differenceCents: -100,
  outcome: RemittanceLineOutcome.AMOUNT_DIFFERS,
  excluded: false,
  note: null
}
const detail = { ...view, lines: [line] }

describe('remittances api', () => {
  it('lists a page with its filters in the query', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [view], nextCursor: null, hasMore: false })
    )
    const page = await fetchRemittances(client, 's1', {
      status: RemittanceStatus.DRAFT,
      connectionId: 'c1',
      cursor: 'abc',
      limit: 10
    })
    expect(page.data[0]?.totals.differenceCents).toBe(-100)
    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '')
    expect(url.pathname.endsWith('/remittances')).toBe(true)
    expect(url.searchParams.get('status')).toBe('draft')
    expect(url.searchParams.get('connectionId')).toBe('c1')
    expect(url.searchParams.get('cursor')).toBe('abc')
    expect(url.searchParams.get('limit')).toBe('10')
  })

  it('asks what is pending for every connection or for one', async () => {
    const pending = [
      {
        connectionId: 'c1',
        connectionName: 'Carrier',
        carrierId: 'x',
        count: 1,
        totalOwedCents: -500,
        oldestDeliveredAt: null,
        oldestAgeDays: null,
        shipments: [],
        truncated: false
      }
    ]
    const { client, fetchImpl } = setup(json(200, pending))
    await expect(fetchRemittancePending(client, 's1')).resolves.toEqual(pending)
    await fetchRemittancePending(client, 's1', 'c1')
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/remittances\/pending$/)
    expect(fetchImpl.mock.calls[1]?.[0]).toMatch(/\/remittances\/pending\?connectionId=c1$/)
  })

  it('reads one remittance with its lines and refuses an answer with a float amount', async () => {
    const { client } = setup(json(200, detail))
    await expect(fetchRemittance(client, 's1', 'r1')).resolves.toMatchObject({
      lines: [{ outcome: RemittanceLineOutcome.AMOUNT_DIFFERS }]
    })
    const bad = setup(json(200, { ...detail, totals: { ...view.totals, reportedCents: 14.5 } }))
    await expect(fetchRemittance(bad.client, 's1', 'r1')).rejects.toBeDefined()
  })

  it('sends the changes of a line, the confirmation and the void as JSON bodies', async () => {
    const { client, fetchImpl } = setup(json(200, detail))
    await updateRemittanceLine(client, 's1', 'r1', 'l1', { reportedCents: 1500 })
    await confirmRemittance(client, 's1', 'r1', { reference: 'S-9' })
    await voidRemittance(client, 's1', 'r1', { reason: 'wrong file' })
    const calls = fetchImpl.mock.calls
    expect(calls[0]?.[0]).toMatch(/\/remittances\/r1\/lines\/l1$/)
    expect(calls[0]?.[1].method).toBe('PATCH')
    expect(calls[0]?.[1].body).toBe(JSON.stringify({ reportedCents: 1500 }))
    expect(calls[1]?.[0]).toMatch(/\/remittances\/r1\/confirm$/)
    expect(calls[2]?.[0]).toMatch(/\/remittances\/r1\/void$/)
    expect(calls[2]?.[1].body).toBe(JSON.stringify({ reason: 'wrong file' }))
  })

  it('discards a draft with a 204', async () => {
    const { client, fetchImpl } = setup(new Response(null, { status: 204 }))
    await expect(discardRemittance(client, 's1', 'r1')).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })

  it('previews a sample with the mapping being tried', async () => {
    const preview = {
      headers: ['Guide', 'Amount'],
      rowCount: 1,
      lines: [{ guideNumber: 'G-1', reportedCents: 1400, row: 2 }],
      errors: [{ row: 3, field: 'amount', code: 'invalid_amount', value: 'abc' }],
      errorCount: 1,
      reference: null,
      receivedOn: null
    }
    const { client, fetchImpl } = setup(json(200, preview))
    const result = await previewRemittanceImport(client, 's1', {
      text: 'Guide,Amount\nG-1,14.00',
      profile: {
        delimiter: ',',
        hasHeader: true,
        decimalSeparator: '.',
        dateFormat: 'yyyy-MM-dd',
        columns: { guideNumber: 'Guide', amount: 'Amount' }
      }
    })
    expect(result.errors[0]?.code).toBe('invalid_amount')
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/remittances\/imports\/preview$/)
  })

  it('sends the file itself as text with its own content type, not as JSON', async () => {
    const { client, fetchImpl } = setup(json(201, detail))
    await importRemittanceFile(client, 's1', {
      connectionId: 'c1',
      profileId: 'p1',
      text: 'Guide;Amount\nG-1;14,00',
      contentType: 'text/csv'
    })
    const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
    expect(url).toMatch(/\/remittances\/imports\?connectionId=c1&profileId=p1$/)
    expect(init.body).toBe('Guide;Amount\nG-1;14,00')
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/csv')
  })

  it('keeps the row errors of a refused file', async () => {
    const { client } = setup(
      json(400, {
        correlationId: 'corr-1',
        error: {
          code: 'REMITTANCE_IMPORT_INVALID',
          message: 'the file has rows that cannot be read',
          metadata: {
            errorCount: 1,
            errors: [{ row: 2, field: 'amount', code: 'invalid_amount', value: 'abc' }]
          }
        }
      })
    )
    const error = await importRemittanceFile(client, 's1', {
      connectionId: 'c1',
      profileId: 'p1',
      text: 'x',
      contentType: 'text/csv'
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('REMITTANCE_IMPORT_INVALID')
    expect((error as ApiError).metadata['errorCount']).toBe(1)
  })
})
