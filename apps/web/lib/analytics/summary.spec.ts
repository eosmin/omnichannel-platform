import type { MetricsResultView } from '@platform/api-client'

import { breakdownOf, changeOf, dailyValues, toneOf, wholeStoreSummary } from './summary'

const result = (series: MetricsResultView['series']): MetricsResultView => ({
  metric: 'conversations.created',
  granularity: 'day',
  dimension: '',
  aggregation: 'sum',
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-04T00:00:00.000Z',
  series
})

describe('wholeStoreSummary', () => {
  it('is the summary of the one series, and null when nothing happened', () => {
    expect(
      wholeStoreSummary(result([{ dimensionId: '', points: [], summary: { value: 5, count: 5 } }]))
    ).toEqual({ value: 5, count: 5 })
    expect(wholeStoreSummary(result([]))).toBeNull()
    expect(wholeStoreSummary(undefined)).toBeNull()
  })
})

describe('changeOf', () => {
  it('is the fraction against the period before', () => {
    expect(changeOf(112, 100)).toBeCloseTo(0.12)
    expect(changeOf(50, 100)).toBeCloseTo(-0.5)
  })

  it('is null when there is nothing to compare with: no figure or a zero before', () => {
    expect(changeOf(5, 0)).toBeNull()
    expect(changeOf(null, 5)).toBeNull()
    expect(changeOf(5, null)).toBeNull()
  })
})

describe('toneOf', () => {
  it('reads a drop in a time as better and a drop in a count as worse', () => {
    expect(toneOf(-0.2, 'lower')).toBe('better')
    expect(toneOf(0.2, 'lower')).toBe('worse')
    expect(toneOf(-0.2, 'higher')).toBe('worse')
    expect(toneOf(0.2, 'higher')).toBe('better')
  })

  it('calls a change under half a percent no change', () => {
    expect(toneOf(0.004, 'higher')).toBe('same')
    expect(toneOf(-0.004, 'lower')).toBe('same')
  })
})

describe('dailyValues', () => {
  it('puts a zero on the days with no row, in the order of the days', () => {
    const series = {
      dimensionId: '',
      points: [
        { timestamp: '2026-11-03T00:00:00.000Z', value: 4, count: 4 },
        { timestamp: '2026-11-01T00:00:00.000Z', value: 2, count: 2 }
      ],
      summary: { value: 6, count: 6 }
    }
    expect(dailyValues(series, ['2026-11-01', '2026-11-02', '2026-11-03'])).toEqual([2, 0, 4])
    expect(dailyValues(undefined, ['2026-11-01'])).toEqual([0])
  })
})

describe('breakdownOf', () => {
  it('puts the biggest first and breaks a tie by id', () => {
    const rows = breakdownOf(
      result([
        { dimensionId: 'b', points: [], summary: { value: 3, count: 3 } },
        { dimensionId: 'c', points: [], summary: { value: 9, count: 9 } },
        { dimensionId: 'a', points: [], summary: { value: 3, count: 3 } }
      ])
    )
    expect(rows.map(row => row.id)).toEqual(['c', 'a', 'b'])
  })
})
