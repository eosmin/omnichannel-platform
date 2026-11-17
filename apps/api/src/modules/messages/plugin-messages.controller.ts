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
  Put,
  Req,
  Res
} from '@nestjs/common'
import type { Response } from 'express'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { PluginApiRoutes } from '@platform/core/api'
import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  AuthorType,
  ChannelCapability,
  PluginApiDenialReasons,
  PluginMessageOperations,
  uuidSchema
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { MULTI_FILE_SEND_ENABLED, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  AgentReactionsService,
  type EditMessageBody,
  editMessageSchema,
  fileIndexSchema,
  MediaRefetchService,
  MessageChangesService,
  type MessageView,
  MessagesService,
  type PluginCreateMessageBody,
  pluginCreateMessageSchema,
  pluginMessageOf,
  pluginMessageViewOf,
  pluginViewerOf,
  type ReactToMessageBody,
  reactToMessageSchema,
  type RevisionView
} from '@platform/core/messaging'
import { REDIS_CLIENT } from '@platform/core/redis'
import { PluginRegistry } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { auditPluginDenial } from '../plugins/plugin-denial-audit'
import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'
import { pluginUserId } from '../tenancy/actor'

import { channelFileLimits } from './channel-file-limits'

// What a plugin reads of an edit: the text it had, by what kind of author and when; never the person
export type PluginRevisionView = Omit<RevisionView, 'editedById' | 'editedByPluginId'>

interface PluginCaller {
  id: string
  pluginId: string
  scopes: readonly string[]
}

