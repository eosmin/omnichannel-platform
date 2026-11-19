import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { JobContext, PrismaService } from '@platform/core/database'
import { BulkLabelJobStatus, BulkLabelLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { inEachStoreStrict } from '../schedulers/store-sweep'

// rls-context: every read and write of a table of a store runs inside JobContext.forStore of the store being cleaned; the bucket is touched outside

export interface BulkLabelsCleanupReport {
  filesDeleted: number
  jobsClosed: number
}

interface ExpiredFile {
  id: string
  store_id: string
  key: string
}

const HOUR_MS = 60 * 60 * 1000

// What the bulk generation of labels leaves behind (TDD_17 §4.6): the merged files carry the name, address and phone of customers,
// so they do not stay past `StoreSettings.bulkLabelRetentionDays`; and a run that was lost is closed so nobody waits for it.
@Injectable()
export class BulkLabelsCleaner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(BulkLabelsCleaner.name)
  }

  // Store by store, each in its own context (the policies answer nothing else). A store that cannot be read stops the run: a file with
  // a customer's address that is never looked at is a file that stays. The bucket is touched outside the transactions.
  async run(now: Date = new Date()): Promise<BulkLabelsCleanupReport> {
    const report: BulkLabelsCleanupReport = { filesDeleted: 0, jobsClosed: 0 }
    await inEachStoreStrict(this.prisma, async storeId => {
      report.filesDeleted += await this.deleteExpiredFiles(storeId, now)
      report.jobsClosed += await this.closeLostRuns(storeId, now)
    })
    return report
  }

  // Each store keeps its files for its own number of days. The oldest first, so a backlog is worked off in order.
  private async deleteExpiredFiles(storeId: string, now: Date): Promise<number> {
    const rows = await this.jobContext.forStore(
      storeId,
      () =>
        this.prisma.client.$queryRaw<ExpiredFile[]>`
      SELECT m.id, m.store_id, m.key
      FROM media m
      LEFT JOIN store_settings s ON s.store_id = m.store_id
      WHERE m.purpose = ${MediaPurpose.BULK_LABELS}
        AND m.store_id = ${storeId}
        AND m.created_at <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => GREATEST(COALESCE(s.bulk_label_retention_days, ${BulkLabelLimits.DEFAULT_RETENTION_DAYS}), 1))
      ORDER BY m.created_at ASC
      LIMIT ${BulkLabelLimits.CLEAN_FILES_PER_RUN}`
    )
    let deleted = 0
    for (const row of rows) {
      // One file that cannot be deleted must not keep the rest from expiring
      try {
        // The object first: a row removed with its file still there would never be looked at again
        await this.storage.delete(row.key)
        await this.jobContext.forStore(storeId, () =>
          this.prisma.transaction(async tx => {
            // A run that points at the file is left pointing at nothing: its screen says the file is gone
            await tx.bulkLabelJob.updateMany({
              where: { storeId: row.store_id, mergedMediaId: row.id },
              data: { mergedMediaId: null }
            })
            await tx.media.deleteMany({ where: { id: row.id, storeId: row.store_id } })
          })
        )
        deleted += 1
      } catch (error) {
        this.logger.error(
          { mediaId: row.id, errorName: errorName(error) },
          'an expired file of labels could not be deleted'
        )
      }
    }
    return deleted
  }

  private async closeLostRuns(storeId: string, now: Date): Promise<number> {
    const lost = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.bulkLabelJob.findMany({
        where: {
          storeId,
          status: { in: [BulkLabelJobStatus.QUEUED, BulkLabelJobStatus.RUNNING] },
          createdAt: { lte: new Date(now.getTime() - BulkLabelLimits.STALE_JOB_HOURS * HOUR_MS) }
        },
        select: { id: true, storeId: true, requestedBy: true },
        orderBy: { createdAt: 'asc' },
        take: BulkLabelLimits.CLEAN_FILES_PER_RUN
      })
    )
    let closed = 0
    for (const job of lost) {
      try {
        const done = await this.jobContext.forStore(storeId, () =>
          this.prisma.transaction(async tx => {
            const marked = await tx.bulkLabelJob.updateMany({
              where: {
                id: job.id,
                storeId: job.storeId,
                status: { in: [BulkLabelJobStatus.QUEUED, BulkLabelJobStatus.RUNNING] }
              },
              data: { status: BulkLabelJobStatus.FAILED, finishedAt: now }
            })
            if (marked.count === 0) return false
            this.events.publish(tx, Events.BULK_LABELS_DONE, {
              storeId: job.storeId,
              jobId: job.id,
              requestedBy: job.requestedBy,
              status: BulkLabelJobStatus.FAILED,
              mergedMediaId: null
            })
            return true
          })
        )
        if (done) closed += 1
      } catch (error) {
        this.logger.error(
          { jobId: job.id, errorName: errorName(error) },
          'a lost bulk run of labels could not be closed'
        )
      }
    }
    return closed
  }
}
