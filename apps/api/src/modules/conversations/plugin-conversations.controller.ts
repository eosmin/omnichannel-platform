import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res
} from '@nestjs/common'
import type { Response } from 'express'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { CHANNEL_ANONYMITY, type ChannelAnonymitySource, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  type AssignBody,
  assignSchema,
  type AttachTagBody,
  attachTagSchema,
  type ChangeStatusBody,
  type ConversationCounts,
  type ConversationDetail,
  type ConversationPage,
  ConversationsService,
  type ListConversationsQuery,
  listConversationsQuerySchema,
  type SnoozeBody,
  snoozeSchema,
  type Viewer
} from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  type WithAnonymous,
  withAnonymousCustomers,
  withAnonymousPage,
  type WithAnonymousPage
} from '../channel-registry'
import {
  CurrentPluginInstallation,
  CurrentPluginViewer,
  PluginApi
} from '../plugins/plugin-api.decorators'
import { CurrentStore, pluginActorOf, RequirePermissions } from '../tenancy'

import { type BulkResult, ConversationBulkService } from './conversation-bulk.service'
import { ConversationCountsService } from './conversation-counts.service'
import { ConversationOriginsService, type OriginView } from './conversation-origins.service'
import { ConversationStartService } from './conversation-start.service'
import { ConversationStatusChangeService } from './conversation-status-change.service'
import { type ConversationTag, ConversationTagsService } from './conversation-tags.service'
import {
  type PluginBulkBody,
  pluginBulkActionSchema,
  pluginChangeStatusSchema,
  type StartConversationBody,
  startConversationSchema
} from './plugin-conversations.schemas'

const id = () => new ZodValidationPipe(uuidSchema)

type Installation = { id: string }
type Store = { id: string }

const READ = PluginScopes.CONVERSATIONS_READ
const WRITE = PluginScopes.CONVERSATIONS_WRITE
const MESSAGES = PluginScopes.MESSAGES_READ

// The conversations of the store of the key (Step 5.6 PR E1), over the same services as the inbox. The plugin is the viewer
// `plugin:<installation id>`: it holds the permissions its scopes stand for, so it sees every conversation a person with
// CONVERSATIONS_VIEW_ALL sees, but not the archived or spam ones (CONVERSATIONS_ARCHIVE is in no scope), and it never matches
// an assignment. Reads take `conversations:read`; every route that changes something takes `conversations:write` AND
// `conversations:read`, because it answers with the conversation as it is now. A permission each method asks for is the one
// the same route of the inbox asks for.
@Controller()
export class PluginConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly statusChange: ConversationStatusChangeService,
    private readonly bulk: ConversationBulkService,
    private readonly counts: ConversationCountsService,
    private readonly tags: ConversationTagsService,
    private readonly origins: ConversationOriginsService,
    private readonly starter: ConversationStartService,
    @Inject(CHANNEL_ANONYMITY) private readonly anonymity: ChannelAnonymitySource
  ) {}

  private marked(detail: ConversationDetail): WithAnonymous<ConversationDetail> {
    return withAnonymousCustomers(this.anonymity, detail)
  }

  // countsOnly=true answers the numbers beside the filters instead of a page
  @PluginApi(READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.conversations.list)
  list(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Query(new ZodValidationPipe(listConversationsQuerySchema)) query: ListConversationsQuery
  ): Promise<WithAnonymousPage<ConversationPage> | ConversationCounts> {
    return query.countsOnly
      ? this.counts.counts(store.id, viewer)
      : this.conversations
          .list(store.id, query, viewer)
          .then(page => withAnonymousPage(this.anonymity, page))
  }

  // The first route that starts a conversation (Q6): the handle of a customer on an account of the store. `conversations:write`
  // stands for CONVERSATIONS_CREATE. 201 when it made one, 200 when the thread of that handle on that account already existed.
  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_CREATE)
  @Post(PluginApiRoutes.conversations.list)
  async start(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Body(new ZodValidationPipe(startConversationSchema)) body: StartConversationBody,
    @Res({ passthrough: true }) response: Response
  ): Promise<{ created: boolean; conversation: WithAnonymous<ConversationDetail> }> {
    const started = await this.starter.start(store.id, body, viewer)
    response.status(started.created ? HttpStatusCodes.CREATED : HttpStatusCodes.OK)
    return { created: started.created, conversation: this.marked(started.conversation) }
  }

  // Declared before the `:id` routes, or "bulk" would be read as an id. Not the CSV and not "assign to me" (see the schema).
  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Post(PluginApiRoutes.conversations.bulk)
  @HttpCode(HttpStatusCodes.OK)
  runBulk(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPluginViewer() viewer: Viewer,
    @Body(new ZodValidationPipe(pluginBulkActionSchema)) body: PluginBulkBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BulkResult> {
    return this.bulk.run(store.id, body, viewer, pluginActorOf(installation, store, req))
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.conversations.byId(':id'))
  get(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .get(store.id, conversationId, viewer)
      .then(detail => this.marked(detail))
  }

  // The ads and posts the customer came from: the messages are read too, as for a person
  @PluginApi(READ, MESSAGES)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @Get(PluginApiRoutes.conversations.origins(':id'))
  listOrigins(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string
  ): Promise<OriginView[]> {
    return this.origins.list(store.id, conversationId, viewer)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Patch(PluginApiRoutes.conversations.status(':id'))
  changeStatus(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(pluginChangeStatusSchema)) body: ChangeStatusBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.statusChange
      .change(store.id, conversationId, body, viewer, pluginActorOf(installation, store, req))
      .then(detail => this.marked(detail))
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_SNOOZE)
  @Post(PluginApiRoutes.conversations.snooze(':id'))
  @HttpCode(HttpStatusCodes.OK)
  snooze(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(snoozeSchema)) body: SnoozeBody
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .snooze(store.id, conversationId, body.until, viewer, body.note ?? null)
      .then(detail => this.marked(detail))
  }

  // To a person of the store, or to nobody (null). The service checks that the person is a member and that the plugin may assign.
  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Patch(PluginApiRoutes.conversations.assign(':id'))
  assign(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignBody
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .assign(store.id, conversationId, body.userId, viewer)
      .then(detail => this.marked(detail))
  }

  // Writes what the whole team sees (the unread count). Unlike the inbox, no read receipt goes to the customer's channel: an
  // automation that only reads must not tell the customer that a person saw the message
  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Post(PluginApiRoutes.conversations.read(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async read(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string
  ): Promise<WithAnonymous<ConversationDetail>> {
    const detail = await this.conversations.markRead(store.id, conversationId, viewer)
    return this.marked(detail)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Post(PluginApiRoutes.conversations.unread(':id'))
  @HttpCode(HttpStatusCodes.OK)
  unread(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string
  ): Promise<WithAnonymous<ConversationDetail>> {
    return this.conversations
      .markUnread(store.id, conversationId, viewer)
      .then(detail => this.marked(detail))
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Post(PluginApiRoutes.conversations.tags(':id'))
  @HttpCode(HttpStatusCodes.OK)
  attachTag(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string,
    @Body(new ZodValidationPipe(attachTagSchema)) body: AttachTagBody
  ): Promise<ConversationTag[]> {
    return this.tags.attach(store.id, conversationId, body.tagId, viewer)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE)
  @Delete(PluginApiRoutes.conversations.tagById(':id', ':tagId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async detachTag(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) conversationId: string,
    @Param('tagId', id()) tagId: string
  ): Promise<void> {
    await this.tags.detach(store.id, conversationId, tagId, viewer)
  }
}
