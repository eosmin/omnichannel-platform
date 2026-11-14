import { SearchConfig } from '@platform/core/domain'

import {
  globalSearchQuerySchema,
  searchClickBodySchema,
  searchMessagesQuerySchema,
  searchQuerySchema
} from './search.schemas'

describe('the queries of the search', () => {
  it('reads the text trimmed, in NFC, with every kind of space as one space', () => {
    const parsed = searchQuerySchema.parse({ q: '  Jose  Perez  ' })
    expect(parsed.q).toBe('Jose Perez')
    // "e" + a combining acute becomes the single letter
    expect(searchQuerySchema.parse({ q: 'José' }).q).toBe('José')
  })

  it('counts characters, not UTF-16 units', () => {
    // One emoji is one character: two of them reach the minimum
    expect(searchQuerySchema.safeParse({ q: '\u{1F600}' }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ q: '\u{1F600}\u{1F600}' }).success).toBe(true)
  })

  it('accepts exactly the minimum and the maximum, and nothing outside them', () => {
    const q = (length: number) => searchQuerySchema.safeParse({ q: 'a'.repeat(length) }).success
    expect(q(SearchConfig.MIN_QUERY_LENGTH - 1)).toBe(false)
    expect(q(SearchConfig.MIN_QUERY_LENGTH)).toBe(true)
    expect(q(SearchConfig.MAX_QUERY_LENGTH)).toBe(true)
    expect(q(SearchConfig.MAX_QUERY_LENGTH + 1)).toBe(false)
  })

  it('refuses a text that is only blanks, a NUL character, or missing', () => {
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ q: 'ab\0cd' }).success).toBe(false)
    expect(searchQuerySchema.safeParse({}).success).toBe(false)
  })

  it('refuses a parameter it does not know, such as the store', () => {
    expect(searchQuerySchema.safeParse({ q: 'ab', storeId: 'x' }).success).toBe(false)
    expect(globalSearchQuerySchema.safeParse({ q: 'ab', limit: '5' }).success).toBe(false)
  })

  it('reads the limit as a number, with a default and a ceiling', () => {
    expect(searchQuerySchema.parse({ q: 'ab' }).limit).toBe(SearchConfig.DEFAULT_LIMIT)
    expect(searchQuerySchema.parse({ q: 'ab', limit: '7' }).limit).toBe(7)
    expect(searchQuerySchema.safeParse({ q: 'ab', limit: '0' }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ q: 'ab', limit: '1.5' }).success).toBe(false)
    expect(
      searchQuerySchema.safeParse({ q: 'ab', limit: `${SearchConfig.MAX_LIMIT}` }).success
    ).toBe(true)
    expect(
      searchQuerySchema.safeParse({ q: 'ab', limit: `${SearchConfig.MAX_LIMIT + 1}` }).success
    ).toBe(false)
  })

  it('takes a conversation id that is a UUID, for the messages only', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(searchMessagesQuerySchema.parse({ q: 'ab', conversationId: id }).conversationId).toBe(id)
    expect(searchMessagesQuerySchema.safeParse({ q: 'ab', conversationId: 'nope' }).success).toBe(
      false
    )
    expect(searchQuerySchema.safeParse({ q: 'ab', conversationId: id }).success).toBe(false)
  })
})

describe('the passive flag of the global search', () => {
  it('is off unless the request says so', () => {
    expect(globalSearchQuerySchema.parse({ q: 'jose' }).passive).toBe(false)
    expect(globalSearchQuerySchema.parse({ q: 'jose', passive: 'false' }).passive).toBe(false)
    expect(globalSearchQuerySchema.parse({ q: 'jose', passive: 'true' }).passive).toBe(true)
  })

  it('refuses a value that is not a boolean', () => {
    expect(globalSearchQuerySchema.safeParse({ q: 'jose', passive: 'maybe' }).success).toBe(false)
  })
})

describe('the body of a click on a result', () => {
  const body = { q: ' Jose  Perez ', scope: 'global', entity: 'customers', position: 0 }

  it('reads the text as every search does', () => {
    expect(searchClickBodySchema.parse(body).q).toBe('Jose Perez')
  })

  it.each([
    ['a text below the minimum', { ...body, q: 'a' }],
    ['a kind it does not know', { ...body, entity: 'invoices' }],
    ['a scope it does not know', { ...body, scope: 'invoices' }],
    ['a kind the search could not have shown', { ...body, scope: 'orders', entity: 'customers' }],
    ['a position past the page', { ...body, position: 100 }],
    ['a field it does not carry', { ...body, storeId: '11111111-1111-4111-8111-111111111111' }]
  ])('refuses %s', (_label, input) => {
    expect(searchClickBodySchema.safeParse(input).success).toBe(false)
  })
})
