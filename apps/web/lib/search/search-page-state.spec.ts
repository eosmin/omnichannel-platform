import { SearchEntities, SearchPageScopes } from '@platform/core/domain'

import { readScope, searchAddress } from './search-page-state'

describe('readScope', () => {
  it('reads a scope the member may search', () => {
    expect(readScope('orders', [SearchEntities.ORDERS])).toBe(SearchEntities.ORDERS)
  })

  it('falls back to all for a scope the member may not search, an unknown one, or none', () => {
    expect(readScope('orders', [SearchEntities.CUSTOMERS])).toBe(SearchPageScopes.ALL)
    expect(readScope('nothing', [SearchEntities.CUSTOMERS])).toBe(SearchPageScopes.ALL)
    expect(readScope(null, [SearchEntities.CUSTOMERS])).toBe(SearchPageScopes.ALL)
  })
})

describe('searchAddress', () => {
  it('writes the text and leaves the default scope out', () => {
    expect(searchAddress('/s/1/search', 'José Pérez', SearchPageScopes.ALL)).toBe(
      '/s/1/search?q=Jos%C3%A9+P%C3%A9rez'
    )
  })

  it('writes a scope that is not the default', () => {
    expect(searchAddress('/s/1/search', 'ab', SearchEntities.MESSAGES)).toBe(
      '/s/1/search?q=ab&scope=messages'
    )
  })

  it('is the bare path for no text and no scope', () => {
    expect(searchAddress('/s/1/search', '', SearchPageScopes.ALL)).toBe('/s/1/search')
  })
})
