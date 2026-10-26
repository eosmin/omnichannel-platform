import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'

import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'

import { ConversationCountsService } from './conversation-counts.service'
import { type ConversationTag, ConversationTagsService } from './conversation-tags.service'
import {
  type AssignBody,
  assignSchema,
  type AttachTagBody,
  attachTagSchema,
  type ChangeStatusBody,
  changeStatusSchema,
  idSchema,
  type ListConversationsQuery,
  listConversationsQuerySchema,
  type SnoozeBody,
  snoozeSchema
} from './conversations.schemas'
import { ConversationsService } from './conversations.service'
import { viewerOf } from './conversations.support'
import type {
  ConversationCounts,
  ConversationDetail,
  ConversationPage
} from './conversations.views'

const id = () => new ZodValidationPipe(idSchema)

// The conversations of the store in X-Store-Id. Every route also applies what the caller may see: an
// agent without CONVERSATIONS_VIEW_ALL gets the conversations assigned to them and the ones nobody
// has. What each change needs beyond seeing the conversation is decided by the service.
@Controller()
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly counts: ConversationCountsService,
    private readonly tags: ConversationTagsService
  ) {}

  // countsOnly=true answers the numbers beside the filters instead of a page
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.conversations.list)
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(listConversationsQuerySchema)) query: ListConversationsQuery
  ): Promise<ConversationPage | ConversationCounts> {
    const viewer = viewerOf(user.id, held)
    return query.countsOnly
      ? this.counts.counts(store.id, viewer)
      : this.conversations.list(store.id, query, viewer)
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.conversations.byId(':id'))
  get(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<ConversationDetail> {
    return this.conversations.get(store.id, conversationId, viewerOf(user.id, held))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Patch(ApiRoutes.conversations.status(':id'))
  changeStatus(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(changeStatusSchema)) body: ChangeStatusBody
  ): Promise<ConversationDetail> {
    return this.conversations.updateStatus(store.id, conversationId, body.status, {
      actor: viewerOf(user.id, held),
      ...(body.resolutionReason === undefined ? {} : { resolutionReason: body.resolutionReason })
    })
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_SNOOZE)
  @Post(ApiRoutes.conversations.snooze(':id'))
  @HttpCode(HttpStatusCodes.OK)
  snooze(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(snoozeSchema)) body: SnoozeBody
  ): Promise<ConversationDetail> {
    return this.conversations.snooze(store.id, conversationId, body.until, viewerOf(user.id, held))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Patch(ApiRoutes.conversations.assign(':id'))
  assign(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignBody
  ): Promise<ConversationDetail> {
    return this.conversations.assign(store.id, conversationId, body.userId, viewerOf(user.id, held))
  }

  // It writes what the whole team sees (the unread count), so it is for who works the conversation
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Post(ApiRoutes.conversations.read(':id'))
  @HttpCode(HttpStatusCodes.OK)
  read(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<ConversationDetail> {
    return this.conversations.markRead(store.id, conversationId, viewerOf(user.id, held))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Post(ApiRoutes.conversations.tags(':id'))
  @HttpCode(HttpStatusCodes.OK)
  attachTag(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(attachTagSchema)) body: AttachTagBody
  ): Promise<ConversationTag[]> {
    return this.tags.attach(store.id, conversationId, body.tagId, viewerOf(user.id, held))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Delete(ApiRoutes.conversations.tagById(':id', ':tagId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async detachTag(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Param('tagId', id()) tagId: string
  ): Promise<void> {
    await this.tags.detach(store.id, conversationId, tagId, viewerOf(user.id, held))
  }
}
