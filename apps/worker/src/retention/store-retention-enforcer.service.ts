// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one batch; the bucket is called outside of it
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { RetentionDefaults, RetentionRun, type RetentionField } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { ConversationStatus, DAY_MS } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { filesOfConversationsWhere, MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { categoryRunner, inBatches, PartialRunError } from './retention-batches'
import { objectKeysOf } from './retention-objects'

const DATE_LENGTH = 10 // "2026-11-14" in an ISO date

export interface RetentionReport {
  conversations: number
  media: number
  analyticsEvents: number
  notifications: number
  // The categories that stopped on a full batch: the next night takes the rest
  more: string[]
  // Files whose row is gone and that the bucket would not delete (the orphan cleaner takes them later)
  filesLeft: number
}

type Category = 'conversations' | 'media' | 'analyticsEvents' | 'notifications'

const FINISHED_STATUSES = [ConversationStatus.RESOLVED, ConversationStatus.ARCHIVED]

// The nightly retention of one store (TDD_05 §10.4), run by the heavy-processing job at the store's 03:00. The windows
// are the store's RetentionSettings (the factory defaults when it has no row): a resolved or archived conversation
// (with its messages and files) that nothing has touched for conversationDays, a message file older than mediaDays,
// an analytics event older than analyticsDays and a read notification older than notificationDays. Every query
// carries the store of the job; orders and the audit log are never reached. Each category takes batches of
// RetentionRun.BATCH_SIZE and one that fails does not stop the others (the job fails after them, so the queue tries
// the store again: what was deleted is gone, and the rest is found again).
@Injectable()
export class StoreRetentionEnforcer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(StoreRetentionEnforcer.name)
  }

  async enforce(storeId: string, now: Date = new Date()): Promise<RetentionReport> {
    // Read in the context of the store: with no row of settings the defaults apply, so a read that row security hid would delete at the
    // default what the owner asked to keep longer. A store that is not there ends the job (the processor treats it as done: its rows
    // went with it). The deletes below only ever remove less when they see less.
    const row = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.retentionSettings.findUnique({
        where: { storeId },
        select: {
          conversationDays: true,
          mediaDays: true,
          analyticsDays: true,
          notificationDays: true
        }
      })
    )
    const days: Record<RetentionField, number> = row ?? RetentionDefaults
    const before = (field: RetentionField): Date => new Date(now.getTime() - days[field] * DAY_MS)

    const report: RetentionReport = {
      conversations: 0,
      media: 0,
      analyticsEvents: 0,
      notifications: 0,
      more: [],
      filesLeft: 0
    }
    const failed: Category[] = []
    const run = categoryRunner(report, failed, (category, error) => {
      this.logger.error(
        { storeId, category, errorName: errorName(error) },
        'a category of the retention run failed'
      )
    })

    await run('conversations', () =>
      this.conversations(storeId, before('conversationDays'), report)
    )
    await run('media', () => this.media(storeId, before('mediaDays'), report))
    await run('analyticsEvents', () => this.analyticsEvents(storeId, before('analyticsDays')))
    await run('notifications', () => this.notifications(storeId, before('notificationDays')))

    this.logger.info({ storeId, ...report }, 'the retention run of a store finished')
    if (report.more.length > 0) {
      this.logger.warn({ storeId, more: report.more }, 'a full batch was deleted; more waits')
    }
    if (failed.length > 0) throw new Error(`the retention run failed for ${failed.join(', ')}`)
    return report
  }

  // Resolved or archived, and quiet since the cutoff (the last message, or the creation of a conversation with none).
  // A batch the database refuses (a trigger, a timeout) is tried again one conversation at a time, and the one that
  // fails is left for tomorrow and skipped for the rest of this run, so it never holds the ones behind it.
  private async conversations(storeId: string, cutoff: Date, report: RetentionReport) {
    const skipped: string[] = []
    return inBatches(
      RetentionRun.CONVERSATION_BATCH_SIZE,
      RetentionRun.CONVERSATION_MAX_BATCHES,
      async () => {
        const batch = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.conversation.findMany({
            where: {
              storeId,
              status: { in: FINISHED_STATUSES },
              OR: [
                { lastMessageAt: { lt: cutoff } },
                { lastMessageAt: null, createdAt: { lt: cutoff } }
              ],
              // Resolved or archived again after the cutoff is a person's work on it: it starts the window over
              AND: [
                { OR: [{ resolvedAt: null }, { resolvedAt: { lt: cutoff } }] },
                { OR: [{ archivedAt: null }, { archivedAt: { lt: cutoff } }] }
              ],
              ...(skipped.length === 0 ? {} : { id: { notIn: skipped } })
            },
            select: { id: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: RetentionRun.CONVERSATION_BATCH_SIZE
          })
        )
        if (batch.length === 0) return { taken: 0, deleted: 0 }
        const ids = batch.map(conversation => conversation.id)
        let deleted = 0
        try {
          deleted = await this.deleteConversations(storeId, ids, cutoff, report)
        } catch (error) {
          this.logger.warn(
            { storeId, errorName: errorName(error) },
            'a batch of conversations was refused; trying them one at a time'
          )
          let refused = 0
          for (const id of ids) {
            try {
              deleted += await this.deleteConversations(storeId, [id], cutoff, report)
            } catch (single) {
              refused += 1
              skipped.push(id)
              this.logger.warn(
                { storeId, conversationId: id, errorName: errorName(single) },
                'a conversation past its window could not be deleted'
              )
            }
          }
          // Every one refused: it is the database and not a row, so the category stops and fails (the queue tries again)
          if (ids.length >= RetentionRun.SYSTEMIC_REFUSALS && refused === ids.length)
            throw new PartialRunError(deleted, error)
        }
        return { taken: batch.length, deleted }
      }
    )
  }

  // The rows go first, in one transaction, and the files after: a delete of the database that fails leaves
  // everything as it was, and a file the bucket will not delete is a stray that OrphanMediaCleaner removes
  private async deleteConversations(
    storeId: string,
    ids: string[],
    cutoff: Date,
    report: RetentionReport
  ): Promise<number> {
    const gone = await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(
        async tx => {
          // Read again under the lock: a conversation an agent reopened since the batch was read is left alone
          const eligible = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM conversations
          WHERE id = ANY(${ids}::text[]) AND store_id = ${storeId}
            AND status IN (${ConversationStatus.RESOLVED}, ${ConversationStatus.ARCHIVED})
            AND COALESCE(last_message_at, created_at) < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            AND (resolved_at IS NULL OR resolved_at < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
            AND (archived_at IS NULL OR archived_at < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
          FOR UPDATE`
          const eligibleIds = eligible.map(conversation => conversation.id)
          if (eligibleIds.length === 0) return { files: [] as FileRow[], count: 0 }
          // The files of its messages and of the picture of its ad: the rows of the messages go with the conversation
          // and would leave these with no owner. The documents of an order sent in it are not among them: they belong to the
          // order and keep their row and their objects (the same rule as the manual deletion, TDD_05 §10.4)
          const files = await tx.media.findMany({
            where: filesOfConversationsWhere(storeId, eligibleIds),
            select: { id: true, key: true, variants: true }
          })
          await tx.media.deleteMany({ where: { id: { in: files.map(file => file.id) }, storeId } })
          // An order made from the conversation keeps its own data and loses only the link (a plain column, no key)
          // (raw: the update must not move the `updated_at` of orders that are years old)
          await tx.$executeRaw`
          UPDATE orders SET conversation_id = NULL
          WHERE store_id = ${storeId} AND conversation_id = ANY(${eligibleIds}::text[])`
          const removed = await tx.conversation.deleteMany({
            where: { id: { in: eligibleIds }, storeId }
          })
          return { files, count: removed.count }
        },
        { timeout: RetentionRun.TRANSACTION_TIMEOUT_MS }
      )
    )
    report.filesLeft += await this.deleteFiles(storeId, gone.files)
    return gone.count
  }

  // The files of messages older than mediaDays: the row and the objects. The message stays, without the file.
  private async media(storeId: string, cutoff: Date, report: RetentionReport) {
    return inBatches(RetentionRun.BATCH_SIZE, RetentionRun.MAX_BATCHES, async () => {
      const batch = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.findMany({
          where: { storeId, purpose: MediaPurpose.MESSAGE, createdAt: { lt: cutoff } },
          select: { id: true, key: true, variants: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: RetentionRun.BATCH_SIZE
        })
      )
      if (batch.length === 0) return { taken: 0, deleted: 0 }
      const removed = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.deleteMany({
          where: { id: { in: batch.map(file => file.id) }, storeId }
        })
      )
      report.filesLeft += await this.deleteFiles(storeId, batch)
      return { taken: batch.length, deleted: removed.count }
    })
  }

  private async analyticsEvents(storeId: string, cutoff: Date) {
    const day = cutoff.toISOString().slice(0, DATE_LENGTH)
    return inBatches(RetentionRun.BATCH_SIZE, RetentionRun.MAX_BATCHES, async () => {
      const deleted = await this.jobContext.forStore(
        storeId,
        () =>
          this.prisma.client.$executeRaw`
        DELETE FROM analytics_events WHERE id IN (
          SELECT id FROM analytics_events
          WHERE store_id = ${storeId} AND date < ${day}::date
          ORDER BY date LIMIT ${RetentionRun.BATCH_SIZE})`
      )
      return { taken: deleted, deleted }
    })
  }

  // Read ones only: a notification nobody has opened is still news
  private async notifications(storeId: string, cutoff: Date) {
    return inBatches(RetentionRun.BATCH_SIZE, RetentionRun.MAX_BATCHES, async () => {
      const deleted = await this.jobContext.forStore(
        storeId,
        () =>
          this.prisma.client.$executeRaw`
        DELETE FROM notifications WHERE id IN (
          SELECT id FROM notifications
          WHERE store_id = ${storeId} AND read_at IS NOT NULL
            AND created_at < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          ORDER BY created_at LIMIT ${RetentionRun.BATCH_SIZE})`
      )
      return { taken: deleted, deleted }
    })
  }

  // Returns how many objects the bucket would not delete. One of them does not keep the others
  private async deleteFiles(storeId: string, files: FileRow[]): Promise<number> {
    const targets: { key: string; mediaId: string }[] = []
    let left = 0
    for (const file of files) {
      const { keys, foreign } = objectKeysOf(storeId, file)
      for (const key of keys) targets.push({ key, mediaId: file.id })
      if (foreign.length > 0) {
        // A key outside the prefix of the store is not ours to delete: it stays, and the log says so
        left += foreign.length
        this.logger.warn(
          { storeId, mediaId: file.id, count: foreign.length },
          'a file of deleted data has a key outside the store and was left in the bucket'
        )
      }
    }
    for (let at = 0; at < targets.length; at += RetentionRun.FILE_DELETE_CONCURRENCY) {
      const chunk = targets.slice(at, at + RetentionRun.FILE_DELETE_CONCURRENCY)
      await Promise.all(
        chunk.map(async target => {
          try {
            await this.storage.delete(target.key)
          } catch (error) {
            left += 1
            this.logger.warn(
              { storeId, mediaId: target.mediaId, errorName: errorName(error) },
              'a file of deleted data could not be removed from the bucket'
            )
          }
        })
      )
    }
    return left
  }
}

interface FileRow {
  id: string
  key: string
  variants: unknown
}
