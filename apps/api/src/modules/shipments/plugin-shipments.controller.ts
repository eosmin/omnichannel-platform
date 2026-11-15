import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

import {
  type PluginShipmentDetailView,
  type PluginShipmentPage,
  pluginShipmentDetail,
  pluginShipmentPage
} from './plugin-shipments.views'
import {
  type ListShipmentsQuery,
  listShipmentsQuerySchema,
  shipmentIdSchema
} from './shipments.schemas'
import { ShipmentsService } from './shipments.service'

const READ = PluginScopes.SHIPMENTS_READ

// The shipments of the store of the key, read only (Step 5.6 PR E5, TDD_17 §4.1, §6), over the same service as the screen. The
// store is the one the key is bound to, never one of the request, so a shipment of another store is a 404. The money of the carrier
// and the person who made the guide are not answered (`plugin-shipments.views.ts`). Not here, and left to PR E5-2: every route that
// writes (a guide spends the prepaid balance of the carrier and stores the id of a person; a status, a cancellation, a check and a
// void move the shipment and the order), and the two that need `shipping:manage` to read (the link of a label, good for minutes,
// and the state of a run of labels, which is its requester's alone).
@Controller()
export class PluginShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.shipments.list)
  async list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listShipmentsQuerySchema)) query: ListShipmentsQuery
  ): Promise<PluginShipmentPage> {
    return pluginShipmentPage(await this.shipments.list(store.id, query))
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(PluginApiRoutes.shipments.byId(':id'))
  async get(
    @CurrentStore() store: { id: string },
    @Param('id', new ZodValidationPipe(shipmentIdSchema)) shipmentId: string
  ): Promise<PluginShipmentDetailView> {
    return pluginShipmentDetail(await this.shipments.get(store.id, shipmentId))
  }
}
