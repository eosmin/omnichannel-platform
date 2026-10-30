import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res
} from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Audit } from '@platform/core/audit-module'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { type CursorPage, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import {
  AgentReactionsService,
  type CreateMessageBody,
  createMessageSchema,
  type EditMessageBody,
  editMessageSchema,
  type ListMessagesQuery,
  listMessagesQuerySchema,
  MessageChangesService,
  MessagesService,
  type RevisionView,
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
    private readonly changes: MessageChangesService,
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

  // The whole new text. A note carries the `version` it was read at (409 with the current text if it
  // changed); a reply the customer has changes only when the channel takes the edit, and the answer
  // says `pendingEdit` until then. What each kind needs on top of seeing the conversation is decided
  // by the service.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Patch(ApiRoutes.messages.byId(':id'))
  edit(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Body(new ZodValidationPipe(editMessageSchema)) body: EditMessageBody
  ): Promise<MessageView> {
    return this.changes.edit(store.id, messageId, body, viewerOf(user.id, held), channel =>
      this.registry.hasCapability(channel, ChannelCapability.EDIT_MESSAGE)
    )
  }

  // Deletes for everyone, or answers 409 when the channel cannot. Every delete is audited.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Audit(AuditAction.MESSAGE_DELETED, { resourceType: 'message' })
  @Delete(ApiRoutes.messages.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string
  ): Promise<void> {
    await this.changes.remove(store.id, messageId, viewerOf(user.id, held), channel =>
      this.registry.hasCapability(channel, ChannelCapability.DELETE_MESSAGE)
    )
  }

  // The text of a message the customer deleted, while it is kept. Every read is audited.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW_DELETED)
  @Audit(AuditAction.MESSAGE_DELETED_CONTENT_VIEWED, { resourceType: 'message' })
  @Get(ApiRoutes.messages.deletedContent(':id'))
  deletedContent(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string
  ): Promise<{ content: string | null }> {
    return this.changes.deletedContent(store.id, messageId, viewerOf(user.id, held))
  }

  // The earlier texts of an edited message, for the "edited by" link of a note
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @Get(ApiRoutes.messages.revisions(':id'))
  revisions(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string
  ): Promise<RevisionView[]> {
    return this.changes.revisions(store.id, messageId, viewerOf(user.id, held))
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
