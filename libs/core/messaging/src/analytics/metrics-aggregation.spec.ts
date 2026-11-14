import { MetricAggregations } from '@platform/core/analytics'

import { type BucketRow, buildSeries } from './metrics-aggregation'

const row = (over: Partial<BucketRow>): BucketRow => ({
  dimensionId: '',
  bucket: new Date('2026-11-10T00:00:00.000Z'),
  total: null,
  weighted: null,
  count: 0,
  last: null,
  lastCount: 0,
  ...over
})

describe('buildSeries', () => {
  it('adds a count over the buckets and in the summary', () => {
    const [series] = buildSeries(MetricAggregations.SUM, [
      row({ bucket: new Date('2026-11-11T00:00:00.000Z'), total: 5, count: 5 }),
      row({ bucket: new Date('2026-11-10T00:00:00.000Z'), total: 3, count: 3 })
    ])
    expect(series?.points.map(point => point.value)).toEqual([3, 5])
    expect(series?.summary).toEqual({ value: 8, count: 8 })
  })

  it('weighs a time by the conversations behind it, never adds or averages the medians', () => {
    // 10 conversations at 60 s and 30 at 120 s: 105 s, not 90 (average of medians) nor 180 (sum)
    const [series] = buildSeries(MetricAggregations.WEIGHTED_MEAN, [
      row({ bucket: new Date('2026-11-11T00:00:00.000Z'), weighted: 3600, count: 30 }),
      row({ bucket: new Date('2026-11-10T00:00:00.000Z'), weighted: 600, count: 10 })
    ])
    expect(series?.points.map(point => point.value)).toEqual([60, 120])
    expect(series?.summary).toEqual({ value: 105, count: 40 })
  })

  it('leaves out a bucket of a time with no conversation instead of showing zero', () => {
    const [series] = buildSeries(MetricAggregations.WEIGHTED_MEAN, [
      row({ weighted: null, count: 0 })
    ])
    expect(series?.points).toEqual([])
    expect(series?.summary).toEqual({ value: 0, count: 0 })
  })

  it('takes the last point of a count of the moment', () => {
    const [series] = buildSeries(MetricAggregations.LAST, [
      // Newest first: the last is by time, not by the order the rows came in
      row({ bucket: new Date('2026-11-11T00:00:00.000Z'), last: 4, lastCount: 4 }),
      row({ bucket: new Date('2026-11-10T00:00:00.000Z'), last: 9, lastCount: 9 })
    ])
    expect(series?.summary).toEqual({ value: 4, count: 4 })
  })

  it('skips only the empty buckets of a time and keeps the weight of the others', () => {
    const [series] = buildSeries(MetricAggregations.WEIGHTED_MEAN, [
      row({ bucket: new Date('2026-11-10T00:00:00.000Z'), weighted: 600, count: 10 }),
      row({ bucket: new Date('2026-11-11T00:00:00.000Z'), weighted: null, count: 0 })
    ])
    expect(series?.points).toHaveLength(1)
    expect(series?.summary).toEqual({ value: 60, count: 10 })
  })

  it('takes a zero for a count of the moment that came back null', () => {
    const [series] = buildSeries(MetricAggregations.LAST, [row({ last: null, lastCount: 0 })])
    expect(series?.summary).toEqual({ value: 0, count: 0 })
  })

  it('keeps one series for each dimension id, in order', () => {
    const series = buildSeries(MetricAggregations.SUM, [
      row({ dimensionId: 'b', total: 1, count: 1 }),
      row({ dimensionId: 'a', total: 2, count: 2 })
    ])
    expect(series.map(item => item.dimensionId)).toEqual(['a', 'b'])
  })
})
