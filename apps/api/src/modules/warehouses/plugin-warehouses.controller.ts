import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentOrganization, CurrentStore, RequirePermissions } from '../tenancy'

import { pluginWarehousePage, pluginWarehouseView } from './plugin-warehouses.views'
import { idSchema, type ListWarehousesQuery, listWarehousesQuerySchema } from './warehouses.schemas'
import { WarehousesService } from './warehouses.service'
import type { WarehousePage, WarehouseView } from './warehouses.views'

const READ = PluginScopes.WAREHOUSES_READ

// The warehouses of the organization of the store of the key, read only (Step 5.6 PR E4a, TDD_16 §1), over the same service as the
// screen: the organization is the one the guard resolved from the key, never one from the request, and a person with INVENTORY_VIEW
// reads the same list. A key is bound to one store, so the links of a warehouse to OTHER stores are never answered
// (`pluginWarehouseView`). The writes (create, change, replace the store links) are not here: their permission is organization-wide
// (ORG_MANAGE_WAREHOUSES), so a key bound to one store would change a warehouse of its siblings; PR E4a-2 decides their reach.
@Controller()
export class PluginWarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.warehouses.list)
  async list(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listWarehousesQuerySchema)) query: ListWarehousesQuery
  ): Promise<WarehousePage> {
    return pluginWarehousePage(await this.warehouses.list(organization.id, query), store.id)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(PluginApiRoutes.warehouses.byId(':id'))
  async get(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @Param('id', new ZodValidationPipe(idSchema)) warehouseId: string
  ): Promise<WarehouseView> {
    return pluginWarehouseView(await this.warehouses.get(organization.id, warehouseId), store.id)
  }
}
