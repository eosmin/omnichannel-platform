import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { type CursorPage, OrderMessageTriggers, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import { invalidInput } from '@platform/core/messaging'
import { pressedDispatchKey } from '@platform/core/shipping'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  type OrderMessageHistoryItem,
  OrderMessageHistoryService
} from './order-message-history.service'
import {
  type ListOrderMessagesQuery,
  listOrderMessagesQuerySchema,
  type SendOrderMessageBody,
  type SendOrderMessageQuery,
  sendOrderMessageQuerySchema,
  sendOrderMessageSchema
} from './order-messages.schemas'
import {
  type OrderMessageOutcome,
  type OrderMessagePreviewResult,
  OrderMessagesService
} from './order-messages.service'

// Sending a message about an order by hand, or seeing what it would say (TDD_17 §4.7, §6). The order is read by the store that
// TenantGuard resolved, never by a value of the request, so an order of another store is one that does not exist.
@Controller()
export class OrderMessagesController {
  constructor(
    private readonly messages: OrderMessagesService,
    private readonly history: OrderMessageHistoryService
  ) {}

  // What was sent about the order, or not sent and why, newest first
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(ApiRoutes.orders.messages(':id'))
  list(
    @CurrentStore() store: ResolvedTenant['store'],
    @Param('id', new ZodValidationPipe(uuidSchema)) orderId: string,
    @Query(new ZodValidationPipe(listOrderMessagesQuerySchema)) query: ListOrderMessagesQuery
  ): Promise<CursorPage<OrderMessageHistoryItem>> {
    return this.history.list(store.id, orderId, query)
  }

  @RequirePermissions(Permissions.ORDERS_SEND_MESSAGES)
  @Post(ApiRoutes.orders.messages(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async send(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) orderId: string,
    @Query(new ZodValidationPipe(sendOrderMessageQuerySchema)) query: SendOrderMessageQuery,
    @Body(new ZodValidationPipe(sendOrderMessageSchema)) body: SendOrderMessageBody
  ): Promise<OrderMessageOutcome | ({ preview: true } & OrderMessagePreviewResult)> {
    if (query.preview) {
      return {
        preview: true,
        ...(await this.messages.preview(store.id, orderId, body.kind, body.shipmentId))
      }
    }
    if (body.idempotencyKey === undefined) {
      throw invalidInput('a message is sent with the key of its press (idempotencyKey)')
    }
    return this.messages.send({
      storeId: store.id,
      orderId,
      kind: body.kind,
      trigger: OrderMessageTriggers.MANUAL,
      idempotencyKey: pressedDispatchKey(orderId, body.kind, body.idempotencyKey),
      shipmentId: body.shipmentId,
      requestedBy: user.id
    })
  }
}
