import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { type Permission, Permissions } from '@platform/core/auth'
import {
  type ChangeOrderStatusInput,
  type CreateOrderInput,
  type OrderCopyDraft,
  OrderStatus,
  PriceApprovalStatus,
  type RecordOrderPaymentInput,
  type UpdateOrderInput
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentPermissions, CurrentStore, pluginActorOf, RequirePermissions } from '../tenancy'

import { type OrdersBulkResult, OrdersStatusService } from './orders-status.service'
import {
  type CancelOrderBody,
  pluginCancelOrderSchema,
  type ConfirmOrderBody,
  confirmOrderSchema,
  type ConfirmOrdersBulkBody,
  confirmOrdersBulkSchema,
  idSchema,
  type PluginListOrdersQuery,
  pluginChangeOrderStatusSchema,
  pluginCreateOrderSchema,
  pluginListOrdersQuerySchema,
  pluginRecordOrderPaymentSchema,
  pluginUpdateOrderSchema,
  type PriceDecisionBody,
  priceDecisionSchema
} from './orders.schemas'
import { OrdersService } from './orders.service'
import {
  type PluginCreatedOrder,
  pluginCopyView,
  pluginCreatedView,
  type PluginOrderDetailView,
  type PluginOrderPage,
  pluginDetailView,
  pluginPageView
} from './orders.views'

// The installation the guard let in: the plugin is who acts, never a person
type Installation = { id: string; pluginId: string }

const id = () => new ZodValidationPipe(idSchema)

