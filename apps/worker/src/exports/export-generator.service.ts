import { Injectable } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'
import { ExportFileExtensions } from '@platform/core/exports'
import {
  conversationsExportFiltersSchema,
  customersExportFiltersSchema,
  mediaZipFiltersSchema
} from '@platform/core/messaging'
import {
  ExportAuditActions,
  ExportStatus,
  type ExportType,
  ExportTypes
} from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { conversationsExportSource } from './conversations-export.source'
import { CsvExportWriter } from './csv-export-writer'
import { customersExportSource } from './customers-export.source'
import { mediaZipSource, ZipEmptyError, ZipTooLargeError } from './media-zip-export.source'
import { ZipExportWriter } from './zip-export-writer'

// How a kind of export is written: the extension of its file and the call that writes it at a key
interface ExportPlan {
  extension: string
  write: (key: string) => Promise<{ rowCount: number }>
}

// Makes the file of an export row (TDD_07 §7). The row is the whole job: the kind, the filters and who
// asked are read from it, never from the job, which only names it.
@Injectable()
export class ExportGenerator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: CsvExportWriter,
    private readonly zipWriter: ZipExportWriter,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExportGenerator.name)
  }

  async generate(exportId: string, lastAttempt: boolean): Promise<void> {
    const row = await this.prisma.client.export.findUnique({ where: { id: exportId } })
    // Gone with its store, or already settled: a job that arrives twice makes the file once
    if (row === null || row.status !== ExportStatus.PENDING) return

    const plan = this.planOf(row.type, row.storeId, row.filters)
    if (plan === null) {
      await this.fail(exportId, row.storeId)
      throw new UnrecoverableError('the export row does not fit its kind')
    }

    const filename = `${row.type}-${new Date().toISOString().slice(0, 10)}.${plan.extension}`
    const key = StorageKeys.export(row.storeId, row.id, filename)
    try {
      const { rowCount } = await plan.write(key)
      const settled = await this.prisma.client.export.updateMany({
        // Not over a row that settled meanwhile
        where: { id: row.id, storeId: row.storeId, status: ExportStatus.PENDING },
        data: { status: ExportStatus.READY, key, rowCount, completedAt: new Date(), error: null }
      })
      if (settled.count === 0) {
        // The row settled meanwhile (given up, failed): nothing will ever point at this file
        await this.discard(key)
        return
      }
      this.audit.log({
        action: ExportAuditActions[row.type as ExportType],
        actor: { userId: row.requestedBy },
        storeId: row.storeId,
        resourceType: 'export',
        resourceId: row.id,
        metadata: { type: row.type, format: row.format, rowCount, filters: row.filters ?? {} }
      })
    } catch (error) {
      this.logger.error({ exportId, errorName: errorName(error) }, 'an export could not be written')
      if (error instanceof ZipTooLargeError || error instanceof ZipEmptyError) {
        // Trying again finds the same files
        const code =
          error instanceof ZipTooLargeError ? ErrorCodes.EXPORT_TOO_LARGE : ErrorCodes.EXPORT_EMPTY
        await this.fail(exportId, row.storeId, code)
        await this.discard(key)
        throw new UnrecoverableError(error.message)
      }
      if (lastAttempt) {
        await this.fail(exportId, row.storeId)
        await this.discard(key)
      }
      throw error
    }
  }

  // null when the row holds a kind this step does not make, or filters that do not fit their schema
  private planOf(type: string, storeId: string, filters: unknown): ExportPlan | null {
    if (type === ExportTypes.CUSTOMERS) {
      const parsed = customersExportFiltersSchema.safeParse(filters ?? {})
      if (!parsed.success) return null
      const source = customersExportSource(this.prisma, storeId, parsed.data)
      return { extension: ExportFileExtensions.CSV, write: key => this.writer.write(key, source) }
    }
    if (type === ExportTypes.CONVERSATIONS) {
      const parsed = conversationsExportFiltersSchema.safeParse(filters)
      if (!parsed.success) return null
      const source = conversationsExportSource(this.prisma, storeId, parsed.data)
      return { extension: ExportFileExtensions.CSV, write: key => this.writer.write(key, source) }
    }
    if (type === ExportTypes.MEDIA_ZIP) {
      const parsed = mediaZipFiltersSchema.safeParse(filters)
      if (!parsed.success) return null
      const source = mediaZipSource(this.prisma, storeId, parsed.data)
      return {
        extension: ExportFileExtensions.ZIP,
        write: key => this.zipWriter.write(key, source)
      }
    }
    return null
  }

  // A file with personal data that no `ready` row points to is never deleted by the cleanup
  private async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch((error: unknown) => {
      this.logger.error({ errorName: errorName(error) }, 'an export file could not be discarded')
    })
  }

  private async fail(
    exportId: string,
    storeId: string,
    code: string = ErrorCodes.EXPORT_FAILED
  ): Promise<void> {
    await this.prisma.client.export.updateMany({
      where: { id: exportId, storeId, status: ExportStatus.PENDING },
      data: {
        status: ExportStatus.FAILED,
        error: code,
        completedAt: new Date()
      }
    })
  }
}
