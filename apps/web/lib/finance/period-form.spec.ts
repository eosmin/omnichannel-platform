import {
  openPeriodDraftOf,
  openPeriodInputOf,
  openPeriodProblem,
  periodHasEnded,
  periodKeyOf
} from './period-form'

describe('open a month', () => {
  it('suggests the month of the day it is given', () => {
    expect(openPeriodDraftOf(new Date(2026, 10, 15))).toEqual({ year: '2026', month: '11' })
  })

  it('accepts a real month and year', () => {
    expect(openPeriodProblem({ year: '2026', month: '12' })).toBeNull()
    expect(openPeriodInputOf({ year: '2026', month: '12' })).toEqual({ year: 2026, month: 12 })
  })

  it.each(['', '0', '13', 'x', '1.5', '-1'])('refuses the month %j', month => {
    expect(openPeriodProblem({ year: '2026', month })).toBe('month')
  })

  it.each(['', '1999', '2201', 'abc', '20260'])('refuses the year %j', year => {
    expect(openPeriodProblem({ year, month: '1' })).toBe('year')
  })

  it('writes a period as year and month, the order the api lists them in', () => {
    expect(periodKeyOf({ year: 2026, month: 3 })).toBe('2026-03')
  })
})

describe('periodHasEnded', () => {
  it('is true from the day after the last one, by the UTC day', () => {
    const period = { endsOn: '2026-03-31' }
    expect(periodHasEnded(period, new Date('2026-03-31T23:59:59Z'))).toBe(false)
    expect(periodHasEnded(period, new Date('2026-04-01T00:00:00Z'))).toBe(true)
    expect(periodHasEnded(period, new Date('2026-03-15T12:00:00Z'))).toBe(false)
  })
})
