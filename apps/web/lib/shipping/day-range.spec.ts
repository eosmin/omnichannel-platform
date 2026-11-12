import { dayRangeToMoments } from './day-range'

describe('dayRangeToMoments', () => {
  it('opens a side that was left empty', () => {
    expect(dayRangeToMoments('', '')).toEqual({ from: undefined, to: undefined })
  })

  it('starts at the first moment of the first day and ends at the last of the second', () => {
    const range = dayRangeToMoments('2026-11-01', '2026-11-01')
    expect(new Date(range.from ?? '').getTime()).toBe(new Date('2026-11-01T00:00:00').getTime())
    expect(new Date(range.to ?? '').getTime()).toBe(new Date('2026-11-01T23:59:59.999').getTime())
  })

  it('drops a day that does not exist instead of sending an invalid moment', () => {
    expect(dayRangeToMoments('not a day', 'also not')).toEqual({ from: undefined, to: undefined })
  })
})
