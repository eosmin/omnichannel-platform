import { createApiClient } from './api-client'
import {
  closeFinancePeriod,
  fetchFinanceJournalCsv,
  fetchFinanceLedger,
  fetchFinanceLedgerCsv,
  fetchFinanceTrialBalance,
  fetchFinanceTrialBalanceCsv,
  reopenFinancePeriod,
  verifyFinanceChain
} from './finance-reports-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(response: () => Response) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(response()))
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

const period = {
  id: 'p1',
  year: 2026,
  month: 10,
  startsOn: '2026-10-01',
  endsOn: '2026-10-31',
  status: 'closed',
  closedAt: '2026-11-02T10:00:00.000Z',
  closedBy: 'u1',
  reopenedAt: null,
  reopenedBy: null,
  reopenReason: null,
  closingHash: 'd'.repeat(64),
  hasEnded: true,
  hasStarted: true
}

describe('closing and reopening a month', () => {
  it('closes with a POST that has no body', async () => {
    const { client, fetchImpl } = setup(() => json(200, period))
    await expect(closeFinancePeriod(client, 's1', 'p1')).resolves.toMatchObject({
      status: 'closed'
    })
    const { url, init, headers } = callOf(fetchImpl)
    expect(url).toBe('https://api.example.com/api/v1/finance/periods/p1/close')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(headers.get('x-store-id')).toBe('s1')
  })

  it('reopens with the reason in the body', async () => {
    const { client, fetchImpl } = setup(() => json(200, { ...period, status: 'open' }))
    await reopenFinancePeriod(client, 's1', 'p1', { reason: 'a bill came late' })
    const { url, init } = callOf(fetchImpl)
    expect(url).toBe('https://api.example.com/api/v1/finance/periods/p1/reopen')
    expect(init.body).toBe('{"reason":"a bill came late"}')
  })
})

describe('the reports', () => {
  it('asks the trial balance of one period and keeps the sums as text', async () => {
    const answer = {
      periodId: 'p1',
      storeId: null,
      rows: [
        {
          accountId: 'a1',
          code: '1101',
          name: 'Cash',
          type: 'asset',
          debitCents: '99999999999',
          creditCents: '0',
          balanceCents: '99999999999'
        }
      ],
      totals: { debitCents: '99999999999', creditCents: '99999999999', balanced: true }
    }
    const { client, fetchImpl } = setup(() => json(200, answer))
    const view = await fetchFinanceTrialBalance(client, 's1', 'p1')
    expect(view.rows[0]?.debitCents).toBe('99999999999')
    expect(callOf(fetchImpl).url).toBe(
      'https://api.example.com/api/v1/finance/reports/trial-balance?periodId=p1'
    )
  })

  it('refuses a sum that is not whole digits', async () => {
    const { client } = setup(() =>
      json(200, {
        periodId: 'p1',
        storeId: null,
        rows: [],
        totals: { debitCents: '1.5', creditCents: '0', balanced: false }
      })
    )
    await expect(fetchFinanceTrialBalance(client, 's1', 'p1')).rejects.toThrow()
  })

  it('sends the range and the position of a page of the ledger, and only those that are set', async () => {
    const { client, fetchImpl } = setup(() =>
      json(200, {
        account: { id: 'a1', code: '1101', name: 'Cash', type: 'asset', normalSide: 'debit' },
        openingCents: '0',
        lines: [],
        nextCursor: null,
        hasMore: false
      })
    )
    await fetchFinanceLedger(client, 's1', { accountId: 'a1', from: null, to: null, cursor: null })
    expect(callOf(fetchImpl).url).toBe(
      'https://api.example.com/api/v1/finance/reports/ledger?accountId=a1'
    )
    await fetchFinanceLedger(client, 's1', {
      accountId: 'a1',
      from: '2026-10-01',
      to: '2026-10-31',
      cursor: '2026-10-05:12:1'
    })
    const second = new URL(fetchImpl.mock.calls[1]?.[0] ?? '')
    expect(second.searchParams.get('from')).toBe('2026-10-01')
    expect(second.searchParams.get('to')).toBe('2026-10-31')
    expect(second.searchParams.get('cursor')).toBe('2026-10-05:12:1')
  })

  it('reads every file as the text the api wrote', async () => {
    const csv = 'a,b\r\n1,2\r\n'
    const { client, fetchImpl } = setup(
      () => new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })
    )
    await expect(fetchFinanceTrialBalanceCsv(client, 's1', 'p1')).resolves.toBe(csv)
    await expect(
      fetchFinanceLedgerCsv(client, 's1', { accountId: 'a1', from: '2026-01-01', to: '2026-12-31' })
    ).resolves.toBe(csv)
    await expect(
      fetchFinanceJournalCsv(client, 's1', { from: '2026-01-01', to: '2026-12-31' })
    ).resolves.toBe(csv)
    expect(fetchImpl.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
      '/api/v1/finance/reports/trial-balance.csv',
      '/api/v1/finance/reports/ledger.csv',
      '/api/v1/finance/reports/journal.csv'
    ])
  })

  it('verifies the chain with a POST', async () => {
    const { client, fetchImpl } = setup(() =>
      json(200, {
        ok: false,
        entriesChecked: 3,
        headNumber: '3',
        headHash: 'abc',
        break: { entryId: 'e2', number: '2', reason: 'head_mismatch' },
        frozenHeads: [{ periodId: 'p1', year: 2026, month: 10, present: false }]
      })
    )
    const view = await verifyFinanceChain(client, 's1')
    expect(view.break?.reason).toBe('head_mismatch')
    expect(callOf(fetchImpl).init.method).toBe('POST')
  })
})
