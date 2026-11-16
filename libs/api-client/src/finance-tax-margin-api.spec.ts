import { createApiClient } from './api-client'
import {
  fetchFinanceChainStatus,
  fetchFinanceMargin,
  fetchFinanceMarginCsv,
  fetchFinanceVat,
  fetchFinanceVatCsv
} from './finance-tax-margin-api'

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

const RANGE = { from: '2026-03-01', to: '2026-03-31' }

describe('the VAT report', () => {
  const body = {
    from: RANGE.from,
    to: RANGE.to,
    currency: 'USD',
    recognizedOn: 'delivered',
    accountingStartDate: '2026-01-01',
    rows: [
      {
        month: '2026-03',
        side: 'output',
        kind: 'taxed',
        rateBps: 1300,
        baseCents: 100000,
        taxCents: 13000,
        documents: 4
      },
      {
        month: '2026-03',
        side: 'input',
        kind: 'taxed',
        rateBps: null,
        baseCents: null,
        taxCents: 2600,
        documents: 1
      }
    ],
    months: [{ month: '2026-03', outputTaxCents: 13000, inputTaxCents: 2600, balanceCents: 10400 }],
    ordersWithoutTaxSnapshot: 0,
    ordersNotReadable: 0,
    returnedOrdersIncluded: 1
  }

  it('asks for the range through the store of the request and reads whole cents', async () => {
    const { client, fetchImpl } = setup(json(200, body))
    const view = await fetchFinanceVat(client, 's1', RANGE)
    const call = callOf(fetchImpl)
    expect(call.url).toContain('/finance/reports/vat?from=2026-03-01&to=2026-03-31')
    expect(call.headers.get('X-Store-Id')).toBe('s1')
    expect(view.months[0]?.balanceCents).toBe(10400)
    expect(view.rows[1]?.baseCents).toBeNull()
  })

  it('refuses an amount that is not whole cents', async () => {
    const bad = { ...body, months: [{ ...body.months[0], balanceCents: 10.5 }] }
    const { client } = setup(json(200, bad))
    await expect(fetchFinanceVat(client, 's1', RANGE)).rejects.toBeDefined()
  })

  it('reads the file as the text the api wrote', async () => {
    const { client, fetchImpl } = setup(text('a,b\n1,2\n'))
    await expect(fetchFinanceVatCsv(client, 's1', RANGE)).resolves.toBe('a,b\n1,2\n')
    expect(callOf(fetchImpl).url).toContain(
      '/finance/reports/vat.csv?from=2026-03-01&to=2026-03-31'
    )
  })
})

describe('the margin report', () => {
  const body = {
    from: RANGE.from,
    to: RANGE.to,
    storeId: null,
    rows: [
      {
        storeId: 's1',
        productId: 'p1',
        productName: 'Mug',
        unitsSold: 3,
        revenueCents: 3000,
        costCents: 1200,
        marginCents: 1800,
        marginBps: 6000
      }
    ],
    totals: {
      unitsSold: 3,
      revenueCents: 3000,
      costCents: 1200,
      marginCents: 1800,
      marginBps: 6000
    },
    ledger: {
      revenueCents: null,
      costCents: null,
      revenueDifferenceCents: null,
      costDifferenceCents: null
    },
    returns: { revenueCents: null, costCents: null },
    ordersUsed: 2,
    ordersNotReadable: 0,
    unvaluedUnits: 0,
    warnings: ['revenue_role_not_mapped']
  }

  it('reads the rows, the totals and a ledger that is not mapped as null (never zero)', async () => {
    const { client, fetchImpl } = setup(json(200, body))
    const view = await fetchFinanceMargin(client, 's1', RANGE)
    expect(callOf(fetchImpl).url).toContain('/finance/reports/margin?from=2026-03-01&to=2026-03-31')
    expect(view.ledger.revenueCents).toBeNull()
    expect(view.rows[0]?.marginBps).toBe(6000)
  })

  it('reads the file as text', async () => {
    const { client, fetchImpl } = setup(text('x\n'))
    await expect(fetchFinanceMarginCsv(client, 's1', RANGE)).resolves.toBe('x\n')
    expect(callOf(fetchImpl).url).toContain('/finance/reports/margin.csv?')
  })
})

describe('the state of the chain', () => {
  it('reads no incident and an open one', async () => {
    const none = setup(json(200, { open: null }))
    await expect(fetchFinanceChainStatus(none.client, 's1')).resolves.toEqual({ open: null })
    expect(callOf(none.fetchImpl).url).toContain('/finance/reports/chain-status')
    const open = setup(
      json(200, {
        open: {
          reason: 'hash_mismatch',
          entryNumber: '42',
          entriesChecked: 100,
          detectedAt: '2026-03-01T05:00:00.000Z',
          lastSeenAt: '2026-03-08T05:00:00.000Z'
        }
      })
    )
    const view = await fetchFinanceChainStatus(open.client, 's1')
    expect(view.open?.entryNumber).toBe('42')
  })
})
