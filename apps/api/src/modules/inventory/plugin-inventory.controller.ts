import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import type { Viewer } from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginViewer, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, mayViewCost, RequirePermissions } from '../tenancy'

import { InventoryQueriesService } from './inventory-queries.service'
import {
  idSchema,
  type KardexQuery,
  kardexQuerySchema,
  type ListLevelsQuery,
  listLevelsQuerySchema,
  type ListMovementsQuery,
  listMovementsQuerySchema,
  type StockSummaryQuery,
  stockSummaryQuerySchema
} from './inventory.schemas'
import type { LevelPage, ProductInventory, StockSummary } from './inventory.views'
import { type PluginMovementPage, pluginMovementPage } from './plugin-inventory.views'

const READ = PluginScopes.INVENTORY_READ

// The stock of the store of the key, read only (Step 5.6 PR E4a), over the same queries as the screen. The cost fields come only
// with PRODUCTS_VIEW_COST, which no scope grants, so a plugin never reads one. A movement is answered without `createdBy`
// (`pluginMovementPage`). The adjustment of stock (`POST /inventory/adjustments`) is not here: the movement stores the id of the
// person who made it, and waits for the plugin actor (PR E4a-2).
@Controller()
export class PluginInventoryController {
  constructor(private readonly queries: InventoryQueriesService) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.inventory.levels)
  levels(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Query(new ZodValidationPipe(listLevelsQuerySchema)) query: ListLevelsQuery
  ): Promise<LevelPage> {
    return this.queries.listLevels(store.id, query, mayViewCost(viewer.held))
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.inventory.summary)
  summary(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(stockSummaryQuerySchema)) query: StockSummaryQuery
  ): Promise<StockSummary> {
    return this.queries.summary(store.id, query.productIds)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.inventory.movements)
  async movements(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Query(new ZodValidationPipe(listMovementsQuerySchema)) query: ListMovementsQuery
  ): Promise<PluginMovementPage> {
    return pluginMovementPage(
      await this.queries.listMovements(store.id, query, mayViewCost(viewer.held))
    )
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.inventory.kardex)
  async kardex(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Query(new ZodValidationPipe(kardexQuerySchema)) query: KardexQuery
  ): Promise<PluginMovementPage> {
    return pluginMovementPage(await this.queries.kardex(store.id, query, mayViewCost(viewer.held)))
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.products.inventory(':id'))
  productInventory(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', new ZodValidationPipe(idSchema)) productId: string
  ): Promise<ProductInventory> {
    return this.queries.productInventory(store.id, productId, mayViewCost(viewer.held))
  }
}
