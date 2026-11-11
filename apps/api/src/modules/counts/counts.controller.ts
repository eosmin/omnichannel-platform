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

import { CountsApplyService } from './counts-apply.service'
import {
  type CountLinesQuery,
  countLinesQuerySchema,
  type CreateCountBody,
  createCountSchema,
  idSchema,
  type ListCountsQuery,
  listCountsQuerySchema,
  type UpdateCountLinesBody,
  updateCountLinesSchema
} from './counts.schemas'
import { CountsService } from './counts.service'
import type { CountDetailView, CountPage, CountView } from './counts.views'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The physical counts of the organization of the store in X-Store-Id (TDD_16 §1, §6): the permission is the one the caller
// holds in that store, and the organization is the one TenantGuard resolved from it, never one from the request.
// Counting is inventory:manage_counts; applying a count is inventory:apply_counts, which the approver holds without the
// other, so the readings and the way back to counting accept either.
@Controller()
export class CountsController {
  constructor(
    private readonly counts: CountsService,
    private readonly applying: CountsApplyService
  ) {}

  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Get(ApiRoutes.counts.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listCountsQuerySchema)) query: ListCountsQuery
  ): Promise<CountPage> {
    return this.counts.list(organization.id, query)
  }

  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Get(ApiRoutes.counts.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Query(new ZodValidationPipe(countLinesQuerySchema)) query: CountLinesQuery
  ): Promise<CountDetailView> {
    return this.counts.get(organization.id, user.id, countId, query)
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(ApiRoutes.counts.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createCountSchema)) body: CreateCountBody,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.counts.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(ApiRoutes.counts.start(':id'))
  @HttpCode(HttpStatusCodes.OK)
  start(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.counts.start(organization.id, countId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Patch(ApiRoutes.counts.lines(':id'))
  updateLines(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Body(new ZodValidationPipe(updateCountLinesSchema)) body: UpdateCountLinesBody,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.counts.updateLines(organization.id, countId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(ApiRoutes.counts.submit(':id'))
  @HttpCode(HttpStatusCodes.OK)
  submit(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.counts.submit(organization.id, countId, actorOf(user, store, req))
  }

  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Post(ApiRoutes.counts.reopen(':id'))
  @HttpCode(HttpStatusCodes.OK)
  reopen(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.counts.reopen(organization.id, countId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.INVENTORY_APPLY_COUNTS)
  @Post(ApiRoutes.counts.apply(':id'))
  @HttpCode(HttpStatusCodes.OK)
  apply(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.applying.apply(organization.id, countId, actorOf(user, store, req))
  }

  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Post(ApiRoutes.counts.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CountView> {
    return this.counts.cancel(organization.id, countId, actorOf(user, store, req))
  }
}
