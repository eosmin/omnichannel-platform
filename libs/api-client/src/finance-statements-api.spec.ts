import { AgingKind } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  fetchFinanceAging,
  fetchFinanceAgingCsv,
  fetchFinanceBalanceSheet,
  fetchFinanceBalanceSheetCsv,
  fetchFinanceCashFlow,
  fetchFinanceCashFlowCsv,
  fetchFinanceIncomeStatement,
  fetchFinanceIncomeStatementCsv
} from './finance-statements-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } })

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

const section = {
  rows: [
    {
      accountId: 'a1',
      code: '4101',
      name: 'Sales',
      parentId: null,
      isPostable: true,
      balanceCents: '125000',
      rollupCents: '125000'
    }
  ],
  totalCents: '125000'
}
const empty = { rows: [], totalCents: '0' }

describe('the income statement', () => {
  const body = {
    from: '2026-03-01',
    to: '2026-03-31',
    storeId: null,
    income: section,
    costOfSales: empty,
    expenses: empty,
    grossMarginCents: '125000',
    netResultCents: '-3000000000000',
    warnings: ['no_cost_of_sales']
  }

  it('asks for the range, for the store of the header, and keeps a sum beyond 32 bits as digits', async () => {
    const { client, fetchImpl } = setup(json(200, body))
    const statement = await fetchFinanceIncomeStatement(client, 'store-1', {
      from: '2026-03-01',
      to: '2026-03-31'
    })
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/finance/reports/income-statement?')
    expect(url).toContain('from=2026-03-01')
    expect(url).toContain('to=2026-03-31')
    expect(headers.get('X-Store-Id')).toBe('store-1')
    expect(statement.netResultCents).toBe('-3000000000000')
    expect(statement.warnings).toEqual(['no_cost_of_sales'])
  })

  it('refuses a sum that is not whole cents (never a float)', async () => {
    const { client } = setup(json(200, { ...body, netResultCents: '12.5' }))
    await expect(
      fetchFinanceIncomeStatement(client, 's', { from: '2026-03-01', to: '2026-03-31' })
    ).rejects.toThrow()
  })

  it('takes the file as the text the api wrote, not as JSON', async () => {
    const { client, fetchImpl } = setup(text('﻿section,code,name\r\n'))
    const file = await fetchFinanceIncomeStatementCsv(client, 's', {
      from: '2026-03-01',
      to: '2026-03-31'
    })
    expect(callOf(fetchImpl).url).toContain('/finance/reports/income-statement.csv?')
    expect(file).toContain('section,code,name')
  })
})

describe('the balance sheet', () => {
  it('asks for a day and reads the slice of a store as unbalanced-by-itself (balanced null)', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        asOf: '2026-03-31',
        storeId: 'store-1',
        assets: section,
        liabilities: empty,
        equity: empty,
        resultCents: '125000',
        equityWithResultCents: '125000',
        balanced: null,
        warnings: []
      })
    )
    const sheet = await fetchFinanceBalanceSheet(client, 's', { asOf: '2026-03-31' })
    expect(callOf(fetchImpl).url).toContain('/finance/reports/balance-sheet?asOf=2026-03-31')
    expect(sheet.balanced).toBeNull()
  })

  it('has its file on the .csv route', async () => {
    const { client, fetchImpl } = setup(text('a'))
    await fetchFinanceBalanceSheetCsv(client, 's', { asOf: '2026-03-31' })
    expect(callOf(fetchImpl).url).toContain('/finance/reports/balance-sheet.csv?asOf=2026-03-31')
  })
})

describe('the cash flow', () => {
  it('reads the sources and whether the two ends close', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        from: '2026-03-01',
        to: '2026-03-31',
        storeId: null,
        sources: [
          { source: 'order', inflowCents: '500', outflowCents: '0', netCents: '500' },
          { source: 'finance_transaction', inflowCents: '0', outflowCents: '200', netCents: '-200' }
        ],
        inflowCents: '500',
        outflowCents: '200',
        netCents: '300',
        openingCents: '1000',
        closingCents: '1300',
        closes: true,
        warnings: []
      })
    )
    const flow = await fetchFinanceCashFlow(client, 's', { from: '2026-03-01', to: '2026-03-31' })
    expect(callOf(fetchImpl).url).toContain('/finance/reports/cash-flow?')
    expect(flow.sources).toHaveLength(2)
    expect(flow.closes).toBe(true)
  })

  it('has its file on the .csv route', async () => {
    const { client, fetchImpl } = setup(text('a'))
    await fetchFinanceCashFlowCsv(client, 's', { from: '2026-03-01', to: '2026-03-31' })
    expect(callOf(fetchImpl).url).toContain('/finance/reports/cash-flow.csv?')
  })
})

describe('the lists with age', () => {
  const aging = {
    kind: 'payables',
    asOf: '2026-03-31',
    storeId: null,
    bucketDays: [30, 60, 90],
    rows: [
      {
        partyType: 'supplier',
        partyId: 'p1',
        partyName: 'Paper Co',
        bucketsCents: ['100', '0', '0', '50'],
        unappliedCents: '0',
        totalCents: '150'
      },
      {
        partyType: null,
        partyId: null,
        partyName: null,
        bucketsCents: ['0', '0', '0', '0'],
        unappliedCents: '-20',
        totalCents: '-20'
      }
    ],
    bucketsCents: ['100', '0', '0', '50'],
    unappliedCents: '-20',
    totalCents: '130',
    missingRoles: ['payable_carriers'],
    warnings: ['role_not_mapped']
  }

  it('asks for the kind and the day and says which roles the settings lack', async () => {
    const { client, fetchImpl } = setup(json(200, aging))
    const answer = await fetchFinanceAging(client, 's', {
      kind: AgingKind.PAYABLES,
      asOf: '2026-03-31'
    })
    const { url } = callOf(fetchImpl)
    expect(url).toContain('/finance/reports/aging?')
    expect(url).toContain('kind=payables')
    expect(url).toContain('asOf=2026-03-31')
    expect(answer.missingRoles).toEqual(['payable_carriers'])
    expect(answer.rows[1]?.partyId).toBeNull()
  })

  it('has its file on the .csv route', async () => {
    const { client, fetchImpl } = setup(text('a'))
    await fetchFinanceAgingCsv(client, 's', { kind: AgingKind.RECEIVABLES, asOf: '2026-03-31' })
    expect(callOf(fetchImpl).url).toContain('/finance/reports/aging.csv?kind=receivables')
  })
})
