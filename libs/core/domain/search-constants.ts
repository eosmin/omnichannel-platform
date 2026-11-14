// Global search (Step 5.1, TDD_08 §5). The kinds of thing a search finds, its limits, and what each search
// leaves in the analytics queue (TDD_08 §5.6).

export const SearchEntities = {
  MESSAGES: 'messages',
  CUSTOMERS: 'customers',
  ORDERS: 'orders',
  PRODUCTS: 'products'
} as const
export type SearchEntity = (typeof SearchEntities)[keyof typeof SearchEntities]

export const SearchConfig = {
  // Characters, after trimming. A shorter text is a 400 here (the palette does not ask before the minimum)
  MIN_QUERY_LENGTH: 2,
  MAX_QUERY_LENGTH: 200,
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 100,
  // A name with a typo still counts when its trigram similarity to the text is above this
  SIMILARITY_THRESHOLD: 0.3,
  SNIPPET_MAX_WORDS: 20,
  SNIPPET_MIN_WORDS: 5,
  DEBOUNCE_MS: 250,
  // Hits of each group of the global search
  GLOBAL_SEARCH_PER_GROUP: 5,
  // The newest messages that match a text are ranked; ranking reads and parses the text of each one again, so a word
  // of every conversation ("pedido") must not ask it of every match
  MESSAGE_CANDIDATES: 500,
  // A digit run shorter than this is not looked for in phones: three digits match half the book
  MIN_PHONE_DIGITS: 4
} as const

// The text language of the generated search columns (TDD_01 §5). The configuration is spliced into the
// statement as a literal because `websearch_to_tsquery` and `ts_headline` take a `regconfig`, and a bind
// parameter arrives as `text`. Nothing a user typed is ever part of it.
export const SearchLanguage = 'spanish' as const

// The marks around a match in a snippet. The web draws them with these, and escapes every other character
// of the snippet: the text of a message is the customer's, never markup.
export const SearchSnippetMarks = { START: '<mark>', STOP: '</mark>' } as const

// The results page (Step 5.1): the parameters of its address, and what it can be narrowed to. `all` is the global
// search; the others are the route of one kind of thing, which asks for more hits of it.
export const SearchPageParams = { QUERY: 'q', SCOPE: 'scope' } as const
export const SearchPageScopes = { ALL: 'all', ...SearchEntities } as const
export type SearchPageScope = (typeof SearchPageScopes)[keyof typeof SearchPageScopes]

// What a tracked search was asked of: one kind of thing, or all of them at once (the global search)
export const SearchTrackedScopes = { ...SearchEntities, GLOBAL: 'global' } as const
export type SearchTrackedScope = (typeof SearchTrackedScopes)[keyof typeof SearchTrackedScopes]

// What a search leaves in the analytics queue as `search.performed` (TDD_08 §5.6). The raw text is kept
// for the zero-result report only (what people looked for and did not find), capped like the query.
export const SearchTracking = {
  // A hash of the folded text, so the repeated searches of one text group without storing every text
  HASH_LENGTH: 16,
  QUERY_MAX_LENGTH: 200,
  // A run of this many digits in a text is a phone number, a document or an account: such a text is never kept
  PERSONAL_DIGITS: 7,
  // Events that may wait for the queue at once; past it they are dropped
  MAX_IN_FLIGHT: 200
} as const

// The injection token of the secret that keys the hash of a search text (what a search leaves in analytics): a hash with
// no key could be rebuilt from a guessed phone number or email, and analytics rows outlive any erasure. The value is
// read from the validated env by `SearchPlatformModule`; the token lives here so that what uses it imports no env.
export const SEARCH_HASH_KEY = Symbol('SEARCH_HASH_KEY')
