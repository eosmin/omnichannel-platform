import { Controller, Get, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { Viewer } from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginViewer, PluginApi, PluginHoldsScope } from '../plugins/plugin-api.decorators'
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
import {
  type CustomerSearchHit,
  type MessageSearchHit,
  type OrderSearchHit,
  type PluginMessageSearchHit,
  type PluginOrderSearchHit,
  type SearchResult,
  withoutMessageCustomer,
  withoutOrderCustomer
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

  // Conversations AND messages, as for a person. The id and the name of the customer are answered only to a key that also holds
  // `customers:read`. The conversation of a hit tells a key without it the id of the customer and nothing else of them (PR
  // plugin-conversations-identity), so the id is not a secret between the two routes: the name, the handle and the photo are.
  @PluginApi(PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_READ)
  @RequirePermissions(...MessageSearchPermissions)
  @NoStore()
  @Get(PluginApiRoutes.search.messages)
  async messages(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @PluginHoldsScope(PluginScopes.CUSTOMERS_READ) holdsCustomers: boolean,
    @Query(new ZodValidationPipe(searchMessagesQuerySchema)) query: SearchMessagesQuery
  ): Promise<SearchResult<MessageSearchHit | PluginMessageSearchHit>> {
    const result = await this.runner.messages(store.id, viewer, query, PASSIVE)
    return holdsCustomers ? result : { ...result, hits: result.hits.map(withoutMessageCustomer) }
  }

  @PluginApi(PluginScopes.CUSTOMERS_READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.search.customers)
  customers(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<SearchResult<CustomerSearchHit>> {
    return this.runner.customers(store.id, query, PASSIVE)
  }

  // An order is found by its number. Who it is for (the name and the phone of the customer, and the id and the name in the hit)
  // is what `customers:read` guards, as in the orders of the plugin API: a key without it neither searches by those nor gets them.
  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.search.orders)
  async orders(
    @CurrentStore() store: { id: string },
    @PluginHoldsScope(PluginScopes.CUSTOMERS_READ) holdsCustomers: boolean,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<SearchResult<OrderSearchHit | PluginOrderSearchHit>> {
    const result = await this.runner.orders(store.id, query, PASSIVE, holdsCustomers)
    return holdsCustomers ? result : { ...result, hits: result.hits.map(withoutOrderCustomer) }
  }

  @PluginApi(PluginScopes.PRODUCTS_READ)
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.search.products)
  products(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery
  ): Promise<ProductSuggestions> {
    return this.runner.productSuggestions(store.id, query, PASSIVE)
  }
}
