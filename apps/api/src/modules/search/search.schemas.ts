import { z } from 'zod'

import { foldForSearch, plainName, SearchConfig, uuidSchema } from '@platform/core/domain'

// The text of a search, read as the names it is compared with were stored: NFC, every kind of space one space. A
// text shorter than the minimum (in characters, after trimming) or longer than the maximum is a 400: the palette does
// not ask before the minimum, and one letter would match half the store.
const queryText = z
  .string()
  // Cheap bound before anything walks the text: a character is at most two UTF-16 units
  .max(SearchConfig.MAX_QUERY_LENGTH * 2)
  .transform(plainName)
  .refine(value => [...value].length >= SearchConfig.MIN_QUERY_LENGTH, {
    message: `at least ${SearchConfig.MIN_QUERY_LENGTH} characters`
  })
  .refine(value => [...value].length <= SearchConfig.MAX_QUERY_LENGTH, {
    message: `at most ${SearchConfig.MAX_QUERY_LENGTH} characters`
  })
  .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })
  // Nothing but combining marks is no text to look for: it would fold to nothing and match everything
  .refine(value => foldForSearch(value).trim() !== '', { message: 'has no text to search' })

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(SearchConfig.MAX_LIMIT)
  .default(SearchConfig.DEFAULT_LIMIT)

// The global search asks for the text only: how many of each group is the platform's call
export const globalSearchQuerySchema = z.strictObject({ q: queryText })
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>

export const searchQuerySchema = z.strictObject({ q: queryText, limit })
export type SearchQuery = z.infer<typeof searchQuerySchema>

// The messages can be searched inside one conversation (the search of the thread)
export const searchMessagesQuerySchema = z.strictObject({
  q: queryText,
  limit,
  conversationId: uuidSchema.optional()
})
export type SearchMessagesQuery = z.infer<typeof searchMessagesQuerySchema>
