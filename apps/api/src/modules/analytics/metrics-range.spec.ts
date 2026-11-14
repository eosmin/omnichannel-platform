import { TimeGranularity } from '@platform/core/analytics'

import { dayRangeOf } from './metrics-range'

const range = (granularity: Parameters<typeof dayRangeOf>[0], from: string, to: string) =>
  dayRangeOf(granularity, new Date(from), new Date(to))

describe('dayRangeOf', () => {
  it('reads whole days: the first is in and the last is out', () => {
    expect(
      range(TimeGranularity.DAY, '2026-11-09T00:00:00.000Z', '2026-11-11T00:00:00.000Z')
    ).toEqual({
      from: '2026-11-09',
      to: '2026-11-11'
    })
  })

  it('includes the day of an end that is past its midnight, so a range inside a day is that day', () => {
    expect(
      range(TimeGranularity.DAY, '2026-11-12T10:00:00.000Z', '2026-11-12T20:00:00.000Z')
    ).toEqual({
      from: '2026-11-12',
      to: '2026-11-13'
    })
  })

  it('starts a week on its Monday', () => {
    // 2026-11-11 is a Wednesday
    expect(
      range(TimeGranularity.WEEK, '2026-11-11T00:00:00.000Z', '2026-11-30T00:00:00.000Z').from
    ).toBe('2026-11-09')
    // A Monday stays, and a Sunday goes back six days
    expect(
      range(TimeGranularity.WEEK, '2026-11-09T00:00:00.000Z', '2026-11-30T00:00:00.000Z').from
    ).toBe('2026-11-09')
    expect(
      range(TimeGranularity.WEEK, '2026-11-15T00:00:00.000Z', '2026-11-30T00:00:00.000Z').from
    ).toBe('2026-11-09')
  })

  it('starts a month on its first day', () => {
    expect(
      range(TimeGranularity.MONTH, '2026-11-18T00:00:00.000Z', '2026-12-31T00:00:00.000Z').from
    ).toBe('2026-11-01')
  })
})
