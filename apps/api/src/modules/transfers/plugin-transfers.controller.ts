import { Controller, Get, Param, Query, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentOrganization, CurrentStore, pluginActorOf, RequireAnyPermission } from '../tenancy'

import {
  type PluginTransferPage,
  pluginTransferPage,
  type PluginTransferView,
  pluginTransferView
} from './plugin-transfers.views'
import { idSchema, type ListTransfersQuery, listTransfersQuerySchema } from './transfers.schemas'
import { TransfersService } from './transfers.service'

const READ = PluginScopes.TRANSFERS_READ

// The transfers between warehouses, read only (Step 5.6 PR E4b, TDD_16 §1, §6), over the same service as the screen. The
// organization is the one the guard resolved from the key, never one from the request. A key is bound to ONE store and holds no
// membership, so the service answers for the plugin actor with that store as the only one it sees: a transfer with no line of the
// store is a transfer that does not exist for it (404), and the lines of other stores are never in an answer. The ids of the people
// who made and sent a transfer are not answered (`plugin-transfers.views.ts`). The writes (create, change, dispatch, receive,
// close, cancel) are not here: each stores the id of a person (`createdBy`, `dispatchedBy`, and the stock movements it makes) and
// moves the stock of every line, so they wait for PR E4b-2 and the plugin actor.
@Controller()
export class PluginTransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @PluginApi(READ)
  @RequireAnyPermission(
    Permissions.INVENTORY_MANAGE_TRANSFERS,
    Permissions.INVENTORY_RECEIVE_TRANSFERS
  )
  @Get(PluginApiRoutes.transfers.list)
  async list(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Query(new ZodValidationPipe(listTransfersQuerySchema)) query: ListTransfersQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferPage> {
    return pluginTransferPage(
      await this.transfers.list(organization.id, pluginActorOf(installation, store, req), query)
    )
  }

  @PluginApi(READ)
  @RequireAnyPermission(
    Permissions.INVENTORY_MANAGE_TRANSFERS,
    Permissions.INVENTORY_RECEIVE_TRANSFERS
  )
  @Get(PluginApiRoutes.transfers.byId(':id'))
  async get(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('id', new ZodValidationPipe(idSchema)) transferId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.get(organization.id, pluginActorOf(installation, store, req), transferId)
    )
  }
}
