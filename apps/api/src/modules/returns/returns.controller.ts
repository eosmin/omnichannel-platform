import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type CompleteReturnBody,
  completeReturnSchema,
  type ApproveReturnBody,
  approveReturnSchema,
  type CreateReturnBody,
  createReturnSchema,
  type CursorPage,
  type ReceiveReturnBody,
  receiveReturnSchema,
  type ReturnDecisionBody,
  returnDecisionSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { ReturnsService } from '@platform/core/shipping'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { ReturnsQueries } from './returns.queries'
import { type ListReturnsQuery, listReturnsQuerySchema, returnIdSchema } from './returns.schemas'
import type { ReturnView } from './returns.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(returnIdSchema)

// The returns of the store in X-Store-Id (TDD_17 §6). Reading them asks for returns:view; everything that changes one asks for
// returns:manage. The store is the one TenantGuard resolved, never a value of the request. The return leg (a guide made for the
// way back) and the exchange are the work of PR R1b; the reception by scanner, of PR R2.
@Controller()
export class ReturnsController {
  constructor(
    private readonly returns: ReturnsService,
    private readonly queries: ReturnsQueries
  ) {}

  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(ApiRoutes.returns.list)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listReturnsQuerySchema)) query: ListReturnsQuery
  ): Promise<CursorPage<ReturnView>> {
    return this.queries.list(store.id, query)
  }

  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(ApiRoutes.returns.byId(':id'))
  get(@CurrentStore() store: Store, @Param('id', id()) returnId: string): Promise<ReturnView> {
    return this.queries.get(store.id, returnId)
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createReturnSchema)) body: CreateReturnBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .create(store.id, body, actorOf(user, store, req))
      .then(returnId => this.queries.get(store.id, returnId))
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.approve(':id'))
  @HttpCode(HttpStatusCodes.OK)
  approve(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) returnId: string,
    @Body(new ZodValidationPipe(approveReturnSchema.default({}))) body: ApproveReturnBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .approve(store.id, returnId, body, actorOf(user, store, req))
      .then(returnId => this.queries.get(store.id, returnId))
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.reject(':id'))
  @HttpCode(HttpStatusCodes.OK)
  reject(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) returnId: string,
    @Body(new ZodValidationPipe(returnDecisionSchema)) body: ReturnDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .reject(store.id, returnId, actorOf(user, store, req), body.notes)
      .then(returnId => this.queries.get(store.id, returnId))
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) returnId: string,
    @Body(new ZodValidationPipe(returnDecisionSchema)) body: ReturnDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .cancel(store.id, returnId, actorOf(user, store, req), body.notes)
      .then(returnId => this.queries.get(store.id, returnId))
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.inTransit(':id'))
  @HttpCode(HttpStatusCodes.OK)
  inTransit(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) returnId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .markInTransit(store.id, returnId, actorOf(user, store, req))
      .then(returnId => this.queries.get(store.id, returnId))
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.receive(':id'))
  @HttpCode(HttpStatusCodes.OK)
  receive(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) returnId: string,
    @Body(new ZodValidationPipe(receiveReturnSchema)) body: ReceiveReturnBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .receive(store.id, returnId, body, actorOf(user, store, req))
      .then(returnId => this.queries.get(store.id, returnId))
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.complete(':id'))
  @HttpCode(HttpStatusCodes.OK)
  complete(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) returnId: string,
    @Body(new ZodValidationPipe(completeReturnSchema)) body: CompleteReturnBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ReturnView> {
    return this.returns
      .complete(store.id, returnId, body, actorOf(user, store, req))
      .then(returnId => this.queries.get(store.id, returnId))
  }
}
