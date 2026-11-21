import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ComplianceConfig, RetentionRun } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { MessageType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
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
}

// What hangs from an erased customer (TDD_05 §10.3, Step 7.2-C), cleared in the context of its store: the text of its messages (the
// placeholder, the rows stay for the metrics), the text of their past edits, the comment of a satisfaction survey, the name that its
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
      cleared: false
    }
    const customer = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.customer.findFirst({
        where: { id: customerId, storeId },
        select: { erasedAt: true, erasedDataPurgedAt: true }
      })
    )
    // Gone, or a customer that was not erased: nothing to clear (and nothing that this may touch)
    if (customer === null || customer.erasedAt === null) return report
    if (customer.erasedDataPurgedAt !== null) {
      report.cleared = true
      return report
    }

    let more = false
    const take = (outcome: { deleted: number; more: boolean }): number => {
      more = more || outcome.more
      return outcome.deleted
    }
    report.messages = take(
      await this.inStore(storeId, ids => this.messages(storeId, customerId, ids))
    )
    report.revisions = take(
      await this.inStore(storeId, ids => this.revisions(storeId, customerId, ids))
    )
    report.csatComments = take(
      await this.inStore(storeId, ids => this.csat(storeId, customerId, ids))
    )
    report.notifications = take(
      await this.inStore(storeId, ids => this.notifications(storeId, customerId, ids))
    )
    const files = await this.files(storeId, customerId)
    report.files = files.deleted
    report.filesLeft = files.left
    more = more || files.more

    // Marked only when nothing waits: the sweep takes the customers that are not
    if (!more && files.left === 0) {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.customer.updateMany({
          where: { id: customerId, storeId, erasedAt: { not: null } },
          data: { erasedDataPurgedAt: new Date() }
        })
      )
      report.cleared = true
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

  // What the customer wrote in a satisfaction survey: the score stays for the metrics
  private csat(storeId: string, customerId: string, limit: number): Promise<number> {
    return this.prisma.client.$executeRaw`
      UPDATE conversations SET csat_comment = NULL WHERE id IN (
        SELECT id FROM conversations
        WHERE store_id = ${storeId} AND customer_id = ${customerId} AND csat_comment IS NOT NULL
        LIMIT ${limit})`
  }

  // The name that a notification about a conversation of the customer carries (`params.customer`), for whoever opens it or gets it by mail
  private notifications(storeId: string, customerId: string, limit: number): Promise<number> {
    const placeholder = ComplianceConfig.ERASED_CONTENT_PLACEHOLDER
    return this.prisma.client.$executeRaw`
      UPDATE notifications SET params = jsonb_set(params, '{customer}', to_jsonb(${placeholder}::text)) WHERE id IN (
        SELECT n.id FROM notifications n
        JOIN conversations c ON c.id = n.resource_id
        WHERE n.store_id = ${storeId} AND c.store_id = ${storeId} AND c.customer_id = ${customerId}
          AND n.resource_type = 'conversation'
          AND jsonb_exists(n.params, 'customer') AND n.params ->> 'customer' <> ${placeholder}
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
        // A key outside the prefix of the store is not ours to delete: it stays in the bucket, said in the log, and does not hold the row
        if (foreign.length > 0) {
          this.logger.warn(
            { storeId, mediaId: file.id, count: foreign.length },
            'a file of an erased customer has a key outside the store and was left in the bucket'
          )
        }
        let gone = true
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
