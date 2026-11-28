import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type CreateExcludedSubjectPurchaseBody,
  createExcludedSubjectPurchaseSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentOrganization, CurrentStore, RequirePermissions } from '../tenancy'
import type { ResolvedTenant } from '../tenancy'

import {
  type ExcludedSubjectPurchasePage,
  ExcludedSubjectPurchasesService,
  type ExcludedSubjectPurchaseView
} from './excluded-subject-purchases.service'
import {
  idSchema,
  type ListExcludedSubjectPurchasesQuery,
  listExcludedSubjectPurchasesQuerySchema
} from './purchases.schemas'

interface Organization {
  id: string
}

// The purchases from an excluded subject (D20b). Every route asks for the permission that manages purchases: the record holds the identity
// of a natural person, and the answers show it masked. The organization is the guard's, never the body's.
@Controller()
export class ExcludedSubjectPurchasesController {
  constructor(private readonly purchases: ExcludedSubjectPurchasesService) {}

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Get(ApiRoutes.excludedSubjectPurchases.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listExcludedSubjectPurchasesQuerySchema))
    query: ListExcludedSubjectPurchasesQuery
  ): Promise<ExcludedSubjectPurchasePage> {
    return this.purchases.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Get(ApiRoutes.excludedSubjectPurchases.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @Param('id', new ZodValidationPipe(idSchema)) id: string
  ): Promise<ExcludedSubjectPurchaseView> {
    return this.purchases.get(organization.id, id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Post(ApiRoutes.excludedSubjectPurchases.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createExcludedSubjectPurchaseSchema))
    body: CreateExcludedSubjectPurchaseBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ExcludedSubjectPurchaseView> {
    return this.purchases.create(organization.id, body, actorOf(user, store, req))
  }
}
