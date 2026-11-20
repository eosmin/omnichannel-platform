import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { MediaUrls } from '@platform/core/storage'

import {
  actorOf,
  CurrentOrganization,
  CurrentPermissions,
  CurrentStore,
  NoTenantTransaction,
  RequireAnyPermission,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { FinanceTransactionDocumentsService } from './finance-transaction-documents.service'
import { FinanceTransactionsService } from './finance-transactions.service'
import {
  type AttachDocumentBody,
  attachDocumentSchema,
  idSchema,
  type ListTransactionsQuery,
  listTransactionsQuerySchema,
  type RecordTransactionBody,
  recordTransactionSchema,
  type ReplaceTransactionBody,
  replaceTransactionSchema,
  type VoidTransactionBody,
  voidTransactionSchema
} from './finance.schemas'
import type { TransactionPage, TransactionView } from './finance.views'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The expenses, incomes and transfers a person registers by hand (TDD_18 §4.3). Reading is the journal's permission. Writing takes
// either permission of the two that can write one (`finance:manage_transactions` for an expense or an income,
// `finance:move_money` for a transfer): the service narrows to the permission of the KIND of the transaction, so a bookkeeper who
// holds one is never let into the other. The permissions are the caller's in the store of X-Store-Id; the organization is the
// guard's.
@Controller()
export class FinanceTransactionsController {
  constructor(
    private readonly transactions: FinanceTransactionsService,
    private readonly documents: FinanceTransactionDocumentsService
  ) {}

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @NoStore()
  @Get(ApiRoutes.finance.transactions.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery
  ): Promise<TransactionPage> {
    return this.transactions.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @NoStore()
  @Get(ApiRoutes.finance.transactions.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) transactionId: string
  ): Promise<TransactionView> {
    return this.transactions.get(organization.id, transactionId)
  }

  // Who registers a transaction sees it (PermissionRequires): the roles keep the pair and the route asks for both
  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
  @NoStore()
  @Post(ApiRoutes.finance.transactions.record)
  @HttpCode(HttpStatusCodes.CREATED)
  record(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() granted: readonly Permission[],
    @Body(new ZodValidationPipe(recordTransactionSchema)) body: RecordTransactionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransactionView> {
    return this.transactions.record(organization.id, body, actorOf(user, store, req), granted)
  }

  // HIGH tier of DestructiveActionTiers (VOID_FINANCE_TRANSACTION): the interface asks before it sends this
  // Who registers a transaction sees it (PermissionRequires): the roles keep the pair and the route asks for both
  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
  @NoStore()
  @Post(ApiRoutes.finance.transactions.void(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  voidTransaction(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() granted: readonly Permission[],
    @Param('id', id()) transactionId: string,
    @Body(new ZodValidationPipe(voidTransactionSchema)) body: VoidTransactionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransactionView> {
    return this.transactions.voidTransaction(
      organization.id,
      transactionId,
      body,
      actorOf(user, store, req),
      granted
    )
  }

  // Voids one and registers another: the same HIGH tier as voiding it
  // Who registers a transaction sees it (PermissionRequires): the roles keep the pair and the route asks for both
  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
  @NoStore()
  @Post(ApiRoutes.finance.transactions.replace(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  replace(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() granted: readonly Permission[],
    @Param('id', id()) transactionId: string,
    @Body(new ZodValidationPipe(replaceTransactionSchema)) body: ReplaceTransactionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransactionView> {
    return this.transactions.replace(
      organization.id,
      transactionId,
      body,
      actorOf(user, store, req),
      granted
    )
  }

  // The receipt is set once, by who may register this KIND of transaction (the service narrows to it) and may read the journal (the
  // answer carries the transaction, so it tells no more than reading it)
  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
  @NoStore()
  @Post(ApiRoutes.finance.transactions.document(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  attachDocument(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() granted: readonly Permission[],
    @Param('id', id()) transactionId: string,
    @Body(new ZodValidationPipe(attachDocumentSchema)) body: AttachDocumentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TransactionView> {
    return this.documents.attach(
      organization.id,
      transactionId,
      body,
      actorOf(user, store, req),
      granted
    )
  }

  // The signed links of the receipt: the journal's permission reads it, and the files are served only once clean
  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @NoStore()
  @NoTenantTransaction(
    'the receipt is a file of ONE store of the organization, which may not be the store of the header: the service reads the transaction in the context of the organization, finds the store of the file and signs in the context of that store alone'
  )
  @Get(ApiRoutes.finance.transactions.document(':id'))
  documentUrls(
    @CurrentOrganization() organization: Organization,
    @CurrentPermissions() granted: readonly Permission[],
    @Param('id', id()) transactionId: string
  ): Promise<MediaUrls> {
    return this.documents.urls(organization.id, transactionId, granted)
  }
}
