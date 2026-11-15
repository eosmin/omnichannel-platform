import { Controller, Get, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import type { Viewer } from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginViewer, PluginApi } from '../plugins/plugin-api.decorators'
import type { ProductSuggestions } from '../products/products.views'
import { CurrentStore, RequirePermissions } from '../tenancy'

import { MessageSearchPermissions } from './search-access'
import { SearchRunner } from './search-runner.service'
import {
  type SearchMessagesQuery,
  searchMessagesQuerySchema,
  type SearchQuery,
  searchQuerySchema
} from './search.schemas'
import type {
  CustomerSearchHit,
  MessageSearchHit,
  OrderSearchHit,
  SearchResult
} from './search.views'

// What a plugin searches is not what the team looked for: the report of searches does not count it
const PASSIVE = true

// The four searches of the store of the key (Step 5.6 PR E1), over the runner of the inbox: each takes the scope of what it
// searches and, inside it, the permission the same route of the inbox asks for. The global search and the record of a click are
// for a person at a screen and have no route here. The messages are searched as the viewer `plugin:<installation id>`, who sees what
// its permissions allow and never a conversation assigned to a person it is not.
@Controller()
export class PluginSearchController {
  constructor(private readonly runner: SearchRunner) {}

  // Conversations AND messages, as for a person
  @PluginApi(PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_READ)
  @RequirePermissions(...MessageSearchPermissions)
  @Get(PluginApiRoutes.search.messages)
  messages(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Query(new ZodValidationPipe(searchMessagesQuerySchema)) query: SearchMessagesQuery
  ): Promise<SearchResult<MessageSearchHit>> {
    return this.runner.messages(store.id, viewer, query, PASSIVE)
  }

  @PluginApi(PluginScopes.CUSTOMERS_READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(PluginApiRoutes.search.customers)
  customers(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<SearchResult<CustomerSearchHit>> {
    return this.runner.customers(store.id, query, PASSIVE)
  }

  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.search.orders)
  orders(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<SearchResult<OrderSearchHit>> {
    return this.runner.orders(store.id, query, PASSIVE)
  }

  @PluginApi(PluginScopes.PRODUCTS_READ)
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(PluginApiRoutes.search.products)
  products(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<ProductSuggestions> {
    return this.runner.productSuggestions(store.id, query, PASSIVE)
  }
}
