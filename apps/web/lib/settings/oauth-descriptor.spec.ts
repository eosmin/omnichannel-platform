import { assetIdMatcher, linkedAccountText, localizedText } from './oauth-descriptor'

const text = { es: 'Cuenta {username}', en: 'Account {username}' }

describe('localizedText', () => {
  it('reads Spanish for es locales and English for any other', () => {
    expect(localizedText({ es: 'a', en: 'b' }, 'es-MX')).toBe('a')
    expect(localizedText({ es: 'a', en: 'b' }, 'fr')).toBe('b')
  })
})

describe('linkedAccountText', () => {
  it('fills only {username}, as plain text', () => {
    expect(linkedAccountText(text, 'en', '<b>x</b>')).toBe('Account <b>x</b>')
  })

  it('fills every {username}, not only the first', () => {
    const twice = { es: 'IG {username} (@{username})', en: 'IG {username} (@{username})' }
    expect(linkedAccountText(twice, 'en', 'foo')).toBe('IG foo (@foo)')
  })

  it('cuts a long name', () => {
    expect(linkedAccountText(text, 'en', 'n'.repeat(200)).length).toBeLessThan(120)
  })
})

describe('assetIdMatcher', () => {
  it('follows the declared pattern', () => {
    expect(assetIdMatcher('^\\d{1,32}$').test('123')).toBe(true)
    expect(assetIdMatcher('^\\d{1,32}$').test('12a')).toBe(false)
    expect(assetIdMatcher('^[a-z]{3}$').test('abc')).toBe(true)
  })

  it('accepts nothing when the pattern declared is not one the browser runs', () => {
    expect(assetIdMatcher('^(a+)+$').test('aaaa')).toBe(false)
  })

  it('falls back to a bounded plain id when no pattern is known, so typing is never a dead end', () => {
    expect(assetIdMatcher(null).test('123')).toBe(true)
    expect(assetIdMatcher(null).test('a-b_9')).toBe(true)
    expect(assetIdMatcher(null).test('')).toBe(false)
    expect(assetIdMatcher(null).test('<script>')).toBe(false)
    expect(assetIdMatcher(null).test('1'.repeat(65))).toBe(false)
  })

  it('does not run on an input longer than the bound', () => {
    expect(assetIdMatcher('^\\d{1,32}$').test('1'.repeat(65))).toBe(false)
  })
})
