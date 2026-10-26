import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { CursorPage } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'

import { viewerOf } from '../conversations'
import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'

import {
  type CreateMessageBody,
  createMessageSchema,
  idSchema,
  type ListMessagesQuery,
  listMessagesQuerySchema
} from './messages.schemas'
import { MessagesService } from './messages.service'
import type { MessageView } from './messages.views'

// The messages of a conversation of the store in X-Store-Id. Seeing the conversation is required
// by every route; what each message type needs on top of that (MESSAGES_SEND for a reply,
// MESSAGES_INTERNAL_NOTE for a note) depends on the body and is decided by the service.
@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  // 201 for a new message, 200 for the one a repeated idempotencyKey already made
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Post(ApiRoutes.messages.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createMessageSchema)) body: CreateMessageBody,
    @Res({ passthrough: true }) res: Response
  ): Promise<MessageView> {
    const { message, created } = await this.messages.create(store.id, body, viewerOf(user.id, held))
    if (!created) res.status(HttpStatusCodes.OK)
    return message
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @Get(ApiRoutes.conversations.messages(':id'))
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(idSchema)) conversationId: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery
  ): Promise<CursorPage<MessageView>> {
    return this.messages.list(store.id, conversationId, query, viewerOf(user.id, held))
  }
}
