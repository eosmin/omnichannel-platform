import { AnalyticsMetrics, MetricDimensions, TimeGranularity } from '@platform/core/analytics'

import { fetchMetrics } from './analytics-api'
import { createApiClient } from './api-client'
import { fetchMyPerformance } from './my-performance-api'

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

const result = {
  metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
  granularity: TimeGranularity.DAY,
  dimension: '',
  aggregation: 'sum',
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-08T00:00:00.000Z',
  series: [
    {
      dimensionId: '',
      points: [{ timestamp: '2026-11-01T00:00:00.000Z', value: 4, count: 4 }],
      summary: { value: 4, count: 4 }
    }
  ]
}

describe('fetchMetrics', () => {
  it('asks for the metric, the granularity and the range of the store', async () => {
    const { client, fetchImpl } = setup(json(200, result))

    const answer = await fetchMetrics(client, 's1', {
      metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
      granularity: TimeGranularity.DAY,
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-08T00:00:00.000Z'
    })

    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '')
    expect(url.pathname).toBe('/api/v1/analytics/metrics')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      metric: 'conversations.created',
      granularity: 'day',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-08T00:00:00.000Z'
    })
    expect(new Headers(fetchImpl.mock.calls[0]?.[1].headers).get('x-store-id')).toBe('s1')
    expect(answer.series[0]?.summary.value).toBe(4)
  })

  it('names the breakdown only when the metric has one', async () => {
    const { client, fetchImpl } = setup(json(200, { ...result, dimension: 'channel' }))

    await fetchMetrics(client, 's1', {
      metric: AnalyticsMetrics.CHANNEL_VOLUME,
      granularity: TimeGranularity.DAY,
      from: result.from,
      to: result.to,
      dimension: MetricDimensions.CHANNEL
    })

    expect(new URL(fetchImpl.mock.calls[0]?.[0] ?? '').searchParams.get('dimension')).toBe(
      'channel'
    )
  })

  it('refuses an answer that is not the contract', async () => {
    const { client } = setup(json(200, { ...result, aggregation: 'median' }))

    await expect(
      fetchMetrics(client, 's1', {
        metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
        granularity: TimeGranularity.DAY,
        from: result.from,
        to: result.to
      })
    ).rejects.toBeDefined()
  })
})

describe('fetchMyPerformance', () => {
  it('reads the figures of the person for the store', async () => {
    const view = {
      dayStart: '2026-11-14T06:00:00.000Z',
      resolved: 3,
      open: 2,
      medianFirstResponseSeconds: null,
      answered: 0
    }
    const { client, fetchImpl } = setup(json(200, view))

    expect(await fetchMyPerformance(client, 's1')).toEqual(view)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/analytics/my-performance'
    )
  })
})
