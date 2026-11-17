import { receivedTime } from './inbound-time'

const now = new Date('2026-10-27T12:00:00.000Z')

describe('receivedTime', () => {
  it('keeps the date of a message from the past', () => {
    expect(receivedTime('2026-10-27T11:00:00.000Z', now)).toEqual(
      new Date('2026-10-27T11:00:00.000Z')
    )
  })

  it('counts any date ahead of the clock as now, a small drift of the provider included', () => {
    for (const ahead of [1, 1000, 5 * 60 * 1000, 5 * 60 * 1000 + 1, 24 * 60 * 60 * 1000]) {
      expect(receivedTime(new Date(now.getTime() + ahead).toISOString(), now)).toBe(now)
    }
  })

  it('keeps a date that is exactly now', () => {
    expect(receivedTime(now.toISOString(), now)).toEqual(now)
  })

  it('counts a date from long ago as now: it is a unit mistake', () => {
    expect(receivedTime('1970-01-20T00:00:00.000Z', now)).toBe(now)
  })

  it('counts a date that cannot be read as now', () => {
    expect(receivedTime('not a date', now)).toBe(now)
  })
})
