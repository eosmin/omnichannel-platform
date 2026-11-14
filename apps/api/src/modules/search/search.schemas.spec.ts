import { SearchConfig } from '@platform/core/domain'

import {
  globalSearchQuerySchema,
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
