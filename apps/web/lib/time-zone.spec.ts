import { displayTimeZone, isKnownTimeZone } from './time-zone'

describe('displayTimeZone', () => {
  it('prefers the zone of the account', () => {
    expect(displayTimeZone('Asia/Tokyo', 'America/Los_Angeles')).toBe('Asia/Tokyo')
  })

  it('falls back to the zone of the browser when the account has none (null, empty or missing)', () => {
    expect(displayTimeZone(null, 'Pacific/Auckland')).toBe('Pacific/Auckland')
    expect(displayTimeZone('', 'Pacific/Auckland')).toBe('Pacific/Auckland')
    expect(displayTimeZone(undefined, 'Pacific/Auckland')).toBe('Pacific/Auckland')
  })

  it('ignores a zone of the account that this browser cannot format', () => {
    expect(displayTimeZone('Mars/Olympus', 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('has none before the browser is known, so the render of the server stays as it is', () => {
    expect(displayTimeZone(null, undefined)).toBeUndefined()
  })
})

describe('isKnownTimeZone', () => {
  it('knows the names of the IANA zones and refuses an invented one', () => {
    expect(isKnownTimeZone('America/Los_Angeles')).toBe(true)
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false)
  })
})
