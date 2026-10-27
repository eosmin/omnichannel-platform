import { InboundLimits } from '@platform/core/domain'

import { receivedTime } from './inbound-time'

const now = new Date('2026-10-27T12:00:00.000Z')

describe('receivedTime', () => {
  it('keeps the date of a message from the past', () => {
    expect(receivedTime('2026-10-27T11:00:00.000Z', now)).toEqual(
      new Date('2026-10-27T11:00:00.000Z')
    )
  })

  it('allows a small drift of the clock of the provider', () => {
    const ahead = new Date(now.getTime() + InboundLimits.MAX_FUTURE_SKEW_MS)
    expect(receivedTime(ahead.toISOString(), now)).toEqual(ahead)
  })

  it('counts a date too far ahead as now', () => {
    const ahead = new Date(now.getTime() + InboundLimits.MAX_FUTURE_SKEW_MS + 1)
    expect(receivedTime(ahead.toISOString(), now)).toBe(now)
  })

  it('counts a date from long ago as now: it is a unit mistake', () => {
    expect(receivedTime('1970-01-20T00:00:00.000Z', now)).toBe(now)
  })

  it('counts a date that cannot be read as now', () => {
    expect(receivedTime('not a date', now)).toBe(now)
  })
})
