import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  type ImportedLine,
  type ImportRowError,
  MediaStatus,
  parseRemittanceFile,
  RemittanceImportFiles,
  RemittanceDelimiters,
  RemittanceImportLimits,
  type RemittanceImportPreviewBody,
  type RemittanceImportProfileShape,
  type RemittanceImportQuery,
  ShipmentResourceTypes
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { RemittancesService } from '@platform/core/shipping'
import { MediaPurpose, sanitizeFilename, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import type { Actor } from '../tenancy'

import type { ImportBody } from './remittance-import-body'
import { RemittancesApiService } from './remittances.service'
import type { RemittanceDetailView } from './remittances.views'

export interface ImportPreviewView {
  headers: string[]
  // The rows with data that were read, good or bad, and the lines that read well (the first ones)
  rowCount: number
  lines: ImportedLine[]
  errors: ImportRowError[]
  errorCount: number
  reference: string | null
  receivedOn: string | null
}

// What a sample is turned into before anything is saved: the mapper shows it, and nothing is written
function shapeOf(profile: {
  delimiter: string
  hasHeader: boolean
  decimalSeparator: string
  dateFormat: string
  columns: unknown
}): RemittanceImportProfileShape {
  return profile as RemittanceImportProfileShape
}

// The import of a carrier's settlement file (TDD_17 §4.15): read with the saved profile, strictly (one bad cell refuses the file and
// says which), kept as the evidence of the remittance (a `Media` of purpose REMITTANCE_FILE, scanned like any file from outside) and
// turned into a DRAFT: nothing is settled until somebody confirms it.
@Injectable()
export class RemittanceImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: RemittancesService,
    private readonly remittances: RemittancesApiService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>
  ) {}

  // The mapper's preview: the sample is read with the mapping being tried, and no file, no draft and no profile is written
  preview(body: RemittanceImportPreviewBody): ImportPreviewView {
    const parsed = parseRemittanceFile(body.text, shapeOf(body.profile), {
      maxRows: RemittanceImportLimits.PREVIEW_ROWS
    })
    return {
      headers: parsed.headers,
      rowCount: parsed.rowCount,
      lines: parsed.lines,
      errors: parsed.errors,
      errorCount: parsed.errorCount,
      reference: parsed.reference,
      receivedOn: parsed.receivedOn
    }
  }

  async importFile(
    storeId: string,
    query: RemittanceImportQuery,
    file: ImportBody,
    actor: Actor
  ): Promise<RemittanceDetailView> {
    const profile = await this.prisma.client.remittanceImportProfile.findFirst({
      where: { id: query.profileId, storeId, connectionId: query.connectionId }
    })
    // A profile of another connection or store is not found: it says nothing about which of them it is
    if (profile === null) throw resourceNotFound('import profile')
    const parsed = parseRemittanceFile(file.text, shapeOf(profile))
    if (parsed.errorCount > 0) {
      throw new PlatformException(
        ErrorCodes.REMITTANCE_IMPORT_INVALID,
        'the file has rows that cannot be read',
        HttpStatusCodes.BAD_REQUEST,
        { errorCount: parsed.errorCount, errors: parsed.errors }
      )
    }
    const bytes = file.bytes
    const mediaId = randomUUID()
    const kind =
      profile.delimiter === String(RemittanceDelimiters.TAB)
        ? RemittanceImportFiles.TSV
        : RemittanceImportFiles.CSV
    const contentType = kind.contentType
    const filename = sanitizeFilename(
      `${RemittanceImportFiles.FILENAME_PREFIX}-${new Date().toISOString().slice(0, 10)}.${kind.extension}`
    )
    const key = StorageKeys.remittanceFile(storeId, mediaId, filename)
    await this.storage.put(key, bytes, contentType)
    // Once the draft exists the file is its evidence and is never removed, whatever fails after
    let drafted = false
    try {
      await this.prisma.client.media.create({
        data: {
          id: mediaId,
          storeId,
          purpose: MediaPurpose.REMITTANCE_FILE,
          uploadedBy: actor.userId,
          key,
          filename,
          contentType,
          fileSize: bytes.length,
          status: MediaStatus.PENDING
        }
      })
      const created = await this.writes.createDraft(
        storeId,
        {
          connectionId: query.connectionId,
          lines: parsed.lines.map(line => ({
            guideNumber: line.guideNumber,
            reportedCents: line.reportedCents,
            ...(line.reportedFeeCents === undefined
              ? {}
              : { reportedFeeCents: line.reportedFeeCents })
          })),
          ...(parsed.reference === null ? {} : { reference: parsed.reference }),
          ...(parsed.receivedOn === null ? {} : { receivedOn: parsed.receivedOn })
        },
        { type: 'user', id: actor.userId },
        { importProfileId: profile.id, sourceMediaId: mediaId }
      )
      drafted = true
      // A scan that was not queued waits for the hourly cleanup of pending files: it must not fail an import that was made
      await this.queueScan(mediaId).catch(() => undefined)
      this.audit.log({
        action: AuditAction.REMITTANCE_IMPORTED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: ShipmentResourceTypes.REMITTANCE,
        resourceId: created.id,
        metadata: {
          connectionId: query.connectionId,
          profileId: profile.id,
          rows: parsed.lines.length,
          mediaId
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
      return await this.remittances.get(storeId, created.id)
    } catch (error) {
      if (drafted) throw error
      // Nothing was made of the file: it is removed, never left behind (a stray object is found by its prefix)
      await this.prisma.client.media
        .deleteMany({ where: { id: mediaId, storeId } })
        .catch(() => undefined)
      await this.storage.delete(key).catch(() => undefined)
      throw error
    }
  }

  // After the draft exists: the worker scans the file like any that comes from outside
  private async queueScan(mediaId: string): Promise<void> {
    await this.heavyQueue.add(
      JobNames.SCAN_FILE,
      { mediaId },
      { jobId: `${JobNames.SCAN_FILE}-${mediaId}` }
    )
  }
}
