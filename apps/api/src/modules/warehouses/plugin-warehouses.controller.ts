import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentOrganization, CurrentStore, pluginActorOf, RequirePermissions } from '../tenancy'

import { pluginWarehousePage, pluginWarehouseView } from './plugin-warehouses.views'
import {
  type CreateWarehouseBody,
  createWarehouseSchema,
  idSchema,
  type ListWarehousesQuery,
  listWarehousesQuerySchema,
  type UpdateWarehouseBody,
  updateWarehouseSchema
} from './warehouses.schemas'
import { WarehousesService } from './warehouses.service'
import type { WarehousePage, WarehouseView } from './warehouses.views'

const id = () => new ZodValidationPipe(idSchema)

type Store = { id: string }

const READ = PluginScopes.WAREHOUSES_READ
const WRITE = PluginScopes.WAREHOUSES_WRITE

// The warehouses of the organization of the store of the key (Step 5.6 PR E4a, TDD_16 §1), over the same service as the screen: the
// organization is the one the guard resolved from the key, never one from the request. A key is bound to one store, so the links
// of a warehouse to OTHER stores are never answered (`pluginWarehouseView`). A write takes `warehouses:read` besides, so a 404
// does not show a warehouse the key may not read. Replacing the store links (`PUT /warehouses/:id/stores`) is not here: it moves a
// warehouse between stores of the organization, and a key must not reach a store it is not bound to (PR E4a-2). A write leaves its
// audit entry as the system with the installation in the metadata.
@Controller()
export class PluginWarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.warehouses.list)
  async list(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listWarehousesQuerySchema)) query: ListWarehousesQuery
  ): Promise<WarehousePage> {
    return pluginWarehousePage(await this.warehouses.list(organization.id, query), store.id)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.warehouses.byId(':id'))
  async get(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: Store,
    @Param('id', id()) warehouseId: string
  ): Promise<WarehouseView> {
    return pluginWarehouseView(await this.warehouses.get(organization.id, warehouseId), store.id)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.INVENTORY_VIEW, Permissions.ORG_MANAGE_WAREHOUSES)
  @Post(PluginApiRoutes.warehouses.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: { id: string },
    @Body(new ZodValidationPipe(createWarehouseSchema)) body: CreateWarehouseBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WarehouseView> {
    const created = await this.warehouses.create(
      organization.id,
      body,
      pluginActorOf(installation, store, req)
    )
    return pluginWarehouseView(created, store.id)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.INVENTORY_VIEW, Permissions.ORG_MANAGE_WAREHOUSES)
  @Patch(PluginApiRoutes.warehouses.byId(':id'))
  async update(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: { id: string },
    @Param('id', id()) warehouseId: string,
    @Body(new ZodValidationPipe(updateWarehouseSchema)) body: UpdateWarehouseBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WarehouseView> {
    const updated = await this.warehouses.update(
      organization.id,
      warehouseId,
      body,
      pluginActorOf(installation, store, req)
    )
    return pluginWarehouseView(updated, store.id)
  }
}
