import { AnalyticsEventNames, AnalyticsMetrics } from './analytics-constants'

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
})