// Every write names `orders:read` besides its own scope: what it answers is the order as a plugin reads it (lines, prices, totals,
// state), and the answer of a refusal tells whether an order exists, so a key that cannot read orders does not get either.
//
// The orders of the store of the key (Step 5.6 PRs E3a and E3b), over the services of the orders screen: the same rules of status,
// stock, price and tax, with no copy of them. Every route names the scope of what it does and holds exactly the permissions of those
// scopes (`@CurrentPermissions` is what the scopes of THE ROUTE grant, not of the key): a person who creates an order does not cancel
// one by that, and neither does a plugin, so cancelling, confirming, editing and deciding a price are scopes of their own, and the
// status route reached with `orders:write` alone is refused for CONFIRMED and CANCELLED by the service, as for a person.
//
// The writes record the PLUGIN as who did it (`pluginActorOf`: the plugin id in the `*_plugin_id` column beside the person's, the
// audit as the platform with the installation in the metadata, the events as the platform), never the id of a user (PR M1c).
// What a plugin gets back is the same allowlist as its reads (`pluginDetailView`): no customer, address, notes, payment proof, shipping
// data or id of a person of the team. What it may write is narrower than a person's: not the internal and packing notes, not the
// tracking number, not a conversation, not a file (a proof or a receipt), not an override of a price (no scope grants it) and not the
// stock of a return (`inventory:write`), each refused with its own message.
@Controller()
export class PluginOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly lifecycle: OrdersStatusService
  ) {}

  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orders.list)
  async list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(pluginListOrdersQuerySchema)) query: PluginListOrdersQuery
  ): Promise<PluginOrderPage> {
    return pluginPageView(await this.orders.list(store.id, query))
  }

  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orders.byId(':id'))
  async get(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(await this.orders.get(store.id, orderId, held))
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE)
  @RequirePermissions(Permissions.ORDERS_CREATE)
  @Post(PluginApiRoutes.orders.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(pluginCreateOrderSchema)) body: CreateOrderInput,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCreatedOrder> {
    return pluginCreatedView(
      await this.orders.create(store.id, body, pluginActorOf(installation, store, req), held)
    )
  }

  // The draft carries what `orders:read` withholds (the customer, the address, the phones, the ids of the products), so it asks for
  // the scope of each, and leaves out the notes of the team
  @PluginApi(
    PluginScopes.ORDERS_READ,
    PluginScopes.ORDERS_WRITE,
    PluginScopes.CUSTOMERS_READ,
    PluginScopes.PRODUCTS_READ
  )
  @RequirePermissions(Permissions.ORDERS_VIEW, Permissions.ORDERS_CREATE)
  @Get(PluginApiRoutes.orders.copy(':id'))
  async copy(
    @CurrentStore() store: { id: string },
    @Param('id', id()) orderId: string
  ): Promise<OrderCopyDraft> {
    return pluginCopyView(await this.orders.copyDraft(store.id, orderId))
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_EDIT)
  @RequirePermissions(Permissions.ORDERS_EDIT)
  @Patch(PluginApiRoutes.orders.byId(':id'))
  async update(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(pluginUpdateOrderSchema)) body: UpdateOrderInput,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.orders.update(
        store.id,
        orderId,
        body,
        pluginActorOf(installation, store, req),
        held
      )
    )
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE)
  @RequirePermissions(Permissions.ORDERS_CHANGE_STATUS)
  @Post(PluginApiRoutes.orders.status(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async changeStatus(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(pluginChangeOrderStatusSchema)) body: ChangeOrderStatusInput,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.lifecycle.changeStatus(
        store.id,
        orderId,
        body,
        pluginActorOf(installation, store, req),
        held
      )
    )
  }

  // Before the routes of `:id`, like every fixed route of the controller
  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_CONFIRM)
  @RequirePermissions(Permissions.ORDERS_CONFIRM)
  @Post(PluginApiRoutes.orders.confirmBulk)
  @HttpCode(HttpStatusCodes.OK)
  confirmBulk(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(confirmOrdersBulkSchema)) body: ConfirmOrdersBulkBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrdersBulkResult> {
    return this.lifecycle.confirmBulk(
      store.id,
      body.ids,
      body.via,
      pluginActorOf(installation, store, req),
      held
    )
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_CONFIRM)
  @RequirePermissions(Permissions.ORDERS_CONFIRM)
  @Post(PluginApiRoutes.orders.confirm(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async confirm(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(confirmOrderSchema)) body: ConfirmOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.lifecycle.changeStatus(
        store.id,
        orderId,
        { status: OrderStatus.CONFIRMED, confirmedVia: body.via },
        pluginActorOf(installation, store, req),
        held
      )
    )
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_CANCEL)
  @RequirePermissions(Permissions.ORDERS_CANCEL)
  @Post(PluginApiRoutes.orders.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async cancel(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(pluginCancelOrderSchema)) body: CancelOrderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.lifecycle.changeStatus(
        store.id,
        orderId,
        {
          status: OrderStatus.CANCELLED,
          cancellationReason: body.cancellationReason
        },
        pluginActorOf(installation, store, req),
        held
      )
    )
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_EDIT)
  @RequirePermissions(Permissions.ORDERS_EDIT)
  @Post(PluginApiRoutes.orders.payment(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async recordPayment(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(pluginRecordOrderPaymentSchema)) body: RecordOrderPaymentInput,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.lifecycle.recordPayment(
        store.id,
        orderId,
        body,
        pluginActorOf(installation, store, req),
        held
      )
    )
  }

  // Nobody approves their own request: a plugin that asked for the approval (its edit made the price wait) is refused for it as a
  // person would be, by the key `plugin:<plugin id>` that the service compares with the one of the requester
  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_APPROVE_PRICE)
  @RequirePermissions(Permissions.ORDERS_APPROVE_PRICE)
  @Post(PluginApiRoutes.orders.priceApprovalApprove(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async approvePrice(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(priceDecisionSchema)) body: PriceDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.lifecycle.decidePrice(
        store.id,
        orderId,
        PriceApprovalStatus.APPROVED,
        body.reason,
        pluginActorOf(installation, store, req),
        held
      )
    )
  }

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDERS_APPROVE_PRICE)
  @RequirePermissions(Permissions.ORDERS_APPROVE_PRICE)
  @Post(PluginApiRoutes.orders.priceApprovalReject(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async rejectPrice(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(priceDecisionSchema)) body: PriceDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderDetailView> {
    return pluginDetailView(
      await this.lifecycle.decidePrice(
        store.id,
        orderId,
        PriceApprovalStatus.REJECTED,
        body.reason,
        pluginActorOf(installation, store, req),
        held
      )
    )
  }
}
