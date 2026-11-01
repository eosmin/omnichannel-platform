import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'
import { ExportLimits } from '@platform/core/exports'
import { ExportStatus } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

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
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExpiredExportsCleaner.name)
  }

  async run(now: Date = new Date()): Promise<ExportCleanupReport> {
    const expired = await this.prisma.client.export.findMany({
      where: { status: ExportStatus.READY, expiresAt: { lte: now } },
      select: { id: true, storeId: true, key: true },
      orderBy: { expiresAt: 'asc' },
      take: ExportLimits.CLEANUP_BATCH
    })
    let filesDeleted = 0
    for (const row of expired) {
      // One file that cannot be deleted must not keep the rest of the batch (or the next run, which
      // would start with the same row) from expiring
      try {
        // The object first: a row marked expired with its file still there would never be looked at again
        if (row.key !== null) await this.storage.delete(row.key)
        const marked = await this.prisma.client.export.updateMany({
          where: { id: row.id, storeId: row.storeId, status: ExportStatus.READY },
          data: { status: ExportStatus.EXPIRED, key: null }
        })
        filesDeleted += marked.count
      } catch (error) {
        this.logger.error(
          { exportId: row.id, errorName: errorName(error) },
          'an expired export could not be deleted'
        )
      }
    }

    const giveUp = new Date(now.getTime() - ExportLimits.PENDING_GIVE_UP_HOURS * 3_600_000)
    const stale = await this.prisma.client.export.findMany({
      where: { status: ExportStatus.PENDING, createdAt: { lte: giveUp } },
      select: { id: true, storeId: true },
      take: ExportLimits.CLEANUP_BATCH
    })
    let abandoned = 0
    for (const row of stale) {
      try {
        // A worker killed after the upload and before the row turned `ready` left a file no row names
        const { objects } = await this.storage.list(StorageKeys.exportPrefix(row.storeId, row.id))
        for (const object of objects) await this.storage.delete(object.key)
        const marked = await this.prisma.client.export.updateMany({
          where: { id: row.id, storeId: row.storeId, status: ExportStatus.PENDING },
          data: { status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_FAILED, completedAt: now }
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
