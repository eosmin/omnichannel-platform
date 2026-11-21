import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
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
import { CHANNEL_ANONYMITY, type ChannelAnonymitySource, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
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
  type ConversationCounts,
  type ConversationFilter,
  conversationFilterSchema,
  conversationFilterWhere,
  type ConversationsExportFilters,
  type ConversationDetail,
  type ConversationPage,
  ConversationsService,
  type ListConversationsQuery,
  listConversationsQuerySchema,
  ReadReceipts,
  viewPermissionsOf,
  type SnoozeBody,
  snoozeSchema,
  viewerOf
} from '@platform/core/messaging'
import { ExportFormats, ExportTypes } from '@platform/core/queues'

import {
  type WithAnonymous,
  withAnonymousCustomers,
  withAnonymousPage,
  type WithAnonymousPage
} from '../channel-registry'
import { ExportsService, type ExportView } from '../exports'
import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'
import { WidgetReadNotifier } from '../widget/widget-read-notifier.service'

import { type BulkResult, ConversationBulkService } from './conversation-bulk.service'
import { ConversationCountsService } from './conversation-counts.service'
import { ConversationDeletionService } from './conversation-deletion.service'
import { ConversationOriginsService, type OriginView } from './conversation-origins.service'
import { ConversationStatusChangeService } from './conversation-status-change.service'
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
    private readonly statusChange: ConversationStatusChangeService,
    private readonly bulk: ConversationBulkService,
    private readonly counts: ConversationCountsService,
    private readonly tags: ConversationTagsService,
    private readonly origins: ConversationOriginsService,
    private readonly deletion: ConversationDeletionService,
    private readonly readReceipts: ReadReceipts,
    private readonly widgetRead: WidgetReadNotifier,
    private readonly exports: ExportsService,
    @Inject(CHANNEL_ANONYMITY) private readonly anonymity: ChannelAnonymitySource
  ) {}

  private marked(detail: ConversationDetail): WithAnonymous<ConversationDetail> {
    return withAnonymousCustomers(this.anonymity, detail)
  }

  // Declared before `:id`, or "export" would be read as an id. The file holds what the member can see
  // now, with the filters of the list; it is made in the background and the answer is the export to
  // follow in the exports center.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT)
  @NoStore()
  @Get(ApiRoutes.conversations.export)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  requestExport(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(conversationFilterSchema)) filter: ConversationFilter
  ): Promise<ExportView> {
    // Same rule as the list: the history of what was archived is for who may archive
    conversationFilterWhere(store.id, filter, viewerOf(user.id, held))
    const filters: ConversationsExportFilters = {
      filter,
      viewer: { userId: user.id, held: viewPermissionsOf(held) }
    }
    return this.exports.request({
      storeId: store.id,
      userId: user.id,
      type: ExportTypes.CONVERSATIONS,
      format: ExportFormats.CSV,
      filters
    })
  }

  // countsOnly=true answers the numbers beside the filters instead of a page
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Get(ApiRoutes.conversations.list)
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(listConversationsQuerySchema)) query: ListConversationsQuery
  ): Promise<WithAnonymousPage<ConversationPage> | ConversationCounts> {
    const viewer = viewerOf(user.id, held)
    return query.countsOnly
      ? this.counts.counts(store.id, viewer)
      : this.conversations
          .list(store.id, query, viewer)
          .then(page => withAnonymousPage(this.anonymity, page))
  }

  // Declared before `:id` routes, or "bulk" would be read as an id. The answer says which
  // conversations changed and which did not, with our error code for each.
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
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
  @NoStore()
  @Get(ApiRoutes.conversations.byId(':id'))
  get(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .get(store.id, conversationId, viewerOf(user.id, held))
      .then(detail => this.marked(detail))
  }

  // The manual deletion (TDD_05 §10.4): the conversation, its messages and its files are gone for good. The
  // interface asks for the typed phrase first (DestructiveActionTiers.DELETE_CONVERSATION); the permission is
  // what the server keeps. It reaches every conversation of the store, not only the ones the caller may see.
  @RequirePermissions(Permissions.CONVERSATIONS_DELETE)
  @NoStore()
  @NoTenantTransaction(
    'deletes the files of the conversation from the bucket: the rows go in one unit of the service with its own time limit, and the bucket is called after it with no context open'
  )
  @Delete(ApiRoutes.conversations.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async deleteConversation(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) conversationId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.deletion.delete(store.id, conversationId, actorOf(user, store, req))
  }

  // The ads and posts the customer came from, for the card on top of the thread
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @NoStore()
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
  @NoStore()
  @Patch(ApiRoutes.conversations.status(':id'))
  changeStatus(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(changeStatusSchema)) body: ChangeStatusBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.statusChange
      .change(store.id, conversationId, body, viewerOf(user.id, held), actorOf(user, store, req))
      .then(detail => this.marked(detail))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_SNOOZE)
  @NoStore()
  @Post(ApiRoutes.conversations.snooze(':id'))
  @HttpCode(HttpStatusCodes.OK)
  snooze(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(snoozeSchema)) body: SnoozeBody
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .snooze(store.id, conversationId, body.until, viewerOf(user.id, held), body.note ?? null)
      .then(detail => this.marked(detail))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Patch(ApiRoutes.conversations.assign(':id'))
  assign(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignBody
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .assign(store.id, conversationId, body.userId, viewerOf(user.id, held))
      .then(detail => this.marked(detail))
  }

  // It writes what the whole team sees (the unread count), so it is for who works the conversation
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @NoStore()
  @Post(ApiRoutes.conversations.read(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async read(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<WithAnonymous<ConversationDetail>> {
    const detail = await this.conversations.markRead(
      store.id,
      conversationId,
      viewerOf(user.id, held)
    )
    // After the read is stored and only for who could read it: the customer's channel is told too.
    // Awaited, because they read in the tenant transaction of this request, which closes with the answer; a slow
    // or unreachable Redis does not hold it (queueFor leaves the queueing running), and both log their own
    // failures and never reject.
    await this.readReceipts.queueFor(store.id, conversationId)
    await this.widgetRead.notify(store.id, conversationId)
    return this.marked(detail)
  }

  // Keeps a conversation to come back to: it counts as unread again, for the whole team
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @NoStore()
  @Post(ApiRoutes.conversations.unread(':id'))
  @HttpCode(HttpStatusCodes.OK)
  unread(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) conversationId: string
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .markUnread(store.id, conversationId, viewerOf(user.id, held))
      .then(detail => this.marked(detail))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @NoStore()
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
  @NoStore()
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
