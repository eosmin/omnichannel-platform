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

  it('uses the zone of the store when the account has none, before the one of the browser', () => {
    expect(displayTimeZone(null, 'Pacific/Auckland', 'Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(displayTimeZone(undefined, undefined, 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('keeps the zone of the account over the one of the store', () => {
    expect(displayTimeZone('America/Los_Angeles', 'Pacific/Auckland', 'Asia/Tokyo')).toBe(
      'America/Los_Angeles'
    )
  })

  it('ignores a zone of the store that this browser cannot format', () => {
    expect(displayTimeZone(null, 'Asia/Tokyo', 'Mars/Olympus')).toBe('Asia/Tokyo')
  })

  it('falls to the store, not the browser, when the zone of the account cannot be formatted', () => {
    expect(displayTimeZone('Mars/Olympus', 'Asia/Tokyo', 'Pacific/Auckland')).toBe(
      'Pacific/Auckland'
    )
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
