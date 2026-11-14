import { z } from 'zod'

import { SearchTracking, SearchTrackedScopes } from './search-constants'

// The `data` of a `search.performed` event (TDD_08 §5.6): what the API queues in a TRACK_SEARCH job and the worker
// checks before it writes the row. One definition, so a field added on one side fails to compile on the other. The raw
// text is present only when the search found nothing (the zero-result report); every other search is its hash.
export const searchEventDataSchema = z
  .strictObject({
    queryHash: z.string().regex(new RegExp(`^[0-9a-f]{${SearchTracking.HASH_LENGTH}}$`)),
    scope: z.enum(Object.values(SearchTrackedScopes)),
    resultCount: z.number().int().min(0),
    durationMs: z.number().int().min(0),
    query: z.string().min(1).max(SearchTracking.QUERY_MAX_LENGTH).optional()
  })
  // What was typed to find a person, a conversation or an order is only ever a hash: analytics rows are tied to no
  // customer, so an erasure could not reach a name or a phone left in one. Only the products (the gaps of the catalog)
  // keep the text of a search that found nothing.
  .refine(data => data.query === undefined || data.scope === SearchTrackedScopes.PRODUCTS, {
    message: 'only the text of a product search is kept'
  })
export type SearchEventData = z.infer<typeof searchEventDataSchema>
