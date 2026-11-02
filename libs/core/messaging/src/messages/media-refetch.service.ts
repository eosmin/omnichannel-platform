import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { z } from 'zod'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { AuthorType, MediaRefetchLimits, UNAVAILABLE_FILES_KEY } from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { type FetchInboundMediaJob, JobNames, QueueNames } from '@platform/core/queues'

import { lockMessageRow } from '../changes/message-changed'
import {
  lockConversationForWrite,
  requireAnyPermission,
  type Viewer
} from '../conversations/conversations.support'

import { canRetryLostFile, lostFileEntrySchema } from './lost-files'
import { MESSAGE_SELECT, messageView, type MessageView } from './messages.views'

// The metadata as stored: what this version does not know is written back as it is
const storedMetadataSchema = z.record(z.string(), z.json())
const storedListSchema = z.array(z.record(z.string(), z.json()))

// The job of a request: one for each request of an agent (the time it was made), so that a request
// after a refused one is a new job and not the finished one under its old id
export const refetchJobId = (messageId: string, index: number, requestedAt: string): string =>
  `refetch-media-${messageId}-${index}-${Date.parse(requestedAt)}`

// "Download it again" on a file of the customer that was lost. The job is the one that fetched it the
// first time, built here from what the worker kept when it gave up (the id of the provider's media, the
// connection, the type and name) and never from the request: the caller names only the message and the
// place of the file. The worker checks the id as it did before, so the address block of the first fetch
// still stands.
@Injectable()
export class MediaRefetchService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<FetchInboundMediaJob>
  ) {}

  async refetch(
    storeId: string,
    messageId: string,
    index: number,
    viewer: Viewer
  ): Promise<MessageView> {
    // Before any lock: who may not send must not contend with those who write
    requireAnyPermission(viewer.held, [Permissions.MESSAGES_SEND])
    return this.prisma.transaction(async tx => {
      const found = await tx.message.findFirst({
        where: { id: messageId, storeId },
        select: { conversationId: true }
      })
      if (found === null) throw resourceNotFound('message')
      await lockConversationForWrite(tx, storeId, found.conversationId, viewer)
      await lockMessageRow(tx, messageId)
      const row = await tx.message.findFirst({
        where: { id: messageId, storeId },
        select: { ...MESSAGE_SELECT }
      })
      if (row === null) throw resourceNotFound('message')
      if (row.authorType !== String(AuthorType.CUSTOMER) || row.deletedAt !== null) {
        throw resourceConflict('only a file the customer sent can be downloaded again')
      }
      const metadata = storedMetadataSchema.safeParse(row.metadata)
      const list = metadata.success
        ? storedListSchema.safeParse(metadata.data[UNAVAILABLE_FILES_KEY])
        : null
      const position = list?.success ? list.data.findIndex(entry => entry.index === index) : -1
      if (!metadata.success || !list?.success || position < 0) {
        throw resourceNotFound('file')
      }
      const stored = list.data[position]
      const entry = lostFileEntrySchema.safeParse(stored)
      if (!entry.success || stored === undefined || !canRetryLostFile(entry.data)) {
        throw resourceConflict('this file cannot be downloaded again')
      }
      const { source, requestedAt } = entry.data
      if (source === undefined) throw resourceConflict('this file cannot be downloaded again')
      // A time that cannot be read is no wait: the new request replaces it
      const since = requestedAt === undefined ? Number.NaN : Date.now() - Date.parse(requestedAt)
      if (since < MediaRefetchLimits.COOLDOWN_MS) {
        throw resourceConflict('the file was asked for a moment ago: wait for it')
      }
      const now = new Date().toISOString()
      const next = list.data.map((item, at) =>
        at === position ? { ...stored, requestedAt: now } : item
      )
      await tx.message.updateMany({
        where: { id: messageId, storeId },
        data: { metadata: { ...metadata.data, [UNAVAILABLE_FILES_KEY]: next } }
      })
      // Inside the transaction, so that a queue that is down fails the request and leaves no wait behind;
      // the worker takes the row lock before it clears the entry, so it reads this commit
      await this.heavyQueue.add(
        JobNames.FETCH_INBOUND_MEDIA,
        {
          messageId,
          index,
          storeId,
          pluginId: source.pluginId,
          connectionId: source.connectionId,
          mediaRef: source.ref,
          contentType: source.contentType,
          filename: source.filename
        },
        { jobId: refetchJobId(messageId, index, now) }
      )
      return messageView({ ...row, metadata: { ...metadata.data, [UNAVAILABLE_FILES_KEY]: next } })
    })
  }
}
