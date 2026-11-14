import { SearchTracking, SearchTrackedScopes } from './search-constants'
import { searchEventDataSchema } from './search-schemas'

const valid = {
  queryHash: '0123456789abcdef',
  scope: SearchTrackedScopes.CUSTOMERS,
  resultCount: 2,
  durationMs: 14
}

describe('the data of a search event', () => {
  it('accepts a search that found something, with no text', () => {
    expect(searchEventDataSchema.parse(valid)).toEqual(valid)
  })

  it('accepts the text of a product search that found nothing, up to the cap', () => {
    const text = 'a'.repeat(SearchTracking.QUERY_MAX_LENGTH)
    const data = { ...valid, scope: SearchTrackedScopes.PRODUCTS, resultCount: 0, query: text }
    expect(searchEventDataSchema.parse(data).query).toBe(text)
  })

  it.each(
    Object.values(SearchTrackedScopes).filter(scope => scope !== SearchTrackedScopes.PRODUCTS)
  )('refuses the text of a search of %s: what was asked about people stays a hash', scope => {
    expect(searchEventDataSchema.safeParse({ ...valid, scope, query: 'maria lopez' }).success).toBe(
      false
    )
  })

  it.each(Object.values(SearchTrackedScopes))('knows the scope %s', scope => {
    expect(searchEventDataSchema.safeParse({ ...valid, scope }).success).toBe(true)
  })

  it.each([
    ['a scope it does not know', { scope: 'invoices' }],
    ['a hash of another length', { queryHash: '0123' }],
    ['a hash that is not hexadecimal', { queryHash: 'zzzzzzzzzzzzzzzz' }],
    ['a count below zero', { resultCount: -1 }],
    ['a count with decimals', { resultCount: 1.5 }],
    ['a negative duration', { durationMs: -1 }],
    ['an empty text', { scope: SearchTrackedScopes.PRODUCTS, query: '' }],
    [
      'a text over the cap',
      {
        scope: SearchTrackedScopes.PRODUCTS,
        query: 'a'.repeat(SearchTracking.QUERY_MAX_LENGTH + 1)
      }
    ],
    ['a field it does not carry', { userId: 'someone' }]
  ])('refuses %s', (_label, change) => {
    expect(searchEventDataSchema.safeParse({ ...valid, ...change }).success).toBe(false)
  })
})
