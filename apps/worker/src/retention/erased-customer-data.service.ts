import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, RetentionRun } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { MessageType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { NotificationParamKeys, NotificationResourceTypes } from '@platform/core/notifications'
import { MediaPurpose, objectKeysOf } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { inBatches } from './retention-batches'

// rls-context: every access runs inside JobContext.forStore of the store of the customer (the raw updates are the steps `inStore` runs)

// What one run did, in counts: never a value of the person
export interface ErasedDataReport {
  messages: number
  revisions: number
  csatComments: number
  notifications: number
  files: number
  // Files whose objects the bucket would not delete: their rows stay, so the next run asks again
  filesLeft: number
  // True when every category was done and the customer was marked as cleared
  cleared: boolean
  // True when there was nothing to do and nothing was touched: the customer is gone or was not erased (a job for it has no reason to retry)
  skipped: boolean
}

// What hangs from an erased customer (TDD_05 §10.3, Step 7.2-C), cleared in the context of its store: the text of its messages (the
// placeholder, the rows stay for the metrics), the text of their past edits, the free text of its conversations (the survey, the notes of a snooze), the name that its
// notifications carry, and the files of its messages (the objects and the rows). The documents of an order are the books' and stay, as does
// every system line (they hold no word of the person). Idempotent and resumable: each category selects only what is not cleared yet, so a run
// that died, or a bucket that failed halfway, is finished by the next one (the job's retries, then the daily sweep), and the customer is marked
// as cleared only when nothing is left. It refuses a customer who is not erased: this is the one code that deletes the text of a live person.
@Injectable()
export class ErasedCustomerData {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ErasedCustomerData.name)
  }

  async clear(storeId: string, customerId: string): Promise<ErasedDataReport> {
    const report: ErasedDataReport = {
      messages: 0,
      revisions: 0,
      csatComments: 0,
      notifications: 0,
      files: 0,
      filesLeft: 0,
      cleared: false,
      skipped: false
    }
    const customer = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.customer.findFirst({
        where: { id: customerId, storeId },
        select: { erasedAt: true, erasedDataPurgedAt: true }
      })
    )
    // Gone, or a customer that was not erased: nothing to clear (and nothing that this may touch)
    if (customer === null || customer.erasedAt === null) {
      report.skipped = true
      return report
    }
    if (customer.erasedDataPurgedAt !== null) {
      report.cleared = true
      return report
    }
    // The sweep takes the customers tried longest ago first: one that keeps failing does not starve the others
    await this.jobContext.forStore(storeId, () =>
      this.prisma.client.customer.updateMany({
        where: { id: customerId, storeId, erasedAt: { not: null } },
        data: { erasedDataAttemptedAt: new Date() }
      })
    )

    let more = false
    // Each category runs apart: one that fails does not keep the others (the files above all) from running; the first failure is thrown at the end
    const failures: unknown[] = []
    const attempt = async (
      work: () => Promise<{ deleted: number; more: boolean }>
    ): Promise<number> => {
      try {
        const outcome = await work()
        more = more || outcome.more
        return outcome.deleted
      } catch (error) {
        failures.push(error)
        this.logger.warn(
          { storeId, customerId, errorName: errorName(error) },
          'a category of the clearing of an erased customer failed'
        )
        return 0
      }
    }
    report.messages = await attempt(() =>
      this.inStore(storeId, limit => this.messages(storeId, customerId, limit))
    )
    report.revisions = await attempt(() =>
      this.inStore(storeId, limit => this.revisions(storeId, customerId, limit))
    )
    report.csatComments = await attempt(() =>
      this.inStore(storeId, limit => this.conversationNotes(storeId, customerId, limit))
    )
    report.notifications = await attempt(() =>
      this.inStore(storeId, limit => this.notifications(storeId, customerId, limit))
    )
    let filesLeft = 0
    await attempt(async () => {
      const outcome = await this.files(storeId, customerId)
      report.files = outcome.deleted
      filesLeft = outcome.left
      return { deleted: outcome.deleted, more: outcome.more }
    })
    report.filesLeft = filesLeft
    if (failures.length > 0) {
      this.logger.info(
        { storeId, customerId, ...report },
        'the data of an erased customer was cleared in part'
      )
      throw failures[0]
    }

    // Marked only when nothing waits: the sweep takes the customers that are not
    if (!more && report.filesLeft === 0) {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.customer.updateMany({
          where: { id: customerId, storeId, erasedAt: { not: null } },
          data: { erasedDataPurgedAt: new Date() }
        })
      )
      report.cleared = true
      // The end of the erasure, with counts only: when the data was gone is what the entry of the request cannot say
      this.audit.log({
        action: AuditAction.CUSTOMER_ERASED_DATA_CLEARED,
        actor: { system: true },
        storeId,
        resourceType: 'customer',
        resourceId: customerId,
        metadata: {
          messages: report.messages,
          revisions: report.revisions,
          conversationNotes: report.csatComments,
          notifications: report.notifications,
          files: report.files
        }
      })
    }
    this.logger.info(
      { storeId, customerId, ...report },
      'the data of an erased customer was cleared'
    )
    return report
  }

  // One category in batches. `step` clears one batch and says how many it took; a batch that comes back short ends the category
  private inStore(storeId: string, step: (limit: number) => Promise<number>) {
    return inBatches(RetentionRun.BATCH_SIZE, RetentionRun.MAX_BATCHES, async () => {
      const taken = await this.jobContext.forStore(storeId, () => step(RetentionRun.BATCH_SIZE))
      return { taken, deleted: taken }
    })
  }

  // The text of the messages of the conversations of the customer: free text, the text waiting for an edit and the metadata (a template keeps
  // the variables it was filled with, a reply keeps what it quotes). A system line is not touched. Only a row that still holds something
  private messages(storeId: string, customerId: string, limit: number): Promise<number> {
    const placeholder = ComplianceConfig.ERASED_CONTENT_PLACEHOLDER
    return this.prisma.client.$executeRaw`
      UPDATE messages SET
        content = CASE WHEN content IS NULL THEN NULL ELSE ${placeholder} END,
        pending_content = NULL,
        metadata = NULL
      WHERE id IN (
        SELECT m.id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.store_id = ${storeId} AND c.store_id = ${storeId} AND c.customer_id = ${customerId}
          AND m.type <> ${MessageType.SYSTEM}
          AND ((m.content IS NOT NULL AND m.content <> ${placeholder})
            OR m.pending_content IS NOT NULL OR m.metadata IS NOT NULL)
        LIMIT ${limit})`
  }

  // The past versions of an edit are the text of the message too
  private revisions(storeId: string, customerId: string, limit: number): Promise<number> {
    return this.prisma.client.$executeRaw`
      DELETE FROM message_revisions WHERE id IN (
        SELECT r.id FROM message_revisions r
        JOIN messages m ON m.id = r.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE r.store_id = ${storeId} AND m.store_id = ${storeId} AND c.store_id = ${storeId}
          AND c.customer_id = ${customerId}
        LIMIT ${limit})`
  }

  // The free text that hangs from the conversation: what the customer wrote in a satisfaction survey (the score stays) and what an agent
  // wrote to snooze it or to mark it (`snooze_note`, `attention_note`: they often name the person or give a phone to call)
  private conversationNotes(storeId: string, customerId: string, limit: number): Promise<number> {
    return this.prisma.client.$executeRaw`
      UPDATE conversations SET csat_comment = NULL, snooze_note = NULL, attention_note = NULL WHERE id IN (
        SELECT id FROM conversations
        WHERE store_id = ${storeId} AND customer_id = ${customerId}
          AND (csat_comment IS NOT NULL OR snooze_note IS NOT NULL OR attention_note IS NOT NULL)
        LIMIT ${limit})`
  }

  // The name that a notification about the customer carries (`params.customer`), for whoever opens it or gets it by mail: the ones that point to a
  // conversation of the customer and the ones that point to a message of one (a mention in a note)
  private notifications(storeId: string, customerId: string, limit: number): Promise<number> {
    const placeholder = ComplianceConfig.ERASED_CONTENT_PLACEHOLDER
    const key = NotificationParamKeys.CUSTOMER
    return this.prisma.client.$executeRaw`
      UPDATE notifications SET params = jsonb_set(params, ARRAY[${key}]::text[], to_jsonb(${placeholder}::text)) WHERE id IN (
        SELECT n.id FROM notifications n
        WHERE n.store_id = ${storeId}
          AND jsonb_exists(n.params, ${key}) AND n.params ->> ${key} <> ${placeholder}
          AND ((n.resource_type = ${NotificationResourceTypes.CONVERSATION}
                AND n.resource_id IN (
                  SELECT c.id FROM conversations c WHERE c.store_id = ${storeId} AND c.customer_id = ${customerId}))
            OR (n.resource_type = ${NotificationResourceTypes.MESSAGE}
                AND n.resource_id IN (
                  SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE m.store_id = ${storeId} AND c.store_id = ${storeId} AND c.customer_id = ${customerId})))
        LIMIT ${limit})`
  }

  // The files of the messages of the customer. The objects go first and the row after, only when every object of it is gone: a bucket that
  // fails halfway leaves the row, and the next run finds it. The files that belong to an order are not here (they are its documents). Walked by
  // id, so a row that stays does not hide the ones after it.
  private async files(
    storeId: string,
    customerId: string
  ): Promise<{ deleted: number; left: number; more: boolean }> {
    let after = ''
    let deleted = 0
    let left = 0
    for (let batch = 0; batch < RetentionRun.MAX_BATCHES; batch += 1) {
      const rows = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.findMany({
          where: {
            storeId,
            purpose: MediaPurpose.MESSAGE,
            orderId: null,
            id: { gt: after },
            OR: [{ customerId }, { message: { conversation: { customerId, storeId } } }]
          },
          select: { id: true, key: true, variants: true },
          orderBy: { id: 'asc' },
          take: RetentionRun.BATCH_SIZE
        })
      )
      const removable: string[] = []
      for (const file of rows) {
        const { keys, foreign } = objectKeysOf(storeId, file)
        // A key outside the prefix of the store is not ours to delete: it stays in the bucket and said in the log
        if (foreign.length > 0) {
          this.logger.warn(
            { storeId, mediaId: file.id, count: foreign.length },
            'a file of an erased customer has a key outside the store: its row stays and the customer is not cleared'
          )
        }
        // A key that is not ours cannot be deleted: its row stays (and the customer is not marked as cleared) so the object does not lose its only trace
        let gone = foreign.length === 0
        for (const key of keys) {
          try {
            await this.storage.delete(key)
          } catch (error) {
            gone = false
            this.logger.warn(
              { storeId, mediaId: file.id, errorName: errorName(error) },
              'a file of an erased customer could not be removed from the bucket'
            )
          }
        }
        if (gone) removable.push(file.id)
        else left += 1
      }
      // A row that stays (a key that is not ours, a bucket that failed) is the trace of an object, not a place to keep the text of the person
      const kept = rows.filter(file => !removable.includes(file.id)).map(file => file.id)
      if (kept.length > 0) {
        await this.jobContext.forStore(storeId, () =>
          this.prisma.client.media.updateMany({
            where: { id: { in: kept }, storeId },
            data: { filename: ComplianceConfig.ERASED_CONTENT_PLACEHOLDER, caption: null }
          })
        )
      }
      if (removable.length > 0) {
        const removed = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.media.deleteMany({ where: { id: { in: removable }, storeId } })
        )
        deleted += removed.count
      }
      after = rows.at(-1)?.id ?? after
      if (rows.length < RetentionRun.BATCH_SIZE) return { deleted, left, more: false }
    }
    return { deleted, left, more: true }
  }
}
