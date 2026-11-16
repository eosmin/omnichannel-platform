import { LegalBookKind } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  fetchFinanceBook,
  fetchFinanceBookCsv,
  fetchFinanceBookLayouts,
  fetchFinanceFrozenBook,
  fetchFinanceFrozenBooks
} from './finance-legal-books-api'

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

const book = {
  kind: 'sales_taxpayers',
  period: { id: 'p1', year: 2026, month: 3, from: '2026-03-01', to: '2026-03-31', status: 'open' },
  layout: { version: 0, source: 'proposal', accountantConfirmed: false },
  unvalidated: true,
  header: ['correlative', 'date', 'base', 'tax'],
  rows: [
    [1, '2026-03-04', 10000, 1300],
    [2, '2026-03-05', 5000, null]
  ],
  totals: { base: 15000, tax: 1300 },
  warnings: {
    salesWithoutTaxSnapshot: 0,
    salesNotReadable: 0,
    voidedDocuments: 1,
    unclassifiedDocuments: 0,
    returnsNotListed: 0
  },
  contentSha256: 'a'.repeat(64),
  frozen: false
}

describe('the legal books', () => {
  it('reads a book of a kind for a month and keeps it as unvalidated when the api says so', async () => {
    const { client, fetchImpl } = setup(json(200, book))
    const answer = await fetchFinanceBook(client, 'store-1', {
      kind: LegalBookKind.SALES_TAXPAYERS,
      periodId: 'p1'
    })
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/finance/books/sales_taxpayers?periodId=p1')
    expect(headers.get('X-Store-Id')).toBe('store-1')
    expect(answer.unvalidated).toBe(true)
    expect(answer.rows[1]).toEqual([2, '2026-03-05', 5000, null])
  })

  it('refuses a book without its state (an answer that cannot say it is a draft)', async () => {
    const withoutState = Object.fromEntries(
      Object.entries(book).filter(([key]) => key !== 'unvalidated')
    )
    const { client } = setup(json(200, withoutState))
    await expect(
      fetchFinanceBook(client, 's', { kind: LegalBookKind.PURCHASES, periodId: 'p1' })
    ).rejects.toThrow()
  })

  it('takes the file as text on the csv route', async () => {
    const { client, fetchImpl } = setup(new Response('a,b\r\n', { status: 200 }))
    const file = await fetchFinanceBookCsv(client, 's', {
      kind: LegalBookKind.PURCHASES,
      periodId: 'p1'
    })
    expect(callOf(fetchImpl).url).toContain('/finance/books/purchases/csv?periodId=p1')
    expect(file).toBe('a,b\r\n')
  })

  it('lists the layouts of the kinds', async () => {
    const { client, fetchImpl } = setup(
      json(200, [
        {
          kind: 'purchases',
          version: 0,
          source: 'proposal',
          accountantConfirmed: false,
          columns: [{ field: 'date', label: null }],
          sort: 'date',
          correlativeStart: 1,
          correlativeRestart: 'month',
          unissuedSales: 'consumers',
          createdAt: null
        }
      ])
    )
    const layouts = await fetchFinanceBookLayouts(client, 's')
    expect(callOf(fetchImpl).url).toContain('/finance/book-layouts')
    expect(layouts[0]?.columns[0]?.field).toBe('date')
  })
})

describe('the frozen books', () => {
  const frozen = {
    id: 'f1',
    periodId: 'p1',
    kind: 'purchases',
    layoutVersion: 2,
    closedAt: '2026-04-02T10:00:00.000Z',
    contentSha256: 'b'.repeat(64),
    createdAt: '2026-04-02T10:00:01.000Z'
  }

  it('lists the ones of a month and opens one by id', async () => {
    const list = setup(json(200, [frozen]))
    await fetchFinanceFrozenBooks(list.client, 's', 'p1')
    expect(callOf(list.fetchImpl).url).toContain('/finance/frozen-books?periodId=p1')

    const one = setup(json(200, { ...book, frozen: true }))
    const answer = await fetchFinanceFrozenBook(one.client, 's', 'f1')
    expect(callOf(one.fetchImpl).url).toContain('/finance/frozen-books/f1')
    expect(answer.frozen).toBe(true)
  })
})
