import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type AddRemittanceLinesBody,
  addRemittanceLinesSchema,
  type ConfirmRemittanceBody,
  confirmRemittanceSchema,
  type CreateRemittanceBody,
  createRemittanceSchema,
  type CursorPage,
  type RemittancePendingQuery,
  remittancePendingQuerySchema,
  type UpdateRemittanceLineBody,
  updateRemittanceLineSchema,
  type VoidRemittanceBody,
  voidRemittanceSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  type ListRemittancesQuery,
  listRemittancesQuerySchema,
  remittanceIdSchema
} from './remittances.schemas'
import { RemittancesApiService } from './remittances.service'
import type {
  PendingConnectionView,
  RemittanceDetailView,
  RemittanceView
} from './remittances.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(remittanceIdSchema)

// The remittances of cash collected on delivery of the store in X-Store-Id (TDD_17 §4.15, §6). Reading them, and the pending
// list, ask for remittances:view; building a draft, changing its lines, confirming and voiding ask for remittances:manage. The
// store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class RemittancesController {
  constructor(private readonly remittances: RemittancesApiService) {}

  @NoStore()
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(ApiRoutes.remittances.list)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listRemittancesQuerySchema)) query: ListRemittancesQuery
  ): Promise<CursorPage<RemittanceView>> {
    return this.remittances.list(store.id, query)
  }

  // What the carriers still owe, per connection; declared before the route of one remittance, which would take "pending" for an id
  @NoStore()
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(ApiRoutes.remittances.pending)
  pending(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(remittancePendingQuerySchema)) query: RemittancePendingQuery
  ): Promise<PendingConnectionView[]> {
    return this.remittances.pending(store.id, query.connectionId)
  }

  @NoStore()
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(ApiRoutes.remittances.byId(':id'))
  get(
    @CurrentStore() store: Store,
    @Param('id', id()) remittanceId: string
  ): Promise<RemittanceDetailView> {
    return this.remittances.get(store.id, remittanceId)
  }

  // A draft by hand: the connection and, when the agent has them, the lines
  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.list)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createRemittanceSchema)) body: CreateRemittanceBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RemittanceDetailView> {
    return this.remittances.create(store.id, body, actorOf(user, store, req))
  }

  // A draft nobody wants; a confirmed remittance is never deleted (it is voided)
  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Delete(ApiRoutes.remittances.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async discard(
    @CurrentStore() store: Store,
    @Param('id', id()) remittanceId: string
  ): Promise<void> {
    await this.remittances.discard(store.id, remittanceId)
  }

  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.lines(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  addLines(
    @CurrentStore() store: Store,
    @Param('id', id()) remittanceId: string,
    @Body(new ZodValidationPipe(addRemittanceLinesSchema)) body: AddRemittanceLinesBody
  ): Promise<RemittanceDetailView> {
    return this.remittances.addLines(store.id, remittanceId, body)
  }

  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Patch(ApiRoutes.remittances.lineById(':id', ':lineId'))
  updateLine(
    @CurrentStore() store: Store,
    @Param('id', id()) remittanceId: string,
    @Param('lineId', id()) lineId: string,
    @Body(new ZodValidationPipe(updateRemittanceLineSchema)) body: UpdateRemittanceLineBody
  ): Promise<RemittanceDetailView> {
    return this.remittances.updateLine(store.id, remittanceId, lineId, body)
  }

  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.confirm(':id'))
  @HttpCode(HttpStatusCodes.OK)
  confirm(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) remittanceId: string,
    @Body(new ZodValidationPipe(confirmRemittanceSchema)) body: ConfirmRemittanceBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RemittanceDetailView> {
    return this.remittances.confirm(store.id, remittanceId, body, actorOf(user, store, req))
  }

  // Voiding a confirmed remittance is a HIGH-tier action (TDD_09 §11.1): the screen asks twice, and the entry says who did it
  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.void(':id'))
  @HttpCode(HttpStatusCodes.OK)
  void(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) remittanceId: string,
    @Body(new ZodValidationPipe(voidRemittanceSchema)) body: VoidRemittanceBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RemittanceDetailView> {
    return this.remittances.void(store.id, remittanceId, actorOf(user, store, req), body)
  }
}
