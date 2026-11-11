import { Body, Controller, HttpCode, Param, Post, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { OrderMessageTriggers, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import { invalidInput } from '@platform/core/messaging'
import { pressedDispatchKey } from '@platform/core/shipping'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
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
  constructor(private readonly messages: OrderMessagesService) {}

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
      return { preview: true, ...(await this.messages.preview(store.id, orderId, body.kind)) }
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
      requestedBy: user.id
    })
  }
}
