import { z } from 'zod'

import { SearchEntities, SearchTracking, SearchTrackedScopes } from './search-constants'

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

// What says which result a person opened, apart from the text: the api reads it from the request and keys the hash itself;
// the worker reads it back with the hash. A search of one kind of thing can only have shown that kind; only the global
// search shows them all.
export const searchClickFields = {
  scope: z.enum(Object.values(SearchTrackedScopes)),
  entity: z.enum(Object.values(SearchEntities)),
  position: z.number().int().min(0).max(SearchTracking.MAX_POSITION)
} as const
export function isConsistentClick(click: { scope: string; entity: string }): boolean {
  return click.scope === SearchTrackedScopes.GLOBAL || click.scope === click.entity
}
export const CLICK_SCOPE_MESSAGE = 'a search of one kind shows only that kind'

// The `data` of a `search.clicked` event: a person opened a result of a search. It carries the hash of the text (so the
// click groups with the searches of the same text), what the search was asked of, the kind of thing opened and its
// place in the list. It never carries the text or the result: analytics rows are tied to no customer.
export const searchClickDataSchema = z
  .strictObject({
    queryHash: z.string().regex(new RegExp(`^[0-9a-f]{${SearchTracking.HASH_LENGTH}}$`)),
    ...searchClickFields
  })
  .refine(isConsistentClick, { message: CLICK_SCOPE_MESSAGE })
export type SearchClickData = z.infer<typeof searchClickDataSchema>
