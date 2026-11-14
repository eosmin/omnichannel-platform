import { SearchConfig } from '@platform/core/domain'

// The text the search may ask the api for: trimmed, at least `MIN_QUERY_LENGTH` characters (counted as the api counts
// them, in code points) and at most `MAX_QUERY_LENGTH`. Null when there is nothing to ask yet: a text the api would
// answer with a 400 is never sent, and one letter would match half the store.
export function readySearchText(text: string): string | null {
  const trimmed = text.trim().replaceAll(/\s+/gu, ' ')
  const length = [...trimmed].length
  if (length < SearchConfig.MIN_QUERY_LENGTH) return null
  return length > SearchConfig.MAX_QUERY_LENGTH
    ? [...trimmed].slice(0, SearchConfig.MAX_QUERY_LENGTH).join('')
    : trimmed
}
