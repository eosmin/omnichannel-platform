import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { RetentionRun } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { CONVERSATION_RESOURCE_TYPE } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { isHiddenStatus, lockConversationForWrite } from '@platform/core/messaging'
import { filesOfConversationsWhere, objectKeysOf } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import type { Actor } from '../tenancy'

// What a manual deletion removed, in numbers only
export interface ConversationDeletion {
  messages: number
  files: number
}

// The manual deletion of a conversation (TDD_05 §10.4, Step 5.4): the conversation, every message and note
// in it, the reactions, the revisions, the ads it came from and the files of all of them, in one transaction.
// What it does not touch: the customer (their other conversations stay), the orders of the customer (an order
// that was made from this conversation only forgets which one), and the audit log, which keeps one entry that
// says who deleted it and how much, never what it held.
@Injectable()
export class ConversationDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobContext,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ConversationDeletionService.name)
  }

  async delete(
    storeId: string,
    conversationId: string,
    actor: Actor
  ): Promise<ConversationDeletion> {
    // The rows in ONE unit of their own (the route is @NoTenantTransaction); the audit entry and the bucket come after it, with no context
    const outcome = await this.jobs.forStoreOrJoin(
      storeId,
      async () => {
        const done = await this.prisma.transaction(async tx => {
          // No viewer: the permission to delete reaches every conversation of the store. One of another store is one
          // that does not exist.
          const locked = await lockConversationForWrite(tx, storeId, conversationId)
          const conversation = await tx.conversation.findUniqueOrThrow({
            where: { id: conversationId, storeId },
            select: { customerId: true, channelType: true }
          })
          const messageCount = await tx.message.count({ where: { conversationId, storeId } })
          // The files are rows of their own that point at the message with no cascade (a file may outlive its message
          // in the gallery of other places), so they are found and deleted here, and so are the pictures of the ads.
          // Found through the conversation, never through a list of ids: a conversation of any length is one query.
          // The documents of an order (its summary, sent as a message) belong to the order: they keep their row and only
          // lose the message they were sent with (`Media.message` is SET NULL). The same rule as the nightly retention.
          const filesOfConversation = filesOfConversationsWhere(storeId, [conversationId])
          const files = await tx.media.findMany({
            where: filesOfConversation,
            select: { key: true, variants: true }
          })
          await tx.media.deleteMany({ where: filesOfConversation })
          // An order keeps its place in the customer's history and forgets only the conversation it came from
          // (written raw so that the link going away is not a change of the order: its `updated_at` stays)
          await tx.$executeRaw`
        UPDATE orders SET conversation_id = NULL WHERE store_id = ${storeId} AND conversation_id = ${conversationId}`
          // Messages, reactions, revisions, origins and the links of the tags go with it (onDelete: Cascade)
          await tx.conversation.delete({ where: { id: conversationId, storeId } })
          this.events.publish(tx, Events.CONVERSATION_DELETED, {
            storeId,
            conversationId,
            customerId: conversation.customerId,
            visibility: { hidden: isHiddenStatus(locked.status), assignedTo: locked.assignedTo }
          })
          // Only keys under the store's own prefix are deleted: a damaged `variants` column cannot name the files of
          // another store or of a person
          const named = files.map(file => objectKeysOf(storeId, file))
          return {
            counts: { messages: messageCount, files: files.length },
            keys: named.flatMap(item => item.keys),
            foreign: named.reduce((total, item) => total + item.foreign.length, 0),
            channelType: conversation.channelType,
            customerId: conversation.customerId
          }
        })
        // Queued with the unit: the deletion and its entry commit together, so a deletion of customer data is never without its record.
        // Numbers and ids, never text: what the customer wrote is what was deleted
        this.audit.log({
          action: AuditAction.CONVERSATION_DELETED,
          actor: { userId: actor.userId },
          storeId,
          resourceType: CONVERSATION_RESOURCE_TYPE,
          resourceId: conversationId,
          metadata: {
            customerId: done.customerId,
            channelType: done.channelType,
            messages: done.counts.messages,
            files: done.counts.files
          },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent
        })
        return done
      },
      { timeout: RetentionRun.TRANSACTION_TIMEOUT_MS }
    )

    if (outcome.foreign > 0) {
      this.logger.warn(
        { storeId, count: outcome.foreign },
        'a file of a deleted conversation has a key outside the store and was left in the bucket'
      )
    }
    // Chunked, like the retention run: a conversation can hold thousands of files. A key that is not deleted is a
    // stray object, and the orphan cleanup of the worker removes it; the rows and the entry are gone either way.
    await this.deleteObjects(outcome.keys)
    return outcome.counts
  }

  private async deleteObjects(keys: readonly string[]): Promise<void> {
    let failed = 0
    for (let at = 0; at < keys.length; at += RetentionRun.FILE_DELETE_CONCURRENCY) {
      const chunk = keys.slice(at, at + RetentionRun.FILE_DELETE_CONCURRENCY)
      const results = await Promise.allSettled(chunk.map(key => this.storage.delete(key)))
      failed += results.filter(result => result.status === 'rejected').length
    }
    if (failed > 0) {
      this.logger.warn(
        { failed, total: keys.length },
        'some files of a deleted conversation were left in storage for the orphan cleanup'
      )
    }
  }
}
