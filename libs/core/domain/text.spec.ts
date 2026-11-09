import { isSingleEmoji, phraseMatches, plainText } from './text'

describe('plainText', () => {
  it('lowers the case and takes the accents off', () => {
    expect(plainText('ENVÍO Rápido')).toBe('envio rapido')
    expect(plainText('envio')).toBe(plainText('Envío'))
  })

  it('reads a precomposed letter and a decomposed one as the same', () => {
    expect(plainText('é')).toBe(plainText('é'))
  })

  it('takes out the invisible characters that split a word', () => {
    for (const invisible of ['​', '⁠', '­', '﻿', '‍', '‮', 'ㅤ']) {
      expect(plainText(`re${invisible}fund`)).toBe('refund')
    }
  })

  it('leaves nothing of a text made of accents and invisible characters', () => {
    expect(plainText('́')).toBe('')
    expect(plainText('​́')).toBe('')
    expect(plainText('ㅤ')).toBe('')
  })

  it('reads every run of blanks as one space, so a phrase is found across lines', () => {
    expect(plainText('where is my\norder')).toBe('where is my order')
    expect(plainText('where  is\tmy order')).toBe('where is my order')
  })

  it('keeps the marks that change a word in other scripts', () => {
    // ba (voiced) and ha (unvoiced) of the kana are two words
    expect(plainText('ばか')).not.toBe(plainText('はか'))
  })

  it('keeps the rest as it is', () => {
    expect(plainText('¿cuánto? 2x1!')).toBe('¿cuanto? 2x1!')
  })
})

describe('phraseMatches', () => {
  it('ignores the space around either text and nothing else', () => {
    expect(phraseMatches('  My shop ', 'My shop')).toBe(true)
    expect(phraseMatches('My shop', 'My shop ')).toBe(true)
    expect(phraseMatches('my shop', 'My shop')).toBe(false)
    expect(phraseMatches('', 'My shop')).toBe(false)
    expect(phraseMatches('My  shop', 'My shop')).toBe(false)
  })
})

describe('isSingleEmoji', () => {
  it.each([
    ['a face', '😀'],
    ['a heart with the emoji selector', '❤️'],
    ['a heart without it', '❤'],
    ['a thumb with a skin tone', '👍🏽'],
    ['a family joined with ZWJ', '👨‍👩‍👧‍👦'],
    ['a couple with skin tones and a heart', '👩🏽‍❤️‍💋‍👨🏻'],
    ['a flag of two regional indicators', '🇲🇽'],
    [
      'a flag of a subdivision (tag sequence)',
      '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'
    ],
    ['a keycap', '1️⃣'],
    ['a rainbow flag (ZWJ)', '🏳️‍🌈'],
    ['a keycap without the selector', '1\u20E3']
  ])('takes %s', (_name, value) => {
    expect(isSingleEmoji(value, 32)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['blank', ' '],
    ['letters', 'abc'],
    ['markup', '<b>'],
    ['a digit', '1'],
    ['a letter with an emoji', 'x😀'],
    ['two emoji', '😀😀'],
    ['two flags', '🇲🇽🇺🇸'],
    ['one regional indicator', '🇲'],
    ['three regional indicators', '🇲🇽🇺'],
    ['an emoji and a space', '😀 '],
    ['a space before', ' 😀'],
    ['an emoji and a line break', '😀\n'],
    ['a control character', '\u0007😀'],
    ['a zero-width space', '😀\u200B'],
    ['a bidi override', '😀\u202E'],
    ['a trailing ZWJ', '👍\u200D'],
    ['a leading ZWJ', '\u200D👍'],
    ['a ZWJ with a letter', '👍\u200Da'],
    ['a doubled emoji selector', '❤\uFE0F\uFE0F'],
    ['a lone skin tone', '🏽'],
    ['a skin tone on a face', '😀🏽'],
    ['a skin tone after the selector', '👍\uFE0F🏽'],
    ['too many joined', '👨\u200D👩\u200D👧\u200D👦\u200D👦'],
    ['a lone selector', '\uFE0F'],
    ['a lone tag character', '\u{E0067}'],
    ['a NUL', '😀\0'],
    ['half of an emoji', '\uD83D'],
    ['an emoji with a combining mark', '😀\u0301'],
    ['text over the limit', '😀\u200D'.repeat(20)]
  ])('refuses %s', (_name, value) => {
    expect(isSingleEmoji(value, 32)).toBe(false)
  })

  it('refuses an emoji longer than the limit given', () => {
    expect(isSingleEmoji('👨‍👩‍👧‍👦', 4)).toBe(false)
  })
})
