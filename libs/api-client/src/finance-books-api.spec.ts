import { createApiClient } from './api-client'
import {
  attachFinanceTransactionDocument,
  fetchFinanceEntryPage,
  fetchFinanceTransactionPage,
  postManualFinanceEntry,
  recordFinanceTransaction,
  replaceFinanceTransaction,
  reverseFinanceEntry,
  voidFinanceTransaction
} from './finance-books-api'

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

const entry = {
  id: 'e1',
  number: '12',
  entryDate: '2026-02-03',
  periodId: 'p1',
  type: 'manual',
  sourceType: null,
  sourceId: null,
  sourceDate: null,
  reversesEntryId: null,
  reversedByEntryId: null,
  memo: 'Opening',
  currency: 'USD',
  totalCents: 1500,
  createdBy: 'u1',
  origin: 'user',
  createdAt: '2026-02-03T10:00:00.000Z'
}
const line = {
  id: 'l1',
  lineNo: 1,
  accountId: 'a1',
  storeId: null,
  debitCents: 1500,
  creditCents: 0,
  memo: null
}
const transaction = {
  id: 't1',
  storeId: null,
  kind: 'expense',
  occurredOn: '2026-02-03',
  amountCents: 1130,
  fromAccountId: 'a1',
  toAccountId: null,
  categoryAccountId: 'a2',
  taxRateId: null,
  taxCents: 0,
  taxCreditable: false,
  documentNumber: null,
  documentMediaId: null,
  memo: null,
  entryId: 'e1',
  voidedByEntryId: null,
  voided: false,
  replacesTransactionId: null,
  createdBy: 'u1',
  createdAt: '2026-02-03T10:00:00.000Z'
}

describe('the journal', () => {
  it('reads a page with only the filters that are set, for the store of the header', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [entry], nextCursor: '12', hasMore: true })
    )
    const page = await fetchFinanceEntryPage(
      client,
      'store-1',
      { type: 'manual', accountId: '', from: '2026-02-01' },
      '40'
    )
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/finance/entries?')
    expect(url).toContain('type=manual')
    expect(url).toContain('from=2026-02-01')
    expect(url).toContain('cursor=40')
    expect(url).not.toContain('accountId')
    expect(headers.get('X-Store-Id')).toBe('store-1')
    expect(page.data[0]?.number).toBe('12')
    expect(page.hasMore).toBe(true)
  })

  it('refuses a number of the journal that is not digits', async () => {
    const { client } = setup(
      json(200, { data: [{ ...entry, number: '1.5' }], nextCursor: null, hasMore: false })
    )
    await expect(fetchFinanceEntryPage(client, 's', {}, null)).rejects.toThrow()
  })

  it('posts a manual entry and reverses one, with the body as given', async () => {
    const posted = setup(json(201, { ...entry, lines: [line] }))
    const input = {
      idempotencyKey: 'once-per-form',
      entryDate: '2026-02-03',
      type: 'manual',
      memo: 'Opening',
      lines: [{ accountId: 'a1', debitCents: 1500, creditCents: 0 }]
    }
    const created = await postManualFinanceEntry(posted.client, 's', input)
    expect(callOf(posted.fetchImpl).init.method).toBe('POST')
    expect(JSON.parse(callOf(posted.fetchImpl).init.body as string)).toEqual(input)
    expect(created.lines).toHaveLength(1)

    const reversed = setup(json(201, { ...entry, lines: [line] }))
    await reverseFinanceEntry(reversed.client, 's', 'e1', { memo: 'Wrong month' })
    expect(callOf(reversed.fetchImpl).url).toContain('/finance/entries/e1/reverse')
  })
})

describe('the transactions', () => {
  it('lists the voided ones only when asked', async () => {
    const without = setup(json(200, { data: [transaction], nextCursor: null, hasMore: false }))
    await fetchFinanceTransactionPage(without.client, 's', { includeVoided: false }, null)
    expect(callOf(without.fetchImpl).url).not.toContain('includeVoided')
    const withVoided = setup(json(200, { data: [transaction], nextCursor: null, hasMore: false }))
    await fetchFinanceTransactionPage(withVoided.client, 's', { includeVoided: true }, null)
    expect(callOf(withVoided.fetchImpl).url).toContain('includeVoided=true')
  })

  it('records, voids, replaces and attaches a receipt through the routes of the api', async () => {
    const input = {
      idempotencyKey: 'once-per-form',
      kind: 'expense',
      occurredOn: '2026-02-03',
      amountCents: 1130,
      fromAccountId: 'a1',
      categoryAccountId: 'a2'
    }
    const record = setup(json(201, transaction))
    await recordFinanceTransaction(record.client, 's', input)
    expect(callOf(record.fetchImpl).url).toMatch(/\/finance\/transactions$/)

    const voided = setup(json(201, { ...transaction, voided: true, voidedByEntryId: 'e2' }))
    const view = await voidFinanceTransaction(voided.client, 's', 't1', 'Typed twice')
    expect(view.voided).toBe(true)
    expect(JSON.parse(callOf(voided.fetchImpl).init.body as string)).toEqual({
      reason: 'Typed twice'
    })
    expect(callOf(voided.fetchImpl).url).toContain('/finance/transactions/t1/void')

    const replaced = setup(json(201, transaction))
    await replaceFinanceTransaction(replaced.client, 's', 't1', {
      reason: 'Amount',
      replacement: input
    })
    expect(callOf(replaced.fetchImpl).url).toContain('/finance/transactions/t1/replace')

    const attached = setup(json(201, { ...transaction, documentMediaId: 'm1' }))
    const withReceipt = await attachFinanceTransactionDocument(attached.client, 's', 't1', 'm1')
    expect(withReceipt.documentMediaId).toBe('m1')
    expect(JSON.parse(callOf(attached.fetchImpl).init.body as string)).toEqual({ mediaId: 'm1' })
  })
})
