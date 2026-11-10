import { matchesFilter } from './product-filter'

describe('matchesFilter', () => {
  it.each([
    ['all', true, true],
    ['all', false, true],
    ['active', true, true],
    ['active', false, false],
    ['archived', true, false],
    ['archived', false, true]
  ] as const)('under %s, an active=%s product is shown: %s', (filter, isActive, shown) => {
    expect(matchesFilter(filter, isActive)).toBe(shown)
  })
})
