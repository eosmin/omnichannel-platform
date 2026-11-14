import {
  AnalyticsEventNames,
  AnalyticsMetrics,
  MetricDimensions,
  MetricDimensionsOf,
  RolledUpMetrics
} from './analytics-constants'

describe('analytics constants', () => {
  it('uses unique metric and event names', () => {
    for (const set of [AnalyticsMetrics, AnalyticsEventNames]) {
      const names: string[] = Object.values(set)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('has no AI or SLA metrics', () => {
    const names: string[] = [
      ...Object.values(AnalyticsMetrics),
      ...Object.values(AnalyticsEventNames)
    ]
    expect(names.filter(name => /(^ai\.|sla)/.test(name))).toEqual([])
  })

  it('rolls up only metrics of the catalog, and breaks down only by a dimension that exists', () => {
    const catalog: string[] = Object.values(AnalyticsMetrics)
    expect(Object.keys(RolledUpMetrics).filter(metric => !catalog.includes(metric))).toEqual([])
    const dimensions: string[] = Object.values(MetricDimensions)
    expect(
      Object.entries(MetricDimensionsOf).filter(
        ([metric, dimension]) => !(metric in RolledUpMetrics) || !dimensions.includes(dimension)
      )
    ).toEqual([])
  })
})
