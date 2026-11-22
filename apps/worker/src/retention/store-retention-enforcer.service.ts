// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one batch; the bucket is called outside of it
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  orderDocumentCutoff,
  RetentionDefaults,
  RetentionResourceTypes,
  RetentionRun,
  type RetentionField
} from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { ConversationStatus, DAY_MS, FinanceSourceType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { FILE_WITHOUT_OWNER, filesOfConversationsWhere, MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { categoryRunner, inBatches, PartialRunError } from './retention-batches'
import { objectKeysOf } from './retention-objects'
import { runAuditMetadata, runHasNews } from './run-audit'

const DATE_LENGTH = 10 // "2026-11-14" in an ISO date

export interface RetentionReport {
  conversations: number
  media: number
  // Documents of orders (files; the orders are never touched) deleted past the legal period of the books (TDD_05 §10.3), and the ones past it that the books or a fiscal
  // document hold (a number that says what is kept, not what was done)
  orderDocuments: number
  orderDocumentsHeld: number
  analyticsEvents: number
  notifications: number
  // The categories that stopped on a full batch: the next night takes the rest
  more: string[]
  // Files whose row is gone and that the bucket would not delete (the orphan cleaner takes them later)
  filesLeft: number
}

type Category = 'conversations' | 'media' | 'orderDocuments' | 'analyticsEvents' | 'notifications'

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
    private readonly jobContext: JobContext,
    private readonly audit: AuditService
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
      orderDocuments: 0,
      orderDocumentsHeld: 0,
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
    await run('orderDocuments', () =>
      this.orderDocuments(storeId, orderDocumentCutoff(now), report)
    )
    await run('analyticsEvents', () => this.analyticsEvents(storeId, before('analyticsDays')))
    await run('notifications', () => this.notifications(storeId, before('notificationDays')))

    this.logger.info({ storeId, ...report }, 'the retention run of a store finished')
    // One entry for the run, with the store: the viewer of the audit log of that store reads it. Written before the failure below, so a
    // run that stopped halfway still says what it deleted and where it failed
    const metadata = runAuditMetadata(report, report.more, failed)
    if (runHasNews(metadata, ['orderDocumentsHeld'])) {
      this.audit.log({
        action: AuditAction.RETENTION_RUN,
        actor: { system: true },
        storeId,
        resourceType: RetentionResourceTypes.STORE,
        resourceId: storeId,
        metadata
      })
    }
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
    // The limit is the context's: a transaction inside it joins it and keeps none of its own
    const gone = await this.jobContext.forStore(
      storeId,
      () =>
        this.prisma.transaction(async tx => {
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
        }),
      { timeout: RetentionRun.TRANSACTION_TIMEOUT_MS }
    )
    report.filesLeft += await this.deleteFiles(storeId, gone.files)
    return gone.count
  }

  // The files of messages older than mediaDays: the row and the objects. The message stays, without the file.
  private async media(storeId: string, cutoff: Date, report: RetentionReport) {
    return inBatches(RetentionRun.BATCH_SIZE, RetentionRun.MAX_BATCHES, async () => {
      const batch = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.findMany({
          // The owner columns are named here too: a file of an order or of the books is never "a file of a message", whatever its purpose says
          where: {
            storeId,
            purpose: MediaPurpose.MESSAGE,
            ...FILE_WITHOUT_OWNER,
            createdAt: { lt: cutoff }
          },
          select: { id: true, key: true, variants: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: RetentionRun.BATCH_SIZE
        })
      )
      if (batch.length === 0) return { taken: 0, deleted: 0 }
      const removed = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.deleteMany({
          where: { id: { in: batch.map(file => file.id) }, storeId, ...FILE_WITHOUT_OWNER }
        })
      )
      // The objects of the rows that went only: a file that was given an owner after it was read keeps its row (the filter above) and so keeps
      // its objects
      const kept = new Set(
        (
          await this.jobContext.forStore(storeId, () =>
            this.prisma.client.media.findMany({
              where: { id: { in: batch.map(file => file.id) }, storeId },
              select: { id: true }
            })
          )
        ).map(file => file.id)
      )
      report.filesLeft += await this.deleteFiles(
        storeId,
        batch.filter(file => !kept.has(file.id))
      )
      return { taken: batch.length, deleted: removed.count }
    })
  }

  // The documents of orders (purpose order, an order, no transaction and no fiscal document) made before the end of the legal period of the
  // books, whose ORDER was also made before it. Held, never deleted: an order with a fiscal document of any status, and an order whose sale
  // entry is in a period that has a legal book taken (sealed). The selection is made in SQL so that a held document never takes the place
  // of one that can go (a batch full of them would stop the sweep for ever). The bucket goes first and the row after: a bucket that
  // fails leaves the row, and the next night finds it again; a row whose objects are gone is deleted by the next run (deleting a missing
  // object is not an error). A document that fails is skipped for the rest of this run so it does not hold the ones behind it.
  private async orderDocuments(storeId: string, cutoff: Date, report: RetentionReport) {
    const cutoffAt = cutoff.toISOString()
    const skipped: string[] = []
    report.orderDocumentsHeld = await this.jobContext.forStore(storeId, async () => {
      const [row] = await this.prisma.client.$queryRaw<{ held: bigint }[]>`
        SELECT count(*) AS held FROM media m
        JOIN orders o ON o.id = m.order_id AND o.store_id = m.store_id
        WHERE m.store_id = ${storeId} AND m.purpose = ${MediaPurpose.ORDER}
          AND m.finance_transaction_id IS NULL AND m.fiscal_document_id IS NULL
          AND m.created_at < (${cutoffAt}::timestamptz AT TIME ZONE 'UTC') AND o.created_at < (${cutoffAt}::timestamptz AT TIME ZONE 'UTC')
          AND (
            EXISTS (SELECT 1 FROM fiscal_documents f WHERE f.order_id = o.id)
            OR EXISTS (
              SELECT 1 FROM journal_entries je
              JOIN finance_book_snapshots b ON b.organization_id = je.organization_id AND b.period_id = je.period_id
              WHERE je.source_type = ${FinanceSourceType.ORDER} AND je.source_id = o.id)
          )`
      return Number(row?.held ?? 0)
    })
    return inBatches(RetentionRun.BATCH_SIZE, RetentionRun.MAX_BATCHES, async () => {
      const ids = await this.eligibleOrderDocumentIds(storeId, cutoffAt, RetentionRun.BATCH_SIZE, {
        skipped
      })
      const batch = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.findMany({
          where: { id: { in: ids }, storeId },
          select: { id: true, key: true, variants: true }
        })
      )
      if (batch.length === 0) return { taken: 0, deleted: 0 }
      const gone: string[] = []
      for (const file of batch) {
        // Asked again for this one file right before its objects go: a fiscal document or a legal book that appeared since the batch was read
        // holds it (what is left is the time of one call to the bucket)
        const [still] = await this.eligibleOrderDocumentIds(storeId, cutoffAt, 1, { only: file.id })
        if (still === undefined) {
          skipped.push(file.id)
        } else if (await this.deleteObjectsOf(storeId, file, report)) {
          gone.push(file.id)
        } else {
          skipped.push(file.id)
        }
      }
      const removed = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.deleteMany({
          where: {
            id: { in: gone },
            storeId,
            purpose: MediaPurpose.ORDER,
            orderId: { not: null },
            financeTransactionId: null,
            fiscalDocumentId: null
          }
        })
      )
      return { taken: batch.length, deleted: removed.count }
    })
  }

  // The documents of orders that are past the period and that nothing holds, oldest first. The same predicate as the held count above, with
  // the hold negated: KEEP THE TWO IN STEP (a hold added to one and not to the other makes the report say "held" while the sweep deletes).
  private async eligibleOrderDocumentIds(
    storeId: string,
    cutoffAt: string,
    limit: number,
    filter: { skipped?: readonly string[]; only?: string }
  ): Promise<string[]> {
    const skipped = [...(filter.skipped ?? [])]
    const only = filter.only ?? null
    const rows = await this.jobContext.forStore(
      storeId,
      () =>
        this.prisma.client.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM media m
        JOIN orders o ON o.id = m.order_id AND o.store_id = m.store_id
        WHERE m.store_id = ${storeId} AND m.purpose = ${MediaPurpose.ORDER}
          AND m.finance_transaction_id IS NULL AND m.fiscal_document_id IS NULL
          AND m.created_at < (${cutoffAt}::timestamptz AT TIME ZONE 'UTC') AND o.created_at < (${cutoffAt}::timestamptz AT TIME ZONE 'UTC')
          AND NOT (
            EXISTS (SELECT 1 FROM fiscal_documents f WHERE f.order_id = o.id)
            OR EXISTS (
              SELECT 1 FROM journal_entries je
              JOIN finance_book_snapshots b ON b.organization_id = je.organization_id AND b.period_id = je.period_id
              WHERE je.source_type = ${FinanceSourceType.ORDER} AND je.source_id = o.id)
          )
          AND NOT (m.id = ANY(${skipped}::text[]))
          AND (${only}::text IS NULL OR m.id = ${only})
        ORDER BY m.created_at, m.id LIMIT ${limit}`
    )
    return rows.map(row => row.id)
  }

  // The objects of one file, the bucket before the row. False when one the store owns could not be deleted: the row stays
  private async deleteObjectsOf(
    storeId: string,
    file: FileRow,
    report: RetentionReport
  ): Promise<boolean> {
    const { keys, foreign } = objectKeysOf(storeId, file)
    if (foreign.length > 0) {
      report.filesLeft += foreign.length
      this.logger.warn(
        { storeId, mediaId: file.id, count: foreign.length },
        'a file of deleted data has a key outside the store and was left in the bucket'
      )
    }
    try {
      for (const key of keys) await this.storage.delete(key)
      return true
    } catch (error) {
      this.logger.warn(
        { storeId, mediaId: file.id, errorName: errorName(error) },
        'an order document could not be removed from the bucket; its row stays for the next run'
      )
      return false
    }
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
