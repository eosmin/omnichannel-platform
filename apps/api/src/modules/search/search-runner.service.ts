import { Injectable } from '@nestjs/common'

import {
  ProductSearchConfig,
  SearchConfig,
  SearchEntities,
  type SearchTrackedScope,
  SearchTrackedScopes
} from '@platform/core/domain'

import { ProductSearchService } from '../products/product-search.service'
import type { ProductSuggestions } from '../products/products.views'

import { searchableBy } from './search-access'
import { SearchTracker } from './search-tracker.service'
import { SearchService, type SearchViewer } from './search.service'
import type {
  CustomerSearchHit,
  GlobalSearchGroup,
  GlobalSearchResult,
  MessageSearchHit,
  OrderSearchHit,
  SearchResult
} from './search.views'

// What each route of the search runs: the search itself, timed, and the event it leaves in the analytics queue. The
// global search is one event of its own (its scope is `global`), not one per kind it read, so the report of what was
// looked for counts a person's search once. A search that fails leaves no event: it was not performed.
@Injectable()
export class SearchRunner {
  constructor(
    private readonly search: SearchService,
    private readonly products: ProductSearchService,
    private readonly tracker: SearchTracker
  ) {}

  messages(
    storeId: string,
    viewer: SearchViewer,
    params: { q: string; limit: number; conversationId?: string }
  ): Promise<SearchResult<MessageSearchHit>> {
    return this.tracked(storeId, SearchTrackedScopes.MESSAGES, params.q, () =>
      this.search.searchMessages(storeId, viewer, params)
    )
  }

  customers(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<SearchResult<CustomerSearchHit>> {
    return this.tracked(storeId, SearchTrackedScopes.CUSTOMERS, params.q, () =>
      this.search.searchCustomers(storeId, params)
    )
  }

  orders(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<SearchResult<OrderSearchHit>> {
    return this.tracked(storeId, SearchTrackedScopes.ORDERS, params.q, () =>
      this.search.searchOrders(storeId, params)
    )
  }

  // The products are the autocomplete of the catalog (Step 4.1), which has its own ceiling on how many it returns
  productSuggestions(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<ProductSuggestions> {
    return this.tracked(storeId, SearchTrackedScopes.PRODUCTS, params.q, () =>
      this.productsOf(storeId, params)
    )
  }

  // A few hits of each kind the member may search, only the groups with hits. The kinds are read one after the other:
  // they share the connection of the request, so running them together would only queue them.
  async global(storeId: string, viewer: SearchViewer, q: string): Promise<GlobalSearchResult> {
    return this.tracked(storeId, SearchTrackedScopes.GLOBAL, q, async () => {
      const kinds = searchableBy(viewer.held)
      const params = { q, limit: SearchConfig.GLOBAL_SEARCH_PER_GROUP }
      const groups: GlobalSearchGroup[] = []
      if (kinds.has(SearchEntities.CUSTOMERS)) {
        const { hits } = await this.search.searchCustomers(storeId, params)
        if (hits.length > 0) groups.push({ entity: SearchEntities.CUSTOMERS, hits })
      }
      if (kinds.has(SearchEntities.MESSAGES)) {
        const { hits } = await this.search.searchMessages(storeId, viewer, params)
        if (hits.length > 0) groups.push({ entity: SearchEntities.MESSAGES, hits })
      }
      if (kinds.has(SearchEntities.ORDERS)) {
        const { hits } = await this.search.searchOrders(storeId, params)
        if (hits.length > 0) groups.push({ entity: SearchEntities.ORDERS, hits })
      }
      if (kinds.has(SearchEntities.PRODUCTS)) {
        const { data } = await this.productsOf(storeId, params)
        if (data.length > 0) groups.push({ entity: SearchEntities.PRODUCTS, hits: data })
      }
      return { query: q, groups }
    })
  }

  private async tracked<
    T extends { hits?: unknown[]; data?: unknown[]; groups?: { hits: unknown[] }[] }
  >(storeId: string, scope: SearchTrackedScope, q: string, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now()
    const result = await run()
    const count =
      result.groups?.reduce((sum, group) => sum + group.hits.length, 0) ??
      (result.hits ?? result.data ?? []).length
    this.tracker.track(storeId, scope, q, count, startedAt)
    return result
  }

  private productsOf(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<ProductSuggestions> {
    return this.products.search(storeId, {
      q: params.q,
      limit: Math.min(params.limit, ProductSearchConfig.MAX_LIMIT),
      includeArchived: false
    })
  }
}
