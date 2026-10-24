import { MetricNames } from './metric-names'

describe('MetricNames', () => {
  it('uses unique Prometheus-style snake_case names', () => {
    const names: string[] = Object.values(MetricNames)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('prefixes business metrics with platform_ and counters with _total', () => {
    expect(MetricNames.TENANT_VIOLATIONS).toBe('platform_tenant_violations_total')
    expect(MetricNames.SHIPMENTS_CREATED_TOTAL).toBe('platform_shipments_created_total')
  })

  it('has no quota, billing or AI metrics', () => {
    const forbidden = /(quota|billable|_ai_)/
    expect(Object.values(MetricNames).filter(name => forbidden.test(name))).toEqual([])
  })
})
