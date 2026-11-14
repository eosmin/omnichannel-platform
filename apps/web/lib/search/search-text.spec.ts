import { SearchConfig } from '@platform/core/domain'

import { readySearchText } from './search-text'

describe('readySearchText', () => {
  it('waits for the minimum, counted in characters after trimming', () => {
    expect(readySearchText('')).toBeNull()
    expect(readySearchText('  a  ')).toBeNull()
    expect(readySearchText('ab')).toBe('ab')
  })

  it('counts a character outside the BMP as one', () => {
    expect(SearchConfig.MIN_QUERY_LENGTH).toBe(2)
    expect(readySearchText('😀')).toBeNull()
    expect(readySearchText('😀😀')).toBe('😀😀')
  })

  it('folds every run of spaces into one', () => {
    expect(readySearchText('  José \t  Pérez ')).toBe('José Pérez')
  })

  it('cuts a text longer than the maximum instead of sending one the api refuses', () => {
    const long = 'x'.repeat(SearchConfig.MAX_QUERY_LENGTH + 50)
    expect([...(readySearchText(long) ?? '')]).toHaveLength(SearchConfig.MAX_QUERY_LENGTH)
  })
})
