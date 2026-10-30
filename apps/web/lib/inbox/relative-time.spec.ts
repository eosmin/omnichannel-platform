import { relativeTime } from './relative-time'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000)

describe('relativeTime', () => {
  it('says now under a minute', () => {
    expect(relativeTime(ago(20), NOW, 'en')).toBe('now')
  })

  it('says now for a moment slightly in the future, as a clock that runs behind gives', () => {
    expect(relativeTime(ago(-120), NOW, 'en')).toBe('now')
  })

  it('counts minutes, hours and days back', () => {
    expect(relativeTime(ago(5 * 60), NOW, 'en')).toMatch(/5/)
    expect(relativeTime(ago(3 * 3600), NOW, 'en')).toMatch(/3/)
    expect(relativeTime(ago(2 * 86_400), NOW, 'en')).toMatch(/2/)
  })

  it('is a year, not twelve months, a few days before the year is full', () => {
    expect(relativeTime(ago(360 * 86_400), NOW, 'en')).not.toMatch(/12/)
    expect(relativeTime(ago(366 * 86_400), NOW, 'en')).not.toMatch(/mo/)
  })

  it('follows the language', () => {
    expect(relativeTime(ago(5 * 60), NOW, 'es')).toMatch(/hace/)
  })
})
