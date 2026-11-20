import { Controller, Get, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { ExportContentTypes, ExportFileExtensions } from '@platform/core/exports'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions
} from '../tenancy'
import type { ResolvedTenant } from '../tenancy'

import { marginCsv } from './finance-margin.csv'
import { FinanceMarginService, type MarginView } from './finance-margin.service'
import { type FlowQuery, marginQuerySchema } from './finance-reports.schemas'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

// The margin by product (TDD_18 §10): finance:view_reports to read it, and finance:export besides to take the file. It only reads the
// journal and the orders, and covers the whole organization narrowed to a store when `storeId` is sent (a dimension, not a bound).
@Controller()
export class FinanceMarginController {
  constructor(private readonly margin: FinanceMarginService) {}

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS)
  @NoTenantTransaction(
    'reads the orders of every store of the organization: the service opens the context of the organization itself, because the one of the request holds the store of the header alone'
  )
  @NoStore()
  @Get(ApiRoutes.finance.reports.margin)
  report(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(marginQuerySchema)) query: FlowQuery
  ): Promise<MarginView> {
    return this.margin.margin(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @NoTenantTransaction(
    'reads the orders of every store of the organization: the service opens the context of the organization itself, because the one of the request holds the store of the header alone'
  )
  @Get(ApiRoutes.finance.reports.marginCsv)
  async csv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(marginQuerySchema)) query: FlowQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const rows = await this.margin.marginCsvRows(organization.id, query, actorOf(user, store, req))
    res.setHeader('Content-Type', ExportContentTypes.CSV)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="margin-${query.from}-${query.to}.${ExportFileExtensions.CSV}"`
    )
    // A financial file is not kept by a shared cache
    res.setHeader('Cache-Control', 'no-store')
    return marginCsv(rows)
  }
}
