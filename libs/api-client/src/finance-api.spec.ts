import { createApiClient } from './api-client'
import {
  fetchAllFinanceAccounts,
  fetchFinanceBalances,
  fetchFinanceSetup,
  mapFinanceAccountRole,
  removeFinancePaymentAccount,
  retryFinancePosting,
  setFinanceAccountActive,
  setFinancePaymentAccount,
  setUpFinance,
  updateFinanceSettings
} from './finance-api'

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

const account = (code: string) => ({
  id: `id-${code}`,
  code,
  name: `Account ${code}`,
  type: 'asset',
  normalSide: 'debit',
  parentId: null,
  isPostable: true,
  cashKind: null,
  isSystem: false,
  active: true,
  currency: 'USD',
  createdAt: '2026-11-15T10:00:00.000Z'
})

const settings = {
  countryCode: 'SV',
  baseCurrency: 'USD',
  accountingStartDate: '2026-11-01',
  lockedThrough: null,
  recognizeSaleOn: 'delivered',
  roundingAccountId: null,
  taxRounding: 'half_up',
  shippingTaxed: true,
  updatedAt: '2026-11-15T10:00:00.000Z'
}

describe('finance api', () => {
  it('reads the state of the setup through the store of the request', async () => {
    const { client, fetchImpl } = setup(
      json(200, { ready: false, countries: ['SV'], settings: null })
    )

    const state = await fetchFinanceSetup(client, 's1')

    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/finance/setup')
    expect(callOf(fetchImpl).headers.get('x-store-id')).toBe('s1')
    expect(state).toEqual({ ready: false, countries: ['SV'], settings: null })
  })

  it('sets the books up with the country and no other key when the date is left out', async () => {
    const { client, fetchImpl } = setup(json(201, { ready: true, countries: ['SV'], settings }))

    await setUpFinance(client, 's1', { countryCode: 'SV' })

    expect(callOf(fetchImpl).init.method).toBe('POST')
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({ countryCode: 'SV' })
  })

  it('follows the pages of the chart by the code of the last account', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [account('1000')], nextCursor: '1000', hasMore: true }),
      json(200, { data: [account('1100')], nextCursor: null, hasMore: false })
    )

    const accounts = await fetchAllFinanceAccounts(client, 's1')

    expect(accounts.map(item => item.code)).toEqual(['1000', '1100'])
    expect(callOf(fetchImpl, 1).url).toContain('cursor=1000')
  })

  it('stops following a cursor that never ends, and fails rather than answer with a shorter list', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [account('1000')], nextCursor: '1000', hasMore: true })
    )

    await expect(fetchAllFinanceAccounts(client, 's1')).rejects.toThrow()

    expect(fetchImpl.mock.calls.length).toBe(40)
  })

  it('turns an account on or off through its own route', async () => {
    const { client, fetchImpl } = setup(json(200, account('1000')))

    await setFinanceAccountActive(client, 's1', 'a b', false)
    await setFinanceAccountActive(client, 's1', 'a b', true)

    expect(callOf(fetchImpl, 0).url).toBe(
      'https://api.example.com/api/v1/finance/accounts/a%20b/deactivate'
    )
    expect(callOf(fetchImpl, 1).url).toBe(
      'https://api.example.com/api/v1/finance/accounts/a%20b/reactivate'
    )
  })

  it('sends only the settings that change', async () => {
    const { client, fetchImpl } = setup(json(200, settings))

    await updateFinanceSettings(client, 's1', { shippingTaxed: false })

    expect(callOf(fetchImpl).init.method).toBe('PATCH')
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({ shippingTaxed: false })
  })

  it('maps a role to an account and a payment method to the organization default or a store', async () => {
    const { client, fetchImpl } = setup(
      json(200, { role: 'cash_default', accountId: 'a1' }),
      json(200, { id: 'p1', paymentMethod: 'CASH', storeId: null, accountId: 'a1' })
    )

    await mapFinanceAccountRole(client, 's1', 'cash_default', 'a1')
    await setFinancePaymentAccount(client, 's1', {
      paymentMethod: 'CASH',
      accountId: 'a1',
      forStoreId: null
    })

    expect(callOf(fetchImpl, 0).url).toBe(
      'https://api.example.com/api/v1/finance/account-roles/cash_default'
    )
    expect(JSON.parse(callOf(fetchImpl, 0).init.body as string)).toEqual({ accountId: 'a1' })
    expect(JSON.parse(callOf(fetchImpl, 1).init.body as string)).toEqual({
      paymentMethod: 'CASH',
      accountId: 'a1',
      storeId: null
    })
  })

  it('takes a store choice away with a 204', async () => {
    const { client, fetchImpl } = setup(new Response(null, { status: 204 }))

    await removeFinancePaymentAccount(client, 's1', 'p1')

    expect(callOf(fetchImpl).init.method).toBe('DELETE')
  })

  it('keeps a balance as the digits it came as, so no sum is turned into a float', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        data: [
          {
            accountId: 'a1',
            debitCents: '9007199254740993',
            creditCents: '0',
            balanceCents: '9007199254740993'
          }
        ]
      })
    )

    const balances = await fetchFinanceBalances(client, 's1', 'per1')

    expect(callOf(fetchImpl).url).toContain('periodId=per1')
    expect(balances[0]?.balanceCents).toBe('9007199254740993')
  })

  it('refuses a balance that is not digits', async () => {
    const { client } = setup(
      json(200, {
        data: [{ accountId: 'a1', debitCents: '1.5', creditCents: '0', balanceCents: '1' }]
      })
    )

    await expect(fetchFinanceBalances(client, 's1', null)).rejects.toBeDefined()
  })

  it('asks for a posting to be tried again', async () => {
    const { client, fetchImpl } = setup(json(200, { data: { queued: true } }))

    await retryFinancePosting(client, 's1', 'f1')

    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/finance/postings/f1/retry')
    expect(callOf(fetchImpl).init.method).toBe('POST')
  })
})
