import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  type AssignBody,
  type BulkActionBody,
  bulkActionSchema,
  assignSchema,
  type AttachTagBody,
  attachTagSchema,
  type ChangeStatusBody,
  changeStatusSchema,
  ConversationClosingService,
  type ConversationCounts,
  type ConversationDetail,
  type ConversationPage,
  ConversationsService,
  type ListConversationsQuery,
  listConversationsQuerySchema,
  ReadReceipts,
  type SnoozeBody,
  snoozeSchema,
  viewerOf
} from '@platform/core/messaging'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { type BulkResult, ConversationBulkService } from './conversation-bulk.service'
import { ConversationCountsService } from './conversation-counts.service'
import { ConversationOriginsService, type OriginView } from './conversation-origins.service'
import { type ConversationTag, ConversationTagsService } from './conversation-tags.service'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(uuidSchema)

// The conversations of the store in X-Store-Id. Every route also applies what the caller may see: an
// agent without CONVERSATIONS_VIEW_ALL gets the conversations assigned to them and the ones nobody
// has. What each change needs beyond seeing the conversation is decided by the service.
@Controller()
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly closing: ConversationClosingService,
    private readonly bulk: ConversationBulkService,
    private readonly counts: ConversationCountsService,
    private readonly tags: ConversationTagsService,
    private readonly origins: ConversationOriginsService,
    private readonly readReceipts: ReadReceipts
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

  // Declared before `:id` routes, or "bulk" would be read as an id. The answer says which
  // conversations changed and which did not, with our error code for each.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Post(ApiRoutes.conversations.bulk)
  @HttpCode(HttpStatusCodes.OK)
  runBulk(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BulkResult> {
    return this.bulk.run(store.id, body, viewerOf(user.id, held), actorOf(user, store, req))
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

  // The ads and posts the customer came from, for the card on top of the thread
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @Get(ApiRoutes.conversations.origins(':id'))
  listOrigins(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<OriginView[]> {
    return this.origins.list(store.id, conversationId, viewerOf(user.id, held))
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
    const options = {
      actor: viewerOf(user.id, held),
      ...(body.resolutionReason === undefined ? {} : { resolutionReason: body.resolutionReason })
    }
    if (body.closingSnippetId !== undefined) {
      return this.closing.resolve(store.id, conversationId, body.closingSnippetId, options)
    }
    return this.conversations.updateStatus(store.id, conversationId, body.status, options)
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
  async read(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<ConversationDetail> {
    const detail = await this.conversations.markRead(
      store.id,
      conversationId,
      viewerOf(user.id, held)
    )
    // After the read is stored and only for who could read it: the customer's channel is told too.
    // Not awaited, so that a slow or unreachable Redis does not hold the answer; queueFor logs its own
    // failures and never rejects.
    void this.readReceipts.queueFor(store.id, conversationId)
    return detail
  }

  // Keeps a conversation to come back to: it counts as unread again, for the whole team
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Post(ApiRoutes.conversations.unread(':id'))
  @HttpCode(HttpStatusCodes.OK)
  unread(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<ConversationDetail> {
    return this.conversations.markUnread(store.id, conversationId, viewerOf(user.id, held))
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
