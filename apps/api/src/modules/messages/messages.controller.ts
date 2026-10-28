import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { type CursorPage, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import {
  AgentReactionsService,
  type CreateMessageBody,
  createMessageSchema,
  type ListMessagesQuery,
  listMessagesQuerySchema,
  MessagesService,
  type ReactToMessageBody,
  reactToMessageSchema,
  type MessageView,
  viewerOf
} from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'

// The messages of a conversation of the store in X-Store-Id. Seeing the conversation is required
// by every route; what each message type needs on top of that (MESSAGES_SEND for a reply,
// MESSAGES_INTERNAL_NOTE for a note) depends on the body and is decided by the service.
@Controller()
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly reactions: AgentReactionsService,
    private readonly registry: PluginRegistry
  ) {}

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

  // The reaction of the caller to a message: `{ emoji }` sets it, `{ emoji: null }` takes it back. The
  // answer is 204: the thread shows the reaction and whether the channel took it.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND)
  @Put(ApiRoutes.messages.reaction(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async react(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Body(new ZodValidationPipe(reactToMessageSchema)) body: ReactToMessageBody
  ): Promise<void> {
    await this.reactions.react(store.id, messageId, body.emoji, viewerOf(user.id, held), channel =>
      this.registry.hasCapability(channel, ChannelCapability.REACTIONS)
    )
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @Get(ApiRoutes.conversations.messages(':id'))
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) conversationId: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery
  ): Promise<CursorPage<MessageView>> {
    return this.messages.list(store.id, conversationId, query, viewerOf(user.id, held))
  }
}
