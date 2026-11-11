import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import type { PrismaTransaction } from '@platform/core/database'
import { MediaStatus, ShipmentLimits } from '@platform/core/domain'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { MediaPurpose, sanitizeFilename, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { hasPdfSignature } from './shipment-labels.rules'

// A label put in the bucket and not yet written down: the object is there, the row of `Media` is made inside the
// transaction that records the guide, and if that transaction fails the object is removed
export interface StoredLabel {
  mediaId: string
  key: string
  filename: string
  byteLength: number
  // A label the platform drew itself needs no scan; one a carrier sent does (TDD_17 §4.5 step 4)
  needsScan: boolean
}

const CONTENT_TYPE = 'application/pdf'

// The label of a shipment as a file of `Media` (purpose SHIPPING_LABEL), kept once and printed from there: reprinting
// never calls the carrier (TDD_17 §4.6)
@Injectable()
export class ShipmentLabels {
  constructor(
    private readonly storage: StorageService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>
  ) {}

  // Puts the file in the bucket. `drawn` is a label the platform made from its own layout; a file from a carrier is checked
  // to be a PDF of a sane size first and is scanned like any file that comes from outside. Returns null when the carrier's
  // file is not one the platform keeps (the guide is still recorded, without a label).
  async put(
    storeId: string,
    shipmentId: string,
    guideNumber: string,
    data: Uint8Array,
    contentType: string,
    drawn: boolean
  ): Promise<StoredLabel | null> {
    if (!drawn) {
      // `application/pdf; charset=binary` and capitals are still a PDF: the signature below is the real check
      if (contentType.split(';')[0]?.trim().toLowerCase() !== CONTENT_TYPE) return null
      if (data.byteLength === 0 || data.byteLength > ShipmentLimits.LABEL_MAX_BYTES) return null
      if (!hasPdfSignature(data)) return null
    }
    const mediaId = randomUUID()
    // The guide is the carrier's own text: only what a file name may hold survives of it
    const filename = sanitizeFilename(`label-${guideNumber}.pdf`)
    const key = StorageKeys.shippingLabel(storeId, shipmentId, mediaId, filename)
    await this.storage.put(key, Buffer.from(data), CONTENT_TYPE)
    return { mediaId, key, filename, byteLength: data.byteLength, needsScan: !drawn }
  }

  // The row of the file, written with the guide. A drawn label is clean at once; a carrier's waits for the scan.
  async record(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    uploadedBy: string | null,
    label: StoredLabel
  ): Promise<void> {
    await tx.media.create({
      data: {
        id: label.mediaId,
        storeId,
        purpose: MediaPurpose.SHIPPING_LABEL,
        orderId,
        uploadedBy,
        key: label.key,
        filename: label.filename,
        contentType: CONTENT_TYPE,
        fileSize: label.byteLength,
        status: label.needsScan ? MediaStatus.PENDING : MediaStatus.CLEAN,
        ...(label.needsScan ? {} : { scannedAt: new Date(), processedAt: new Date() })
      }
    })
  }

  // After the commit: a label from a carrier is scanned by the worker, like any file that comes from outside
  async queueScan(label: StoredLabel): Promise<void> {
    if (!label.needsScan) return
    await this.heavyQueue.add(
      JobNames.SCAN_FILE,
      { mediaId: label.mediaId },
      { jobId: `${JobNames.SCAN_FILE}-${label.mediaId}` }
    )
  }

  // A file whose guide could not be recorded: removed, never left behind. A failure here leaves a stray object, which the
  // storage cleanup finds by its prefix; it is not worth failing a request that is already failing.
  async discard(label: StoredLabel): Promise<void> {
    try {
      await this.storage.delete(label.key)
    } catch {
      // see above
    }
  }
}
