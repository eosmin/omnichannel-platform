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

import { PayablesService } from './payables.service'
import {
  type CreateSupplierBody,
  createSupplierSchema,
  idSchema,
  type ListPaymentsQuery,
  listPaymentsQuerySchema,
  type ListSuppliersQuery,
  listSuppliersQuerySchema,
  type PayablesQuery,
  payablesQuerySchema,
  type RecordPaymentBody,
  recordPaymentSchema,
  type UpdateSupplierBody,
  updateSupplierSchema,
  type VoidPaymentBody,
  voidPaymentSchema
} from './purchases.schemas'
import type {
  PayablesView,
  PaymentPage,
  PaymentView,
  SupplierBalanceView,
  SupplierPage,
  SupplierView
} from './purchases.views'
import { SupplierPaymentsService } from './supplier-payments.service'
import { SuppliersService } from './suppliers.service'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The suppliers of the organization and what is owed to them (TDD_18 §2.7, §12). Managing suppliers is `finance:manage_purchases`;
// paying one (and voiding a payment) is `finance:move_money`; what is owed is read with either. The permissions are the caller's in the
// store of X-Store-Id; the organization is the guard's, never the body's. `payables` is declared before `:id` so it is never read as an id.
@Controller()
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly payables: PayablesService,
    private readonly payments: SupplierPaymentsService
  ) {}

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @Get(ApiRoutes.suppliers.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listSuppliersQuerySchema)) query: ListSuppliersQuery
  ): Promise<SupplierPage> {
    return this.suppliers.list(organization.id, query)
  }

  @RequireAnyPermission(Permissions.FINANCE_MANAGE_PURCHASES, Permissions.FINANCE_MOVE_MONEY)
  @Get(ApiRoutes.suppliers.payables)
  listPayables(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(payablesQuerySchema)) query: PayablesQuery
  ): Promise<PayablesView> {
    return this.payables.payables(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @Post(ApiRoutes.suppliers.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createSupplierSchema)) body: CreateSupplierBody,
    @Req() req: AuthenticatedRequest
  ): Promise<SupplierView> {
    return this.suppliers.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @Get(ApiRoutes.suppliers.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) supplierId: string
  ): Promise<SupplierView> {
    return this.suppliers.get(organization.id, supplierId)
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @Patch(ApiRoutes.suppliers.update(':id'))
  update(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) supplierId: string,
    @Body(new ZodValidationPipe(updateSupplierSchema)) body: UpdateSupplierBody,
    @Req() req: AuthenticatedRequest
  ): Promise<SupplierView> {
    return this.suppliers.update(organization.id, supplierId, body, actorOf(user, store, req))
  }

  @RequireAnyPermission(Permissions.FINANCE_MANAGE_PURCHASES, Permissions.FINANCE_MOVE_MONEY)
  @Get(ApiRoutes.suppliers.balance(':id'))
  balance(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) supplierId: string
  ): Promise<SupplierBalanceView> {
    return this.payables.balance(organization.id, supplierId)
  }

  @RequireAnyPermission(Permissions.FINANCE_MANAGE_PURCHASES, Permissions.FINANCE_MOVE_MONEY)
  @Get(ApiRoutes.suppliers.payments(':id'))
  listPayments(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) supplierId: string,
    @Query(new ZodValidationPipe(listPaymentsQuerySchema)) query: ListPaymentsQuery
  ): Promise<PaymentPage> {
    return this.payments.list(organization.id, supplierId, query)
  }

  @RequirePermissions(Permissions.FINANCE_MOVE_MONEY)
  @Post(ApiRoutes.suppliers.recordPayment(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  recordPayment(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) supplierId: string,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PaymentView> {
    return this.payments.record(organization.id, supplierId, body, actorOf(user, store, req))
  }

  // HIGH tier of DestructiveActionTiers (VOID_SUPPLIER_PAYMENT): the interface asks before it sends this
  @RequirePermissions(Permissions.FINANCE_MOVE_MONEY)
  @Post(ApiRoutes.supplierPayments.void(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  voidPayment(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) paymentId: string,
    @Body(new ZodValidationPipe(voidPaymentSchema)) body: VoidPaymentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PaymentView> {
    return this.payments.voidPayment(organization.id, paymentId, body, actorOf(user, store, req))
  }
}
