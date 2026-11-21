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
import type { Request } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { BankStatementLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { isImportContentType, readImportBody } from '../remittances/remittance-import-body'
import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type BankImportView,
  FinanceBankImportsService,
  type BankPreviewView
} from './finance-bank-imports.service'
import { type BankProfileView, FinanceBankProfilesService } from './finance-bank-profiles.service'
import {
  type BankBookCandidatesQuery,
  type BankGroupBody,
  type BankPairBody,
  bankImportQuerySchema,
  type BankImportQuery,
  bankBookCandidatesQuerySchema,
  bankGroupSchema,
  bankPairSchema,
  bankPreviewSchema,
  type BankPreviewBody,
  bankStatusQuerySchema,
  type BankStatusQuery,
  createBankProfileSchema,
  type CreateBankProfileBody,
  type ListBankImportsQuery,
  listBankImportsQuerySchema,
  type ListBankLinesQuery,
  listBankLinesQuerySchema,
  bankRegisterDraftQuerySchema,
  type BankRegisterDraftQuery,
  type ListBankProfilesQuery,
  listBankProfilesQuerySchema,
  type UpdateBankProfileBody,
  updateBankProfileSchema
} from './finance-bank.schemas'
import {
  type BankBookCandidatesView,
  type BankDifferenceView,
  type BankLinePage,
  type BankLineView,
  type BankRegisterDraft,
  type BankStatusView,
  FinanceReconciliationService
} from './finance-reconciliation.service'
import { idSchema } from './finance.schemas'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The bank reconciliation by CSV (TDD_18 §4.4): the profiles that read the CSV of a bank, the import of a statement and what a person
// decides on the suggestions. Every route asks for `finance:reconcile` (a statement shows the movements of the accounts), in the
// organization the guard resolved; nothing here posts an entry or edits the journal.
@Controller()
export class FinanceBankController {
  constructor(
    private readonly profiles: FinanceBankProfilesService,
    private readonly imports: FinanceBankImportsService,
    private readonly reconciliation: FinanceReconciliationService
  ) {}

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.profiles)
  listProfiles(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listBankProfilesQuerySchema)) query: ListBankProfilesQuery
  ): Promise<BankProfileView[]> {
    return this.profiles.list(organization.id, query.accountId)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.profiles)
  @HttpCode(HttpStatusCodes.CREATED)
  createProfile(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createBankProfileSchema)) body: CreateBankProfileBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BankProfileView> {
    return this.profiles.create(organization.id, body, actorOf(user, store, req))
  }

  // The mapper: a sample read with the mapping being tried. It writes nothing
  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.profilePreview)
  @HttpCode(HttpStatusCodes.OK)
  preview(@Body(new ZodValidationPipe(bankPreviewSchema)) body: BankPreviewBody): BankPreviewView {
    return this.imports.preview(body)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Patch(ApiRoutes.finance.bank.profileById(':id'))
  updateProfile(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) profileId: string,
    @Body(new ZodValidationPipe(updateBankProfileSchema)) body: UpdateBankProfileBody
  ): Promise<BankProfileView> {
    return this.profiles.update(organization.id, profileId, body)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Delete(ApiRoutes.finance.bank.profileById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeProfile(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) profileId: string
  ): Promise<void> {
    await this.profiles.remove(organization.id, profileId)
  }

  // The file itself is the body (text/csv, text/tab-separated-values or text/plain, up to 5 MB), read as the profile's encoding; the
  // profile, and the closing balance when the person knows it, are in the query. A file with a row that cannot be read answers 400
  // and makes nothing; one with no new line answers 409.
  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @NoTenantTransaction(
    'the file arrives over the network and goes to the bucket: the service reads the profile, writes the rows and checks for the import in short units of its own, and the bucket is called with no context open'
  )
  @Post(ApiRoutes.finance.bank.imports)
  @HttpCode(HttpStatusCodes.CREATED)
  async importFile(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(bankImportQuerySchema)) query: BankImportQuery,
    @Req() req: AuthenticatedRequest & Request
  ): Promise<BankImportView> {
    if (!isImportContentType(req.headers['content-type'])) {
      throw new PlatformException(
        ErrorCodes.BANK_STATEMENT_INVALID,
        'the file must be sent as text/csv, text/tab-separated-values or text/plain',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    // The profile first: it says how the bytes become text
    const profile = await this.profiles.forImport(organization.id, store.id, query.profileId)
    const file = await readImportBody(req, BankStatementLimits.MAX_BYTES, {
      invalidCode: ErrorCodes.BANK_STATEMENT_INVALID,
      encoding: profile.encoding
    })
    return this.imports.importFile(
      organization.id,
      store.id,
      query,
      profile,
      file,
      actorOf(user, store, req)
    )
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.imports)
  listImports(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listBankImportsQuerySchema)) query: ListBankImportsQuery
  ): Promise<BankImportView[]> {
    return this.imports.list(organization.id, query.accountId, query.limit)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.importById(':id'))
  getImport(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) importId: string
  ): Promise<BankImportView> {
    return this.imports.get(organization.id, importId)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.importLines(':id'))
  lines(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) importId: string,
    @Query(new ZodValidationPipe(listBankLinesQuerySchema)) query: ListBankLinesQuery
  ): Promise<BankLinePage> {
    return this.reconciliation.lines(organization.id, importId, query)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.confirmExact(':id'))
  @HttpCode(HttpStatusCodes.OK)
  confirmExact(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) importId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ confirmed: number; left: number }> {
    return this.reconciliation.confirmExact(organization.id, importId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.difference(':id'))
  difference(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) importId: string
  ): Promise<BankDifferenceView> {
    return this.reconciliation.difference(organization.id, importId)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.lineMatches(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  confirm(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) lineId: string,
    @Body(new ZodValidationPipe(bankPairSchema)) body: BankPairBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BankLineView> {
    return this.reconciliation.confirm(organization.id, lineId, body, actorOf(user, store, req))
  }

  // One statement line against several lines of the journal whose signed sum is exactly its amount (HC-121): taken back whole by `matchUndo`
  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.lineGroupMatches(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  confirmGroup(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) lineId: string,
    @Body(new ZodValidationPipe(bankGroupSchema)) body: BankGroupBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BankLineView> {
    return this.reconciliation.confirmGroup(
      organization.id,
      lineId,
      body,
      actorOf(user, store, req)
    )
  }

  // The lines of the books of the account of the statement line that nothing matched: what a group is chosen from (HC-121)
  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.lineBookCandidates(':id'))
  bookCandidates(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) lineId: string,
    @Query(new ZodValidationPipe(bankBookCandidatesQuerySchema)) query: BankBookCandidatesQuery
  ): Promise<BankBookCandidatesView> {
    return this.reconciliation.bookCandidates(organization.id, lineId, query)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.lineRejections(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  reject(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) lineId: string,
    @Body(new ZodValidationPipe(bankPairSchema)) body: BankPairBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BankLineView> {
    return this.reconciliation.reject(organization.id, lineId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.lineRegisterDraft(':id'))
  registerDraft(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) lineId: string,
    @Query(new ZodValidationPipe(bankRegisterDraftQuerySchema)) query: BankRegisterDraftQuery
  ): Promise<BankRegisterDraft> {
    return this.reconciliation.registerDraft(organization.id, lineId, query.useDescriptionAsMemo)
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Post(ApiRoutes.finance.bank.matchUndo(':id'))
  @HttpCode(HttpStatusCodes.OK)
  undo(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) matchId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<BankLineView> {
    return this.reconciliation.undo(organization.id, matchId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_RECONCILE)
  @NoStore()
  @Get(ApiRoutes.finance.bank.status)
  status(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(bankStatusQuerySchema)) query: BankStatusQuery
  ): Promise<BankStatusView> {
    return this.reconciliation.status(organization.id, query)
  }
}
