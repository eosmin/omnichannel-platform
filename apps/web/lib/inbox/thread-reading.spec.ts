import { stickyDayOf, unseenAfter } from './thread-reading'

describe('unseenAfter', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('counts the messages after the last one the reader has reached', () => {
    expect(unseenAfter(ids, 'b')).toBe(2)
    expect(unseenAfter(ids, 'd')).toBe(0)
  })

  it('counts nothing for a reader who has reached the end, and everything for one with no mark', () => {
    expect(unseenAfter(ids, 'd')).toBe(0)
    expect(unseenAfter(ids, null)).toBe(0)
  })

  it('counts nothing when the mark is not in the list (older pages, another conversation)', () => {
    expect(unseenAfter(ids, 'zzz')).toBe(0)
  })
})

describe('stickyDayOf', () => {
  const days = [
    { key: '2026-11-05', top: 0 },
    { key: '2026-11-06', top: 400 },
    { key: '2026-11-07', top: 900 }
  ]

  it('is the day whose block the top of the view is inside', () => {
    expect(stickyDayOf(days, 0)).toBe('2026-11-05')
    expect(stickyDayOf(days, 399)).toBe('2026-11-05')
    expect(stickyDayOf(days, 400)).toBe('2026-11-06')
    expect(stickyDayOf(days, 5000)).toBe('2026-11-07')
  })

  it('is nothing when the view is above the first day, or there are no days', () => {
    expect(stickyDayOf(days, -10)).toBeNull()
    expect(stickyDayOf([], 100)).toBeNull()
  })
})
