import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ConversationStatus } from '@platform/core/domain'
import {
  type ChangeStatusBody,
  ConversationClosingService,
  type ConversationDetail,
  ConversationsService,
  type StatusTransition,
  type Viewer
} from '@platform/core/messaging'

import { type Actor, auditActorOf, auditViaOf } from '../tenancy'

// The change of status of one conversation, for the person at the inbox and for a plugin: the same service, the same audit entry.
// The log says what the service did, once it committed: a resolution that happened, or the Undo of one (and whether the thread
// kept a line of it), never a request that changed nothing.
@Injectable()
export class ConversationStatusChangeService {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly closing: ConversationClosingService,
    private readonly audit: AuditService
  ) {}

  change(
    storeId: string,
    conversationId: string,
    body: ChangeStatusBody,
    viewer: Viewer,
    actor: Actor
  ): Promise<ConversationDetail> {
    const options = {
      actor: viewer,
      ...(body.resolutionReason === undefined ? {} : { resolutionReason: body.resolutionReason }),
      ...(body.undoesResolution === undefined ? {} : { undoesResolution: true }),
      afterTransition: ({ from, to, retracted }: StatusTransition) => {
        const resolved = to === ConversationStatus.RESOLVED
        const undone =
          body.undoesResolution === true &&
          from === ConversationStatus.RESOLVED &&
          to === ConversationStatus.OPEN
        if (!resolved && !undone) return
        // An Undo that the thread did not take back (late, or not the resolver's) is a reopening: the
        // audit log says so, as the thread does with its own line
        const action = resolved
          ? AuditAction.CONVERSATION_RESOLVED
          : retracted
            ? AuditAction.CONVERSATION_RESOLVE_UNDONE
            : AuditAction.CONVERSATION_REOPENED
        this.audit.log({
          action,
          actor: auditActorOf(actor),
          storeId,
          resourceType: 'conversation',
          resourceId: conversationId,
          metadata: { ...auditViaOf(actor), ...(undone && retracted ? { silent: true } : {}) },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent
        })
      }
    }
    return body.closingSnippetId !== undefined
      ? this.closing.resolve(storeId, conversationId, body.closingSnippetId, options)
      : this.conversations.updateStatus(storeId, conversationId, body.status, options)
  }
}
