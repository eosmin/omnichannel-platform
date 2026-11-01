import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { BulkActions, BulkLimits, ConversationStatus } from '@platform/core/domain'
import { errorName, ErrorCodes, PlatformException } from '@platform/core/errors'
import {
  type BulkActionBody,
  type ConversationsExportFilters,
  ConversationsService,
  ReadReceipts,
  requireAnyPermission,
  RoutingService,
  type Viewer,
  viewPermissionsOf
} from '@platform/core/messaging'
import { ExportFormats, ExportTypes } from '@platform/core/queues'

import { ExportsService } from '../exports'
import type { Actor } from '../tenancy'
import { WidgetReadNotifier } from '../widget/widget-read-notifier.service'

import { ConversationTagsService } from './conversation-tags.service'

export interface BulkFailure {
  id: string
  code: string
}

// A bulk action does not stop at the first conversation it cannot change: each one is a change of its
// own, and the answer says which went through and which did not, with the reason.
export interface BulkResult {
  succeeded: string[]
  failed: BulkFailure[]
  // True when the filter matched more conversations than BulkLimits.MAX_ITEMS allows
  truncated: boolean
}

// What an action needs on top of seeing each conversation, checked once before anything changes. The
// ones missing here (assigning to oneself, a status, archiving) are checked by the service that makes
// the change, which knows the rule for each conversation.
const UP_FRONT_PERMISSIONS: Partial<Record<BulkActionBody['action'], Permission>> = {
  [BulkActions.ROUND_ROBIN_TO_TEAM]: Permissions.CONVERSATIONS_ASSIGN,
  [BulkActions.ADD_TAG]: Permissions.CONVERSATIONS_RESOLVE,
  [BulkActions.REMOVE_TAG]: Permissions.CONVERSATIONS_RESOLVE,
  [BulkActions.MARK_READ]: Permissions.CONVERSATIONS_RESOLVE,
  [BulkActions.MARK_UNREAD]: Permissions.CONVERSATIONS_RESOLVE,
  [BulkActions.EXPORT_CSV]: Permissions.CONVERSATIONS_EXPORT
}

