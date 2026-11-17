import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'

import type { ProductSuggestions } from '../products/products.views'
import {
  CurrentPermissions,
  CurrentStore,
  RequireAnyPermission,
  RequirePermissions
} from '../tenancy'

import { GlobalSearchPermissions, MessageSearchPermissions } from './search-access'
import { SearchRunner } from './search-runner.service'
import {
  type GlobalSearchQuery,
  globalSearchQuerySchema,
  type SearchClickBody,
  searchClickBodySchema,
  type SearchMessagesQuery,
  searchMessagesQuerySchema,
  type SearchQuery,
  searchQuerySchema
} from './search.schemas'
import type {
  CustomerSearchHit,
  GlobalSearchResult,
  MessageSearchHit,
  OrderSearchHit,
  SearchResult
} from './search.views'

// The search of the store in X-Store-Id. Each route asks for the permission of what it searches (the messages, for
// the conversations and the messages they hold), and the global one for any of them: it answers with the groups the
// member may search and leaves out the rest.
@Controller()
export class SearchController {
  constructor(private readonly runner: SearchRunner) {}

  @RequireAnyPermission(...GlobalSearchPermissions)
  @NoStore()
  @Get(ApiRoutes.search.global)
  global(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(globalSearchQuerySchema)) query: GlobalSearchQuery
  ): Promise<GlobalSearchResult> {
    return this.runner.global(store.id, { userId: user.id, held }, query.q, query.passive)
  }

  // The result a person opened, for the report of what was searched. The answer is empty: the event is queued and the
  // click is never worth a wait. The runner checks the kind of result against what the member may search.
  @RequireAnyPermission(...GlobalSearchPermissions)
  @NoStore()
  @Post(ApiRoutes.search.clicks)
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  click(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(searchClickBodySchema)) body: SearchClickBody
  ): void {
    this.runner.recordClick(store.id, held, body)
  }

  @RequirePermissions(...MessageSearchPermissions)
  @NoStore()
  @Get(ApiRoutes.search.messages)
  messages(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(searchMessagesQuerySchema)) query: SearchMessagesQuery
  ): Promise<SearchResult<MessageSearchHit>> {
    return this.runner.messages(store.id, { userId: user.id, held }, query)
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @NoStore()
  @Get(ApiRoutes.search.customers)
  customers(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<SearchResult<CustomerSearchHit>> {
    return this.runner.customers(store.id, query)
  }

  @RequirePermissions(Permissions.ORDERS_VIEW)
  @NoStore()
  @Get(ApiRoutes.search.orders)
  orders(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<SearchResult<OrderSearchHit>> {
    return this.runner.orders(store.id, query, false, true)
  }

  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @NoStore()
  @Get(ApiRoutes.search.products)
  products(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<ProductSuggestions> {
    return this.runner.productSuggestions(store.id, query)
  }
}
