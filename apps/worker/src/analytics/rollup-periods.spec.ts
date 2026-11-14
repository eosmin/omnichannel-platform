import { isAligned, periodsToRecompute, RollupGranularities } from './rollup-periods'

describe('periodsToRecompute', () => {
  it('takes the two closed hours before the running one, newest first', () => {
    const periods = periodsToRecompute(
      RollupGranularities.HOURLY,
      new Date('2026-11-14T10:05:30.000Z')
    )
    expect(periods.map(p => [p.start.toISOString(), p.end.toISOString()])).toEqual([
      ['2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z'],
      ['2026-11-14T08:00:00.000Z', '2026-11-14T09:00:00.000Z']
    ])
  })

  it('takes the two closed UTC days, even across a month boundary', () => {
    const periods = periodsToRecompute(
      RollupGranularities.DAILY,
      new Date('2026-12-01T00:15:00.000Z')
    )
    expect(periods.map(p => p.start.toISOString())).toEqual([
      '2026-11-30T00:00:00.000Z',
      '2026-11-29T00:00:00.000Z'
    ])
  })

  it('never returns the period that is still running, not even at its first millisecond', () => {
    const [newest] = periodsToRecompute(
      RollupGranularities.HOURLY,
      new Date('2026-11-14T10:00:00.000Z')
    )
    expect(newest?.start.toISOString()).toBe('2026-11-14T09:00:00.000Z')
    expect(newest?.end.toISOString()).toBe('2026-11-14T10:00:00.000Z')
  })

  it('still takes the hour before the running one a millisecond before it closes', () => {
    const periods = periodsToRecompute(
      RollupGranularities.HOURLY,
      new Date('2026-11-14T09:59:59.999Z')
    )
    expect(periods.map(p => p.start.toISOString())).toEqual([
      '2026-11-14T08:00:00.000Z',
      '2026-11-14T07:00:00.000Z'
    ])
  })
})

describe('isAligned', () => {
  const hour = RollupGranularities.HOURLY
  const day = RollupGranularities.DAILY

  it('accepts a whole hour and a whole UTC day', () => {
    expect(
      isAligned(hour, new Date('2026-11-14T09:00:00.000Z'), new Date('2026-11-14T10:00:00.000Z'))
    ).toBe(true)
    expect(
      isAligned(day, new Date('2026-11-14T00:00:00.000Z'), new Date('2026-11-15T00:00:00.000Z'))
    ).toBe(true)
  })

  it.each([
    ['a start that is not on the hour', '2026-11-14T09:30:00.000Z', '2026-11-14T10:30:00.000Z'],
    ['a period of two hours', '2026-11-14T09:00:00.000Z', '2026-11-14T11:00:00.000Z'],
    ['an end before the start', '2026-11-14T10:00:00.000Z', '2026-11-14T09:00:00.000Z']
  ])('refuses %s as an hour', (_label, start, end) => {
    expect(isAligned(hour, new Date(start), new Date(end))).toBe(false)
  })

  it('refuses a whole hour as a day', () => {
    expect(
      isAligned(day, new Date('2026-11-14T09:00:00.000Z'), new Date('2026-11-14T10:00:00.000Z'))
    ).toBe(false)
  })
})
