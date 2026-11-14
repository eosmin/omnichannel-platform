import { DateRangePresets } from '@platform/core/analytics'

import { daysOf, isAnalyticsRange, previousRangeOf, rangeOf } from './date-range'

const NOW = new Date('2026-11-14T17:36:00Z')
const iso = (range: { from: Date; to: Date }): string[] => [
  range.from.toISOString(),
  range.to.toISOString()
]

describe('rangeOf', () => {
  it('ends at the start of today, because today has no rollup yet', () => {
    expect(iso(rangeOf(DateRangePresets.LAST_7_DAYS, NOW))).toEqual([
      '2026-11-07T00:00:00.000Z',
      '2026-11-14T00:00:00.000Z'
    ])
    expect(rangeOf(DateRangePresets.LAST_30_DAYS, NOW).from.toISOString()).toBe(
      '2026-10-15T00:00:00.000Z'
    )
    expect(rangeOf(DateRangePresets.LAST_90_DAYS, NOW).from.toISOString()).toBe(
      '2026-08-16T00:00:00.000Z'
    )
  })

  it('is the whole of the month before for last month', () => {
    expect(iso(rangeOf(DateRangePresets.LAST_MONTH, NOW))).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z'
    ])
    // Across the year
    expect(iso(rangeOf(DateRangePresets.LAST_MONTH, new Date('2027-01-05T00:00:00Z')))).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z'
    ])
  })
})

describe('previousRangeOf', () => {
  it('is the period of the same length right before', () => {
    expect(iso(previousRangeOf(DateRangePresets.LAST_7_DAYS, NOW))).toEqual([
      '2026-10-31T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z'
    ])
  })

  it('is the month before the month, whatever their lengths', () => {
    expect(iso(previousRangeOf(DateRangePresets.LAST_MONTH, NOW))).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z'
    ])
  })
})

describe('daysOf', () => {
  it('lists the days of the range and leaves the end out', () => {
    expect(daysOf(rangeOf(DateRangePresets.LAST_7_DAYS, NOW))).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13'
    ])
  })
})

describe('isAnalyticsRange', () => {
  it('knows the offered ranges and nothing else', () => {
    expect(isAnalyticsRange(DateRangePresets.LAST_30_DAYS)).toBe(true)
    expect(isAnalyticsRange(DateRangePresets.CUSTOM)).toBe(false)
    expect(isAnalyticsRange('')).toBe(false)
  })
})
