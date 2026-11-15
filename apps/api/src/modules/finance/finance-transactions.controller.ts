import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentPermissions,
  CurrentStore,
  RequireAnyPermission,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { FinanceTransactionsService } from './finance-transactions.service'
import {
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
  constructor(private readonly transactions: FinanceTransactionsService) {}

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @Get(ApiRoutes.finance.transactions.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery
  ): Promise<TransactionPage> {
    return this.transactions.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_JOURNAL)
  @Get(ApiRoutes.finance.transactions.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) transactionId: string
  ): Promise<TransactionView> {
    return this.transactions.get(organization.id, transactionId)
  }

  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
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
  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
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
  @RequireAnyPermission(Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY)
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
}
