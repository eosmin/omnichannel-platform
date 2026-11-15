import {
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  ShipmentStatus
} from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  fetchBenefit,
  fetchGuideBalance,
  fetchGuideMovements,
  putGuidePolicy,
  recordGuidePurchase,
  voidGuidePurchase
} from './carrier-guides-api'

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

const movement = {
  id: 'm1',
  kind: 'purchase',
  guidesDelta: 110,
  costCentsDelta: 8000,
  paidQuantity: 100,
  giftQuantity: 10,
  unitCostCents: null,
  shipmentId: null,
  voidsMovementId: null,
  voided: false,
  note: null,
  createdBy: 'u1',
  occurredAt: '2026-11-15T00:00:00.000Z',
  createdAt: '2026-11-15T00:00:00.000Z'
}

describe('the guide balance api (TDD_17 §4.18)', () => {
  it('reads the balance of a connection of the store in the header', async () => {
    const body = {
      tracked: true,
      balance: 10,
      receivedGuides: 110,
      paidCents: 8000,
      averageCostCents: 73,
      lowBalanceThreshold: null,
      warnOnEmptyBalance: true,
      low: false,
      empty: false
    }
    const { client, fetchImpl } = setup(json(200, body))
    expect(await fetchGuideBalance(client, 's1', 'c1')).toEqual(body)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/carriers/c1/guide-balance')
    expect(new Headers(init?.headers).get('x-store-id')).toBe('s1')
  })

  it('reads a page of the ledger with its cursor', async () => {
    const page = { data: [movement], nextCursor: 'abc', hasMore: true }
    const { client, fetchImpl } = setup(json(200, page))
    expect(await fetchGuideMovements(client, 's1', 'c1', { cursor: 'x', limit: 10 })).toEqual(page)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/carriers/c1/guide-movements?cursor=x&limit=10'
    )
  })

  it('records and voids a purchase with a POST of the body, in whole cents', async () => {
    const { client, fetchImpl } = setup(json(201, movement))
    await recordGuidePurchase(client, 's1', 'c1', {
      paidQuantity: 100,
      giftQuantity: 10,
      totalCostCents: 8000
    })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/carriers/c1/guide-purchases')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      paidQuantity: 100,
      giftQuantity: 10,
      totalCostCents: 8000
    })
    await voidGuidePurchase(client, 's1', 'c1', 'm1', { note: 'typed twice' })
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.example.com/api/v1/carriers/c1/guide-purchases/m1/void'
    )
  })

  it('replaces the policy with a PUT and reads the benefit', async () => {
    const policy = {
      stored: true,
      balanceEnabled: true,
      benefitEnabled: true,
      warnOnEmptyBalance: true,
      lowBalanceThreshold: null,
      periodKind: 'fixed_days',
      periodDays: 15,
      periodAnchor: '2026-11-01',
      thresholdBps: 1000,
      warnAtBps: 8000,
      base: 'delivered',
      returnStatuses: ['returned'],
      refundRule: 'at_period_close',
      lossRule: 'from_crossing',
      toConfirm: ['thresholdBps']
    }
    const { client, fetchImpl } = setup(json(200, policy))
    const body = {
      balanceEnabled: true,
      benefitEnabled: true,
      warnOnEmptyBalance: true,
      lowBalanceThreshold: null,
      periodKind: BenefitPeriodKind.FIXED_DAYS,
      periodDays: 15,
      periodAnchor: '2026-11-01',
      thresholdBps: 1000,
      warnAtBps: 8000,
      base: BenefitBase.DELIVERED,
      returnStatuses: [ShipmentStatus.RETURNED],
      refundRule: BenefitRefundRule.AT_PERIOD_CLOSE,
      lossRule: BenefitLossRule.FROM_CROSSING
    }
    expect(await putGuidePolicy(client, 's1', 'c1', body)).toEqual(policy)
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('PUT')

    const benefit = {
      enabled: true,
      state: 'at_risk',
      periodStart: '2026-11-01T06:00:00.000Z',
      periodEnd: '2026-11-16T06:00:00.000Z',
      baseCount: 12,
      returnCount: 1,
      rateBps: 833,
      thresholdBps: 1000,
      warnAtBps: 8000,
      crossedAt: null
    }
    const second = setup(json(200, benefit))
    expect(await fetchBenefit(second.client, 's1', 'c1')).toEqual(benefit)
  })

  it('refuses an answer that is not the shape of the view', async () => {
    const { client } = setup(json(200, { balance: 'ten' }))
    await expect(fetchGuideBalance(client, 's1', 'c1')).rejects.toThrow()
  })
})
