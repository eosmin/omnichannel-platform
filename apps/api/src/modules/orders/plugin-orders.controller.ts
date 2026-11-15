import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import type { Viewer } from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginViewer, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

import { idSchema, type PluginListOrdersQuery, pluginListOrdersQuerySchema } from './orders.schemas'
import { OrdersService } from './orders.service'
import {
  type PluginOrderDetailView,
  type PluginOrderPage,
  pluginDetailView,
  pluginPageView
} from './orders.views'

// The reading of the orders of the store of the key (Step 5.6 PR E3a), over the service of the orders screen. Both routes take
// `orders:read` and, inside it, ORDERS_VIEW, as the same routes of the screen do. What a plugin gets back is an allowlist
// (`pluginDetailView`, `pluginPageView`): no customer, address, notes, payment proof, shipping data or id of a person of the team,
// because none of those has a scope that was reviewed to open it. The list takes no text search and no customer, guide or carrier
// filter for the same reason. The writes (create, edit, status, confirm, cancel, payment, price decisions) store the id of the
// person who did it, and a plugin has none: they wait for the plugin actor of PR E3b.
@Controller()
export class PluginOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orders.list)
  async list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(pluginListOrdersQuerySchema)) query: PluginListOrdersQuery
  ): Promise<PluginOrderPage> {
    return pluginPageView(await this.orders.list(store.id, query))
  }

  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orders.byId(':id'))
  async get(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', new ZodValidationPipe(idSchema)) orderId: string
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(await this.orders.get(store.id, orderId, viewer.held))
  }
}
