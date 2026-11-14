import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { CONVERSATION_RESOURCE_TYPE } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { isHiddenStatus, lockConversationForWrite } from '@platform/core/messaging'
import { StorageService } from '@platform/core/storage-module'

import type { Actor } from '../tenancy'

// What the worker wrote under `Media.variants`: the keys of the sizes of a picture
const variantsSchema = z.object({
  full: z.string().optional(),
  medium: z.string().optional(),
  thumb: z.string().optional()
})

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
    const outcome = await this.prisma.transaction(async tx => {
      // No viewer: the permission to delete reaches every conversation of the store. One of another store is one
      // that does not exist.
      const locked = await lockConversationForWrite(tx, storeId, conversationId)
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId, storeId },
        select: { customerId: true, channelType: true }
      })
      const messages = await tx.message.findMany({
        where: { conversationId, storeId },
        select: { id: true }
      })
      const origins = await tx.conversationOrigin.findMany({
        where: { conversationId, storeId },
        select: { id: true }
      })
      const messageIds = messages.map(message => message.id)
      const originIds = origins.map(origin => origin.id)
      // The files are rows of their own that point at the message with no cascade (a file may outlive its message
      // in the gallery of other places), so they are found and deleted here, and so are the pictures of the ads
      const files = await tx.media.findMany({
        where: {
          storeId,
          OR: [{ messageId: { in: messageIds } }, { originId: { in: originIds } }]
        },
        select: { id: true, key: true, variants: true }
      })
      await tx.media.deleteMany({ where: { id: { in: files.map(file => file.id) } } })
      // An order keeps its place in the customer's history and forgets only the conversation it came from
      await tx.order.updateMany({
        where: { storeId, conversationId },
        data: { conversationId: null }
      })
      // Messages, reactions, revisions, origins and the links of the tags go with it (onDelete: Cascade)
      await tx.conversation.delete({ where: { id: conversationId, storeId } })
      this.events.publish(tx, Events.CONVERSATION_DELETED, {
        storeId,
        conversationId,
        customerId: conversation.customerId,
        visibility: { hidden: isHiddenStatus(locked.status), assignedTo: locked.assignedTo }
      })
      return {
        counts: { messages: messageIds.length, files: files.length },
        keys: files.flatMap(file => keysOf(file.key, file.variants)),
        channelType: conversation.channelType,
        customerId: conversation.customerId
      }
    })

    // After the commit and never waited on for its result: a key that is not deleted here is a stray object, and the
    // orphan cleanup of the worker removes it. The rows are gone either way, so nothing can be served from them.
    await this.deleteObjects(outcome.keys)

    this.audit.log({
      action: AuditAction.CONVERSATION_DELETED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: CONVERSATION_RESOURCE_TYPE,
      resourceId: conversationId,
      // Numbers and ids, never text: what the customer wrote is what was deleted
      metadata: {
        customerId: outcome.customerId,
        channelType: outcome.channelType,
        messages: outcome.counts.messages,
        files: outcome.counts.files
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return outcome.counts
  }

  private async deleteObjects(keys: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(keys.map(key => this.storage.delete(key)))
    const failed = results.filter(result => result.status === 'rejected').length
    if (failed > 0) {
      this.logger.warn(
        { failed, total: keys.length },
        'some files of a deleted conversation were left in storage for the orphan cleanup'
      )
    }
  }
}

function keysOf(key: string, variants: unknown): string[] {
  const parsed = variantsSchema.safeParse(variants)
  const sizes = parsed.success ? Object.values(parsed.data) : []
  return [...new Set([key, ...sizes.filter((size): size is string => typeof size === 'string')])]
}
