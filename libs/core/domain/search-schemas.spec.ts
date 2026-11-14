import { SearchEntities, SearchTracking, SearchTrackedScopes } from './search-constants'
import { searchClickDataSchema, searchEventDataSchema } from './search-schemas'

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

describe('the data of a search click event', () => {
  const click = {
    queryHash: '0123456789abcdef',
    scope: SearchTrackedScopes.GLOBAL,
    entity: SearchEntities.ORDERS,
    position: 4
  }

  it('accepts a click of the global search on any kind', () => {
    for (const entity of Object.values(SearchEntities)) {
      expect(searchClickDataSchema.parse({ ...click, entity }).entity).toBe(entity)
    }
  })

  it('accepts a click of a search of one kind on that kind, and on no other', () => {
    const same = { ...click, scope: SearchEntities.ORDERS, entity: SearchEntities.ORDERS }
    expect(searchClickDataSchema.safeParse(same).success).toBe(true)
    expect(
      searchClickDataSchema.safeParse({ ...same, entity: SearchEntities.CUSTOMERS }).success
    ).toBe(false)
  })

  it('has room for the first and the last place of the largest page, and none past it', () => {
    expect(searchClickDataSchema.safeParse({ ...click, position: 0 }).success).toBe(true)
    expect(
      searchClickDataSchema.safeParse({ ...click, position: SearchTracking.MAX_POSITION }).success
    ).toBe(true)
    expect(
      searchClickDataSchema.safeParse({ ...click, position: SearchTracking.MAX_POSITION + 1 })
        .success
    ).toBe(false)
    expect(searchClickDataSchema.safeParse({ ...click, position: -1 }).success).toBe(false)
    expect(searchClickDataSchema.safeParse({ ...click, position: 1.5 }).success).toBe(false)
  })

  it('carries no text and nothing of the result', () => {
    expect(searchClickDataSchema.safeParse({ ...click, query: 'maria' }).success).toBe(false)
    expect(searchClickDataSchema.safeParse({ ...click, resultId: 'abc' }).success).toBe(false)
    expect(searchClickDataSchema.safeParse({ ...click, queryHash: 'nope' }).success).toBe(false)
  })
})
