import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { CursorPage } from '@platform/core/domain'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { PickupManifest } from '@platform/core/shipping'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

import { type ListPickupsQuery, listPickupsQuerySchema, pickupIdSchema } from './pickups.schemas'
import { PickupsApiService } from './pickups.service'
import {
  type PluginPickupView,
  pluginPickupManifest,
  pluginPickupView
} from './plugin-pickups.views'

const READ = PluginScopes.PICKUPS_READ

// The pickups of the store of the key, read only (Step 5.6 PR E5, TDD_17 §4.10, §6), over the same service as the screen. The store
// is the one the key is bound to. The person who asked for a pickup is not answered. Asking for one, adding or taking out a guide,
// confirming and cancelling are promises made to a carrier in the name of a person: they wait for PR E5-2.
@Controller()
export class PluginPickupsController {
  constructor(private readonly pickups: PickupsApiService) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.pickups.list)
  async list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listPickupsQuerySchema)) query: ListPickupsQuery
  ): Promise<CursorPage<PluginPickupView>> {
    const page = await this.pickups.list(store.id, query)
    return { ...page, data: page.data.map(pluginPickupView) }
  }

  // The list for the courier names the recipients and carries the guide, shipment and order of every parcel, so it takes
  // `customers:read` and `shipments:read` too (the events tie those fields to the same scopes): a key without them gets a 403. No
  // shared cache keeps it, as on the screen.
  @NoStore()
  @PluginApi(READ, PluginScopes.CUSTOMERS_READ, PluginScopes.SHIPMENTS_READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW, Permissions.CUSTOMERS_VIEW)
  @Get(PluginApiRoutes.pickups.manifest(':id'))
  async manifest(
    @CurrentStore() store: { id: string },
    @Param('id', new ZodValidationPipe(pickupIdSchema)) pickupId: string
  ): Promise<PickupManifest> {
    return pluginPickupManifest(await this.pickups.manifest(store.id, pickupId))
  }
}
