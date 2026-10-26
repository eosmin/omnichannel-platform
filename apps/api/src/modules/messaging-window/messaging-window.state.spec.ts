import { stateOf } from './messaging-window.state'

const HOUR_MS = 60 * 60 * 1000
const now = new Date('2026-03-02T12:00:00Z')
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR_MS)
const whatsapp = { hours: 24, requiresTemplateWhenClosed: true }
const meta = { hours: 24, requiresTemplateWhenClosed: false }

describe('stateOf', () => {
  it('has no window for a channel with no policy', () => {
    expect(stateOf(null, null, now)).toEqual({
      open: true,
      closesAt: null,
      requiresTemplate: false
    })
    expect(stateOf(null, hoursAgo(1000), now).open).toBe(true)
  })

  it('is open until the policy hours after the last message of the customer', () => {
    const state = stateOf(whatsapp, hoursAgo(2), now)

    expect(state.open).toBe(true)
    expect(state.requiresTemplate).toBe(false)
    expect(state.closesAt).toEqual(new Date('2026-03-03T10:00:00Z'))
  })

  it('closes at the very moment the window ends', () => {
    expect(stateOf(whatsapp, new Date(now.getTime() - 24 * HOUR_MS + 1), now).open).toBe(true)
    expect(stateOf(whatsapp, hoursAgo(24), now).open).toBe(false)
    expect(stateOf(whatsapp, hoursAgo(25), now).open).toBe(false)
  })

  it('asks for a template only on a channel that lets one through', () => {
    expect(stateOf(whatsapp, hoursAgo(30), now).requiresTemplate).toBe(true)
    expect(stateOf(meta, hoursAgo(30), now).requiresTemplate).toBe(false)
  })

  it('is closed when the customer never wrote, with no date to count from', () => {
    expect(stateOf(whatsapp, null, now)).toEqual({
      open: false,
      closesAt: null,
      requiresTemplate: true
    })
    expect(stateOf(meta, null, now)).toEqual({
      open: false,
      closesAt: null,
      requiresTemplate: false
    })
  })

  it('does not let a date from the future make the window longer', () => {
    const ahead = new Date(now.getTime() + 3 * HOUR_MS)

    const state = stateOf(whatsapp, ahead, now)

    expect(state.closesAt).toEqual(new Date(now.getTime() + 24 * HOUR_MS))
  })

  it('counts the hours of the policy and not a fixed 24', () => {
    const short = { hours: 2, requiresTemplateWhenClosed: false }

    expect(stateOf(short, hoursAgo(1), now).open).toBe(true)
    expect(stateOf(short, hoursAgo(3), now).open).toBe(false)
  })
})
