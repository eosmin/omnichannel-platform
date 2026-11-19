import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { JobContext, PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { ExportLimits } from '@platform/core/exports'
import { ExportStatus } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { inEachStoreStrict } from '../schedulers/store-sweep'

import { publishExportSettled } from './export-settled'

// rls-context: every read and write of `exports` runs inside JobContext.forStore of the store being cleaned; the bucket is touched outside

export interface ExportCleanupReport {
  filesDeleted: number
  abandoned: number
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
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExpiredExportsCleaner.name)
  }

  // Store by store, each in its own context (the policy of `exports` answers nothing else). A store that cannot be read stops the
  // run: an export that is never looked at is a file with personal data that stays. The objects of the bucket are deleted outside
  // the transactions (no external call inside one).
  async run(now: Date = new Date()): Promise<ExportCleanupReport> {
    const report: ExportCleanupReport = { filesDeleted: 0, abandoned: 0 }
    await inEachStoreStrict(this.prisma, async storeId => {
      const done = await this.cleanStore(storeId, now)
      report.filesDeleted += done.filesDeleted
      report.abandoned += done.abandoned
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
        // The object first: a row marked expired with its file still there would never be looked at again
        if (row.key !== null) await this.storage.delete(row.key)
        const marked = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.export.updateMany({
            where: { id: row.id, storeId: row.storeId, status: ExportStatus.READY },
            data: { status: ExportStatus.EXPIRED, key: null }
          })
        )
        filesDeleted += marked.count
      } catch (error) {
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
    return { filesDeleted, abandoned }
  }
}
