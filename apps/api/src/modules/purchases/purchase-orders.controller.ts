import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequireAnyPermission,
  RequirePermissions,
  type ResolvedTenant,
  TenantOfOrganizationStores
} from '../tenancy'

import { PurchaseOrdersService } from './purchase-orders.service'
import { PurchaseReceivingService } from './purchase-receiving.service'
import {
  type ClosePurchaseOrderBody,
  closePurchaseOrderSchema,
  type CreatePurchaseOrderBody,
  createPurchaseOrderSchema,
  idSchema,
  type ListPaymentsQuery,
  listPaymentsQuerySchema,
  type ListPurchaseOrdersQuery,
  listPurchaseOrdersQuerySchema,
  type ReceivePurchaseOrderBody,
  receivePurchaseOrderSchema,
  type RecordPaymentBody,
  recordPaymentSchema,
  type UpdatePurchaseOrderBody,
  updatePurchaseOrderSchema
} from './purchases.schemas'
import type { OrderPage, OrderView, PaymentPage, PaymentView } from './purchases.views'
import { SupplierPaymentsService } from './supplier-payments.service'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The purchase orders of the organization (TDD_18 §2.7, §12): `finance:manage_purchases` writes and reads them; a payment is
// `finance:move_money`. The organization is the guard's; the lines a caller sees are the ones of the stores it belongs to.
@TenantOfOrganizationStores(
  'a purchase order carries lines of several stores of the organization and receiving it raises the stock of each of them (inventory_levels and inventory_movements are tables of a store): the context holds every store of the organization, and the service decides which lines each caller sees and receives (visibleStoreIds, seesEveryLine, before any stock moves). The payment routes of this controller inherit the mark and write organization tables only: add NO new write to a table of a store in this controller without reviewing the wide context'
)
@Controller()
export class PurchaseOrdersController {
  constructor(
    private readonly orders: PurchaseOrdersService,
    private readonly receiving: PurchaseReceivingService,
    private readonly payments: SupplierPaymentsService
  ) {}

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Get(ApiRoutes.purchaseOrders.list)
  list(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listPurchaseOrdersQuerySchema)) query: ListPurchaseOrdersQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderPage> {
    return this.orders.list(organization.id, query, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Post(ApiRoutes.purchaseOrders.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createPurchaseOrderSchema)) body: CreatePurchaseOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.orders.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Get(ApiRoutes.purchaseOrders.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.orders.get(organization.id, orderId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Patch(ApiRoutes.purchaseOrders.update(':id'))
  update(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(updatePurchaseOrderSchema)) body: UpdatePurchaseOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.orders.update(organization.id, orderId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Post(ApiRoutes.purchaseOrders.order(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  order(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.orders.order(organization.id, orderId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Post(ApiRoutes.purchaseOrders.receive(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  receive(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(receivePurchaseOrderSchema)) body: ReceivePurchaseOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.receiving.receive(organization.id, orderId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Post(ApiRoutes.purchaseOrders.close(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  close(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(closePurchaseOrderSchema)) body: ClosePurchaseOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.orders.close(organization.id, orderId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_MANAGE_PURCHASES)
  @NoStore()
  @Post(ApiRoutes.purchaseOrders.cancel(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  cancel(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(closePurchaseOrderSchema)) body: ClosePurchaseOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderView> {
    return this.orders.cancel(organization.id, orderId, body, actorOf(user, store, req))
  }

  @RequireAnyPermission(Permissions.FINANCE_MANAGE_PURCHASES, Permissions.FINANCE_MOVE_MONEY)
  @NoStore()
  @Get(ApiRoutes.purchaseOrders.payments(':id'))
  listPayments(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) orderId: string,
    @Query(new ZodValidationPipe(listPaymentsQuerySchema)) query: ListPaymentsQuery
  ): Promise<PaymentPage> {
    return this.payments.listOfOrder(organization.id, orderId, query)
  }

  // Pays a bill of this order: the body names it (`purchaseReceiptId`, required here)
  @RequirePermissions(Permissions.FINANCE_MOVE_MONEY)
  @NoStore()
  @Post(ApiRoutes.purchaseOrders.recordPayment(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  recordPayment(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PaymentView> {
    return this.payments.recordForOrder(organization.id, orderId, body, actorOf(user, store, req))
  }
}
