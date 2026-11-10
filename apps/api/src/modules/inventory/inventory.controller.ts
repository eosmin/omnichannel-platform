import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

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
  listMovementsQuerySchema
} from './inventory.schemas'
import type { AdjustmentView, LevelPage, MovementPage, ProductInventory } from './inventory.views'

const id = () => new ZodValidationPipe(idSchema)
const mayViewCost = (held: readonly Permission[]): boolean =>
  held.includes(Permissions.PRODUCTS_VIEW_COST)

// The stock of the store in X-Store-Id. Reading asks for inventory:view, an adjustment for inventory:adjust; the cost
// fields come only with products:view_cost. The warehouses themselves (organization scope) are their own routes.
@Controller()
export class InventoryController {
  constructor(
    private readonly queries: InventoryQueriesService,
    private readonly adjustments: InventoryAdjustmentsService
  ) {}

  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(ApiRoutes.inventory.levels)
  levels(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(listLevelsQuerySchema)) query: ListLevelsQuery
  ): Promise<LevelPage> {
    return this.queries.listLevels(store.id, query, mayViewCost(held))
  }

  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(ApiRoutes.inventory.movements)
  movements(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(listMovementsQuerySchema)) query: ListMovementsQuery
  ): Promise<MovementPage> {
    return this.queries.listMovements(store.id, query, mayViewCost(held))
  }

  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(ApiRoutes.inventory.kardex)
  kardex(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(kardexQuerySchema)) query: KardexQuery
  ): Promise<MovementPage> {
    return this.queries.kardex(store.id, query, mayViewCost(held))
  }

  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(ApiRoutes.products.inventory(':id'))
  productInventory(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) productId: string
  ): Promise<ProductInventory> {
    return this.queries.productInventory(store.id, productId, mayViewCost(held))
  }

  // 201 for a movement made now, 200 for the answer to a retry of one already made
  @RequirePermissions(Permissions.INVENTORY_ADJUST)
  @Post(ApiRoutes.inventory.adjustments)
  @HttpCode(HttpStatusCodes.CREATED)
  async adjust(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createAdjustmentSchema)) body: CreateAdjustmentBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<AdjustmentView> {
    const result = await this.adjustments.adjust(store.id, body, actorOf(user, store, req), held)
    if (result.replayed) res.status(HttpStatusCodes.OK)
    return result
  }
}
