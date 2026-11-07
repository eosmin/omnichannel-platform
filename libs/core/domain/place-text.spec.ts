import { placeTextOf } from './place-text'

describe('placeTextOf', () => {
  it('keeps a plain text, trimmed', () => {
    expect(placeTextOf('  Main Square ')).toBe('Main Square')
  })

  it.each([
    ['a right-to-left override', 'Bank\u202E gnihsihp'],
    ['a zero-width space', 'Ba\u200Bnk gnihsihp'],
    ['the Arabic letter mark', 'Bank\u061C gnihsihp'],
    ['a soft hyphen', 'Ba\u00ADnk gnihsihp'],
    ['a tag character', 'Bank\u{E0041} gnihsihp']
  ])('takes %s out', (_name, text) => {
    expect(placeTextOf(text)).toMatch(/^Bank gnihsihp$/)
  })

  it('keeps accents and emoji, which are not misleading', () => {
    expect(placeTextOf('Café Ñandú 🏠')).toBe('Café Ñandú 🏠')
  })

  it('is null when nothing is left', () => {
    expect(placeTextOf('   ')).toBeNull()
    expect(placeTextOf('\u200B\u202E')).toBeNull()
    expect(placeTextOf(undefined)).toBeNull()
  })

  it('cuts to the limit without splitting a character', () => {
    expect(placeTextOf('🏠'.repeat(150), 200)).toBe('🏠'.repeat(100))
    expect(placeTextOf('abcdef', 3)).toBe('abc')
  })

  it('turns control characters into spaces', () => {
    expect(placeTextOf('a\u0000b\r\nc\u0085d\u007Fe')).toBe('a b c d e')
    expect(placeTextOf('\u0000\n')).toBeNull()
  })
})
