import { Readable } from 'node:stream'

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile
} from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ExportContentTypes, ExportFileExtensions } from '@platform/core/exports'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { type ChainVerification, FinanceChainService } from './finance-chain.service'
import { FinanceCloseService } from './finance-close.service'
import { journalCsvHeader, journalCsvRows, ledgerCsv, trialBalanceCsv } from './finance-reports.csv'
import {
  type JournalCsvQuery,
  journalCsvQuerySchema,
  type LedgerCsvQuery,
  ledgerCsvQuerySchema,
  type LedgerQuery,
  ledgerQuerySchema,
  type ReopenPeriodBody,
  reopenPeriodSchema,
  type TrialBalanceQuery,
  trialBalanceCsvQuerySchema,
  trialBalanceQuerySchema
} from './finance-reports.schemas'
import {
  FinanceReportsService,
  type LedgerView,
  type TrialBalanceView
} from './finance-reports.service'
import { idSchema } from './finance.schemas'
import type { PeriodView } from './finance.views'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// What a financial file is told: it is an attachment and no shared cache keeps it
function attachment(res: Response, name: string): void {
  res.setHeader('Content-Type', ExportContentTypes.CSV)
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${ExportFileExtensions.CSV}"`)
  res.setHeader('Cache-Control', 'no-store')
}

// The close of a month, the reports of the books and the files an auditor takes out (TDD_18 §5, §10, §11). Closing and reopening ask for
// finance:close_periods; the trial balance for finance:view; the ledger of an account and every file for what they show (the journal
// for finance:view_journal, a file also for finance:export). Every file and every check leaves an audit row.
@Controller()
export class FinanceReportsController {
  constructor(
    private readonly close: FinanceCloseService,
    private readonly reports: FinanceReportsService,
    private readonly chain: FinanceChainService
  ) {}

  // HIGH tier of DestructiveActionTiers (CLOSE_FISCAL_PERIOD): the interface asks before it sends this
  @RequirePermissions(Permissions.FINANCE_CLOSE_PERIODS)
  @Post(ApiRoutes.finance.periods.close(':id'))
  @HttpCode(HttpStatusCodes.OK)
  closePeriod(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) periodId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PeriodView> {
    return this.close.close(organization.id, periodId, actorOf(user, store, req))
  }

  // HIGH tier of DestructiveActionTiers (REOPEN_FISCAL_PERIOD)
  @RequirePermissions(Permissions.FINANCE_CLOSE_PERIODS)
  @Post(ApiRoutes.finance.periods.reopen(':id'))
  @HttpCode(HttpStatusCodes.OK)
  reopenPeriod(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) periodId: string,
    @Body(new ZodValidationPipe(reopenPeriodSchema)) body: ReopenPeriodBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PeriodView> {
    return this.close.reopen(organization.id, periodId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.reports.trialBalance)
  trialBalance(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery
  ): Promise<TrialBalanceView> {
    return this.reports.trialBalance(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @Get(ApiRoutes.finance.reports.ledger)
  ledger(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery
  ): Promise<LedgerView> {
    return this.reports.ledger(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.trialBalanceCsv)
  async trialBalanceCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(trialBalanceCsvQuerySchema)) query: TrialBalanceQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const rows = await this.reports.trialBalanceCsvRows(
      organization.id,
      query,
      actorOf(user, store, req)
    )
    attachment(res, `trial-balance-${query.periodId}`)
    return trialBalanceCsv(rows)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.ledgerCsv)
  async ledgerCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(ledgerCsvQuerySchema)) query: LedgerCsvQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const { account, rows } = await this.reports.ledgerCsv(
      organization.id,
      query,
      actorOf(user, store, req)
    )
    attachment(res, `ledger-${account.code}-${query.from}-${query.to}`)
    return ledgerCsv(rows)
  }

  // One row per line of the journal, with what the hash of each entry covers, written as it is read
  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.journalCsv)
  async journalCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(journalCsvQuerySchema)) query: JournalCsvQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<StreamableFile> {
    const pages = await this.reports.journalCsv(organization.id, query, actorOf(user, store, req))
    attachment(res, `journal-${query.from}-${query.to}`)
    async function* chunks(): AsyncGenerator<string> {
      yield journalCsvHeader()
      for await (const page of pages) yield journalCsvRows(page)
    }
    return new StreamableFile(Readable.from(chunks()))
  }

  // The check of the hash chain, on demand for the auditor (TDD_18 §11): the verdict, the head, and whether every frozen head is still there
  @RequirePermissions(Permissions.FINANCE_EXPORT)
  @Post(ApiRoutes.finance.reports.verifyChain)
  @HttpCode(HttpStatusCodes.OK)
  verifyChain(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<ChainVerification> {
    return this.chain.verifyAudited(organization.id, actorOf(user, store, req))
  }
}