// What a plugin does with the messages of a conversation of its store, through its key (TDD_10 §6.4). The same services as the
// routes of the people, with a viewer made of the permissions of the scopes (`pluginViewerOf`: no user), so a plugin sees what
// `conversations:read` shows and writes what `messages:write` allows, and nothing else. To see a conversation a plugin needs
// `conversations:read` as well as the scope of the message, because the service asks for it exactly as for a person.
//
// Editing, sending again, discarding, reacting and deleting (PR M1c) record WHO did it, and the viewer made here carries the plugin
// (`pluginViewerOf(held, pluginId)`), so the services write the plugin and never a person's id (`actorOfViewer`). A plugin changes
// only the messages it wrote; it may react to any message it can see.
@Controller()
export class PluginMessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly refetches: MediaRefetchService,
    private readonly changes: MessageChangesService,
    private readonly reactions: AgentReactionsService,
    private readonly registry: PluginRegistry,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(MULTI_FILE_SEND_ENABLED) private readonly multiFileEnabled: boolean
  ) {
    this.logger.setContext(PluginMessagesController.name)
  }

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
    // A file is the installation's own upload, which asked for `media:write`: a key that lost that scope since sends no file (the route
    // names `messages:write` only, because the same route carries text)
    if ('mediaIds' in body && !installation.scopes.includes(PluginScopes.MEDIA_WRITE)) {
      const missing = [PluginScopes.MEDIA_WRITE]
      // The same fields the guard logs for a scope it refuses (never the key), so that one search finds both
      this.logger.warn(
        {
          installationId: installation.id,
          pluginId: installation.pluginId,
          kind: PluginApiDenialReasons.SCOPE,
          missing
        },
        'a plugin key was refused for lack of access'
      )
      // And in the audit log, as the guard does for every other scope it refuses (capped the same way; never throws)
      await auditPluginDenial({ audit: this.audit, redis: this.redis, logger: this.logger }, req, {
        reason: PluginApiDenialReasons.SCOPE,
        installation: { id: installation.id, pluginId: installation.pluginId, storeId: store.id },
        missing
      })
      throw new PlatformException(
        ErrorCodes.PLUGIN_SCOPE_DENIED,
        'sending a file needs the scope media:write',
        HttpStatusCodes.FORBIDDEN,
        { required: missing }
      )
    }
    const plugin = await this.prisma.client.plugin.findUnique({
      where: { id: installation.pluginId },
      select: { name: true }
    })
    const { body: message, origin } = pluginMessageOf(body, {
      id: installation.pluginId,
      name: plugin?.name ?? installation.pluginId,
      // The files of the message are the ones this installation uploaded (`media:write`), owned by `plugin:<installation id>`
      uploaderId: pluginUserId(installation.id)
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
    const answer = this.quoted(installation, created)
    if (!isNew) {
      res.status(HttpStatusCodes.OK)
      return answer
    }
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_SENT, store.id, created.id, installation, req, {
      conversationId: message.conversationId,
      type: message.type,
      authorType: origin.author,
      quiet: origin.quiet,
      ...('mediaIds' in message ? { files: message.mediaIds.length } : {}),
      ...(origin.author === AuthorType.AGENT ? { userId: origin.userId } : {})
    })
    return answer
  }

  // The whole new text of a message or note the plugin wrote. A note carries the `version` it was read at (409 with the current text
  // if it changed); a reply the customer has changes only when the channel takes the edit, and the answer says `pendingEdit`.
  @PluginApi(PluginScopes.MESSAGES_WRITE, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Patch(PluginApiRoutes.messages.byId(':id'))
  async edit(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Body(new ZodValidationPipe(editMessageSchema)) body: EditMessageBody,
    @Req() req: AuthenticatedRequest
  ): Promise<MessageView> {
    const message = await this.changes.edit(
      store.id,
      messageId,
      body,
      pluginViewerOf(held, installation.pluginId),
      channel => this.registry.hasCapability(channel, ChannelCapability.EDIT_MESSAGE),
      channel => this.registry.limitsOf(channel)
    )
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: PluginMessageOperations.EDIT
    })
    return this.quoted(installation, message)
  }

  // Deletes for everyone a message the plugin wrote, or answers 409 when the channel cannot. Its own scope (`messages:delete`).
  @PluginApi(
    PluginScopes.MESSAGES_DELETE,
    PluginScopes.MESSAGES_WRITE,
    PluginScopes.CONVERSATIONS_READ
  )
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_DELETE)
  @Delete(PluginApiRoutes.messages.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.changes.remove(
      store.id,
      messageId,
      pluginViewerOf(held, installation.pluginId),
      channel => this.registry.hasCapability(channel, ChannelCapability.DELETE_MESSAGE)
    )
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: PluginMessageOperations.DELETE
    })
  }

  // "Send again" on a reply of the plugin that failed. The same message goes back to the channel; the conversation does not move
  @PluginApi(PluginScopes.MESSAGES_WRITE, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND)
  @Post(PluginApiRoutes.messages.resend(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async resend(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<MessageView> {
    const message = await this.messages.resend(
      store.id,
      messageId,
      pluginViewerOf(held, installation.pluginId)
    )
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: PluginMessageOperations.RESEND
    })
    return this.quoted(installation, message)
  }

  // "Discard" on a reply of the plugin that failed for good and never reached the customer. 409 when it may have gone; twice is once
  // (204 both times, one audit entry). Throwing away is deleting, so it needs the scope of deleting.
  @PluginApi(
    PluginScopes.MESSAGES_DELETE,
    PluginScopes.MESSAGES_WRITE,
    PluginScopes.CONVERSATIONS_READ
  )
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND)
  @Post(PluginApiRoutes.messages.discard(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async discard(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    const outcome = await this.changes.discard(
      store.id,
      messageId,
      pluginViewerOf(held, installation.pluginId)
    )
    if (!outcome.discarded) return
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: PluginMessageOperations.DISCARD,
      type: outcome.type,
      deliveryError: outcome.deliveryError
    })
  }

  // The reaction of the plugin to a message: `{ emoji }` sets it, `{ emoji: null }` takes it back. A plugin reacts as the system.
  @PluginApi(PluginScopes.MESSAGES_WRITE, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND)
  @Put(PluginApiRoutes.messages.reaction(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async react(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: PluginCaller,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Body(new ZodValidationPipe(reactToMessageSchema)) body: ReactToMessageBody,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.reactions.react(
      store.id,
      messageId,
      body.emoji,
      pluginViewerOf(held, installation.pluginId),
      channel => this.registry.hasCapability(channel, ChannelCapability.REACTIONS),
      body.mediaId
    )
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation:
        body.emoji === null ? PluginMessageOperations.UNREACT : PluginMessageOperations.REACT
    })
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
    const message = await this.messages.resendCaption(
      store.id,
      messageId,
      pluginViewerOf(held, installation.pluginId)
    )
    this.auditPlugin(AuditAction.MESSAGE_PLUGIN_CHANGED, store.id, messageId, installation, req, {
      operation: PluginMessageOperations.RESEND_CAPTION
    })
    return this.quoted(installation, message)
  }

  // "Download it again" on a file of the customer that was lost
  // The answer is the message of a CUSTOMER (its text, its places, its files), so this route reads messages: `messages:read` too
  @PluginApi(
    PluginScopes.MESSAGES_WRITE,
    PluginScopes.MESSAGES_READ,
    PluginScopes.CONVERSATIONS_READ
  )
  @RequirePermissions(
    Permissions.CONVERSATIONS_VIEW,
    Permissions.MESSAGES_SEND,
    Permissions.MESSAGES_VIEW
  )
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
      operation: PluginMessageOperations.REFETCH_FILE,
      index
    })
    return this.quoted(installation, message)
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

  // The message a write answers, held to what the key may read (`pluginMessageViewOf`)
  private quoted(installation: PluginCaller, message: MessageView): MessageView {
    return pluginMessageViewOf(message, installation.scopes.includes(PluginScopes.MESSAGES_READ))
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
