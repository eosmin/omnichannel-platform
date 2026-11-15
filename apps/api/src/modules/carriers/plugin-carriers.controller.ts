import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { CursorPage } from '@platform/core/domain'
import { ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

import {
  connectionIdSchema,
  type ListCarriersQuery,
  listCarriersQuerySchema
} from './carrier-connections.schemas'
import { CarrierConnectionsService } from './carrier-connections.service'
import {
  type ListUnmappedStatusesQuery,
  listUnmappedStatusesQuerySchema
} from './carrier-status-mappings.schemas'
import { CarrierStatusMappingsService } from './carrier-status-mappings.service'
import {
  type PluginCarrierConnectionView,
  type PluginCarrierRegistryEntry,
  pluginCarrierConnection,
  pluginCarrierRegistryEntry,
  type PluginStatusCatalogEntry,
  pluginStatusCatalogEntry,
  type PluginUnmappedStatusView,
  pluginUnmappedStatus
} from './plugin-carriers.views'

const READ = PluginScopes.CARRIERS_READ
const id = () => new ZodValidationPipe(connectionIdSchema)

// The carrier connections of the store of the key, read only (Step 5.6 PR E5, TDD_17 §6), over the same services as the screen. The
// credentials and the webhook secret never leave the platform: not in an answer, and not as a flag that they exist, and neither do
// the commission and the rates agreed with the carrier (`plugin-carriers.views.ts`). Connecting, editing, testing, rotating the
// secret and disconnecting are the owner's (SETTINGS_MANAGE_CARRIERS: no scope grants it, so they have no plugin route), and neither
// does the table that maps a carrier's statuses. The prepaid balance of guides is not here either (TDD_17 §4.16: a person's
// permission of its own). The store is the one the key is bound to, so a connection of another store is a 404.
@Controller()
export class PluginCarriersController {
  constructor(
    private readonly connections: CarrierConnectionsService,
    private readonly mappings: CarrierStatusMappingsService
  ) {}

  // Declared before the routes with an id: `registry` is not the id of a connection
  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.carriers.registry)
  async registry(@CurrentStore() store: { id: string }): Promise<PluginCarrierRegistryEntry[]> {
    return (await this.connections.registryOf(store.id)).map(pluginCarrierRegistryEntry)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.carriers.list)
  async list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listCarriersQuerySchema)) query: ListCarriersQuery
  ): Promise<CursorPage<PluginCarrierConnectionView>> {
    const page = await this.connections.list(store.id, query)
    return { ...page, data: page.data.map(pluginCarrierConnection) }
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.carriers.byId(':id'))
  async get(
    @CurrentStore() store: { id: string },
    @Param('id', id()) connectionId: string
  ): Promise<PluginCarrierConnectionView> {
    return pluginCarrierConnection(await this.connections.get(store.id, connectionId))
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.carriers.statusCatalog(':id'))
  async statusCatalog(
    @CurrentStore() store: { id: string },
    @Param('id', id()) connectionId: string
  ): Promise<PluginStatusCatalogEntry[]> {
    return (await this.mappings.catalog(store.id, connectionId)).map(pluginStatusCatalogEntry)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.carriers.unmappedStatuses(':id'))
  async unmappedStatuses(
    @CurrentStore() store: { id: string },
    @Param('id', id()) connectionId: string,
    @Query(new ZodValidationPipe(listUnmappedStatusesQuerySchema)) query: ListUnmappedStatusesQuery
  ): Promise<CursorPage<PluginUnmappedStatusView>> {
    const page = await this.mappings.listUnmapped(store.id, connectionId, query)
    return { ...page, data: page.data.map(pluginUnmappedStatus) }
  }
}
