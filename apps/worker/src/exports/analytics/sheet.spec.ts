import { AnalyticsMetrics, MetricUnits, RolledUpMetricUnits } from '@platform/core/analytics'

import { displayValue } from './sheet'

describe('displayValue', () => {
  it('keeps money as the rollup holds it: whole units of the currency, never divided again', () => {
    expect(displayValue(19.99, MetricUnits.CURRENCY)).toBe(19.99)
    expect(displayValue(0.01, MetricUnits.CURRENCY)).toBe(0.01)
    expect(displayValue(100, MetricUnits.CURRENCY)).toBe(100)
    expect(displayValue(0, MetricUnits.CURRENCY)).toBe(0)
  })

  it('rounds to the cent only at the end, from the four decimals the rollup stores', () => {
    expect(displayValue(19.9899, MetricUnits.CURRENCY)).toBe(19.99)
    expect(displayValue(0.0049, MetricUnits.CURRENCY)).toBe(0)
    expect(displayValue(0.005, MetricUnits.CURRENCY)).toBe(0.01)
    expect(displayValue(1234567.891, MetricUnits.CURRENCY)).toBe(1234567.89)
  })

  it('leaves a count and a time as they are, and an unknown figure empty', () => {
    expect(displayValue(7, MetricUnits.COUNT)).toBe(7)
    expect(displayValue(222, MetricUnits.SECONDS)).toBe(222)
    expect(displayValue(null, MetricUnits.CURRENCY)).toBeNull()
  })
})

describe('the unit of the revenue', () => {
  it('is money in whole units, the one the worker writes to the rollup', () => {
    expect(RolledUpMetricUnits[AnalyticsMetrics.ORDERS_REVENUE]).toBe(MetricUnits.CURRENCY)
  })
})
