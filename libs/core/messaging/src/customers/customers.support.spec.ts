import { cleanText } from './customers.support'

// What a channel reports as a name is drawn as it comes in the inbox: a line break splits the row, an
// override of direction writes the rest of the line backwards, a zero-width space makes two names that
// look the same (QA TRX-04). It is made one visible line, not refused: the message must still arrive.
describe('cleanText', () => {
  it('keeps an ordinary name, accents and emoji with their joiner', () => {
    expect(cleanText('  Ñandú Pérez  ', 120)).toBe('Ñandú Pérez')
    expect(cleanText('👩\u200d👩\u200d👧 Familia', 120)).toBe('👩\u200d👩\u200d👧 Familia')
  })

  it.each([
    ['a line break', 'dos\nlineas', 'dos lineas'],
    ['a tab', 'dos\tcolumnas', 'dos columnas'],
    ['a line separator', 'dos\u2028lineas', 'dos lineas'],
    ['a paragraph separator', 'dos\u2029lineas', 'dos lineas'],
    ['a zero-width space', 'Zero\u200bwidth', 'Zerowidth'],
    ['a direction override', 'Ana \u202egnirpS', 'Ana gnirpS'],
    ['a NUL', 'Ana\0 Pérez', 'Ana Pérez'],
    ['a Hangul filler', 'Ana\u3164Pérez', 'AnaPérez'],
    ['a NUL beside an invisible one', 'Ana\0\u200bPérez', 'AnaPérez'],
    ['a run of non-breaking spaces', 'Ana\u00a0\u00a0\u00a0Pérez', 'Ana Pérez'],
    ['a joiner that joins nothing', '\u200d', undefined],
    ['a joiner at the end', 'Ana\u200d', 'Ana'],
    ['two joiners in a row', 'Ana\u200d\u200dPérez', 'Ana\u200dPérez'],
    ['a pile of combining marks', `x${'\u0300'.repeat(9)}`, `x${'\u0300'.repeat(4)}`],
    ['a name that is only invisible', '\u200b\u202e', undefined],
    ['a name that is only a line break', '\n', undefined]
  ])('makes %s one visible line', (_name, raw, expected) => {
    expect(cleanText(raw, 120)).toBe(expected)
  })

  it('keeps the joiner of Persian spelling', () => {
    expect(cleanText('علی\u200cاکبر', 120)).toBe('علی\u200cاکبر')
  })

  it('loses the joiner that a cut leaves at the end', () => {
    expect(cleanText('Ana👩\u200d👩\u200d👧', 5)).toBe('Ana👩')
  })

  it('writes a letter typed in two parts as one', () => {
    expect(cleanText('José', 120)).toBe('José')
  })

  it('cuts by characters, never in the middle of an emoji', () => {
    expect(cleanText('😀'.repeat(10), 3)).toBe('😀😀😀')
  })
})
