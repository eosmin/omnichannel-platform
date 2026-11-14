import { foldForSearch } from './search-text'

describe('foldForSearch', () => {
  it.each([
    ['José Pérez', 'jose perez'],
    ['MARÍA', 'maria'],
    ['Ñandú', 'nandu'],
    ['Sebastián', 'sebastian'],
    ['über', 'uber'],
    ['Łukasz', 'lukasz'],
    ['Strauß', 'strauss'],
    ['Øre', 'ore'],
    ['Ana  López', 'ana  lopez']
  ])('folds %s to %s, as unaccent(lower()) does', (typed, folded) => {
    expect(foldForSearch(typed)).toBe(folded)
  })

  it('reads a decomposed accent as the composed one', () => {
    expect(foldForSearch('José')).toBe('jose')
  })

  it('leaves the scripts that have no Latin accents as they are written', () => {
    // Hangul and kana with a voicing mark must not be decomposed: the stored side is not
    expect(foldForSearch('김민수')).toBe('김민수')
    expect(foldForSearch('がぎぐ')).toBe('がぎぐ')
    expect(foldForSearch('Иван')).toBe('иван')
  })

  it('is empty for a text that is only combining marks', () => {
    expect(foldForSearch('́́')).toBe('')
  })
})
