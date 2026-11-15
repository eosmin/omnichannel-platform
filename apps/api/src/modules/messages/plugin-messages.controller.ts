import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { PluginApiRoutes } from '@platform/core/api'
import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { AuthorType, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { MULTI_FILE_SEND_ENABLED, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  fileIndexSchema,
  MediaRefetchService,
  MessageChangesService,
  type MessageView,
  MessagesService,
  type PluginCreateMessageBody,
  pluginCreateMessageSchema,
  pluginMessageOf,
  pluginViewerOf,
  type RevisionView
} from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'

import { channelFileLimits } from './channel-file-limits'

// What a plugin reads of an edit: the text it had, by what kind of author and when; never the person
export type PluginRevisionView = Omit<RevisionView, 'editedById'>

interface PluginCaller {
  id: string
  pluginId: string
}

// What a plugin does with the messages of a conversation of its store, through its key (TDD_10 §6.4). The same services as the
// routes of the people, with a viewer made of the permissions of the scopes (`pluginViewerOf`: no user), so a plugin sees what
// `conversations:read` shows and writes what `messages:write` allows, and nothing else. To see a conversation a plugin needs
// `conversations:read` as well as the scope of the message, because the service asks for it exactly as for a person.
//
// Not here yet, with the reason (Step 5.6, "Left by PR M1b"): editing, sending again, discarding and reacting write the id of the
// person who did it (`editedById`, `deletedById`, the author of the reaction, the one that reopens the conversation), and a
// plugin is not a person; they need an actor of their own in the core first.
@Controller()
export class PluginMessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly refetches: MediaRefetchService,
    private readonly changes: MessageChangesService,
    private readonly registry: PluginRegistry,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(MULTI_FILE_SEND_ENABLED) private readonly multiFileEnabled: boolean
  ) {}

  // 201 for a new message, 200 for the one a repeated idempotencyKey already made (and then nothing is audited twice)
  @PluginApi(PluginScopes.MESSAGES_WRITE, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Post(PluginApiRoutes.messages.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(pluginCreateMessageSchema)) body: PluginCreateMessageBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<MessageView> {
    const plugin = await this.prisma.client.plugin.findUnique({
      where: { id: installation.pluginId },
      select: { name: true }
    })
    const { body: message, origin } = pluginMessageOf(body, {
      id: installation.pluginId,
      name: plugin?.name ?? installation.pluginId
    })
    const { message: created, created: isNew } = await this.messages.create(
      store.id,
      message,
      pluginViewerOf(held),
      undefined,
      (channel, capability) => this.registry.hasCapability(channel, capability),
      channelFileLimits(this.registry, this.multiFileEnabled),
      channelType => this.registry.limitsOf(channelType),
      origin
    )
    if (!isNew) {
      res.status(HttpStatusCodes.OK)
      return created
    }
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_SENT, store.id, created.id, installation, req, {
      conversationId: message.conversationId,
      type: message.type,
      authorType: origin.author,
      quiet: origin.quiet,
      ...(origin.author === AuthorType.AGENT ? { userId: origin.userId } : {})
    })
    return created
  }

  // "Send the text again" on a file whose caption failed or may not have gone
  @PluginApi(PluginScopes.MESSAGES_WRITE, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND)
  @Post(PluginApiRoutes.messages.resendCaption(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async resendCaption(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<MessageView> {
    const message = await this.messages.resendCaption(store.id, messageId, pluginViewerOf(held))
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: 'resend_caption'
    })
    return message
  }

  // "Download it again" on a file of the customer that was lost
  @PluginApi(PluginScopes.MESSAGES_WRITE, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND)
  @Post(PluginApiRoutes.messages.refetchFile(':id', ':index'))
  @HttpCode(HttpStatusCodes.OK)
  async refetchFile(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Param('index', new ZodValidationPipe(fileIndexSchema)) index: number,
    @Req() req: AuthenticatedRequest
  ): Promise<MessageView> {
    const message = await this.refetches.refetch(store.id, messageId, index, pluginViewerOf(held))
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: 'refetch_file',
      index
    })
    return message
  }

  // The text of a message the customer deleted, while it is kept. Every read is audited, with the plugin on the metadata.
  @PluginApi(PluginScopes.MESSAGES_READ_DELETED, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW_DELETED)
  @Get(PluginApiRoutes.messages.deletedContent(':id'))
  async deletedContent(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ content: string | null }> {
    const result = await this.changes.deletedContent(store.id, messageId, pluginViewerOf(held))
    this.auditPlugin(
      AuditAction.MESSAGE_DELETED_CONTENT_VIEWED,
      store.id,
      messageId,
      installation,
      req
    )
    return result
  }

  // The earlier texts of an edited message. Who edited is not given: a plugin has no scope to learn the ids of the staff, and the id
  // of a person is what `authorType: agent` of the create route asks for
  @PluginApi(PluginScopes.MESSAGES_READ, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW)
  @Get(PluginApiRoutes.messages.revisions(':id'))
  async revisions(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string
  ): Promise<PluginRevisionView[]> {
    const revisions = await this.changes.revisions(store.id, messageId, pluginViewerOf(held))
    return revisions.map(({ version, content, editedByType, createdAt }) => ({
      version,
      content,
      editedByType,
      createdAt
    }))
  }

  // The trail of what a plugin did: the actor is the platform (nobody is signed in), the plugin and its installation are on the
  // metadata, and never the text of a message
  private auditPlugin(
    action: AuditActionType,
    storeId: string,
    messageId: string,
    installation: PluginCaller,
    req: AuthenticatedRequest,
    extra: Record<string, unknown> = {}
  ): void {
    const userAgent = req.get('user-agent')
    this.audit.log({
      action,
      actor: { system: true },
      storeId,
      resourceType: 'message',
      resourceId: messageId,
      metadata: { pluginId: installation.pluginId, installationId: installation.id, ...extra },
      ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
      ...(userAgent === undefined ? {} : { userAgent })
    })
  }
}
