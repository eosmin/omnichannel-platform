import { messageTimeOptions } from './message-time'

const at = (locale: string, hour: number, minute: number): string =>
  new Intl.DateTimeFormat(locale, { ...messageTimeOptions(locale), timeZone: 'UTC' })
    .format(
      new Date(Date.UTC(2026, 0, 1, hour, minute))
      // Newer ICU writes a narrow no-break space before AM and PM
    )
    .replace(/\s/g, ' ')

describe('messageTimeOptions', () => {
  it('writes the hour with two digits where the clock has 24 hours (00:35, not 0:35)', () => {
    expect(at('es', 0, 35)).toBe('00:35')
    expect(at('es', 9, 5)).toBe('09:05')
    expect(at('es', 17, 40)).toBe('17:40')
  })

  it('keeps the usual way of a 12 hour clock', () => {
    expect(at('en', 9, 5)).toBe('9:05 AM')
    expect(at('en', 0, 35)).toBe('12:35 AM')
  })
})
