import { Controller, Get, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { ExportContentTypes, ExportFileExtensions } from '@platform/core/exports'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentOrganization, CurrentStore, RequirePermissions } from '../tenancy'
import type { ResolvedTenant } from '../tenancy'

import {
  type AgingQuery,
  agingQuerySchema,
  type BalanceSheetQuery,
  balanceSheetQuerySchema,
  type FlowQuery,
  flowQuerySchema
} from './finance-reports.schemas'
import { agingCsv, statementCsv } from './finance-statements.csv'
import {
  type AgingView,
  type BalanceSheetView,
  type CashFlowView,
  FinanceStatementsService,
  type IncomeStatementView
} from './finance-statements.service'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

// What a financial file is told: it is an attachment and no shared cache keeps it
function attachment(res: Response, name: string): void {
  res.setHeader('Content-Type', ExportContentTypes.CSV)
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${ExportFileExtensions.CSV}"`)
  res.setHeader('Cache-Control', 'no-store')
}

// The statements and the lists with age (TDD_18 §10): finance:view_reports to read them, and finance:export besides to take a file. A
// report only reads the journal. They cover the whole organization, narrowed to a store when `storeId` is sent (a dimension of the
// lines, not a bound: the same as the trial balance of 4B.8a).
@Controller()
export class FinanceStatementsController {
  constructor(private readonly statements: FinanceStatementsService) {}

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS)
  @Get(ApiRoutes.finance.reports.incomeStatement)
  incomeStatement(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(flowQuerySchema)) query: FlowQuery
  ): Promise<IncomeStatementView> {
    return this.statements.incomeStatement(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS)
  @Get(ApiRoutes.finance.reports.balanceSheet)
  balanceSheet(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery
  ): Promise<BalanceSheetView> {
    return this.statements.balanceSheet(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS)
  @Get(ApiRoutes.finance.reports.cashFlow)
  cashFlow(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(flowQuerySchema)) query: FlowQuery
  ): Promise<CashFlowView> {
    return this.statements.cashFlow(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS)
  @Get(ApiRoutes.finance.reports.aging)
  aging(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(agingQuerySchema)) query: AgingQuery
  ): Promise<AgingView> {
    return this.statements.aging(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.incomeStatementCsv)
  async incomeStatementCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(flowQuerySchema)) query: FlowQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const rows = await this.statements.incomeStatementCsvRows(
      organization.id,
      query,
      actorOf(user, store, req)
    )
    attachment(res, `income-statement-${query.from}-${query.to}`)
    return statementCsv(rows)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.balanceSheetCsv)
  async balanceSheetCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const rows = await this.statements.balanceSheetCsvRows(
      organization.id,
      query,
      actorOf(user, store, req)
    )
    attachment(res, `balance-sheet-${query.asOf}`)
    return statementCsv(rows)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.cashFlowCsv)
  async cashFlowCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(flowQuerySchema)) query: FlowQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const rows = await this.statements.cashFlowCsvRows(
      organization.id,
      query,
      actorOf(user, store, req)
    )
    attachment(res, `cash-flow-${query.from}-${query.to}`)
    return statementCsv(rows)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.agingCsv)
  async agingCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(agingQuerySchema)) query: AgingQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const rows = await this.statements.agingCsvRows(
      organization.id,
      query,
      actorOf(user, store, req)
    )
    attachment(res, `${query.kind}-aging-${query.asOf}`)
    return agingCsv(query.kind, query.asOf, rows)
  }
}
