import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { JobContext, PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { ExportDiscardStages, ExportLimits } from '@platform/core/exports'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { ExportStatus } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { inEachStoreStrict } from '../schedulers/store-sweep'

import { publishExportSettled } from './export-settled'

// rls-context: every read and write of `exports` runs inside JobContext.forStore of the store being cleaned; the bucket is touched outside

export interface ExportCleanupReport {
  filesDeleted: number
  abandoned: number
  // Rows of a failed or expired export whose files were looked for and deleted
  swept: number
}

// The files of a row that the bucket refused to delete, with the key that refused
class FileNotDeletedError extends Error {
  constructor(
    readonly key: string,
    readonly reason: unknown
  ) {
    super('an export file could not be deleted')
  }
}

// A file with the personal data of the store does not stay past its date: the download is already
// refused once `expiresAt` passes (ExportsService), and this deletes the object itself.
@Injectable()
export class ExpiredExportsCleaner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger,
    @InjectMetric(MetricNames.EXPORT_FILE_DISCARD_FAILED)
    private readonly discardFailed: Counter<string>
  ) {
    this.logger.setContext(ExpiredExportsCleaner.name)
  }

  // Store by store, each in its own context (the policy of `exports` answers nothing else). A store that cannot be read stops the
  // run: an export that is never looked at is a file with personal data that stays. The objects of the bucket are deleted outside
  // the transactions (no external call inside one).
  async run(now: Date = new Date()): Promise<ExportCleanupReport> {
    const report: ExportCleanupReport = { filesDeleted: 0, abandoned: 0, swept: 0 }
    await inEachStoreStrict(this.prisma, async storeId => {
      const done = await this.cleanStore(storeId, now)
      report.filesDeleted += done.filesDeleted
      report.abandoned += done.abandoned
      report.swept += done.swept
    })
    return report
  }

  private async cleanStore(storeId: string, now: Date): Promise<ExportCleanupReport> {
    const expired = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.export.findMany({
        where: { storeId, status: ExportStatus.READY, expiresAt: { lte: now } },
        select: { id: true, storeId: true, key: true },
        orderBy: { expiresAt: 'asc' },
        take: ExportLimits.CLEANUP_BATCH
      })
    )
    let filesDeleted = 0
    for (const row of expired) {
      // One file that cannot be deleted must not keep the rest of the batch (or the next run, which
      // would start with the same row) from expiring
      try {
        // The objects first: a row marked expired with its file still there would never be looked at again. The whole prefix, not
        // only the key: a retry on another day wrote under another name
        await this.deleteFilesOf(row.storeId, row.id, row.key)
        const marked = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.export.updateMany({
            where: { id: row.id, storeId: row.storeId, status: ExportStatus.READY },
            data: { status: ExportStatus.EXPIRED, key: null }
          })
        )
        filesDeleted += marked.count
      } catch (error) {
        this.discardFailed.inc({ stage: ExportDiscardStages.SWEEP })
        this.logger.error(
          { exportId: row.id, errorName: errorName(error) },
          'an expired export could not be deleted'
        )
      }
    }

    const giveUp = new Date(now.getTime() - ExportLimits.PENDING_GIVE_UP_HOURS * 3_600_000)
    const stale = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.export.findMany({
        where: { storeId, status: ExportStatus.PENDING, createdAt: { lte: giveUp } },
        select: { id: true, storeId: true, requestedBy: true, type: true },
        take: ExportLimits.CLEANUP_BATCH
      })
    )
    let abandoned = 0
    for (const row of stale) {
      try {
        // A worker killed after the upload and before the row turned `ready` left a file no row names
        const { objects } = await this.storage.list(StorageKeys.exportPrefix(row.storeId, row.id))
        for (const object of objects) await this.storage.delete(object.key)
        // The row and the announcement are one transaction: an announcement that fails leaves the export pending, and the next run
        // closes it again (its objects are already gone)
        const marked = await this.jobContext.forStore(storeId, async () => {
          const result = await this.prisma.client.export.updateMany({
            where: { id: row.id, storeId: row.storeId, status: ExportStatus.PENDING },
            data: { status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_FAILED, completedAt: now }
          })
          // The person who asked is told it failed
          if (result.count > 0) {
            await publishExportSettled(this.prisma, this.events, Events.EXPORT_FAILED, row)
          }
          return result
        })
        abandoned += marked.count
      } catch (error) {
        this.logger.error(
          { exportId: row.id, errorName: errorName(error) },
          'an abandoned export could not be closed'
        )
      }
    }
    const swept = await this.sweepSettled(storeId, now)
    return { filesDeleted, abandoned, swept }
  }

  // The files of an export that settled without one: the bucket refused to delete a file when the export failed (the row kept its key
  // for this), or a worker died between the upload and the row. The object goes first and the key of the row after, so a run that dies
  // in the middle finds the row again; deleting twice is harmless. A row that settled a while ago (FILE_SWEEP_DAYS) is left alone,
  // except when it still holds a key, which is a file known to be there.
  private async sweepSettled(storeId: string, now: Date): Promise<number> {
    const settled = [ExportStatus.FAILED, ExportStatus.EXPIRED]
    const from = new Date(now.getTime() - ExportLimits.FILE_SWEEP_DAYS * 86_400_000)
    const until = new Date(now.getTime() - ExportLimits.FILE_SWEEP_GRACE_MINUTES * 60_000)
    const rows = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.export.findMany({
        where: {
          storeId,
          status: { in: settled },
          OR: [{ key: { not: null } }, { completedAt: { gte: from, lte: until } }]
        },
        select: { id: true, storeId: true, key: true },
        // The rows that hold a key are the ones known to leave a file: they come first
        orderBy: [{ key: { sort: 'asc', nulls: 'last' } }, { completedAt: 'desc' }],
        take: ExportLimits.CLEANUP_BATCH
      })
    )
    let swept = 0
    for (const row of rows) {
      try {
        await this.deleteFilesOf(row.storeId, row.id, row.key)
        if (row.key !== null) {
          await this.jobContext.forStore(storeId, () =>
            this.prisma.client.export.updateMany({
              where: {
                id: row.id,
                storeId: row.storeId,
                status: { in: settled },
                key: row.key
              },
              data: { key: null }
            })
          )
        }
        swept += 1
      } catch (error) {
        this.discardFailed.inc({ stage: ExportDiscardStages.SWEEP })
        this.logger.error(
          {
            exportId: row.id,
            errorName: errorName(error instanceof FileNotDeletedError ? error.reason : error)
          },
          'the files of a settled export could not be deleted'
        )
        // A row that did not hold the key now holds it, so the next run finds it however old it is
        if (row.key === null && error instanceof FileNotDeletedError) {
          await this.markKey(storeId, row, error.key)
        }
      }
    }
    return swept
  }

  private async markKey(
    storeId: string,
    row: { id: string; storeId: string },
    key: string
  ): Promise<void> {
    try {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.export.updateMany({
          where: {
            id: row.id,
            storeId: row.storeId,
            status: { in: [ExportStatus.FAILED, ExportStatus.EXPIRED] },
            key: null
          },
          data: { key }
        })
      )
    } catch (error) {
      this.logger.error(
        { exportId: row.id, errorName: errorName(error) },
        'a file that could not be deleted could not be marked on its row'
      )
    }
  }

  // Every object under the prefix of the export, and its key if it is somewhere else. Throws the first refusal of the bucket.
  private async deleteFilesOf(
    storeId: string,
    exportId: string,
    key: string | null
  ): Promise<void> {
    const { objects } = await this.storage.list(StorageKeys.exportPrefix(storeId, exportId))
    const keys = new Set(objects.map(object => object.key))
    if (key !== null) keys.add(key)
    for (const each of keys) {
      try {
        await this.storage.delete(each)
      } catch (error) {
        throw new FileNotDeletedError(each, error)
      }
    }
  }
}
