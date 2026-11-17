import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'
import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type EndFiscalContingencyBody,
  endFiscalContingencySchema,
  type EnterFiscalContingencyBody,
  enterFiscalContingencySchema,
  fiscalIdSchema,
  FiscalLimits
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { FiscalContingencyService, type FiscalContingencyView } from '@platform/fiscal/runtime'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const listQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FiscalLimits.LIST_MAX_PAGE_SIZE)
    .default(FiscalLimits.LIST_PAGE_SIZE)
})

// The contingency of the issuer of the organization (Step 4B.7c-7, TDD_18 §8.3): the time the authority cannot be reached and documents are
// made in the deferred model. Organization-scoped like the rest of the fiscal documents, read from the store of X-Store-Id. No route
// carries a document, a receiver or an answer of the authority: the views are states and counts.
@Controller()
export class FiscalContingencyController {
  constructor(private readonly contingencies: FiscalContingencyService) {}

  // The open contingency, or null
  @RequirePermissions(Permissions.FISCAL_VIEW)
  @Get(ApiRoutes.fiscal.contingency.current)
  async current(
    @CurrentOrganization() organization: Organization
  ): Promise<{ data: FiscalContingencyView | null }> {
    return { data: await this.contingencies.current(organization.id) }
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @Get(ApiRoutes.fiscal.contingency.list)
  async list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.output<typeof listQuerySchema>
  ): Promise<{ data: FiscalContingencyView[] }> {
    return { data: await this.contingencies.list(organization.id, query.limit) }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Post(ApiRoutes.fiscal.contingency.current)
  @HttpCode(HttpStatusCodes.CREATED)
  async enter(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(enterFiscalContingencySchema)) body: EnterFiscalContingencyBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalContingencyView }> {
    return {
      data: await this.contingencies.enter(organization.id, body, actorOf(user, store, req))
    }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Post(ApiRoutes.fiscal.contingency.end)
  @HttpCode(HttpStatusCodes.OK)
  async end(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(endFiscalContingencySchema)) body: EndFiscalContingencyBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalContingencyView }> {
    return {
      data: await this.contingencies.end(organization.id, body, actorOf(user, store, req))
    }
  }

  // An ended contingency whose event was not taken is reported again
  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Post(ApiRoutes.fiscal.contingency.report(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async reportAgain(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(fiscalIdSchema)) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalContingencyView }> {
    return {
      data: await this.contingencies.reportAgain(organization.id, id, actorOf(user, store, req))
    }
  }
}
