import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequireAnyPermission,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

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
import type { TransferPage, TransferView } from './transfers.views'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The transfers of the organization of the store in X-Store-Id (TDD_16 §1, §6): the permission is the one the caller
// holds in that store, the organization is the one TenantGuard resolved from it, never one from the request. Making,
// changing, dispatching and cancelling ask for inventory:manage_transfers; receiving and closing for
// inventory:receive_transfers; reading for either. What an answer shows of the lines is the stores of the caller.
@Controller()
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @RequireAnyPermission(
    Permissions.INVENTORY_MANAGE_TRANSFERS,
    Permissions.INVENTORY_RECEIVE_TRANSFERS
  )
  @Get(ApiRoutes.transfers.list)
  list(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listTransfersQuerySchema)) query: ListTransfersQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferPage> {
    return this.transfers.list(organization.id, actorOf(user, store, req), query)
  }

  @RequireAnyPermission(
    Permissions.INVENTORY_MANAGE_TRANSFERS,
    Permissions.INVENTORY_RECEIVE_TRANSFERS
  )
  @Get(ApiRoutes.transfers.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) transferId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.get(organization.id, actorOf(user, store, req), transferId)
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Post(ApiRoutes.transfers.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Patch(ApiRoutes.transfers.byId(':id'))
  update(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(updateTransferSchema)) body: UpdateTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.update(organization.id, transferId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Post(ApiRoutes.transfers.dispatch(':id'))
  @HttpCode(HttpStatusCodes.OK)
  dispatch(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) transferId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.dispatch(organization.id, transferId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_RECEIVE_TRANSFERS)
  @Post(ApiRoutes.transfers.receive(':id'))
  @HttpCode(HttpStatusCodes.OK)
  receive(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(receiveTransferSchema)) body: ReceiveTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.receive(organization.id, transferId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_RECEIVE_TRANSFERS)
  @Post(ApiRoutes.transfers.close(':id'))
  @HttpCode(HttpStatusCodes.OK)
  close(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(closeTransferSchema)) body: CloseTransferBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.close(organization.id, transferId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_TRANSFERS)
  @Post(ApiRoutes.transfers.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) transferId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<TransferView> {
    return this.transfers.cancel(organization.id, transferId, actorOf(user, store, req))
  }
}
