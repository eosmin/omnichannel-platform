import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { Viewer } from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  CurrentPluginInstallation,
  CurrentPluginViewer,
  PluginApi
} from '../plugins/plugin-api.decorators'
import { CurrentStore, mayViewCost, pluginActorOf, RequirePermissions } from '../tenancy'

import { InventoryAdjustmentsService } from './inventory-adjustments.service'
import { InventoryQueriesService } from './inventory-queries.service'
import {
  type CreateAdjustmentBody,
  createAdjustmentSchema,
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
import {
  type PluginMovementPage,
  type PluginMovementView,
  pluginMovementPage,
  pluginMovementView
} from './plugin-inventory.views'

const READ = PluginScopes.INVENTORY_READ
const WRITE = PluginScopes.INVENTORY_WRITE

// The stock of the store of the key (Step 5.6 PR E4a), over the same queries as the screen. The cost fields come only
// with PRODUCTS_VIEW_COST, which no scope grants, so a plugin never reads or sets one. A movement is answered without `createdBy` or
// `createdByPluginId` (`pluginMovementPage`). The one write is the adjustment of stock (`POST /inventory/adjustments`, PR E4a-2,
// scope `inventory:write` with the read scope): the movement records the PLUGIN as its author (`createdByPluginId`, the actor of
// PR M1c), never a made-up user, and the audit entry names the installation.
@Controller()
export class PluginInventoryController {
  constructor(
    private readonly queries: InventoryQueriesService,
    private readonly adjustments: InventoryAdjustmentsService
  ) {}

  // 201 for a movement made now, 200 for the answer to a retry of one already made
  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.INVENTORY_VIEW, Permissions.INVENTORY_ADJUST)
  @Post(PluginApiRoutes.inventory.adjustments)
  @HttpCode(HttpStatusCodes.CREATED)
  async adjust(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Body(new ZodValidationPipe(createAdjustmentSchema)) body: CreateAdjustmentBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ movement: PluginMovementView; replayed: boolean }> {
    const result = await this.adjustments.adjust(
      store.id,
      body,
      pluginActorOf(installation, store, req),
      viewer.held
    )
    if (result.replayed) res.status(HttpStatusCodes.OK)
    return { movement: pluginMovementView(result.movement), replayed: result.replayed }
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @NoStore()
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
  @NoStore()
  @Get(PluginApiRoutes.inventory.summary)
  summary(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(stockSummaryQuerySchema)) query: StockSummaryQuery
  ): Promise<StockSummary> {
    return this.queries.summary(store.id, query.productIds)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @NoStore()
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
  @NoStore()
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
  @NoStore()
  @Get(PluginApiRoutes.products.inventory(':id'))
  productInventory(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', new ZodValidationPipe(idSchema)) productId: string
  ): Promise<ProductInventory> {
    return this.queries.productInventory(store.id, productId, mayViewCost(viewer.held))
  }
}
