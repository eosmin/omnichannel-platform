// rls-context: every database access of this file runs inside JobContext.forStore, opened around that one call; the bucket and the encoder are called outside of it
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  DatabaseNull,
  JobContext,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  carriesMetadata,
  ImageNotSanitizable,
  isSanitizedType,
  sanitizeImage
} from '@platform/core/image-sanitizer'
import {
  ExistingPictureSweep,
  ImageSanitizing,
  MediaPurpose,
  UploadLimits
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { allStoreIds } from '../schedulers/store-sweep'

type Outcome = (typeof ExistingPictureSweep.Outcomes)[keyof typeof ExistingPictureSweep.Outcomes]

// The pictures that the cleaning of `TDD_07 §6.5` never saw: they were stored before it existed. Their purposes are the ones the scan
// cleans (an avatar has its own processing, and a financial or fiscal file is evidence that is kept as it came).
const SWEPT_PURPOSES = [
  MediaPurpose.MESSAGE,
  MediaPurpose.ORIGIN,
  MediaPurpose.PRODUCT,
  MediaPurpose.ORDER
]

export interface ExistingPictureReport {
  cleaned: number
  alreadyClean: number
  skipped: number
  failed: number
}

interface Candidate {
  id: string
  key: string
  contentType: string
  storeId: string | null
}

// Runs the cleaning of metadata over the pictures stored before it existed, a bounded batch of each store per run. The progress is the
// row: a picture that was cleaned carries `scanResult.sanitized` (as the scan writes it) and one that was looked at and left as it is
// carries `scanResult.sanitizeSweep`, so a row with no `scanResult` is one that has not been seen. Safe to repeat, and to stop at any point.
//
// What keeps a customer's file from being lost: the key, the row id and the URL never change; the cleaned bytes are written over the key
// only after they were produced and checked in memory (an overwrite of an object in the bucket is atomic: if it fails, the original is
// still there), and the row is marked after the write. A crash between the two leaves a file with no metadata and a row with no mark: the
// next run sees that the file carries nothing to remove and only writes the mark, instead of encoding it a second time. A picture that
// cannot be decoded any more is left as it is and logged, never deleted: it was served as clean.
@Injectable()
export class ExistingPictureSanitizer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExistingPictureSanitizer.name)
  }

  // The schedule: every store
  async run(): Promise<ExistingPictureReport> {
    return this.sweep(await allStoreIds(this.prisma))
  }

  // For a spec that shares the database and the bucket with other suites: only the stores it names, and an empty list is no store at all,
  // never every store. No route, job or payload can carry a list.
  runScoped(storeIds: readonly string[]): Promise<ExistingPictureReport> {
    return this.sweep(storeIds)
  }

  private async sweep(storeIds: readonly string[]): Promise<ExistingPictureReport> {
    const report: ExistingPictureReport = { cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 }
    for (const storeId of storeIds) {
      const room = ExistingPictureSweep.MAX_PER_RUN - this.total(report)
      if (room <= 0) break
      try {
        await this.sweepStore(storeId, Math.min(room, ExistingPictureSweep.BATCH_PER_STORE), report)
      } catch (error) {
        // A store that is deleted while it waits has nothing left; any other failure of a store does not stop the others
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'a store could not be swept for pictures with metadata'
        )
      }
    }
    return report
  }

  private total(report: ExistingPictureReport): number {
    return report.cleaned + report.alreadyClean + report.skipped + report.failed
  }

  private async sweepStore(
    storeId: string,
    take: number,
    report: ExistingPictureReport
  ): Promise<void> {
    const rows: Candidate[] = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.findMany({
        where: {
          storeId,
          status: MediaStatus.CLEAN,
          purpose: { in: SWEPT_PURPOSES },
          contentType: { in: [...ImageSanitizing.CONTENT_TYPES] },
          scanResult: { equals: DatabaseNull }
        },
        select: { id: true, key: true, contentType: true, storeId: true },
        orderBy: { id: 'asc' },
        take
      })
    )
    for (const row of rows) {
      try {
        const outcome = await this.sweepOne(row, storeId)
        if (outcome === undefined) report.cleaned += 1
        else if (outcome === ExistingPictureSweep.Outcomes.ALREADY_CLEAN) report.alreadyClean += 1
        else report.skipped += 1
      } catch (error) {
        // An error of the machine (memory, the bucket): the row keeps no mark, so the next run takes it again
        report.failed += 1
        this.logger.error(
          { mediaId: row.id, storeId, errorName: errorName(error) },
          'a stored picture could not be cleaned; the next run tries again'
        )
      }
    }
  }

  // Undefined when the picture was rewritten and marked; otherwise the outcome that was marked without rewriting it
  private async sweepOne(row: Candidate, storeId: string): Promise<Outcome | undefined> {
    if (!isSanitizedType(row.contentType))
      return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.UNTOUCHED)
    const original = await this.storage.read(row.key, UploadLimits.MAX_FILE_SIZE_BYTES)
    if (original === null) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored picture has no file in the bucket and was left as it is'
      )
      return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.MISSING)
    }
    let carries: boolean
    try {
      carries = await carriesMetadata(original)
    } catch (error) {
      return this.undecodable(row, storeId, error)
    }
    if (!carries) return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.ALREADY_CLEAN)

    let cleaned
    try {
      cleaned = await sanitizeImage(original, row.contentType)
    } catch (error) {
      if (!(error instanceof ImageNotSanitizable)) throw error
      return this.undecodable(row, storeId, error.reason)
    }
    if (cleaned.kind === 'untouched')
      return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.UNTOUCHED)

    // The original is replaced only now, with bytes that were produced and checked; a failure here leaves it in the bucket and the row unmarked
    await this.storage.put(row.key, cleaned.body, row.contentType)
    const moved = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: {
          id: row.id,
          storeId,
          status: MediaStatus.CLEAN,
          scanResult: { equals: DatabaseNull }
        },
        data: {
          fileSize: cleaned.body.length,
          scanResult: { [ExistingPictureSweep.CLEANED_KEY]: true }
        }
      })
    )
    if (moved.count === 0) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored picture changed while it was being cleaned; the next run looks at it again'
      )
    }
    return undefined
  }

  private undecodable(row: Candidate, storeId: string, reason: unknown): Promise<Outcome> {
    this.logger.warn(
      { mediaId: row.id, storeId, errorName: errorName(reason) },
      'a stored picture can no longer be decoded and was left as it is'
    )
    return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.UNDECODABLE)
  }

  // Writes the outcome of a picture that was not rewritten, only while the row has no `scanResult`: a mark never replaces another one
  private async mark(mediaId: string, storeId: string, outcome: Outcome): Promise<Outcome> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: {
          id: mediaId,
          storeId,
          status: MediaStatus.CLEAN,
          scanResult: { equals: DatabaseNull }
        },
        data: {
          scanResult:
            outcome === ExistingPictureSweep.Outcomes.ALREADY_CLEAN
              ? {
                  [ExistingPictureSweep.CLEANED_KEY]: true,
                  [ExistingPictureSweep.OUTCOME_KEY]: outcome
                }
              : { [ExistingPictureSweep.OUTCOME_KEY]: outcome }
        }
      })
    )
    return outcome
  }
}
