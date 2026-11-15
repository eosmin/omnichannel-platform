import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import {
  CurrentOrganization,
  CurrentStore,
  pluginActorOf,
  RequireAnyPermission,
  RequirePermissions
} from '../tenancy'

import {
  type PluginTransferPage,
  pluginTransferPage,
  type PluginTransferView,
  pluginTransferView
} from './plugin-transfers.views'
import {
  type CloseTransferBody,
  closeTransferSchema,
  type CreateTransferBody,
  createTransferSchema,
  idSchema,
  type ListTransfersQuery,
  listTransfersQuerySchema,
  type ReceiveTransferBody,
  receiveTransferSchema,
  type UpdateTransferBody,
  updateTransferSchema
} from './transfers.schemas'
import { TransfersService } from './transfers.service'

const READ = PluginScopes.TRANSFERS_READ
const WRITE = PluginScopes.TRANSFERS_WRITE
const RECEIVE = PluginScopes.TRANSFERS_RECEIVE

type Installation = { id: string; pluginId: string }
type Organization = { id: string }
type Store = { id: string }

const id = () => new ZodValidationPipe(idSchema)

// The transfers between warehouses (Step 5.6 PR E4b reads them, PR E4b-2 writes them; TDD_16 §1, §6), over the same service as the
// screen. The organization is the one the guard resolved from the key, never one from the request. A key is bound to ONE store and
// holds no membership, so the service answers for the plugin actor with that store as the only one it sees: a transfer with no line
// of the store is a transfer that does not exist for it (404), and the lines of other stores are never in an answer.
//
// The writes: each route names its own scope AND `transfers:read` (what it answers is the transfer as a plugin reads it, and the
// guard needs every scope of the route). `transfers:write` makes, changes, dispatches and cancels (inventory:manage_transfers);
// `transfers:receive` receives and closes (inventory:receive_transfers), a scope of its own as who sends does not receive. A plugin
// makes a transfer of the lines of its store only, and writes only a transfer whose EVERY line is of its store (dispatching and
// cancelling move the stock of every line, receiving and closing decide for the units of every line): one that spans a sibling store
// is read only to it (409). The movements of stock it writes, the transfer and the audit entry name the plugin (`ActorIdentity`,
// never a made-up user). The ids of the people and of the plugin behind a record are not answered (`plugin-transfers.views.ts`).
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

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Post(PluginApiRoutes.transfers.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.create(organization.id, body, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Patch(PluginApiRoutes.transfers.byId(':id'))
  async update(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(updateTransferSchema)) body: UpdateTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.update(
        organization.id,
        transferId,
        body,
        pluginActorOf(installation, store, req)
      )
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Post(PluginApiRoutes.transfers.dispatch(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async dispatch(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) transferId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.dispatch(
        organization.id,
        transferId,
        pluginActorOf(installation, store, req)
      )
    )
  }

  @PluginApi(RECEIVE, READ)
  @RequirePermissions(Permissions.INVENTORY_RECEIVE_TRANSFERS)
  @Post(PluginApiRoutes.transfers.receive(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async receive(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(receiveTransferSchema)) body: ReceiveTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.receive(
        organization.id,
        transferId,
        body,
        pluginActorOf(installation, store, req)
      )
    )
  }

  @PluginApi(RECEIVE, READ)
  @RequirePermissions(Permissions.INVENTORY_RECEIVE_TRANSFERS)
  @Post(PluginApiRoutes.transfers.close(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async close(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(closeTransferSchema)) body: CloseTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.close(
        organization.id,
        transferId,
        body,
        pluginActorOf(installation, store, req)
      )
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Post(PluginApiRoutes.transfers.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async cancel(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) transferId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginTransferView> {
    return pluginTransferView(
      await this.transfers.cancel(
        organization.id,
        transferId,
        pluginActorOf(installation, store, req)
      )
    )
  }
}
