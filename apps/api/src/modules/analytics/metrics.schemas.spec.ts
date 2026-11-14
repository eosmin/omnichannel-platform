import { AnalyticsMetrics, MetricDimensions } from '@platform/core/analytics'

import { metricsQuerySchema } from './metrics.schemas'

const valid = {
  metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
  from: '2026-11-09T00:00:00.000Z',
  to: '2026-11-11T00:00:00.000Z'
}

describe('metricsQuerySchema', () => {
  it('reads dates with an offset in UTC and defaults to days with no breakdown', () => {
    const parsed = metricsQuerySchema.parse({ ...valid, from: '2026-11-08T18:00:00-06:00' })
    expect(parsed.from.toISOString()).toBe('2026-11-09T00:00:00.000Z')
    expect(parsed.granularity).toBe('day')
    expect(parsed.dimension).toBe(MetricDimensions.NONE)
  })

  it('accepts the breakdown a metric has', () => {
    const parsed = metricsQuerySchema.parse({
      ...valid,
      metric: AnalyticsMetrics.CHANNEL_VOLUME,
      dimension: MetricDimensions.CHANNEL
    })
    expect(parsed.dimension).toBe(MetricDimensions.CHANNEL)
  })

  it.each([
    ['a metric no rollup writes', { metric: AnalyticsMetrics.CSAT_SCORE }],
    ['a breakdown the metric has not', { dimension: MetricDimensions.AGENT }],
    ['a metric read by its breakdown, without it', { metric: AnalyticsMetrics.CHANNEL_VOLUME }],
    ['a date before the rollups', { from: '1999-12-31T00:00:00.000Z' }],
    [
      'a date past four digits',
      { from: '9999-12-31T00:00:00.000Z', to: '9999-12-31T12:00:00.000Z' }
    ],
    ['a store id', { storeId: 'b3f1c1f2-7a55-4b1c-a1d4-0f6f3a2f5c11' }],
    ['a date with no time, without throwing', { from: '2026-11-09' }],
    ['both dates invalid, without throwing', { from: 'x', to: 'y' }],
    ['an empty range', { to: '2026-11-09T00:00:00.000Z' }],
    ['a backwards range', { from: '2026-11-12T00:00:00.000Z' }],
    [
      'hours over fourteen days, by a millisecond',
      { granularity: 'hour', to: '2026-11-23T00:00:00.001Z' }
    ],
    ['hours over fourteen days', { granularity: 'hour', to: '2026-11-30T00:00:00.000Z' }],
    [
      'an end past the last date',
      { from: '2099-12-01T00:00:00.000Z', to: '2100-01-01T00:00:00.001Z' }
    ],
    [
      'days over the limit, by a day',
      { from: '2026-01-01T00:00:00.000Z', to: '2028-03-12T00:00:00.000Z' }
    ],
    ['days over the limit', { to: '2030-01-01T00:00:00.000Z' }]
  ])('refuses %s', (_label, extra) => {
    expect(metricsQuerySchema.safeParse({ ...valid, ...extra }).success).toBe(false)
  })

  it('accepts exactly the longest range of days and the last date', () => {
    expect(
      metricsQuerySchema.safeParse({
        ...valid,
        from: '2026-01-01T00:00:00.000Z',
        to: '2028-03-11T00:00:00.000Z'
      }).success
    ).toBe(true)
    expect(
      metricsQuerySchema.safeParse({
        ...valid,
        from: '2099-12-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z'
      }).success
    ).toBe(true)
  })

  it('accepts exactly the longest range of hours', () => {
    expect(
      metricsQuerySchema.safeParse({
        ...valid,
        granularity: 'hour',
        to: '2026-11-23T00:00:00.000Z'
      }).success
    ).toBe(true)
  })
})