// "Select all matching this filter" and the ids the agent ticked, one by one through the same services
// the single-conversation routes use, so every rule of those routes holds here too.
@Injectable()
export class ConversationBulkService {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly routing: RoutingService,
    private readonly tags: ConversationTagsService,
    private readonly readReceipts: ReadReceipts,
    private readonly widgetRead: WidgetReadNotifier,
    private readonly exports: ExportsService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ConversationBulkService.name)
  }

  async run(
    storeId: string,
    body: BulkActionBody,
    viewer: Viewer,
    actor: Actor
  ): Promise<BulkResult> {
    const needed = UP_FRONT_PERMISSIONS[body.action]
    if (needed !== undefined) requireAnyPermission(viewer.held, [needed])

    const { ids, truncated } = await this.targets(storeId, body, viewer)
    const result: BulkResult =
      body.action === BulkActions.EXPORT_CSV
        ? await this.exportSelection(
            storeId,
            ids,
            truncated,
            body.filter !== undefined,
            viewer,
            actor
          )
        : await this.applyEach(storeId, ids, truncated, body, viewer)
    this.audit.log({
      action: AuditAction.BULK_ACTION_EXECUTED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'conversation',
      metadata: {
        action: body.action,
        requested: ids.length,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
        byFilter: body.filter !== undefined,
        // What was asked, to be told apart afterwards: who got them, which tag, which status, which filter
        ...('params' in body ? { params: body.params } : {}),
        ...(body.filter === undefined ? {} : { filter: body.filter })
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return result
  }

  // One at a time: each change takes the locks of its conversation, and two that ran together on the
  // same store would only wait for each other
  private async applyEach(
    storeId: string,
    ids: readonly string[],
    truncated: boolean,
    body: BulkActionBody,
    viewer: Viewer
  ): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [], truncated }
    for (const id of ids) {
      try {
        await this.apply(storeId, id, body, viewer)
        result.succeeded.push(id)
      } catch (error) {
        const code = codeOf(error)
        // What is ours (a deadlock, a timeout) is said here; the caller gets the code only
        if (code === ErrorCodes.INTERNAL_ERROR) {
          this.logger.error(
            { conversationId: id, action: body.action, errorName: errorName(error) },
            'a conversation of a bulk action was not changed'
          )
        }
        result.failed.push({ id, code })
      }
    }
    return result
  }

  // Changes nothing: queues one file for the conversations the member may see, and says which of the
  // others were left out, as a conversation that "does not exist" for them (the single routes' answer).
  // The row freezes the ids that passed and the permissions that decide what the file holds.
  private async exportSelection(
    storeId: string,
    ids: readonly string[],
    truncated: boolean,
    // The ids came from the filter with the viewer's view: they are all visible already
    fromFilter: boolean,
    viewer: Viewer,
    actor: Actor
  ): Promise<BulkResult> {
    const visible = fromFilter
      ? new Set(ids)
      : await this.conversations.visibleAmong(storeId, ids, viewer)
    const result: BulkResult = {
      succeeded: ids.filter(id => visible.has(id)),
      failed: ids
        .filter(id => !visible.has(id))
        .map(id => ({ id, code: ErrorCodes.RESOURCE_NOT_FOUND })),
      truncated
    }
    if (result.succeeded.length === 0) return result
    const filters: ConversationsExportFilters = {
      filter: {},
      conversationIds: result.succeeded,
      viewer: { userId: viewer.userId, held: viewPermissionsOf(viewer.held) }
    }
    await this.exports.request({
      storeId,
      userId: actor.userId,
      type: ExportTypes.CONVERSATIONS,
      format: ExportFormats.CSV,
      filters
    })
    return result
  }

  private async targets(
    storeId: string,
    body: BulkActionBody,
    viewer: Viewer
  ): Promise<{ ids: string[]; truncated: boolean }> {
    if (body.conversationIds !== undefined) return { ids: body.conversationIds, truncated: false }
    // One more than the cap says whether the filter reached further than the action does
    const matched = await this.conversations.idsMatching(
      storeId,
      body.filter ?? {},
      viewer,
      BulkLimits.MAX_ITEMS + 1
    )
    return {
      ids: matched.slice(0, BulkLimits.MAX_ITEMS),
      truncated: matched.length > BulkLimits.MAX_ITEMS
    }
  }

  private async apply(
    storeId: string,
    conversationId: string,
    body: BulkActionBody,
    viewer: Viewer
  ): Promise<void> {
    switch (body.action) {
      case BulkActions.ASSIGN_TO_ME:
        await this.conversations.assign(storeId, conversationId, viewer.userId, viewer)
        return
      case BulkActions.ASSIGN_TO_AGENT:
        await this.conversations.assign(storeId, conversationId, body.params.userId, viewer)
        return
      case BulkActions.ROUND_ROBIN_TO_TEAM:
        await this.routing.assignRoundRobin(storeId, conversationId, body.params.userIds, viewer)
        return
      case BulkActions.UNASSIGN:
        await this.conversations.assign(storeId, conversationId, null, viewer)
        return
      case BulkActions.SET_STATUS:
        await this.conversations.updateStatus(storeId, conversationId, body.params.status, {
          actor: viewer
        })
        return
      case BulkActions.ARCHIVE:
        await this.conversations.updateStatus(
          storeId,
          conversationId,
          ConversationStatus.ARCHIVED,
          {
            actor: viewer
          }
        )
        return
      case BulkActions.ADD_TAG:
        await this.tags.attach(storeId, conversationId, body.params.tagId, viewer)
        return
      case BulkActions.REMOVE_TAG:
        await this.tags.detach(storeId, conversationId, body.params.tagId, viewer)
        return
      case BulkActions.MARK_READ:
        await this.conversations.markRead(storeId, conversationId, viewer)
        // Not awaited, as the route of one conversation does: queueFor logs its own failures
        void this.readReceipts.queueFor(storeId, conversationId)
        void this.widgetRead.notify(storeId, conversationId)
        return
      case BulkActions.MARK_UNREAD:
        await this.conversations.markUnread(storeId, conversationId, viewer)
        return
      case BulkActions.EXPORT_CSV:
        // run() makes the file for the whole selection; reaching here would be a silent no-op
        throw new Error('EXPORT_CSV is not applied one conversation at a time')
    }
  }
}

// What the caller is told about a conversation that did not change: our code, never the text of an
// error that was not ours
function codeOf(error: unknown): string {
  return error instanceof PlatformException ? error.code : ErrorCodes.INTERNAL_ERROR
}
