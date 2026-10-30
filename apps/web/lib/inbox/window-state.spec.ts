import { hoursAndMinutes, windowStateOf } from './window-state'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const inHours = (hours: number): string => new Date(NOW.getTime() + hours * 3_600_000).toISOString()

describe('windowStateOf', () => {
  it('blocks nothing until the answer is read', () => {
    expect(windowStateOf(undefined, NOW)).toEqual({ kind: 'open' })
  })

  it('is open for a channel with no window', () => {
    const view = { open: true, closesAt: null, requiresTemplate: false }
    expect(windowStateOf(view, NOW)).toEqual({ kind: 'open' })
  })

  it('is open with more than two hours left', () => {
    const view = { open: true, closesAt: inHours(5), requiresTemplate: false }
    expect(windowStateOf(view, NOW)).toEqual({ kind: 'open' })
  })

  it('is closing under two hours, and says how long is left', () => {
    const view = { open: true, closesAt: inHours(1.5), requiresTemplate: false }
    expect(windowStateOf(view, NOW)).toEqual({ kind: 'closing', remainingMs: 5_400_000 })
  })

  it('is still open at exactly two hours', () => {
    const view = { open: true, closesAt: inHours(2), requiresTemplate: false }
    expect(windowStateOf(view, NOW)).toEqual({ kind: 'open' })
  })

  it('keeps zero left for a window that ended while the page was open', () => {
    const view = { open: true, closesAt: inHours(-1), requiresTemplate: false }
    expect(windowStateOf(view, NOW)).toEqual({ kind: 'closing', remainingMs: 0 })
  })

  it('is closed, and says whether a template can follow', () => {
    expect(
      windowStateOf({ open: false, closesAt: inHours(-3), requiresTemplate: true }, NOW)
    ).toEqual({
      kind: 'closed',
      requiresTemplate: true
    })
    expect(windowStateOf({ open: false, closesAt: null, requiresTemplate: false }, NOW)).toEqual({
      kind: 'closed',
      requiresTemplate: false
    })
  })
})

describe('hoursAndMinutes', () => {
  it('splits the time left', () => {
    expect(hoursAndMinutes(107 * 60_000)).toEqual({ hours: 1, minutes: 47 })
    expect(hoursAndMinutes(30 * 60_000)).toEqual({ hours: 0, minutes: 30 })
  })

  it('rounds a partial minute up, and a window that is over to nothing', () => {
    expect(hoursAndMinutes(61_000)).toEqual({ hours: 0, minutes: 2 })
    expect(hoursAndMinutes(0)).toEqual({ hours: 0, minutes: 0 })
  })
})
