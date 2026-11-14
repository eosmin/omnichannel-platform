import type { SearchEntities } from '@platform/core/domain'

import type { ProductSuggestion } from '../products/products.views'

// The message that matched. `snippet` is the text around the match with the matched words between the marks of
// `SearchSnippetMarks`; it is the customer's text, so whoever draws it escapes everything but those marks.
export interface MessageSearchHit {
  id: string
  conversationId: string
  type: string
  createdAt: string
  customerId: string
  customerName: string | null
  snippet: string
}

export interface CustomerSearchHit {
  id: string
  name: string | null
  email: string | null
  phone: string | null
}

export interface OrderSearchHit {
  id: string
  orderNumber: string
  status: string
  totalCents: number
  currency: string
  createdAt: string
  customerId: string
  customerName: string | null
}

// `hasMore`: the page came back full, so there may be more under the same text
export interface SearchResult<T> {
  query: string
  hits: T[]
  hasMore: boolean
}

export type GlobalSearchGroup =
  | { entity: typeof SearchEntities.MESSAGES; hits: MessageSearchHit[] }
  | { entity: typeof SearchEntities.CUSTOMERS; hits: CustomerSearchHit[] }
  | { entity: typeof SearchEntities.ORDERS; hits: OrderSearchHit[] }
  | { entity: typeof SearchEntities.PRODUCTS; hits: ProductSuggestion[] }

export interface GlobalSearchResult {
  query: string
  // Only the groups that have hits, and only the kinds of thing the caller may read
  groups: GlobalSearchGroup[]
}
