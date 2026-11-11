import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  type BulkLabelLeftOutReason,
  BulkLabelLeftOutReasons,
  BulkLabelLimits,
  MediaStatus,
  ShipmentLimits,
  ShipmentPrintableStatuses,
  type ShipmentStatus
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { MediaPurpose, sanitizeFilename, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { fitsMergeBudget, type LabelFile, mergeLabelFiles } from './label-merge'

const CONTENT_TYPE = 'application/pdf'
// Labels read from the bucket at the same time
const READ_GROUP = 5

export interface LabelLeftOut {
  shipmentId: string
  reason: BulkLabelLeftOutReason
}

// The file that was made: the labels in the order they were asked for, kept as `Media` (purpose BULK_LABELS) until the cleanup
export interface MergedFile {
  mediaId: string
  filename: string
  // The shipments whose pages are in the file, in the order of the pages
  merged: string[]
  pageCount: number
  mixedSizes: boolean
}

export interface MergeOutcome {
  // Null when no label could be merged: nothing is stored
  file: MergedFile | null
  leftOut: LabelLeftOut[]
}

export interface MergeOptions {
  // The person who asked (kept on the file); null for the system
  requestedBy: string | null
  // A label a carrier made waits for the scan of the worker before it may be merged: a bulk run waits for it, a reprint of a
  // label that has been there for long does not
  waitForScan: boolean
  scanWaitMs?: number
  scanPollMs?: number
}

interface ShipmentLabelRow {
  id: string
  status: string
  labelMediaId: string | null
}

interface LabelMediaRow {
  id: string
  key: string
  status: string
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The merge of labels that are already stored (TDD_17 §4.6): "print labels" and the last step of a bulk run. Reading a label never
// calls a carrier, and a label that was voided, is not clean or is not a PDF is left out and reported, never merged.
@Injectable()
export class MergedLabels {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MergedLabels.name)
  }

  // One PDF of the labels of these shipments of the store, in the order given. Every id is the store's own: another store's
  // shipment is "not found", exactly like one that does not exist.
  async build(
    storeId: string,
    shipmentIds: readonly string[],
    options: MergeOptions
  ): Promise<MergeOutcome> {
    const rows = await this.prisma.client.shipment.findMany({
      where: { storeId, id: { in: [...shipmentIds] } },
      select: { id: true, status: true, labelMediaId: true }
    })
    const byId = new Map<string, ShipmentLabelRow>(rows.map(row => [row.id, row]))
    const leftOut: LabelLeftOut[] = []
    const candidates: { shipmentId: string; mediaId: string }[] = []
    for (const shipmentId of shipmentIds) {
      const row = byId.get(shipmentId)
      if (row === undefined) {
        leftOut.push({ shipmentId, reason: BulkLabelLeftOutReasons.NOT_FOUND })
      } else if (!ShipmentPrintableStatuses.includes(row.status as ShipmentStatus)) {
        // A voided label is never merged, and neither is one whose guide is not known to exist
        leftOut.push({ shipmentId, reason: BulkLabelLeftOutReasons.NOT_PRINTABLE })
      } else if (row.labelMediaId === null) {
        leftOut.push({ shipmentId, reason: BulkLabelLeftOutReasons.NO_LABEL })
      } else {
        candidates.push({ shipmentId, mediaId: row.labelMediaId })
      }
    }

    const media = await this.cleanMedia(
      storeId,
      candidates.map(candidate => candidate.mediaId),
      options
    )
    const files: LabelFile[] = []
    let used = 0
    const ready: { shipmentId: string; key: string }[] = []
    for (const candidate of candidates) {
      const row = media.get(candidate.mediaId)
      if (row === undefined) {
        leftOut.push({
          shipmentId: candidate.shipmentId,
          reason: BulkLabelLeftOutReasons.NOT_READY
        })
      } else {
        ready.push({ shipmentId: candidate.shipmentId, key: row.key })
      }
    }
    // A few files at a time: a hundred round trips one after another would hold the request (or the slot of the worker) for
    // seconds. The budget is applied in order after each group, so what it leaves out is always the last labels asked for.
    for (let from = 0; from < ready.length; from += READ_GROUP) {
      const group = ready.slice(from, from + READ_GROUP)
      const read = await Promise.all(group.map(item => this.readLabel(item.key)))
      group.forEach((item, index) => {
        const bytes = read[index] ?? null
        if (bytes === null) {
          leftOut.push({ shipmentId: item.shipmentId, reason: BulkLabelLeftOutReasons.NOT_READY })
        } else if (!fitsMergeBudget(used, bytes.byteLength)) {
          leftOut.push({ shipmentId: item.shipmentId, reason: BulkLabelLeftOutReasons.TOO_LARGE })
        } else {
          used += bytes.byteLength
          files.push({ id: item.shipmentId, bytes })
        }
      })
    }

    const merge = await mergeLabelFiles(files)
    for (const shipmentId of merge.unreadable) {
      leftOut.push({ shipmentId, reason: BulkLabelLeftOutReasons.UNREADABLE })
    }
    if (merge.merged.length === 0) return { file: null, leftOut }

    const stored = await this.store(storeId, merge.pdf, options.requestedBy)
    return {
      file: {
        ...stored,
        merged: merge.merged,
        pageCount: merge.pageCount,
        mixedSizes: merge.mixedSizes
      },
      leftOut
    }
  }

  // A short link to a merged file of the store, or null when there is none (never made, another store's, or already removed by
  // the cleanup)
  async download(
    storeId: string,
    mediaId: string
  ): Promise<{ url: string; filename: string } | null> {
    const row = await this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId, purpose: MediaPurpose.BULK_LABELS, status: MediaStatus.CLEAN },
      select: { key: true, filename: true, contentType: true }
    })
    if (row === null) return null
    const url = await this.storage.downloadUrl({
      key: row.key,
      filename: row.filename,
      contentType: row.contentType
    })
    return { url, filename: row.filename }
  }

  // The clean files among the labels' media, by id. A file still waiting for its scan is waited for when the caller asks, up
  // to the limit, and a file that never turns clean (infected, refused, gone) is simply not among them.
  private async cleanMedia(
    storeId: string,
    mediaIds: readonly string[],
    options: MergeOptions
  ): Promise<Map<string, LabelMediaRow>> {
    const clean = new Map<string, LabelMediaRow>()
    if (mediaIds.length === 0) return clean
    const deadline = Date.now() + (options.scanWaitMs ?? BulkLabelLimits.SCAN_WAIT_MS)
    const poll = options.scanPollMs ?? BulkLabelLimits.SCAN_POLL_MS
    let waiting = [...mediaIds]
    for (;;) {
      const rows = await this.prisma.client.media.findMany({
        where: { id: { in: waiting }, storeId, purpose: MediaPurpose.SHIPPING_LABEL },
        select: { id: true, key: true, status: true }
      })
      for (const row of rows) {
        if (row.status === String(MediaStatus.CLEAN)) clean.set(row.id, row)
      }
      waiting = rows.filter(row => row.status === String(MediaStatus.PENDING)).map(row => row.id)
      if (waiting.length === 0 || !options.waitForScan || Date.now() + poll > deadline) break
      await pause(poll)
    }
    return clean
  }

  private async readLabel(key: string): Promise<Uint8Array | null> {
    try {
      return await this.storage.read(key, ShipmentLimits.LABEL_MAX_BYTES)
    } catch (error) {
      this.logger.warn({ errorName: errorName(error) }, 'a stored label could not be read')
      return null
    }
  }

  // The file, put in the bucket and written down; if the row cannot be written the object is removed again
  private async store(
    storeId: string,
    pdf: Uint8Array,
    uploadedBy: string | null
  ): Promise<{ mediaId: string; filename: string }> {
    const mediaId = randomUUID()
    const filename = sanitizeFilename(`labels-${new Date().toISOString().slice(0, 10)}.pdf`)
    const key = StorageKeys.bulkLabels(storeId, mediaId, filename)
    await this.storage.put(key, Buffer.from(pdf), CONTENT_TYPE)
    try {
      await this.prisma.client.media.create({
        data: {
          id: mediaId,
          storeId,
          purpose: MediaPurpose.BULK_LABELS,
          uploadedBy,
          key,
          filename,
          contentType: CONTENT_TYPE,
          fileSize: pdf.byteLength,
          // The platform made this file from files it had already scanned: nothing outside came in
          status: MediaStatus.CLEAN,
          scannedAt: new Date(),
          processedAt: new Date()
        }
      })
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined)
      throw error
    }
    return { mediaId, filename }
  }
}
