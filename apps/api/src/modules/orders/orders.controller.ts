import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type ChangeOrderStatusInput,
  changeOrderStatusSchema,
  type CreateOrderInput,
  createOrderSchema,
  OrderStatus,
  PriceApprovalStatus,
  type RecordOrderPaymentInput,
  recordOrderPaymentSchema,
  type UpdateOrderInput,
  updateOrderSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { OrdersStatusService } from './orders-status.service'
import {
  type CancelOrderBody,
  cancelOrderSchema,
  type ConfirmOrderBody,
  confirmOrderSchema,
  idSchema,
  type ListOrdersQuery,
  listOrdersQuerySchema,
  type PriceDecisionBody,
  priceDecisionSchema
} from './orders.schemas'
import { type CreatedOrder, OrdersService } from './orders.service'
import type { OrderDetailView, OrderPage } from './orders.views'

const id = () => new ZodValidationPipe(idSchema)

// The orders of the store in X-Store-Id. Reading asks for orders:view, creating for orders:create, editing (and recording
// a payment) for orders:edit, changing the status for orders:change_status. Confirming and cancelling have their own
// (orders:confirm, orders:cancel), also when they come through the status route, and deciding a price needs
// orders:approve_price. The two internal notes are read by whoever holds orders:view and by nobody else.
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly lifecycle: OrdersStatusService
  ) {}

  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(ApiRoutes.orders.list)
  list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listOrdersQuerySchema)) query: ListOrdersQuery
  ): Promise<OrderPage> {
    return this.orders.list(store.id, query)
  }

  @RequirePermissions(Permissions.ORDERS_CREATE)
  @Post(ApiRoutes.orders.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @Req() req: AuthenticatedRequest
  ): Promise<CreatedOrder> {
    return this.orders.create(store.id, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(ApiRoutes.orders.byId(':id'))
  get(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string
  ): Promise<OrderDetailView> {
    return this.orders.get(store.id, orderId, held)
  }

  @RequirePermissions(Permissions.ORDERS_EDIT)
  @Patch(ApiRoutes.orders.byId(':id'))
  update(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(updateOrderSchema)) body: UpdateOrderInput,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.orders.update(store.id, orderId, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.ORDERS_CHANGE_STATUS)
  @Post(ApiRoutes.orders.status(':id'))
  @HttpCode(HttpStatusCodes.OK)
  changeStatus(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(changeOrderStatusSchema)) body: ChangeOrderStatusInput,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.lifecycle.changeStatus(store.id, orderId, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.ORDERS_CONFIRM)
  @Post(ApiRoutes.orders.confirm(':id'))
  @HttpCode(HttpStatusCodes.OK)
  confirm(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(confirmOrderSchema)) body: ConfirmOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.lifecycle.changeStatus(
      store.id,
      orderId,
      { status: OrderStatus.CONFIRMED, confirmedVia: body.via },
      actorOf(user, store, req),
      held
    )
  }

  @RequirePermissions(Permissions.ORDERS_CANCEL)
  @Post(ApiRoutes.orders.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(cancelOrderSchema)) body: CancelOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.lifecycle.changeStatus(
      store.id,
      orderId,
      { status: OrderStatus.CANCELLED, cancellationReason: body.cancellationReason },
      actorOf(user, store, req),
      held
    )
  }

  @RequirePermissions(Permissions.ORDERS_EDIT)
  @Post(ApiRoutes.orders.payment(':id'))
  @HttpCode(HttpStatusCodes.OK)
  recordPayment(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(recordOrderPaymentSchema)) body: RecordOrderPaymentInput,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.lifecycle.recordPayment(store.id, orderId, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.ORDERS_APPROVE_PRICE)
  @Post(ApiRoutes.orders.priceApprovalApprove(':id'))
  @HttpCode(HttpStatusCodes.OK)
  approvePrice(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(priceDecisionSchema)) body: PriceDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.lifecycle.decidePrice(
      store.id,
      orderId,
      PriceApprovalStatus.APPROVED,
      body.reason,
      actorOf(user, store, req),
      held
    )
  }

  @RequirePermissions(Permissions.ORDERS_APPROVE_PRICE)
  @Post(ApiRoutes.orders.priceApprovalReject(':id'))
  @HttpCode(HttpStatusCodes.OK)
  rejectPrice(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(priceDecisionSchema)) body: PriceDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderDetailView> {
    return this.lifecycle.decidePrice(
      store.id,
      orderId,
      PriceApprovalStatus.REJECTED,
      body.reason,
      actorOf(user, store, req),
      held
    )
  }
}
