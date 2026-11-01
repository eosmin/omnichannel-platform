import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { type Permission, Permissions } from '@platform/core/auth'
import { DataRetentionPolicies } from '@platform/core/compliance'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import type { CursorPage } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { ExportLimits } from '@platform/core/exports'
import {
  type ExportFormat,
  ExportStatus,
  type ExportType,
  ExportTypes,
  type GenerateExportJob,
  JobNames,
  QueueNames
} from '@platform/core/queues'
import { UploadLimits } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { encodeCursor } from '../customers/list-cursor'

import type { ListExportsQuery } from './exports.schemas'
import {
  type ExportDownload,
  type ExportRow,
  exportContentType,
  EXPORT_COLUMNS,
  exportView,
  type ExportView,
  type JsonObject
} from './exports.views'

// What each kind of export needs. A kind with no entry is not served here yet (orders: Step 4.4,
// analytics: Step 5.2, the audit log: Step 7.2), so nobody sees its rows or downloads its file.
// Every permission listed, the same ones the route that makes the kind asks for.
const TYPE_PERMISSIONS: Partial<Record<ExportType, readonly Permission[]>> = {
  [ExportTypes.CONVERSATIONS]: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT],
  [ExportTypes.CUSTOMERS]: [Permissions.CUSTOMERS_EXPORT],
  [ExportTypes.MEDIA_ZIP]: [
    Permissions.CUSTOMERS_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_DOWNLOAD_ALL
  ]
}

export const ExportListPermissions: [Permission, ...Permission[]] = [
  Permissions.CONVERSATIONS_EXPORT,
  Permissions.CUSTOMERS_EXPORT,
  Permissions.MEDIA_DOWNLOAD_ALL
]

export interface RequestExport {
  storeId: string
  userId: string
  type: ExportType
  format: ExportFormat
  filters: JsonObject
}

function typesOf(held: readonly Permission[]): ExportType[] {
  return Object.entries(TYPE_PERMISSIONS)
    .filter(([, needed]) => needed.every(permission => held.includes(permission)))
    .map(([type]) => type as ExportType)
}

// An export is personal data on its way out of the platform, so a member sees and downloads only the
// exports they asked for, and only of the kinds their role may still make. Every query is filtered
// by the store of the request.
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QueueNames.EXPORTS) private readonly queue: Queue<GenerateExportJob>
  ) {}

  // Creates the row and queues the job. The caller has checked the permission of the kind.
  async request(params: RequestExport): Promise<ExportView> {
    const { storeId, userId, type, format, filters } = params
    const created = await this.prisma.transaction(async tx => {
      // Taking turns per store: two requests at once cannot both pass the limit
      await lockStoreForWrite(tx, storeId)
      const since = new Date(Date.now() - ExportLimits.ACTIVE_WINDOW_MINUTES * 60_000)
      const active = await tx.export.count({
        where: { storeId, status: ExportStatus.PENDING, createdAt: { gt: since } }
      })
      if (active >= ExportLimits.MAX_ACTIVE_PER_STORE) {
        throw new PlatformException(
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          'too many exports are being prepared',
          HttpStatusCodes.TOO_MANY_REQUESTS
        )
      }
      return tx.export.create({
        data: {
          storeId,
          requestedBy: userId,
          type,
          format,
          filters,
          status: ExportStatus.PENDING,
          expiresAt: new Date(Date.now() + DataRetentionPolicies.EXPORTS.defaultDays * 86_400_000)
        },
        select: EXPORT_COLUMNS
      })
    })
    try {
      await this.queue.add(
        JobNames.GENERATE_EXPORT,
        { exportId: created.id },
        { jobId: `${JobNames.GENERATE_EXPORT}-${created.id}` }
      )
    } catch (error) {
      // Nobody will run it: say so now and not an hour later
      await this.prisma.client.export.updateMany({
        where: { id: created.id, storeId },
        data: { status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_FAILED }
      })
      throw error
    }
    return exportView(created)
  }

  async list(
    storeId: string,
    userId: string,
    held: readonly Permission[],
    query: ListExportsQuery
  ): Promise<CursorPage<ExportView>> {
    const { cursor } = query
    const rows = await this.prisma.client.export.findMany({
      where: {
        storeId,
        requestedBy: userId,
        type: { in: typesOf(held) },
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: EXPORT_COLUMNS,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => exportView(row)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(
    storeId: string,
    userId: string,
    held: readonly Permission[],
    exportId: string
  ): Promise<ExportView> {
    return exportView(await this.find(storeId, userId, held, exportId))
  }

  // A signed link to the file, asked each time and never kept: it lasts minutes
  async download(
    storeId: string,
    userId: string,
    held: readonly Permission[],
    exportId: string
  ): Promise<ExportDownload> {
    const row = await this.find(storeId, userId, held, exportId)
    const view = exportView(row)
    if (view.status === ExportStatus.EXPIRED) {
      throw new PlatformException(
        ErrorCodes.EXPORT_EXPIRED,
        'the export has expired',
        HttpStatusCodes.GONE
      )
    }
    if (view.status === ExportStatus.FAILED) {
      throw new PlatformException(
        ErrorCodes.EXPORT_FAILED,
        'the export failed',
        HttpStatusCodes.CONFLICT
      )
    }
    if (view.status !== ExportStatus.READY || row.key === null || view.filename === null) {
      throw new PlatformException(
        ErrorCodes.EXPORT_NOT_READY,
        'the export is still being prepared',
        HttpStatusCodes.CONFLICT
      )
    }
    const contentType = exportContentType(view.format)
    const url = await this.storage.downloadUrl({
      key: row.key,
      contentType,
      filename: view.filename
    })
    return { url, filename: view.filename, expiresInSeconds: UploadLimits.DOWNLOAD_URL_TTL_SECONDS }
  }

  // Another member's export, another store's and a kind the role may not make are the same 404
  private async find(
    storeId: string,
    userId: string,
    held: readonly Permission[],
    exportId: string
  ): Promise<ExportRow> {
    const row = await this.prisma.client.export.findFirst({
      where: { id: exportId, storeId, requestedBy: userId, type: { in: typesOf(held) } },
      select: EXPORT_COLUMNS
    })
    if (row === null) throw resourceNotFound('export')
    return row
  }
}
