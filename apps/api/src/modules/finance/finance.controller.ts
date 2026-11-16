import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res
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

import { FinanceAccountsService } from './finance-accounts.service'
import { FinanceEntriesService } from './finance-entries.service'
import { FinancePeriodsService } from './finance-periods.service'
import { FinanceSettingsService } from './finance-settings.service'
import { FinanceSetupService } from './finance-setup.service'
import { FinanceStoreTaxSettingsService } from './finance-store-tax-settings.service'
import { FinanceTaxRatesService } from './finance-tax-rates.service'
import { FinanceVatReportService } from './finance-vat-report.service'
import {
  balancesQuerySchema,
  type BalancesQuery,
  type CreateAccountBody,
  createAccountSchema,
  type CreateTaxRateBody,
  createTaxRateSchema,
  idSchema,
  type ListAccountsQuery,
  listAccountsQuerySchema,
  type ListEntriesQuery,
  listEntriesQuerySchema,
  type ListPeriodsQuery,
  listPeriodsQuerySchema,
  type ListPostingsQuery,
  listPostingsQuerySchema,
  type ManualEntryBody,
  manualEntrySchema,
  type MapRoleBody,
  mapRoleSchema,
  type OpenPeriodBody,
  openPeriodSchema,
  type ReverseEntryBody,
  reverseEntrySchema,
  roleParamSchema,
  type SetPaymentAccountBody,
  setPaymentAccountSchema,
  type SetupBody,
  setupSchema,
  type UpdateAccountBody,
  updateAccountSchema,
  type UpdateSettingsBody,
  updateSettingsSchema,
  type UpdateStoreTaxSettingsBody,
  updateStoreTaxSettingsSchema,
  type UpdateTaxRateBody,
  updateTaxRateSchema,
  type VatReportQuery,
  vatReportQuerySchema
} from './finance.schemas'
import type {
  AccountPage,
  AccountView,
  BalanceView,
  EntryDetailView,
  EntryPage,
  PaymentAccountView,
  PeriodPage,
  PeriodView,
  PostingPage,
  RoleMappingView,
  SettingsView,
  SetupState,
  StoreTaxSettingsView,
  TaxRateView,
  VatReportView
} from './finance.views'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The books of the organization of the store in X-Store-Id (TDD_18 §2.1, §12): the permission is the one the caller holds in
// that store, and the organization is the one TenantGuard resolved from it, never one from the request. Reading asks for
// finance:view (the journal for finance:view_journal); every change for the permission of what it changes.
@Controller()
export class FinanceController {
  constructor(
    private readonly setup: FinanceSetupService,
    private readonly settings: FinanceSettingsService,
    private readonly accounts: FinanceAccountsService,
    private readonly periods: FinancePeriodsService,
    private readonly entries: FinanceEntriesService,
    private readonly taxRates: FinanceTaxRatesService,
    private readonly storeTax: FinanceStoreTaxSettingsService,
    private readonly vatReport: FinanceVatReportService
  ) {}

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.setup)
  setupState(@CurrentOrganization() organization: Organization): Promise<SetupState> {
    return this.setup.state(organization.id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.setup)
  @HttpCode(HttpStatusCodes.CREATED)
  setUp(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setupSchema)) body: SetupBody,
    @Req() req: AuthenticatedRequest
  ): Promise<SetupState> {
    return this.setup.setup(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.settings)
  getSettings(@CurrentOrganization() organization: Organization): Promise<SettingsView> {
    return this.settings.get(organization.id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Patch(ApiRoutes.finance.settings)
  updateSettings(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateSettingsSchema)) body: UpdateSettingsBody,
    @Req() req: AuthenticatedRequest
  ): Promise<SettingsView> {
    return this.settings.update(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.accounts.list)
  listAccounts(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listAccountsQuerySchema)) query: ListAccountsQuery
  ): Promise<AccountPage> {
    return this.accounts.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.accounts.byId(':id'))
  getAccount(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) accountId: string
  ): Promise<AccountView> {
    return this.accounts.get(organization.id, accountId)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.accounts.create)
  @HttpCode(HttpStatusCodes.CREATED)
  createAccount(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createAccountSchema)) body: CreateAccountBody,
    @Req() req: AuthenticatedRequest
  ): Promise<AccountView> {
    return this.accounts.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Patch(ApiRoutes.finance.accounts.byId(':id'))
  updateAccount(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) accountId: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) body: UpdateAccountBody,
    @Req() req: AuthenticatedRequest
  ): Promise<AccountView> {
    return this.accounts.update(organization.id, accountId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.accounts.deactivate(':id'))
  @HttpCode(HttpStatusCodes.OK)
  deactivateAccount(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) accountId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<AccountView> {
    return this.accounts.deactivate(organization.id, accountId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.accounts.reactivate(':id'))
  @HttpCode(HttpStatusCodes.OK)
  reactivateAccount(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) accountId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<AccountView> {
    return this.accounts.reactivate(organization.id, accountId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.accountRoles.list)
  listRoles(@CurrentOrganization() organization: Organization): Promise<RoleMappingView[]> {
    return this.settings.roles(organization.id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Put(ApiRoutes.finance.accountRoles.byRole(':role'))
  mapRole(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('role', new ZodValidationPipe(roleParamSchema)) role: string,
    @Body(new ZodValidationPipe(mapRoleSchema)) body: MapRoleBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RoleMappingView> {
    return this.settings.mapRole(organization.id, role, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.paymentAccounts.list)
  listPaymentAccounts(
    @CurrentOrganization() organization: Organization
  ): Promise<PaymentAccountView[]> {
    return this.settings.paymentAccounts(organization.id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Put(ApiRoutes.finance.paymentAccounts.set)
  setPaymentAccount(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setPaymentAccountSchema)) body: SetPaymentAccountBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PaymentAccountView> {
    return this.settings.setPaymentAccount(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Delete(ApiRoutes.finance.paymentAccounts.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  removePaymentAccount(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) paymentAccountId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    return this.settings.removePaymentAccount(
      organization.id,
      paymentAccountId,
      actorOf(user, store, req)
    )
  }

  // The VAT report (TDD_18 §7) of the organization for a range of days: the JSON, and the same rows as a CSV file
  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.reports.vat)
  vat(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(vatReportQuerySchema)) query: VatReportQuery
  ): Promise<VatReportView> {
    return this.vatReport.report(organization.id, query)
  }

  // Taking the file out needs finance:export besides, like every other financial file, and leaves an audit row (FINANCE_EXPORTED)
  @RequirePermissions(Permissions.FINANCE_VIEW, Permissions.FINANCE_EXPORT)
  @Get(ApiRoutes.finance.reports.vatCsv)
  async vatCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(vatReportQuerySchema)) query: VatReportQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const file = await this.vatReport.csv(organization.id, query, actorOf(user, store, req))
    res.setHeader('Content-Type', ExportContentTypes.CSV)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vat-${query.from}-${query.to}.${ExportFileExtensions.CSV}"`
    )
    // A financial file is not kept by a shared cache
    res.setHeader('Cache-Control', 'no-store')
    return file
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.taxRates.list)
  listTaxRates(@CurrentOrganization() organization: Organization): Promise<TaxRateView[]> {
    return this.taxRates.list(organization.id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.taxRates.create)
  @HttpCode(HttpStatusCodes.CREATED)
  createTaxRate(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTaxRateSchema)) body: CreateTaxRateBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TaxRateView> {
    return this.taxRates.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Patch(ApiRoutes.finance.taxRates.byId(':id'))
  updateTaxRate(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) taxRateId: string,
    @Body(new ZodValidationPipe(updateTaxRateSchema)) body: UpdateTaxRateBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TaxRateView> {
    return this.taxRates.update(organization.id, taxRateId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.taxRates.deactivate(':id'))
  @HttpCode(HttpStatusCodes.OK)
  deactivateTaxRate(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) taxRateId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<TaxRateView> {
    return this.taxRates.deactivate(organization.id, taxRateId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.taxRates.reactivate(':id'))
  @HttpCode(HttpStatusCodes.OK)
  reactivateTaxRate(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) taxRateId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<TaxRateView> {
    return this.taxRates.reactivate(organization.id, taxRateId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.storeTaxSettings)
  getStoreTaxSettings(@CurrentStore() store: Store): Promise<StoreTaxSettingsView> {
    return this.storeTax.get(store.id)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Patch(ApiRoutes.finance.storeTaxSettings)
  updateStoreTaxSettings(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateStoreTaxSettingsSchema)) body: UpdateStoreTaxSettingsBody,
    @Req() req: AuthenticatedRequest
  ): Promise<StoreTaxSettingsView> {
    return this.storeTax.update(organization.id, store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.periods.list)
  listPeriods(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listPeriodsQuerySchema)) query: ListPeriodsQuery
  ): Promise<PeriodPage> {
    return this.periods.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.periods.byId(':id'))
  getPeriod(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) periodId: string
  ): Promise<PeriodView> {
    return this.periods.get(organization.id, periodId)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.periods.open)
  @HttpCode(HttpStatusCodes.OK)
  openPeriod(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(openPeriodSchema)) body: OpenPeriodBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PeriodView> {
    return this.periods.open(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @Get(ApiRoutes.finance.entries.list)
  listEntries(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listEntriesQuerySchema)) query: ListEntriesQuery
  ): Promise<EntryPage> {
    return this.entries.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @Get(ApiRoutes.finance.entries.byId(':id'))
  getEntry(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) entryId: string
  ): Promise<EntryDetailView> {
    return this.entries.get(organization.id, entryId)
  }

  // HIGH tier of DestructiveActionTiers (POST_MANUAL_ENTRY): the interface asks before it sends this
  @RequirePermissions(Permissions.FINANCE_POST_MANUAL)
  @Post(ApiRoutes.finance.entries.manual)
  @HttpCode(HttpStatusCodes.CREATED)
  postManual(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(manualEntrySchema)) body: ManualEntryBody,
    @Req() req: AuthenticatedRequest
  ): Promise<EntryDetailView> {
    return this.entries.postManual(organization.id, body, actorOf(user, store, req))
  }

  // HIGH tier of DestructiveActionTiers (REVERSE_ENTRY)
  @RequirePermissions(Permissions.FINANCE_POST_MANUAL)
  @Post(ApiRoutes.finance.entries.reverse(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  reverseEntry(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) entryId: string,
    @Body(new ZodValidationPipe(reverseEntrySchema)) body: ReverseEntryBody,
    @Req() req: AuthenticatedRequest
  ): Promise<EntryDetailView> {
    return this.entries.reverse(organization.id, entryId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW)
  @Get(ApiRoutes.finance.balances)
  balances(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(balancesQuerySchema)) query: BalancesQuery
  ): Promise<{ data: BalanceView[] }> {
    return this.entries.balances(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Post(ApiRoutes.finance.postingRetry(':id'))
  @HttpCode(HttpStatusCodes.OK)
  retryPosting(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) failureId: string,
    @Req() req: AuthenticatedRequest
  ): ReturnType<FinanceEntriesService['retryPosting']> {
    return this.entries.retryPosting(organization.id, failureId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @Get(ApiRoutes.finance.postings)
  postings(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listPostingsQuerySchema)) query: ListPostingsQuery
  ): Promise<PostingPage> {
    return this.entries.postings(organization.id, query)
  }
}
